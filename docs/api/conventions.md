# API conventions

**Last updated:** 2026-08-23 · **Status:** partial — task 1.11 owns completing this and
generating `openapi.yaml`. Rules are recorded here **as the module that introduces them
lands**, not in a cleanup pass, because a convention written from memory is a convention
that already drifted.

All routes are under the `/api` prefix.

## 1. Error envelope

Every error, from any layer, is shaped by `AllExceptionsFilter`:

```jsonc
{
  "statusCode": 409,
  "error": "CONFLICT",
  "message": "This course was changed elsewhere. Reload and try again.",
  "details": { "expectedVersion": 7, "currentVersion": 8 }, // optional
  "timestamp": "2026-08-23T09:41:02.114Z",
  "path": "/api/instructor/courses/abc/curriculum",
}
```

- `message` is the **human sentence**. It may be a string or, for validation failures, the
  Zod issue list.
- `details` is **optional and machine-readable**, present only when an exception carries it.

  The force: the publish gate rejects with a _list_ of coded problems, and flattening that
  into one English sentence makes the client parse prose to know which wizard step to open.
  So the sentence stays a sentence and the codes go in `details`.

  Anything a client is expected to branch on belongs in `details` with a **stable code** —
  never in `message`, which is copy and will be reworded.

| Status | Means                                                                               |
| ------ | ----------------------------------------------------------------------------------- |
| 400    | Malformed request — bad Zod parse, a reorder that is not a permutation              |
| 401    | Not signed in                                                                       |
| 403    | Signed in, not permitted (wrong owner, wrong role)                                  |
| 404    | Not found **or not visible to you** — deliberately the same answer                  |
| 409    | The resource's _state_ forbids this: version conflict, illegal transition, archived |
| 422    | Well-formed and permitted, but the _content_ is not ready (publish gate)            |

The 404-for-invisible rule matters: a 403 on an unpublished course confirms it exists, which
is an information leak dressed up as correctness.

The 409/422 split matters too. 409 says "you are racing someone or the state is wrong"; 422
says "you are not finished yet". They send a client down different recovery paths.

## 2. Cursor pagination

Every list returns `{ items, nextCursor }` and **no `total`** — counting the matching set on
every page is exactly the cost keyset pagination exists to avoid. `nextCursor === null` is
the end of the list. See [ADR-0015](../adr/0015-keyset-over-offset-pagination.md).

The cursor is **opaque**. A client that parses it is a client that breaks the day the sort
key changes.

```
GET /api/courses?sort=NEWEST&limit=20&cursor=<opaque>
```

## 3. Optimistic concurrency on content writes

Any endpoint that changes the **content** of an aggregate takes `expectedVersion` in the
body, and every authoring response carries the current `version`. A mismatch is `409` with
`details: { expectedVersion, currentVersion }`.

```
PATCH /api/instructor/courses/:id            { "title": "...", "expectedVersion": 7 }
PATCH /api/instructor/courses/:id/pricing    { "priceMinor": 0, "expectedVersion": 7 }
POST  /api/instructor/courses/:id/curriculum { "expectedVersion": 7, "command": { ... } }
```

**Lifecycle transitions do not take a version.** They re-read the aggregate and re-run their
guards against it, so a stale caller is either still valid or told exactly what is wrong.
See [ADR-0016](../adr/0016-optimistic-concurrency-for-authoring.md).

## 4. Idempotency

Endpoints marked `@Idempotent()` **require** an `Idempotency-Key` header. A repeat with the
same key returns the **stored response**; a repeat with the same key and a _different_ body
is a client bug and is rejected `422`, not silently served the first response.

| Status | Means                                                      |
| ------ | ---------------------------------------------------------- |
| 400    | The header is required and was not sent                    |
| 409    | A request with this key is still in flight — retry shortly |
| 422    | This key was already used with a different request body    |

Keys are scoped **per caller**, never global: a globally-keyed store would let one user probe
another's stored response by guessing a key.

Note the division of labour with §3. Where a write already carries `expectedVersion`, a
replay is _already_ safe — the retry's version is stale and gets a 409, which is a better
answer than a stored response because the client's copy really is out of date. So
`Idempotency-Key` is reserved for unsafe writes that have **no** version to guard them:
`POST /courses/:id/duplicate`, `POST /courses/:id/curriculum/undo`,
`POST /media/uploads/:id/complete`.

## 5. Money

Money crosses the wire as **minor units plus a currency**, never a formatted string and
never a float. Formatting is a locale decision and belongs to the client.

```jsonc
{ "priceMinor": 149900, "listPriceMinor": 199900, "currency": "INR" }
```

## 6. Commands as request bodies

`POST /instructor/courses/:id/curriculum` takes a **discriminated union** rather than nine
REST verbs, because the edit has to be storable and invertible for undo. The discriminator
is `kind`. Adding an edit type adds a member, not a route. See
[`lld/wizard-draft-state.md`](../lld/wizard-draft-state.md).

## 7. Large integers cross the wire as strings

`Asset.sizeBytes` is a 64-bit integer, and `JSON.stringify` throws on a `BigInt`. Rather
than remember to convert at each of the places a size is returned, the **wire type is a
decimal string** and the conversion happens once, at the schema boundary.

```jsonc
{ "sizeBytes": "10737418240" }
```

The rule generalises: any value that can exceed `Number.MAX_SAFE_INTEGER`, or that is stored
as a database `BIGINT`, is a string in JSON. Money is the deliberate exception — minor units
of any real price fit comfortably in a `Number` (§5).

## 8. Client-driven transfers return a plan, not a stream

`POST /media/uploads` returns **part boundaries and presigned URLs**, and the bytes never
touch the API. Two consequences worth stating as conventions:

- **A window, not the whole plan.** At most 100 part URLs per response. A 10 GB upload is
  1250 parts, and signing all of them would return a megabyte of JSON whose last URLs would
  expire before a slow client reached them. The client sends its window, then asks again.
- **Progress and resume are one endpoint.** `GET /media/uploads/:id` reports what the
  storage provider actually holds and re-signs only the missing parts. There is no separate
  `/resume`, deliberately: a recovery path used only after a crash is a path that first runs
  in production. See [ADR-0017](../adr/0017-provider-truth-for-upload-progress.md).

## 9. Long-running work streams over SSE, not WebSocket

Anything that takes minutes and that a human watches — today the transcode pipeline —
exposes **two** endpoints: a one-shot `GET` for a client that would rather poll, and a
`GET .../stream` that emits `text/event-stream`.

SSE over a WebSocket because the data flows one way and the client only ever watches. It is
a plain HTTP response with automatic browser reconnection, no second protocol to secure or
proxy, and no sticky-session requirement in front of the load balancer. Two headers are not
optional: `Cache-Control: no-cache` and `X-Accel-Buffering: no` — nginx and ALB both buffer
by default, which holds every event until the response ends and turns a live progress bar
into one frame at the very end.

A stream emits **only on change** and closes itself when the work reaches a terminal state.

## 10. Still owed by task 1.11

Versioning strategy (`/api/v1` vs header), rate-limit headers, the generated
`openapi.yaml`, and schemathesis contract tests.
