const { contextBridge, ipcRenderer } = require('electron')

// Single generic bridge: the page calls window.lively4shell.invoke(channel, ...),
// main validates the channel against its allowlist. Capabilities are added in
// main.js alone, so this file should never need to change again — which matters
// while the shell itself is being live-programmed.
contextBridge.exposeInMainWorld('lively4shell', {
  invoke: (channel, ...args) => ipcRenderer.invoke('lively4shell', channel, ...args)
})
