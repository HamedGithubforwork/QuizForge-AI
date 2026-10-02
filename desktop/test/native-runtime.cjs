'use strict'
// Real Windows Electron boundary test. Every HTTPS response is synthetic.
const assert = require('node:assert/strict')
const path = require('node:path')
const { app, BrowserWindow, session, ipcMain } = require('electron')
const { windowOptions, APP_ORIGIN } = require('../src/policy.cjs')
const { installNativeBridge } = require('../src/native-bridge.cjs')
const { createNativeAccount } = require('../src/native-account.cjs')
app.enableSandbox()
let window
const timeout = setTimeout(() => app.exit(1), 20000)
app.whenReady().then(async () => {
  const browserSession = session.fromPartition('quiz-from-notes-preview')
  await browserSession.protocol.handle('https', () => new Response('<!doctype html><h1>Desktop fixture</h1>', { headers: { 'Content-Type': 'text/html' } }))
  let generation = 0, signedIn = false
  const nativeSession = { generation: () => generation, status: () => ({ signedIn, signingIn: false }),
    signIn: async () => { generation++; signedIn = true }, signOut: async () => { generation++; signedIn = false },
    session: async () => signedIn ? { accessToken: 'private-fixture-token', userId: 'fixture-user', email: 'fixture@example.test' } : null }
  const account = createNativeAccount({ session: nativeSession, fetch: async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer private-fixture-token')
    assert.equal(new URL(url).origin, 'https://api.quizfromnotes.com')
    return Response.json(url.endsWith('/identity/session')
      ? { id: 'fixture-user', email: 'fixture@example.test', enrolled: true }
      : [{ id: 'fixture-deck', name: 'Fixture deck', due_count: 2 }])
  } })
  const localAi = {
    load: async () => ({ initialized: true, phase: 'idle', progress: null, error: null,
      capability: { localEligible: true, recommendation: 'enhanced-local-preview', modelId: 'fixture',
        acceleration: 'cpu', releaseReady: false, reasons: [], hardware: { gpuDetected: false, gpuAccelerationUsable: false },
        requirements: { modelBytes: 100, diskRequiredBytes: 120 } }, model: { ready: false, bytes: null } }),
    startDownload: async () => ({ phase: 'downloading' }),
    cancelDownload: async () => ({ phase: 'idle' }),
    removeModel: async () => ({ phase: 'idle' }),
  }
  installNativeBridge({ ipcMain, getWindow: () => window, getSession: () => nativeSession,
    getAccount: () => account, getReminders: () => null, getLocalAi: () => localAi,
    openAccountWebsite: async () => {} })
  const options = windowOptions()
  options.webPreferences.preload = path.resolve(__dirname, '../src/preload.cjs')
  window = new BrowserWindow(options)
  await window.loadURL(APP_ORIGIN)
  const result = await window.webContents.executeJavaScript(`(async () => {
    const bridge = window.quizFromNotesDesktop;
    const before = await bridge.status();
    let localDenied = false;
    try { await bridge.localAiStatus() } catch { localDenied = true }
    const identity = await bridge.signIn();
    const localAi = await bridge.localAiStatus();
    const decks = await bridge.request({path:'/api/decks', method:'GET'});
    let denied = false;
    try { await bridge.request({path:'https://evil.test/'}) } catch { denied = true }
    await bridge.signOut();
    const after = await bridge.status();
    return { before, localDenied, identity, localAi, decks, denied, after, node:typeof require, process:typeof process,
      methods: Object.keys(bridge) };
  })()`)
  assert.equal(result.before.account, null)
  assert.equal(result.localDenied, true)
  assert.equal(result.identity.userId, 'fixture-user')
  assert.equal(result.localAi.capability.modelId, 'fixture')
  assert.equal(JSON.parse(result.decks.body)[0].name, 'Fixture deck')
  assert.equal(result.denied, true); assert.equal(result.after.account, null)
  assert.equal(result.node, 'undefined'); assert.equal(result.process, 'undefined')
  assert.equal(JSON.stringify(result).includes('private-fixture-token'), false)
  assert.equal(result.methods.includes('invoke'), false)
  assert.equal(result.methods.includes('localAiStatus'), true)
  assert.equal(result.methods.includes('startLocalAiModelDownload'), true)
  await window.loadURL('https://untrusted.example.test')
  assert.equal(await window.webContents.executeJavaScript('typeof window.quizFromNotesDesktop'), 'undefined')
  window.destroy(); clearTimeout(timeout)
  console.log('PASS: real sandboxed preload, main-frame account/deck IPC, token isolation, sign-out and foreign-origin rejection')
  app.exit(0)
}).catch(() => { clearTimeout(timeout); console.error('Native desktop bridge smoke failed'); app.exit(1) })
