'use strict'
// Runs under real Electron on Windows CI; never contacts production.
const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { windowOptions } = require('../src/policy.cjs')
const { guardContents } = require('../src/guards.cjs')
app.enableSandbox()
let stage = 'app readiness'
const timeout = setTimeout(() => { console.error(`Desktop smoke timed out at ${stage}`); app.exit(1) }, 20000)
app.whenReady().then(async () => {
  const window = new BrowserWindow(windowOptions())
  guardContents(window.webContents)
  stage = 'loading synthetic page'
  await window.loadURL('data:text/html,<h1>Desktop security smoke</h1>')
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
  window.destroy()
  clearTimeout(timeout)
  console.log('Real Electron smoke passed: isolated renderer, blocked popup and navigation')
  app.exit(0)
}).catch(error => {
  console.error(error.message)
  clearTimeout(timeout)
  app.exit(1)
})
