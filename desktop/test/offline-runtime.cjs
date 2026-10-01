'use strict'
// Invoked in two separate real Windows Electron processes. Only synthetic data.
const { app, BrowserWindow, session, safeStorage } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createWindowsSnapshotStore } = require('../src/windows-snapshot-store.cjs')
const { createOfflineReader } = require('../src/offline-reader.cjs')
const { snapshotDeck } = require('./snapshot-fixture.cjs')
const mode = process.argv[2]
if (!['save', 'read', 'verify'].includes(mode) || !process.env.RUNNER_TEMP) throw Error('Runner-only offline test')
const directory = path.join(process.env.RUNNER_TEMP, 'qfn-offline-restart-test')
app.enableSandbox()
let stage = 'ready'
const timeout = setTimeout(() => { console.error('Offline runtime timeout: ' + stage); app.exit(1) }, 30000)
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }))
  const store = createWindowsSnapshotStore({ app: { isReady: () => true, getPath: () => directory }, safeStorage })
  if (mode === 'save') {
    stage = 'save'
    await fs.rm(directory, { recursive: true, force: true })
    await store.save('synthetic-owner', [snapshotDeck()], () => {}, { offlineAccess: true })
    await store.save('online-only-owner', [snapshotDeck()])
  } else if (mode === 'verify') {
    const value = await store.load('synthetic-owner')
    assert.equal(value.reviews.length, 1)
    assert.equal(value.reviews[0].rating, 3)
    assert.equal(value.reviews[0].synced, false)
    await store.remove('synthetic-owner')
    assert.deepEqual(await store.listOffline(), [])
    await fs.rm(directory, { recursive: true, force: true })
  } else {
    try {
      stage = 'cold discovery'
      const copies = await store.listOffline()
      assert.equal(copies.length, 1)
      assert.equal(copies[0].ownerId, 'synthetic-owner')
      const value = await store.load(copies[0].ownerId)
      stage = 'offline window'
      const reader = createOfflineReader({ BrowserWindow, session })
      let recorded
      const saved = new Promise(resolve => { recorded = resolve })
      await reader.open(value, { record: async (cardId, rating, guard) => {
        const updated = await store.recordReview(value.ownerId, cardId, rating, value.savedAt, guard)
        recorded(updated)
        return updated
      } })
      const window = BrowserWindow.getAllWindows()[0]
      assert.equal(window.webContents.getLastWebPreferences().javascript, false)
      assert.equal(window.webContents.getLastWebPreferences().preload, undefined)
      const dev = window.webContents.debugger
      dev.attach('1.3')
      const root = await dev.sendCommand('DOM.getDocument')
      const query = selector => dev.sendCommand('DOM.querySelector', { nodeId: root.root.nodeId, selector })
      const body = await query('body')
      const html = await dev.sendCommand('DOM.getOuterHTML', { nodeId: body.nodeId })
      assert.match(html.outerHTML, /Private question/)
      assert.match(html.outerHTML, /Private answer/)
      assert.equal(html.outerHTML.includes('synthetic-owner'), false)
      stage = 'native disclosure interaction'
      for (const selector of ['.deck > summary', '.answer > summary']) {
        const node = await query(selector)
        const { model } = await dev.sendCommand('DOM.getBoxModel', { nodeId: node.nodeId })
        const x = model.content[0] + 12, y = model.content[1] + 8
        await dev.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await dev.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      }
      assert.notEqual((await query('.answer[open]')).nodeId, 0)
      stage = 'save rating through script-free reader'
      const rating = await query('.ratings a:nth-child(3)')
      const { model } = await dev.sendCommand('DOM.getBoxModel', { nodeId: rating.nodeId })
      const x = model.content[0] + 5, y = model.content[1] + 5
      await dev.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await dev.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      const updated = await saved
      assert.equal(updated.reviews[0].rating, 3)
      reader.close()
    } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error }
  }
  clearTimeout(timeout)
  console.log('PASS: offline ' + mode + ' in separate Windows process; encrypted opt-in only, no account/network dependency')
  app.exit(0)
}).catch(() => { clearTimeout(timeout); console.error('Offline runtime failed: ' + stage); app.exit(1) })
