'use strict'
// Runs under real Electron on Windows CI; never contacts production.
const assert = require('node:assert/strict')
const { app, BrowserWindow, safeStorage, clipboard } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createWindowsSnapshotStore } = require('../src/windows-snapshot-store.cjs')
const { snapshotDeck } = require('./snapshot-fixture.cjs')
const { windowOptions } = require('../src/policy.cjs')
const { guardContents } = require('../src/guards.cjs')
const { createDiagnostics } = require('../src/diagnostics.cjs')
app.enableSandbox()
let stage = 'app readiness'
const timeout = setTimeout(() => { console.error(`Desktop smoke timed out at ${stage}`); app.exit(1) }, 20000)
app.whenReady().then(async () => {
  const window = new BrowserWindow(windowOptions())
  guardContents(window.webContents)
  const diagnostics = createDiagnostics({ appVersion: '0.1.0', electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome, platform: process.platform, arch: process.arch, packaged: false })
  diagnostics.attach(window.webContents)
  stage = 'loading synthetic page'
  await window.loadURL('data:text/html,<h1>Desktop security smoke</h1>')
  stage = 'native diagnostics and clipboard'
  assert.equal(JSON.parse(diagnostics.report()).pageLoads, 1)
  await clipboard.writeText(diagnostics.report())
  assert.equal(await clipboard.readText(), diagnostics.report())
  clipboard.clear()
  stage = 'renderer isolation and popup'
  const result = await window.webContents.executeJavaScript(`({
    node: typeof require, process: typeof process,
    popup: window.open('https://example.com') === null
  })`)
  assert.deepEqual(result, { node: 'undefined', process: 'undefined', popup: true })
  stage = 'blocked frame navigation'
  // The frame guard cancels first, so will-navigate may never fire.
  const blocked = new Promise(resolve => window.webContents.once('will-frame-navigate', event => {
    assert.equal(event.defaultPrevented, true)
    resolve()
  }))
  await window.webContents.executeJavaScript("window.location.href = 'https://example.com'")
  await blocked
  assert.match(window.webContents.getURL(), /^data:/)
  stage = 'Windows encrypted snapshot round trip'
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-dpapi-smoke-'))
  try {
    const store = createWindowsSnapshotStore({
      app: { isReady: () => app.isReady(), getPath: () => directory }, safeStorage,
    })
    const decks = [snapshotDeck()]
    await store.save('synthetic-owner', decks)
    assert.deepEqual((await store.load('synthetic-owner')).decks, decks)
    const files = await fs.readdir(path.join(directory, 'study-snapshots-v1'))
    const encrypted = await fs.readFile(path.join(directory, 'study-snapshots-v1', files[0]))
    assert.equal(encrypted.includes(Buffer.from('Private study notes')), false)
    await store.remove('synthetic-owner')
    assert.equal(await store.load('synthetic-owner'), null)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
  window.destroy()
  clearTimeout(timeout)
  console.log('Real Electron smoke passed: isolated renderer, blocked popup/navigation, Windows encrypted snapshots, local diagnostics/clipboard')
  app.exit(0)
}).catch(error => {
  console.error(error.message)
  clearTimeout(timeout)
  app.exit(1)
})
