'use strict'

const { app, BrowserWindow, dialog, Menu, session, clipboard, shell } = require('electron')
const { APP_ORIGIN, windowOptions } = require('./policy.cjs')

const { guardContents } = require('./guards.cjs')
const { createDiagnostics, showDiagnostics } = require('./diagnostics.cjs')
const diagnostics = createDiagnostics({
  appVersion: app.getVersion(), electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome, platform: process.platform, arch: process.arch, packaged: app.isPackaged,
})

app.enableSandbox()
const { createNativeAuthClient } = require('./native-auth-client.cjs')
const { createNativeSession } = require('./native-session.cjs')
const { createNativeSignInTest } = require('./native-sign-in-test.cjs')
const { PROTOCOL, createCallbackReceiver } = require('./native-protocol.cjs')
// This session is used only by the explicit native acceptance menu, never by the renderer.
let nativeSession = null
let nativeTest = null
let shutdownPromise = null
let shutdownComplete = false
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
  mainWindow.on('closed', () => { mainWindow = undefined; shutdownPromise ||= nativeTest?.dispose() })
  loadHome()
}

function updateNativeMenu() {
  const menu = Menu.getApplicationMenu()
  const running = nativeTest?.status().running === true
  const start = menu?.getMenuItemById('native-test-start')
  const cancel = menu?.getMenuItemById('native-test-cancel')
  if (start) start.enabled = !!nativeTest && !running
  if (cancel) cancel.enabled = running
}

async function reportNativeTest(result) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const messages = {
    verified: ['Desktop sign-in test passed', 'Browser sign-in, return to the desktop app, session refresh and test-session sign-out worked. Your study window still uses its existing account.'],
    failed: ['Desktop sign-in test did not finish', 'Try again from Help. Finish signing in within five minutes and allow your browser to open Quiz From Notes Preview.'],
    cancelled: ['Desktop sign-in test cancelled', 'No test session is kept in the app. Your study window still uses its existing account.'],
    revocation_unconfirmed: ['Test session cleared from this app', 'The server could not confirm test-session sign-out. Reconnect and sign out from your account before using a shared device.'],
  }
  const [message, detail] = messages[result] || messages.failed
  await dialog.showMessageBox(mainWindow, { type: result === 'verified' ? 'info' : 'warning',
    title: 'Desktop sign-in test', message, detail, buttons: ['OK'] })
}

async function runNativeTest() {
  if (!nativeTest || nativeTest.status().running) return
  if (!app.isDefaultProtocolClient(PROTOCOL)) {
    await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Desktop sign-in test',
      message: 'Reinstall this preview to enable returning from your browser.', buttons: ['OK'] })
    return
  }
  await nativeTest.run()
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
  app.whenReady().then(async () => {
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
      { label: 'Help', submenu: [
        { id: 'native-test-start', label: 'Test desktop sign-in…', enabled: false, click: () => { void runNativeTest().catch(() => {}) } },
        { id: 'native-test-cancel', label: 'Cancel desktop sign-in test', enabled: false, click: () => { void nativeTest?.cancel() } },
        { type: 'separator' },
        { label: 'Desktop diagnostics…', click: () => {
        showDiagnostics({ dialog, clipboard, diagnostics }).catch(() => {})
      } }] },
      { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    ]))
    createWindow()
    if (app.isPackaged && process.platform === 'win32') {
      try {
        const config = require('./native-runtime.json')
        if (config.schema !== 1 || Object.keys(config).sort().join(',') !== 'clientId,poolId,schema') throw Error('Invalid native configuration')
        const client = await createNativeAuthClient(config)
        if (!mainWindow || mainWindow.isDestroyed()) return
        nativeSession = createNativeSession({ clientId: config.clientId, client,
          openBrowser: url => shell.openExternal(url) })
        nativeTest = createNativeSignInTest({ session: nativeSession, report: reportNativeTest, changed: updateNativeMenu })
        updateNativeMenu()
      } catch { /* Leave acceptance menu disabled; never log configuration/errors. */ }
    }
    app.on('activate', () => { if (!mainWindow) createWindow() })
  })
  app.on('before-quit', event => {
    if (shutdownComplete || !nativeTest) return
    event.preventDefault()
    shutdownPromise ||= nativeTest.dispose()
    void shutdownPromise.finally(() => { shutdownComplete = true; app.quit() })
  })
  app.on('window-all-closed', () => app.quit())
}
