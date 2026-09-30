# Tip calculator (disposable demo product)

Build a tiny command line tip calculator in Node.js with no runtime dependencies. This exists only to demonstrate the workflow, so keep it small.

## Users

Someone splitting a restaurant bill from a terminal.

## Features

- `tip <bill> [--percent 18] [--people 1]` prints the tip, the total, and the amount per person.
- The default tip is 18 percent.
- Amounts are rounded to the nearest cent, and the per-person amount never loses a cent: if the total does not divide evenly, the first people pay one cent more.

## Out of scope

- A graphical interface, a web page, currency conversion, saving history, publishing to npm.

## Constraints

- Node.js 24 or newer, plain JavaScript or TypeScript, tests with `node:test`.
- No network access, no new dependencies.

## Acceptance criteria

1. `tip 100` prints a tip of 18.00, a total of 118.00 and 118.00 per person.
2. `tip 100 --percent 20 --people 3` prints a tip of 20.00, a total of 120.00 and per-person amounts that add up to exactly 120.00.
3. A negative bill, a non-numeric bill, a percent below 0 or a people count below 1 prints a one-line error and exits with a non-zero code.
4. `npm test` passes and covers each criterion above.
5. A README of at most 20 lines explains usage.
