# <Feature> — Low Level Design

> **One-liner:** what this module is responsible for, in a single sentence.

**Module:** `apps/api/src/modules/<x>` · **Status:** draft | built | hardened
**Last updated:** YYYY-MM-DD

## 1. Problem

What are we solving, and for whom. One paragraph.

## 2. Forces

Why this is not trivial. Name them explicitly: concurrency · retries · money ·
multiple actors · partial failure · write volume · external system you don't control.

## 3. Domain model

Entities, their invariants ("an order can never leave PAID without an enrollment"),
and legal states.

## 4. Class design

```mermaid
classDiagram
  %% interfaces, implementations, injection tokens
```

## 5. Main flow

```mermaid
sequenceDiagram
  %% the happy path, then the interesting failure path
```

## 6. Patterns used

| Pattern | Where | The force that justified it |
| ------- | ----- | --------------------------- |

## 7. Alternatives rejected

| Option | Why not |
| ------ | ------- |

## 8. Failure modes

| Failure | How it is detected | Behaviour | Recovery |
| ------- | ------------------ | --------- | -------- |

## 9. Data & indexes

Tables touched, the indexes that serve them, and the transaction boundaries.

## 10. Tests that prove it

Name the specific tests, especially the idempotency / concurrency ones.

## 11. Interview notes — 60-second recall

The compressed version: the problem, the one design decision that mattered,
and the number that proves it works.

<!--
Section 11 is the highest-value part of this file. Write it LAST, keep it to genuinely
sixty seconds, and keep it in the same shape as the LLD/0. Index.md notes so revision
feels familiar. Do not improvise the shape of this document per module — a fixed
structure is what lets six of these be re-read in twenty minutes.
-->
