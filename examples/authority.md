# Authority settings

`authority.json` shows the default authority for a project. JSON cannot hold comments, so each field is explained here. Change them in Settings (`8`); only you can, and agents can never change them.

| Field | Values | Meaning |
|---|---|---|
| `autoLocalEdits` | true or false | Agents may edit files in their own task worktree without asking. |
| `autoChecks` | true or false | Agents may run the verify commands of a task without asking. |
| `autoIntegrateToForewrightBranch` | true or false | Reviewed work is merged into the `forewright/integration` branch automatically. |
| `mergeToUserBranch` | `ask`, `auto`, `deny` | What happens when integrated work should reach your own branch. `ask` creates an Inbox decision. |
| `publish` | `ask`, `auto`, `deny` | Pushing, releasing or anything visible outside your Mac. Keep this on `ask`. |
| `destructive` | `ask`, `auto`, `deny` | Deleting branches or files outside a task worktree, force operations. Keep this on `ask`. |
| `spendLimitUsd` | number, 0 or more | Budget for pay-per-token API usage. 0 means no API spend. |
| `allowApiBilling` | true or false | Lets agent environments keep API keys. Off means keys are stripped and only your subscription logins are used. |

A stricter example: set `autoIntegrateToForewrightBranch` to false to review every integration yourself, and `mergeToUserBranch` to `deny` to keep Forewright's work on its own branch until you merge by hand.

Note: `autoLocalEdits`, `autoChecks` and `allowApiBilling` are stored but not enforced in this version. See Known limitations in the README.
