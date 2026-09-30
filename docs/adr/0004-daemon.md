# ADR 0004: One user-level daemon

Status: accepted

## Context
Closing the terminal UI must not stop workers or lose state, and several projects may be active at once.

## Decision
`dept serve` runs one daemon per user. It owns execution and persistence for all projects and listens on `DEPT_HOME/dept.sock` (directory 0700, socket 0600). Clients must present the token in `DEPT_HOME/client.token` (0600) during the handshake. The protocol is newline-delimited JSON-RPC 2.0 with a `subscribe` method that streams events. The TUI is a client and reconnects after interruptions.

## Consequences
The daemon can be run in the foreground or managed by launchd. Work does not continue while the Mac sleeps, and the docs say so.
