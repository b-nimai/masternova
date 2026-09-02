import type { JobsOptions } from 'bullmq';

/**
 * One queue for every pipeline job type.
 *
 * A queue per type would give each stage its own concurrency knob, which sounds better and
 * is worse here: the workers are one autoscaled pool sized on total CPU, so five queues
 * means five sets of idle connections and a scaling signal split five ways. One queue keeps
 * queue depth a single number — the number task 2.6's autoscaler actually reads.
 */
export const PIPELINE_QUEUE = 'media-pipeline';

/**
 * Retry policy, and the reasoning behind each number.
 *
 * **5 attempts.** The failures worth retrying are transient — an S3 5xx, a worker evicted
 * mid-job, a pod restarted during a deploy. Those clear in seconds to minutes. Beyond five
 * the failure is structural, and continuing to retry only delays the moment a human sees it
 * while burning CPU that queued work needs.
 *
 * **Exponential from 10s, so: 10s · 20s · 40s · 80s** ≈ two and a half minutes to the
 * dead-letter set. Deliberately longer than the outbox relay's 2s base — that relay sends
 * emails, this runs multi-minute ffmpeg jobs, and retrying a transcode aggressively means
 * three copies of the same 20-minute encode competing for the same CPU.
 */
export const PIPELINE_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },

  /**
   * Completed jobs are removed; **failed jobs are kept**.
   *
   * That asymmetry is the dead-letter queue. BullMQ's failed set already stores the payload,
   * the attempt count and the stack trace of every attempt — everything a replay needs — so
   * building a `dead_letter_jobs` table beside it would be a dual write against state Redis
   * already owns, with the two free to disagree. Same argument as ADR-0017.
   *
   * The bound is 1000 failures or 30 days, whichever comes first: a DLQ nobody can page
   * through is not an operational tool, and an unbounded one is a memory leak.
   */
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 1000, age: 30 * 24 * 60 * 60 },
};

/**
 * How many jobs one worker process runs at once.
 *
 * Two, not ten. Transcoding is CPU-bound and ffmpeg already uses every core it can get, so
 * running ten concurrently on a 2-vCPU task does not transcode ten videos faster — it
 * transcodes all ten more slowly, and makes every one of them miss its visibility timeout
 * together. Concurrency here is for overlapping a CPU-bound encode with an I/O-bound
 * upload, which two covers. Horizontal scale is the answer to depth, not this number.
 */
export const PIPELINE_CONCURRENCY = 2;

/**
 * How long a job may run before BullMQ assumes the worker died and redelivers it.
 *
 * A 90-minute lecture at `veryfast` is a few minutes per rung, and a stalled S3 read can
 * add more. Thirty minutes is generous enough that a slow-but-healthy job is never
 * redelivered — which matters because redelivery of a live job means two ffmpeg processes
 * writing the same output key. The processors are idempotent so the outcome is still
 * correct, but the CPU is wasted.
 */
export const PIPELINE_LOCK_MS = 30 * 60_000;
