'use strict'
// Real Windows Electron boundary test. Every HTTPS response is synthetic.
const assert = require('node:assert/strict')
const path = require('node:path')
const { app, BrowserWindow, session, ipcMain } = require('electron')
const { windowOptions, APP_ORIGIN } = require('../src/policy.cjs')
const { installNativeBridge } = require('../src/native-bridge.cjs')
const { createNativeAccount } = require('../src/native-account.cjs')
const { createAccountSourceTextCache } = require('../src/account-source-text-cache.cjs')
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
  let sourceFetches = 0
  const sourceSha = 'a'.repeat(64)
  const account = createNativeAccount({ session: nativeSession, fetch: async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer private-fixture-token')
    const parsed = new URL(url)
    assert.equal(parsed.origin, 'https://api.quizfromnotes.com')
    if (url.endsWith('/identity/session')) {
      return Response.json({ id: 'fixture-user', email: 'fixture@example.test', enrolled: true })
    }
    if (parsed.pathname === '/api/documents/' + sourceSha + '/pages/1') {
      sourceFetches++
      return Response.json({ pdf_sha256: sourceSha, page_number: 1, text: 'fixture cached source' })
    }
    return Response.json([{ id: 'fixture-deck', name: 'Fixture deck', due_count: 2 }])
  } })
  const sourceValues = new Map()
  const sourceTextCache = createAccountSourceTextCache({
    account,
    store: {
      get: async (owner, sha, page) => sourceValues.get(owner + ':' + sha + ':' + page) ?? null,
      put: async (owner, sha, page, text) => {
        sourceValues.set(owner + ':' + sha + ':' + page, text)
        return true
      },
    },
  })
  const localAi = {
    load: async () => ({ initialized: true, phase: 'idle', progress: null, error: null,
      capability: { localEligible: true, recommendation: 'enhanced-local-preview', modelId: 'fixture',
        acceleration: 'cpu', releaseReady: false, reasons: [], hardware: { gpuDetected: false, gpuAccelerationUsable: false },
        requirements: { modelBytes: 100, diskRequiredBytes: 120 } }, model: { ready: false, bytes: null } }),
    startDownload: async () => ({ phase: 'downloading' }),
    cancelDownload: async () => ({ phase: 'idle' }),
    removeModel: async () => ({ phase: 'idle' }),
    quizStatus: async () => ({
      available: true,
      reason: null,
      busy: false,
      modelId: 'fixture',
      execution: 'local',
      constraints: { questionCount: 5, questionType: 'multiple_choice', maxSourceBytes: 8000 },
    }),
    generateQuiz: async request => {
      assert.equal(request.questionCount, 5)
      assert.equal(request.questionType, 'multiple_choice')
      assert.deepEqual(request.pages, [{ pageNumber: 1, text: 'fixture source' }])
      return {
        title: 'Fixture local quiz',
        questions: Array.from({ length: 5 }, (_, index) => ({
          question_type: 'multiple_choice',
          question: 'Question ' + (index + 1),
          choices: ['A', 'B', 'C', 'D'],
          correct_index: 0,
          correct_answer: 'A',
          accepted_answers: ['A'],
          grading: {
            grading_version: 2,
            grading_mode: 'none',
            answer_groups: [],
            required_group_count: 0,
            numeric_value: 0,
            numeric_tolerance: 0,
            numeric_unit: '',
          },
          explanation: 'Fixture explanation',
          source_pages: [1],
        })),
      }
    },
    cancelQuiz: async () => {},
  }
  installNativeBridge({ ipcMain, getWindow: () => window, getSession: () => nativeSession,
    getAccount: () => account, getReminders: () => null, getLocalAi: () => localAi,
    getSourceTextCache: () => sourceTextCache, openAccountWebsite: async () => {} })
  const options = windowOptions()
  options.webPreferences.preload = path.resolve(__dirname, '../src/preload.cjs')
  window = new BrowserWindow(options)
  await window.loadURL(APP_ORIGIN)
  const result = await window.webContents.executeJavaScript(`(async () => {
    const bridge = window.quizFromNotesDesktop;
    const before = await bridge.status();
    let localDenied = false;
    let localQuizDenied = false;
    let sourceDenied = false;
    try { await bridge.localAiStatus() } catch { localDenied = true }
    try { await bridge.localAiQuizStatus() } catch { localQuizDenied = true }
    try { await bridge.loadSourcePageText({documentSha256:'a'.repeat(64),pageNumber:1}) } catch { sourceDenied = true }
    const identity = await bridge.signIn();
    const cachedSource1 = await bridge.loadSourcePageText({documentSha256:'a'.repeat(64),pageNumber:1});
    const cachedSource2 = await bridge.loadSourcePageText({documentSha256:'a'.repeat(64),pageNumber:1});
    const localAi = await bridge.localAiStatus();
    const localQuizStatus = await bridge.localAiQuizStatus();
    const localQuiz = await bridge.generateLocalAiQuiz({
      pages:[{pageNumber:1,text:'fixture source'}],
      questionCount:5,difficulty:'medium',questionType:'multiple_choice'
    });
    await bridge.cancelLocalAiQuiz();
    const decks = await bridge.request({path:'/api/decks', method:'GET'});
    let denied = false;
    try { await bridge.request({path:'https://evil.test/'}) } catch { denied = true }
    await bridge.signOut();
    const after = await bridge.status();
    return { before, localDenied, localQuizDenied, sourceDenied, identity, cachedSource1, cachedSource2,
      localAi, localQuizStatus, localQuiz, decks, denied, after, node:typeof require,
      process:typeof process, methods: Object.keys(bridge) };
  })()`)
  assert.equal(result.before.account, null)
  assert.equal(result.localDenied, true)
  assert.equal(result.localQuizDenied, true)
  assert.equal(result.sourceDenied, true)
  assert.equal(result.identity.userId, 'fixture-user')
  assert.equal(result.cachedSource1, 'fixture cached source')
  assert.equal(result.cachedSource2, 'fixture cached source')
  assert.equal(sourceFetches, 1)
  assert.equal(result.localAi.capability.modelId, 'fixture')
  assert.equal(result.localQuizStatus.available, true)
  assert.equal(result.localQuiz.ok, true)
  assert.equal(result.localQuiz.quiz.questions.length, 5)
  assert.equal(JSON.parse(result.decks.body)[0].name, 'Fixture deck')
  assert.equal(result.denied, true); assert.equal(result.after.account, null)
  assert.equal(result.node, 'undefined'); assert.equal(result.process, 'undefined')
  assert.equal(JSON.stringify(result).includes('private-fixture-token'), false)
  assert.equal(result.methods.includes('invoke'), false)
  assert.equal(result.methods.includes('localAiStatus'), true)
  assert.equal(result.methods.includes('startLocalAiModelDownload'), true)
  assert.equal(result.methods.includes('loadSourcePageText'), true)
  assert.equal(result.methods.includes('saveSourcePageText'), false)
  assert.equal(result.methods.includes('localAiQuizStatus'), true)
  assert.equal(result.methods.includes('generateLocalAiQuiz'), true)
  assert.equal(result.methods.includes('cancelLocalAiQuiz'), true)
  await window.loadURL('https://untrusted.example.test')
  assert.equal(await window.webContents.executeJavaScript('typeof window.quizFromNotesDesktop'), 'undefined')
  window.destroy(); clearTimeout(timeout)
  console.log('PASS: real sandboxed preload, main-frame account/deck IPC, token isolation, sign-out and foreign-origin rejection')
  app.exit(0)
}).catch(() => { clearTimeout(timeout); console.error('Native desktop bridge smoke failed'); app.exit(1) })
