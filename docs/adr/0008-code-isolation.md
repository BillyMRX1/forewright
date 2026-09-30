# ADR 0008: Code isolation and integration

Status: accepted

## Context
Parallel workers must not trample each other's files, and merged work must be verified together.

## Decision
Each task gets a git branch and worktree under `FOREWRIGHT_HOME/projects/<id>/worktrees/<taskShort>-g<gen>`. One integration queue merges reviewed work into a `forewright/integration` branch and re-runs the checks there. An independent agent reviews each candidate. Evidence is bound to the candidate commit, the task revision and the requirement revision. Merging into the owner's own branch is an inbox decision unless policy allows it. Non-git folders are planning only: code tasks stay blocked with reason `environment` and the inbox offers `git init`, run only after approval.

## Consequences
Worktrees are not an OS security sandbox, and the docs say so. Recovery must never delete a worktree that holds unfinished work.
