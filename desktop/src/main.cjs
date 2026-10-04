'use strict'

const { app, BrowserWindow, dialog, Menu, session, clipboard, shell, ipcMain, Notification, safeStorage } = require('electron')
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
const { createNativeReminders } = require('./native-reminders.cjs')
const { createNativeAccount } = require('./native-account.cjs')
const { createAccountSnapshots } = require('./account-snapshots.cjs')
const { createWindowsSnapshotStore } = require('./windows-snapshot-store.cjs')
const { createWindowsSourceTextStore } = require('./windows-source-text-store.cjs')
const { createAccountSourceTextCache } = require('./account-source-text-cache.cjs')
const { createWindowsLocalAiStack } = require('./windows-local-ai-stack.cjs')
const { createSnapshotMenu } = require('./snapshot-menu.cjs')
const { createOfflineReader } = require('./offline-reader.cjs')
const { createOfflineMenu } = require('./offline-menu.cjs')
const { installNativeBridge } = require('./native-bridge.cjs')
const path = require('node:path')
const { createNativeSignInTest } = require('./native-sign-in-test.cjs')
const { createUpdates, loadApprovedConfiguration } = require('./updates.cjs')
let updates
let updateTimer
const storeManaged = process.platform === 'win32' && process.windowsStore === true
const { PROTOCOL, createCallbackReceiver } = require('./native-protocol.cjs')
// Main-process study session; the acceptance test uses a separate session.
let nativeSession = null
let testSession = null
let nativeAccount = null
let snapshotMenu = null
let snapshotStore = null
let sourceTextStore = null
let sourceTextCache = null
let offlineMenu = null
let reminders = null
let reminderTimer = null
let nativeTest = null
let localAiManager = null
let shutdownPromise = null
let shutdownComplete = false
const receiveCallback = createCallbackReceiver({ getSession: () => nativeTest?.status().running ? testSession : nativeSession, focus: focusWindow })
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
      detail: 'You can open a library previously enabled for offline study on this Windows profile.',
      buttons: ['Retry', 'Offline study', 'Close'], defaultId: 0, cancelId: 2,
    })
    if (response === 0) setImmediate(() => loadHome())
    else if (response === 1) await offlineMenu?.open()
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

async function disposeSessions() {
  offlineMenu?.clear()
  clearInterval(reminderTimer)
  reminders?.dispose()
  nativeAccount?.clear()
  await Promise.allSettled([nativeTest?.dispose(), nativeSession?.signOut(), localAiManager?.dispose()])
}

function loadHome() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(APP_ORIGIN).catch(() => reportFailure())
  }
}

function createWindow() {
  const options = windowOptions()
  if (app.isPackaged && process.platform === 'win32') options.webPreferences.preload = path.join(__dirname, 'preload.cjs')
  mainWindow = new BrowserWindow(options)
  const contents = mainWindow.webContents
  guardContents(contents)
  diagnostics.attach(contents)
  contents.on('render-process-gone', () => reportFailure())
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = undefined; shutdownPromise ||= disposeSessions() })
  loadHome()
}

function updateMenu() {
  const item = Menu.getApplicationMenu()?.getMenuItemById('desktop-updates')
  if (!item || !updates) return
  const { phase, progress, busy } = updates.status()
  item.enabled = !busy
  item.label = phase === 'ready' ? 'Restart to update…' : phase === 'checking' ? 'Checking for updates…' :
    phase === 'downloading' ? `Downloading update… ${progress}%` : 'Check for updates…'
}

async function updatePrompt(kind) {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const copy = {
    restart: ['An update is ready', 'Finish and save your work first. Restart now to update this installed app?', ['Restart and update', 'Later']],
    current: ['You’re up to date', 'No newer desktop release is available.', ['OK']],
    error: ['Could not update the app', 'Your current version is still available. Check your connection and try again later.', ['OK']],
    unavailable: ['Automatic updates are not enabled in this preview', 'An update-enabled signed release is needed once. Future releases can then update this installation.', ['OK']],
  }
  const [message, detail, buttons] = copy[kind]
  const result = await dialog.showMessageBox(mainWindow, { title: 'Quiz From Notes updates',
    type: kind === 'error' ? 'warning' : 'info', message, detail, buttons,
    defaultId: kind === 'restart' ? 1 : 0, cancelId: kind === 'restart' ? 1 : 0 })
  return kind === 'restart' && result.response === 0
}

function formatLocalModelSize(value) {
  if (!Number.isSafeInteger(value) || value < 1) return null
  return (value / 1024 ** 3).toFixed(1) + ' GB'
}

async function confirmLocalAiDownload(status) {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const size = formatLocalModelSize(status?.capability?.requirements?.modelBytes)
  const metadata = status?.model?.metadata
  const label = metadata?.displayName ?? 'experimental Local AI model'
  const license = metadata?.license ? ` under ${metadata.license}` : ''
  const source = metadata?.repository ? ` Source: ${metadata.repository}.` : ''
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Download Local AI model',
    message: `Download ${label}${size ? ` (${size})` : ''}?`,
    detail: `This optional model is distributed${license}.${source} Downloading it does not by itself enable Local AI generation.`,
    buttons: ['Download', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  return response === 0
}

async function confirmLocalAiRemoval() {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Remove Local AI model',
    message: 'Remove the downloaded Local AI model from this Windows profile?',
    detail: 'Study decks, offline reviews, and account data are not removed.',
    buttons: ['Remove model', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  return response === 0
}

async function showStoreUpdates() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  await dialog.showMessageBox(mainWindow, { type: 'info', title: 'Quiz From Notes updates',
    message: 'Microsoft Store manages updates for this app.',
    detail: 'Open Microsoft Store to check for app updates. Automatic updates follow your Store settings.',
    buttons: ['OK'] })
}

function updateNativeMenu() {
  const menu = Menu.getApplicationMenu()
  const running = nativeTest?.status().running === true
  const start = menu?.getMenuItemById('native-test-start')
  const cancel = menu?.getMenuItemById('native-test-cancel')
  if (start) start.enabled = !!nativeTest && !running && !nativeSession?.status().signingIn
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
  if (!nativeTest || nativeTest.status().running || nativeSession?.status().signingIn) return
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
        { id: 'snapshot-save', label: 'Save for offline study…', enabled: false, click: () => { void snapshotMenu?.('save').catch(() => {}) } },
        { id: 'snapshot-sync', label: 'Sync offline reviews…', enabled: false, click: () => { void snapshotMenu?.('sync').catch(() => {}) } },
        { id: 'snapshot-remove', label: 'Remove local study copy…', enabled: false, click: () => { void snapshotMenu?.('remove').catch(() => {}) } },
        { id: 'offline-open', label: 'Open offline study…', enabled: false, click: () => { void offlineMenu?.open().catch(() => {}) } },
        { role: 'quit' },
      ] },
      { role: 'editMenu' },
      { label: 'Help', submenu: [
        { id: 'desktop-updates', label: storeManaged ? 'Updates through Microsoft Store…' : 'Check for updates…',
          click: () => { void (storeManaged ? showStoreUpdates() : updates?.check(true))?.catch(() => {}) } },
        { id: 'native-test-start', label: 'Test desktop sign-in…', enabled: false, click: () => { void runNativeTest().catch(() => {}) } },
        { id: 'native-test-cancel', label: 'Cancel desktop sign-in test', enabled: false, click: () => { void nativeTest?.cancel() } },
        { type: 'separator' },
        { label: 'Desktop diagnostics…', click: () => {
        showDiagnostics({ dialog, clipboard, diagnostics }).catch(() => {})
      } }] },
      { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    ]))
    installNativeBridge({ ipcMain, getWindow: () => mainWindow,
      getSession: () => nativeSession, getAccount: () => nativeAccount, getReminders: () => reminders,
      getLocalAi: () => localAiManager,
      getSourceTextCache: () => sourceTextCache,
      confirmLocalAiDownload,
      confirmLocalAiRemoval,
      canSignIn: () => !nativeTest?.status().running,
      openAccountWebsite: () => shell.openExternal(APP_ORIGIN + '/settings/security') })
    createWindow()
    if (app.isPackaged && process.platform === 'win32') {
      snapshotStore = createWindowsSnapshotStore({ app, safeStorage, platform: process.platform })
      sourceTextStore = createWindowsSourceTextStore({ app, safeStorage, platform: process.platform })
      const runtimeDirectory =
        typeof process.resourcesPath === 'string'
          ? path.join(process.resourcesPath, 'local-ai-runtime')
          : undefined
      localAiManager = createWindowsLocalAiStack({
        userDataDirectory: app.getPath('userData'),
        ...(runtimeDirectory ? { runtimeDirectory } : {}),
      })
      offlineMenu = createOfflineMenu({ store: snapshotStore, reader: createOfflineReader({ BrowserWindow, session }),
        dialog, getWindow: () => mainWindow })
      Menu.getApplicationMenu().getMenuItemById('offline-open').enabled = true
    }
    let updater = null
    if (!storeManaged && app.isPackaged && process.platform === 'win32' && loadApprovedConfiguration(process.resourcesPath)) {
      updater = require('electron-updater').autoUpdater
    }
    updates = createUpdates({ updater, prompt: updatePrompt, changed: updateMenu,
      beforeInstall: async () => {
        shutdownPromise ||= disposeSessions()
        await shutdownPromise
        shutdownComplete = true
      } })
    if (updater) {
      // Check once after startup and then every four hours; never restart on quit.
      const schedule = delay => {
        updateTimer = setTimeout(async () => {
          await updates.check().catch(() => {})
          if (mainWindow && !mainWindow.isDestroyed()) schedule(4 * 60 * 60 * 1000)
        }, delay)
        updateTimer.unref()
      }
      schedule(20000)
    }
    if (app.isPackaged && process.platform === 'win32') {
      try {
        const config = require('./native-runtime.json')
        if (config.schema !== 1 || Object.keys(config).sort().join(',') !== 'clientId,poolId,schema') throw Error('Invalid native configuration')
        const client = await createNativeAuthClient(config)
        if (!mainWindow || mainWindow.isDestroyed()) return
        nativeSession = createNativeSession({ clientId: config.clientId, client,
          openBrowser: url => shell.openExternal(url), onChange: () => {
            if (!nativeSession?.status().signedIn) { nativeAccount?.clear(); reminders?.clear(); offlineMenu?.clear(); void localAiManager?.cancelDownload() }
            updateNativeMenu()
          } })
        nativeAccount = createNativeAccount({ session: nativeSession })
        sourceTextCache = createAccountSourceTextCache({
          account: nativeAccount,
          store: sourceTextStore,
        })
        snapshotMenu = createSnapshotMenu({ account: nativeAccount,
          snapshots: createAccountSnapshots({ account: nativeAccount, store: snapshotStore }),
          dialog, getWindow: () => mainWindow, changed: () => offlineMenu?.clear() })
        for (const id of ['snapshot-save', 'snapshot-remove', 'snapshot-sync']) Menu.getApplicationMenu().getMenuItemById(id).enabled = true
        if (!storeManaged) app.setAppUserModelId('com.quizfromnotes.desktop.preview')
        reminders = createNativeReminders({ account: nativeAccount, supported: () => Notification.isSupported(),
          show: options => {
            const notification = new Notification(options)
            notification.on('click', focusWindow)
            notification.on('failed', () => {})
            notification.show()
            return notification
          } })
        reminderTimer = setInterval(() => { void reminders.tick() }, 60000)
        reminderTimer.unref()
        testSession = createNativeSession({ clientId: config.clientId, client,
          openBrowser: url => shell.openExternal(url) })
        nativeTest = createNativeSignInTest({ session: testSession, report: reportNativeTest, changed: updateNativeMenu })
        updateNativeMenu()
      } catch { /* Leave acceptance menu disabled; never log configuration/errors. */ }
    }
    app.on('activate', () => { if (!mainWindow) createWindow() })
  })
  app.on('before-quit', event => {
    clearTimeout(updateTimer)
    updates?.dispose()
    if (shutdownComplete || (!nativeTest && !nativeSession)) return
    event.preventDefault()
    shutdownPromise ||= disposeSessions()
    void shutdownPromise.finally(() => { shutdownComplete = true; app.quit() })
  })
  app.on('window-all-closed', () => app.quit())
}
