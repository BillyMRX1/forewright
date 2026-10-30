# Forewright desktop app

A small [Tauri v2](https://tauri.app) shell for macOS and Windows. It does not bundle Node or Forewright: it runs the `forewright` command that is already installed on your computer, then shows the GUI in its own window.

## What it does

- On launch it shows a start page and runs `forewright gui --print-url`. That starts the service if needed and prints the local GUI link. The app checks the link is `http` on `127.0.0.1` or `localhost` with a port, then opens it in the window.
- If that fails (Forewright is not installed, or it could not start) the start page says so, shows the command's error output, and has a "Try again" button.
- Links to other websites open in your default browser, never inside the app window.
- Desktop notifications use the system notification centre. The GUI page can use only the notification calls, nothing else of the app.
- "Open at Login" in the app menu (macOS) or the window menu (Windows) turns starting at login on and off.
- Closing the window quits the app. The Forewright service keeps running in the background, as it does when you use the browser.

Needs Forewright installed with npm, for example `npm install -g forewright`. If the app cannot find it, set `FOREWRIGHT_BIN` to the full path of the `forewright` command before opening the app. On macOS the command is run through your login shell (`$SHELL -l`, `/bin/zsh` by default) because apps opened from the Dock do not get your shell PATH.

## Build locally

You need Node 24 and a Rust toolchain ([rustup](https://rustup.rs)), plus the Tauri system requirements for your OS (Xcode command line tools on macOS, Microsoft C++ Build Tools and WebView2 on Windows).

```
npm --prefix desktop ci
npm --prefix desktop run tauri -- build
```

The installer lands in `desktop/src-tauri/target/release/bundle/` (a `.dmg` on macOS, an NSIS `.exe` on Windows). For a development window use `npm --prefix desktop run tauri -- dev`.

The desktop app installs its own dependencies with npm and its own `package-lock.json`, apart from the main project. The root `pnpm install` and `pnpm test` never download Tauri or compile Rust.

## Installers are unsigned

CI (`.github/workflows/desktop.yml`) builds the installers and attaches them to the run as artifacts. They are not code signed yet, so the system warns on first open.

- macOS: open the `.dmg`, drag Forewright to Applications, then right click the app and choose Open, and confirm. If macOS still refuses, open System Settings, Privacy and Security, and choose "Open Anyway" for Forewright.
- Windows: in the SmartScreen window click "More info", then "Run anyway".
