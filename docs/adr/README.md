# Architecture Decision Records

**One ADR = one decision.** Numbered, never deleted — a superseded ADR is marked
`Status: superseded by NNNN`, because the trail of changed decisions is itself the signal.

Write one whenever a real alternative existed. If there was no alternative, it was not a
decision and does not need a record.

| #                                                    | Decision                                              | Status   |
| ---------------------------------------------------- | ----------------------------------------------------- | -------- |
| [0001](0001-modular-monolith.md)                     | Modular monolith over microservices                   | accepted |
| [0002](0002-fresh-repo-over-fork.md)                 | Fresh repository over forking Loom Lite AI            | accepted |
| [0004](0004-outbox-over-direct-publish.md)           | Transactional outbox over publishing directly         | accepted |
| [0010](0010-refresh-rotation-over-stateless-jwt.md)  | Refresh rotation + reuse detection over stateless JWT | accepted |
| [0015](0015-keyset-over-offset-pagination.md)        | Keyset cursors over LIMIT/OFFSET pagination           | accepted |
| [0016](0016-optimistic-concurrency-for-authoring.md) | Optimistic concurrency for authoring writes           | accepted |
| [0017](0017-provider-truth-for-upload-progress.md)   | Storage provider is the truth for upload progress     | accepted |

Planned: see `BUILD_PLAN.md` §12 for the full backlog (0003–0012).
