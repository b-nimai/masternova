# ADR-0003 — HLS with an ABR ladder over progressive MP4

**Status:** accepted · **Date:** 2026-09-02 · **Deciders:** Nimai

## Context

Lectures are the product. A learner watches them on a laptop on campus wifi, on a phone on
a train, and on a 4G connection that varies by the minute — and the platform's audience is
in India, where a good connection and a bad one differ by more than an order of magnitude.

The upload pipeline (task 1.6) puts one source file in object storage. Something has to
decide what a player is given. That decision determines the storage bill, the CDN bill, the
worker fleet's size, and whether a learner on a weak connection watches a lecture or a
spinner.

It also constrains everything downstream: the entitlement engine's three-layer enforcement
(task 1.8) signs a _manifest_ path, the player's quality selector needs variants to select
between, and the "ask the video" feature (1.17) seeks to a timestamp.

## Decision

**HLS with a four-rung ABR ladder (240p/480p/720p/1080p), packaged as fragmented segments
with a master playlist.** The source is never served directly.

Rungs are chosen per-asset and **capped at the source height** — a 480p upload produces two
rungs, not four. Segments are six seconds, and keyframes are pinned so every segment starts
on one across all rungs.

## Alternatives considered

### 1. Progressive MP4 — serve the uploaded file

The simplest thing that works, and it genuinely does work: a `<video src>` pointing at a
presigned URL plays. Rejected for three reasons, in order of how much they hurt.

- **No adaptation.** The learner picks a quality by not picking one — they get whatever was
  uploaded. A 4K screen recording on a 3G connection buffers indefinitely, and the player
  has no lower rung to fall back to because none exists.
- **Seeking costs a round trip and a range request into a multi-gigabyte object**, and it
  is only as good as the source's `moov` atom placement. A file uploaded with the atom at
  the end cannot be seeked at all until it is fully downloaded.
- **It cannot be protected at the CDN.** A signed URL to one large object is one leaked
  link away from being the whole lecture. Task 1.8's design signs a _path_ and expires the
  manifest in five minutes, which needs the media to be many small objects behind a
  playlist.

### 2. MPEG-DASH

Technically the better standard: codec-agnostic, an open ISO spec, and no Apple-specific
history. Rejected on reach, not merit — **Safari and iOS do not play DASH natively**, and a
sizeable share of the audience is on iPhones. Supporting it means shipping a JavaScript MSE
player as the _only_ playback path, where HLS degrades to a native `<video>` element on
Safari and works with hls.js everywhere else.

Doing both is the answer a large platform reaches eventually. Doing both now doubles the
packaging step and the storage for an audience of zero.

### 3. HLS, but one rendition rather than a ladder

Keeps the segmentation and the CDN story, drops the fan-out. Rejected because the
adaptation _is_ the point: a single 720p rendition has the same failure mode as progressive
MP4 on a weak connection, and it would mean building the pipeline and then not getting the
one thing that justified it. The ladder is also what makes the worker fleet a real
autoscaling story — four rungs per lecture is the queue depth 2.6 scales on.

### 4. A managed service (Mux, Cloudflare Stream, AWS MediaConvert)

What a startup should genuinely do. Rejected for this project specifically, and the reason
is honest: **the pipeline is the portfolio.** Handing the interesting part — the job DAG,
idempotent workers, the DLQ, backpressure — to an API leaves a resume line that says "I
called Mux". It is also a recurring per-minute cost against a project with no revenue.

Recorded so the trade is explicit: in a commercial setting with a deadline, MediaConvert is
the right call and this ADR would go the other way.

## Consequences

**Good**

- A learner on a degrading connection drops a rung instead of buffering, and climbs back.
- **Storage is bounded and predictable**: four rungs of a 90-minute lecture is roughly 2.2 GB
  at these bitrates, against a 4K source that could be 20 GB.
- Seeking is a playlist lookup plus one six-second segment.
- The three-layer entitlement design (1.8) becomes possible — a five-minute signed manifest
  and a CloudFront signed cookie on the segment path.
- Sprite thumbnails and, later, WebVTT captions (1.16) attach to the same timeline.

**Bad, and accepted**

- **Transcoding is the platform's largest compute cost**, and it is CPU-bound. Four rungs
  means roughly 4× the encode time of one, which is exactly why the ladder is a fan-out
  across workers rather than one long job.
- **A lecture is not watchable the moment it is uploaded.** There is now a processing window
  with a progress bar and a failure mode, where progressive MP4 had neither. That is what
  the SSE stream and the DLQ replay endpoint exist to make survivable.
- **Thousands of small objects per lecture** rather than one. `ListObjectsV2` over the
  bucket stops being a casual operation, and the reconciliation sweeper has to be driven
  from the database rather than from a bucket walk.
- The bitrate ladder is a published starting point, not a tuned one. Per-title encoding —
  measuring each source's complexity and picking bitrates for it — is the real answer and
  is not built.

## Notes

Keyframe alignment across rungs is not a detail: if the GOP does not divide evenly into
`hls_time × fps`, ffmpeg places segment boundaries at the next available keyframe, the rungs
stop agreeing on where segments start, and a player switching rungs mid-stream stutters or
seeks backwards. That is why `HlsCommandBuilder` is a Builder with an asserted validity
condition rather than a template string — see `docs/lld/video-pipeline.md` §6.
