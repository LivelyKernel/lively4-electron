# lively4-electron

An Electron shell for [Lively4](https://github.com/LivelyKernel/lively4-core) — it
loads the live world in a desktop window with a few things a plain browser tab
can't offer:

- **Fixed remote-debugging port** (`9222`) for CDP tooling.
- **Picker-free screen capture** via `desktopCapturer` — no permission dialog.
- **App-level microphone permission** (for voice input).
- A dedicated Chromium profile, kept outside the served directory.
- A small `window.lively4shell.invoke(channel, …)` bridge to main-process
  capabilities (currently `capture-screen`).

It does **not** reimplement the server or its live-reload — it just spawns the
existing `lively4-server` launcher, which owns the file-watch + restart loop.

## Prerequisites

- [`lively4-core`](https://github.com/LivelyKernel/lively4-core) and
  [`lively4-server`](https://github.com/LivelyKernel/lively4-server) checked out
  together under one parent directory.
- Node.js and Git Bash (Windows).

## Run

```sh
npm install
npm start
```

On launch the shell starts `lively4-server` (via `bin/lively4W1.sh`) if it isn't
already running, waits for `http://localhost:9005`, then opens the world.

## Configuration

Paths are currently set for a `C:\Users\Stefan\lively\lively4` layout in
`main.js` (`LIVELY_DIR`, server script) — adjust these for your checkout.
