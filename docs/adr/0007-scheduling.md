# ADR 0007: Scheduling, leases and fencing

Status: accepted

## Context
Two dispatch attempts must not run the same task, and a slow or replaced worker must not overwrite newer work.

## Decision
One scheduler per project runs inside the daemon with an in-process queue, and SQLite is authoritative. A claim is a single conditional UPDATE inside a transaction that sets the lease owner and expiry and increments the task generation. Every run carries the generation. Reassignment, reclaiming an expired lease and repair increment it. A result whose generation is not current is rejected with `StaleGenerationError` and recorded as a `run.fenced` event before the error is raised.

## Consequences
Correctness does not depend on process timing. The runtime must treat a fenced run as abandoned and stop its process.
