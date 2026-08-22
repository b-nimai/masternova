# HLD — High Level Design

Written **incrementally** (`CLAUDE.md` §7.4): update these the week a container or a
cross-context flow first appears, not in a cleanup pass at the end.

| File | Holds |
| --- | --- |
| `00-overview.md` | system context, actors, C4 L1 (context) + L2 (containers) |
| `01-architecture.md` | container responsibilities, deployment topology, sync vs async edges |
| `02-data-flows.md` | signup · upload→playable · checkout→enrolled · playback |
| `03-capacity.md` | back-of-envelope sizing for 100k learners (QPS, storage, bandwidth, cost) |
| `04-failure-modes.md` | what breaks, blast radius, degradation strategy |
| `05-scaling.md` | the 10x split plan + named breaking points |

Diagrams are **Mermaid inside the markdown** — never a screenshot, never image-only.
