# Example roles

Role, engine, model and permission are separate settings. Change any of them for an agent in the Team view (`6`, `Enter`). Model names depend on what your installed CLI offers; Settings shows the list per engine.

| Role | Engine | Model | Permission | Why |
|---|---|---|---|---|
| CTO | claude | strongest available | coordinator | Planning and coordination need judgment, and the CTO never edits code directly. |
| backend | codex | default | workspace_write | Implements features in its own worktree. |
| frontend | claude | mid-tier | workspace_write | Good fit for UI work without paying for the top model on every task. |
| testing | codex | default | workspace_write | Writes and runs tests. Should differ from the author of the code it reviews. |
| review | claude | mid-tier | read_only | Reads the diff and the checks, cannot change files, so its verdict is independent. |
| docs | claude | small or fast | workspace_write | Documentation rarely needs the most expensive model. |
| integration | codex | default | workspace_write | Resolves merge conflicts on the integration branch. |

Rules of thumb:

- A reviewer should not be the agent that wrote the code. The runtime enforces a different agent, and using a different engine as well gives a more independent second opinion.
- Start with a small team. The CTO hires specialists when the work needs them.
- Read-only permission is the safe default for anything that only needs to look.
- Do not assume the biggest model deserves every task. Reassign to a cheaper agent for routine work.
