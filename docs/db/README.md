# Database docs

| File            | Holds                                                               |
| --------------- | ------------------------------------------------------------------- |
| `erd.md`        | entity diagram + relationships (Mermaid)                            |
| `indexes.md`    | every non-PK index, the query it serves, and its `EXPLAIN` evidence |
| `migrations.md` | expand-contract policy, rollback notes                              |

`indexes.md` is not a list of indexes. It is a list of **(index, query, EXPLAIN before,
EXPLAIN after)** — an index without the query that justifies it is cargo cult.
