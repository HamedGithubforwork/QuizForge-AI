'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { renderOffline, createOfflineReader } = require('../src/offline-reader.cjs')
const { createOfflineMenu } = require('../src/offline-menu.cjs')
const { snapshotDeck } = require('./snapshot-fixture.cjs')
const snapshot = () => ({ ownerId: 'private-owner', schema: 1, savedAt: new Date().toISOString(), offlineAccess: true, decks: [snapshotDeck()] })

test('offline library safely displays questions and answers without scripts, external content or account identifiers', () => {
  const value = snapshot()
  value.decks[0].name = '<img src="https://evil.test" onerror="alert(1)">'
  value.decks[0].cards[0].answer.correct_answer = '</p><script>steal()</script>'
  const html = renderOffline(value)
  assert.equal(html.includes('<script>'), false)
  assert.equal(html.includes('<img '), false)
  assert.match(html, /&lt;script&gt;steal\(\)&lt;\/script&gt;/)
  assert.match(html, /connect-src 'none'/)
  assert.match(html, /Practice only/)
  assert.equal(html.includes('private-owner'), false)
  assert.match(html, /Private question/)
  assert.match(html, /Reveal answer/)
})

test('offline reader creates an ephemeral sandbox with no preload, JavaScript or network and closes replaced content', async () => {
  const windows = [], partitions = []
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = fn => { this.popup = fn }; windows.push(this) }
    isDestroyed() { return !!this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
    show() { this.shown = true }
    async loadURL(url) { this.url = url }
  }
  const session = { fromPartition: partition => {
    partitions.push(partition)
    return { setPermissionRequestHandler(fn) { fn(null, null, result => assert.equal(result, false)) },
      setPermissionCheckHandler(fn) { assert.equal(fn(), false) }, on() {},
      webRequest: { onBeforeRequest(_filter, fn) { fn({}, result => assert.equal(result.cancel, true)) } } }
  } }
  const reader = createOfflineReader({ BrowserWindow: Window, session })
  await reader.open(snapshot())
  const first = windows[0]
  assert.equal(first.options.webPreferences.javascript, false)
  assert.equal(first.options.webPreferences.sandbox, true)
  assert.equal(first.options.webPreferences.nodeIntegration, false)
  assert.equal(first.options.webPreferences.preload, undefined)
  assert.match(first.url, /^data:text\/html/)
  assert.deepEqual(first.popup(), { action: 'deny' })
  let blocked = false
  first.webContents.emit('will-navigate', { preventDefault() { blocked = true } })
  assert.equal(blocked, true)
  await reader.open(snapshot())
  assert.equal(first.destroyed, true)
  assert.notEqual(partitions[0], partitions[1])
  assert.equal(partitions.some(p => p.startsWith('persist:')), false)
  reader.close(); assert.equal(windows[1].destroyed, true)
})

test('offline picker needs no account service; requires explicit selection and refuses non-opted-in copies', async () => {
  const value = snapshot(), reports = [], opened = []
  const window = { isDestroyed: () => false }
  const store = { listOffline: async () => [{ ownerId: value.ownerId, savedAt: value.savedAt, label: 'Saved deck', deckCount: 1 }], load: async () => value }
  const menu = createOfflineMenu({ store, reader: { close() {}, open: async v => opened.push(v) }, getWindow: () => window,
    dialog: { showMessageBox: async (_w, v) => { reports.push(v); return { response: 0 } } } })
  await menu.open(); assert.equal(opened.length, 1)
  value.offlineAccess = false
  await menu.open(); assert.equal(opened.length, 1)
  assert.match(reports.at(-1).message, /Could not unlock/)
})

test('closing or signing out while decrypting cannot reveal a late offline copy', async () => {
  const value = snapshot(); let release, opened = false
  const menu = createOfflineMenu({ store: { listOffline: async () => [{ ownerId: value.ownerId }], load: () => new Promise(r => { release = r }) },
    reader: { close() {}, open: async () => { opened = true } }, getWindow: () => window,
    dialog: { showMessageBox: async () => ({ response: 0 }) } })
  const window = { isDestroyed: () => false }
  const pending = menu.open(); await new Promise(r => setImmediate(r))
  menu.clear(); release(value); await pending
  assert.equal(opened, false)
})

test('offline removal needs confirmation and only removes the selected Windows-unlocked copy', async () => {
  const removed = [], window = { isDestroyed: () => false }; let calls = 0
  const menu = createOfflineMenu({ store: { listOffline: async () => [{ ownerId: 'one' }, { ownerId: 'two' }], remove: async (owner, guard) => { guard(); removed.push(owner) } },
    reader: { close() {} }, getWindow: () => window,
    dialog: { showMessageBox: async () => ({ response: [1, 2, 0][calls++] }) } })
  await menu.open(); assert.deepEqual(removed, ['two'])
})

test('only current opaque rating links can record; repeated clicks and late completions cannot reopen a closed reader', async () => {
  let window, calls = 0, release
  class Window extends EventEmitter {
    constructor() { super(); window = this; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {} }
    isDestroyed() { return !!this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
    show() {}
    async loadURL(url) { this.html = decodeURIComponent(url.split(',').slice(1).join(',')) }
  }
  const session = { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, webRequest: { onBeforeRequest() {} } }) }
  const value = snapshot(), reader = createOfflineReader({ BrowserWindow: Window, session })
  await reader.open(value, { record: async (cardId, rating, guard) => {
    calls++; assert.equal(cardId, value.decks[0].cards[0].id); assert.equal(rating, 3)
    await new Promise(resolve => { release = resolve }); guard(); return value
  } })
  const links = [...window.html.matchAll(/href="([^"]+)"/g)].map(x => x[1])
  assert.equal(links.length, 4)
  const click = url => window.webContents.emit('will-frame-navigate', { preventDefault() {}, url, isMainFrame: true })
  click('https://evil.test'); assert.equal(calls, 0)
  click(links[2]); click(links[2]); assert.equal(calls, 1)
  reader.close(); release(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(window.destroyed, true)
  click(links[1]); assert.equal(calls, 1)
})
