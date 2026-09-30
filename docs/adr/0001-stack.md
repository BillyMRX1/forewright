# ADR 0001: Stack

Status: accepted

## Context
The product is a small local service with a terminal client. The owner works on macOS with Node already installed. The brief asks for a small dependency footprint and a mature TUI library.

## Decision
TypeScript on Node 24 or newer (developed on 26), `node:sqlite` for authoritative state, Ink 7 with React 19 for the TUI, and `node:test` for tests. Everything else uses Node built-ins. TypeScript is compiled with `module: NodeNext`, so relative imports end in `.js`.

## Consequences
No native addons to build. `node:sqlite` is still marked experimental in some Node lines, so the minimum Node version is pinned in `engines`. Ink and React are the only runtime dependencies.
