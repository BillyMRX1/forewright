# ADR 0002: Storage layout

Status: accepted

## Context
State must survive restarts and be easy to inspect and back up, and it must not pollute the user's repository.

## Decision
`FOREWRIGHT_HOME` defaults to `~/Library/Application Support/forewright` on macOS and `$XDG_DATA_HOME/forewright` (or `~/.local/share/forewright`) elsewhere. Each project has `projects/<projectId>/state.db` (SQLite in WAL mode with foreign keys on), `logs/` and `worktrees/`. A global `registry.json` maps project ids to their last known root path and is written atomically. Directories are created with mode 0700. Schema changes are ordered, transactional migrations, and a database newer than the code is refused.

## Consequences
The repository only holds the small `.forewright/project.json` marker, excluded through `.git/info/exclude`. Backups are a copy of one directory.
