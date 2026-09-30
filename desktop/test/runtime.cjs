'use strict'
// Runs under real Electron on Windows CI; never contacts production.
const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { windowOptions } = require('../src/policy.cjs')
const { guardContents } = require('../src/guards.cjs')
app.enableSandbox()
const timeout = setTimeout(() => { console.error('Desktop smoke timed out'); app.exit(1) }, 20000)
app.whenReady().then(async () => {
  const window = new BrowserWindow(windowOptions())
  guardContents(window.webContents)
  await window.loadURL('data:text/html,<h1>Desktop security smoke</h1>')
  const result = await window.webContents.executeJavaScript(`({
    node: typeof require, process: typeof process,
    popup: window.open('https://example.com') === null
  })`)
  assert.deepEqual(result, { node: 'undefined', process: 'undefined', popup: true })
  const blocked = new Promise(resolve => window.webContents.once('will-navigate', event => {
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
