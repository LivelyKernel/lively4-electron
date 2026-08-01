@echo off
REM ============================================================================
REM  Double-click to launch the Lively4 Electron shell.
REM
REM  Runs the electron script IN PLACE (main.js stays live-editable, not packaged).
REM  - Reuses a running lively4-server, or cold-starts one if none is up.
REM  - Spawns the local whisper voice service if it's installed.
REM  Closing the window tears down whisper (its whole tree); the lively4-server is
REM  left running on purpose — it's live-codeable and holds the world + MCP.
REM ============================================================================
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed in this folder.
  echo Run once:   npm install
  echo.
  pause
  exit /b 1
)
REM start "" detaches so this console closes immediately; electron keeps running.
start "" "node_modules\electron\dist\electron.exe" .
