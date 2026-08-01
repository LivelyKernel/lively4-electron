const { app, BrowserWindow, session, screen, desktopCapturer, ipcMain } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')

const LIVELY_URL = 'http://localhost:9005/lively4-core/start.html'
const SERVER_ORIGIN = 'http://localhost:9005'
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const SERVER_SCRIPT = 'lively4-server/bin/lively4W1.sh'
// The shell lives at <parent>/lively4-electron; the world at <parent>/lively4.
// Derive rather than hardcode so a clone runs anywhere. Override with LIVELY_DIR
// in the environment if the checkout is laid out differently.
const LIVELY_DIR = process.env.LIVELY_DIR || path.resolve(__dirname, '..', 'lively4')

// The local whisper.cpp voice service (optional). Sibling of lively4/, outside
// the served root. Started only when installed and not already running; voice
// transcription degrades gracefully (OpenAI whisper / Web Speech) when absent.
const WHISPER_DIR = process.env.WHISPER_DIR || path.resolve(LIVELY_DIR, '..', 'whisper')
const WHISPER_EXE = path.join(WHISPER_DIR, 'whisper-bin', 'Release', 'whisper-server.exe')
const WHISPER_MODEL = path.join(WHISPER_DIR, 'ggml-large-v3-turbo-q5_0.bin')
const WHISPER_ORIGIN = 'http://127.0.0.1:8080'

// --- switches that must be set before app is ready ------------------------

// Fixed CDP port so chrome-devtools-mcp can attach with --browserUrl. A property
// of the app rather than a launch flag nobody remembers to pass.
app.commandLine.appendSwitch('remote-debugging-port', '9222')

// Profile lives outside the repo tree. lively4-server serves and file-watches
// the PARENT of lively4-core, and a Chromium profile is high-churn (cache,
// LevelDB, logs) — it must not be reachable by either.
// Created eagerly: the DevTools handler writes DevToolsActivePort before
// Electron would create the directory itself, and errors if it is missing.
const USER_DATA = path.join(app.getPath('appData'), '..', 'Local', 'lively4-electron')
fs.mkdirSync(USER_DATA, { recursive: true })
app.setPath('userData', USER_DATA)

let serverProcess = null
let whisperProcess = null

// --- lively4-server child -------------------------------------------------

function serverIsUp() {
  return new Promise(resolve => {
    const req = http.get(SERVER_ORIGIN + '/lively4-core/package.json', res => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.setTimeout(1500, () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

// The wrapper owns the restart loop (watch.sh + SIGUSR1), so we only launch it.
// Never re-implement restart here: lively-mcp reconnects 3s after ws close, so
// the ~2s outage is already transparent to the page.
async function startServer() {
  if (await serverIsUp()) {
    console.log('[shell] lively4-server already running — not spawning')
    return
  }
  serverProcess = spawn(GIT_BASH, [SERVER_SCRIPT], {
    cwd: LIVELY_DIR,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  serverProcess.stdout.on('data', d => process.stdout.write('[server] ' + d))
  serverProcess.stderr.on('data', d => process.stderr.write('[server] ' + d))
  serverProcess.on('exit', code => console.log('[shell] server wrapper exited', code))

  // Cold start has been observed taking ~14s here, so wait generously — a
  // premature loadURL just yields ERR_CONNECTION_REFUSED and a blank window.
  for (let i = 0; i < 240; i++) {
    if (await serverIsUp()) return console.log('[shell] lively4-server up')
    await new Promise(r => setTimeout(r, 250))
  }
  console.warn('[shell] server did not answer within 60s — loading anyway')
}

// --- whisper.cpp voice service (optional) ---------------------------------

function whisperIsUp() {
  return new Promise(resolve => {
    const req = http.get(WHISPER_ORIGIN + '/', res => { res.resume(); resolve(true) })
    req.setTimeout(1200, () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

// Launch the local whisper server if installed and not already up. cwd is the
// Release dir so its CUDA/cuBLAS DLLs resolve. Fire-and-forget — the window
// never waits on it, and a missing install is a skip, not an error.
async function startWhisper() {
  if (await whisperIsUp()) {
    console.log('[shell] whisper already running — not spawning')
    return
  }
  if (!fs.existsSync(WHISPER_EXE) || !fs.existsSync(WHISPER_MODEL)) {
    console.log('[shell] whisper not installed — skipping (voice will fall back)')
    return
  }
  whisperProcess = spawn(WHISPER_EXE, ['-m', WHISPER_MODEL, '--host', '127.0.0.1', '--port', '8080'], {
    cwd: path.dirname(WHISPER_EXE),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  whisperProcess.stdout.on('data', d => process.stdout.write('[whisper] ' + d))
  whisperProcess.stderr.on('data', d => process.stderr.write('[whisper] ' + d))
  whisperProcess.on('exit', code => { console.log('[shell] whisper exited', code); whisperProcess = null })
  console.log('[shell] whisper starting (GPU model load ~2-3s)')
}

// --- capability bridge ----------------------------------------------------

// window.lively4shell.invoke(channel, ...) lands here. Unknown channels throw
// rather than silently resolving, so a typo surfaces immediately in the page.
const handlers = {
  // getDisplayMedia needs transient user activation even when auto-approved, so
  // it can never be driven from evaluate-code. desktopCapturer has no such
  // requirement — this is what makes unattended screenshots possible at all.
  async 'capture-screen'() {
    const display = screen.getPrimaryDisplay()
    const { width, height } = display.size
    const scale = display.scaleFactor
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) }
    })
    if (!sources.length) throw new Error('no screen sources')
    const image = sources[0].thumbnail
    const size = image.getSize()
    return { width: size.width, height: size.height, png: image.toPNG() }
  }
}

ipcMain.handle('lively4shell', async (event, channel, ...args) => {
  const handler = handlers[channel]
  if (!handler) throw new Error(`lively4shell: channel not allowed: ${channel}`)
  return handler(...args)
})

// --- window ---------------------------------------------------------------

function configurePermissions() {
  const s = session.defaultSession
  // Microphone, granted at app level so voice capture never prompts.
  s.setPermissionRequestHandler((wc, permission, callback) => callback(permission === 'media'))
  s.setPermissionCheckHandler((wc, permission) => permission === 'media')
  // Any page-initiated getDisplayMedia() resolves without a picker. Kept as the
  // documented fallback path even though capture-screen above is preferred.
  s.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then(sources => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback({}))
  }, { useSystemPicker: false })
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.maximize()
  win.once('ready-to-show', () => win.show())

  // Retry rather than reject: the server may still be binding, and an unhandled
  // rejection here leaves a blank window with no route back.
  for (let attempt = 1; ; attempt++) {
    try {
      await win.loadURL(LIVELY_URL)
      return
    } catch (err) {
      if (attempt >= 10) {
        console.error('[shell] could not load', LIVELY_URL, '-', err.message)
        return
      }
      console.warn(`[shell] load failed (${err.code || err.message}), retry ${attempt}`)
      await new Promise(r => setTimeout(r, 1000))
    }
  }
}

// A second instance cannot bind the CDP port or the profile, and produces
// confusing "address in use" / "cache access denied" errors rather than a
// clear failure. Hand off to the running one instead.
if (!app.requestSingleInstanceLock()) {
  console.log('[shell] another instance is already running — exiting')
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) { if (win.isMinimized()) win.restore(); win.focus() }
  })

  app.whenReady().then(async () => {
    configurePermissions()
    await startServer()
    startWhisper()          // fire-and-forget: warms up while the window loads
    await createWindow()
  })
}

app.on('window-all-closed', () => app.quit())

// Kill a spawned child and its whole tree (taskkill /T) so no node/bash/helper
// orphans linger after the shell exits.
function killTree(proc) {
  if (!proc || proc.killed) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'])
    else proc.kill()
  } catch (e) { /* already gone */ }
}

// On close, tear down only what the shell OWNS as a disposable resource: whisper.
// The lively4-server is deliberately NOT killed — it is live-codeable (self-
// restarts, holds the world + MCP session), so it persists across shell restarts.
// Start it once and relaunch the shell freely without a cold server start.
app.on('quit', () => {
  killTree(whisperProcess)
})
