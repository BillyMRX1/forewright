# ADR 0003: Project identity

Status: accepted

## Context
Sessions and paths change; the project should not. Folders get moved, copied, and checked out as linked worktrees.

## Decision
A marker file `<root>/.dept/project.json` holds `{ id, createdAt, formatVersion }`. Resolution from a directory:

1. In a git repository, use the toplevel and the common git directory. For a linked worktree the main worktree root is the parent of the common directory, and its marker is checked first.
2. Otherwise walk up parent directories looking for a marker, stopping at the home directory and the filesystem root.
3. If nothing is found, the suggested root is the git toplevel or the current directory. Creating a project is an explicit `initProject` call that never overwrites a marker and appends `.dept/` to `.git/info/exclude` once (the user's `.gitignore` is never edited).
4. A moved folder keeps its marker, so the id is stable. On open the registry path is updated and a `project.moved` event is recorded.
5. If the registry's recorded path still exists and carries the same marker id, the new location is a copy and a `DuplicateProjectIdError` is raised with both paths.

## Consequences
Deleting `.dept/` makes a folder a new project. Copying a folder requires removing the marker in the copy, which is reported clearly.
