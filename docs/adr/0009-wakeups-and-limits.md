# ADR 0009: Wakeups and limits

Status: accepted

## Context
Repeated model calls when nothing changed waste quota and money, and unbounded loops are a reliability risk.

## Decision
The CTO wakes only on a human message to the CTO, a worker completion or failure, a decision resolution, or a scope approval. Pending items are batched into its mailbox and delivered at the next turn boundary. A watchdog (default every 15 seconds) checks leases, process liveness (pid plus OS start time) and timeouts without calling a model. Default limits, configurable per project: 2 concurrent workers, 40 turns per run, 30 minute run timeout, 2 retries per task, 2 repair loops, 20 CTO wakeups per hour, 30 messages per thread per hour. Agent message rates are enforced in the store.

## Consequences
Limits are visible in Settings and exhausted recovery becomes a visible block, never a silent loop.
