'use strict'

const { app, BrowserWindow, dialog, Menu, session, clipboard } = require('electron')
const { APP_ORIGIN, windowOptions } = require('./policy.cjs')

const { guardContents } = require('./guards.cjs')
const { createDiagnostics, showDiagnostics } = require('./diagnostics.cjs')
const diagnostics = createDiagnostics({
  appVersion: app.getVersion(), electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome, platform: process.platform, arch: process.arch, packaged: app.isPackaged,
})

app.enableSandbox()
const { createCallbackReceiver } = require('./native-protocol.cjs')
// The native session is attached only after the reviewed login integration.
let nativeSession = null
const receiveCallback = createCallbackReceiver({ getSession: () => nativeSession, focus: focusWindow })
let mainWindow
let showingFailure = false

async function reportFailure() {
  if (showingFailure || !mainWindow || mainWindow.isDestroyed()) return
  showingFailure = true
  try {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Unable to open Quiz From Notes',
      message: 'Check your internet connection and try again.',
      detail: 'This preview requires an internet connection. Your saved decks remain in your account.',
      buttons: ['Retry', 'Close'], defaultId: 0, cancelId: 1,
    })
    if (response === 0) setImmediate(() => loadHome())
    else app.quit()
  } finally {
    showingFailure = false
  }
}

function focusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function loadHome() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(APP_ORIGIN).catch(() => reportFailure())
  }
}

function createWindow() {
  mainWindow = new BrowserWindow(windowOptions())
  const contents = mainWindow.webContents
  guardContents(contents)
  diagnostics.attach(contents)
  contents.on('render-process-gone', () => reportFailure())
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = undefined })
  loadHome()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    void receiveCallback(argv)
    focusWindow()
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    void receiveCallback([url])
  })
  // Cold callbacks cannot match a prior process's private PKCE transaction.
  void receiveCallback(process.argv)
  app.whenReady().then(() => {
    const browserSession = session.fromPartition('quiz-from-notes-preview')
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.on('will-download', event => event.preventDefault())
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Quiz From Notes', submenu: [
        { label: 'Home', click: loadHome },
        { role: 'quit' },
      ] },
      { role: 'editMenu' },
      { label: 'Help', submenu: [{ label: 'Desktop diagnostics…', click: () => {
        showDiagnostics({ dialog, clipboard, diagnostics }).catch(() => {})
      } }] },
      { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    ]))
    createWindow()
    app.on('activate', () => { if (!mainWindow) createWindow() })
  })
  app.on('window-all-closed', () => app.quit())
}
