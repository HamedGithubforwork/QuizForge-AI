'use strict'
const test=require('node:test'), assert=require('node:assert/strict')
const {installNativeBridge}=require('../src/native-bridge.cjs')
test('bridge rejects foreign contents, child frames, navigated origins and extra arguments',async()=>{
  const handlers={},frame={url:'https://quizfromnotes.com/decks'},contents={isDestroyed:()=>false,mainFrame:frame}
  let calls=0
  installNativeBridge({ipcMain:{handle:(name,fn)=>{handlers[name]=fn}},getWindow:()=>({webContents:contents}),
    getSession:()=>({}),getAccount:()=>({current:()=>{calls++;return null}}),openAccountWebsite:()=>{}})
  const event={sender:contents,senderFrame:frame}
  assert.deepEqual(await handlers['qfn:status'](event),{available:true,account:null})
  for(const bad of [{...event,sender:{}},{...event,senderFrame:{...frame}}, {...event,senderFrame:null}])
    await assert.rejects(handlers['qfn:status'](bad))
  for(const url of ['https://evil.test','https://quizfromnotes.com.evil.test','https://user@quizfromnotes.com','file:///x']){
    frame.url=url;await assert.rejects(handlers['qfn:status'](event))
  }
  frame.url='https://quizfromnotes.com/'
  await assert.rejects(handlers['qfn:status'](event,'extra'))
  assert.equal(calls,1)
})
test('navigation during an IPC request drops its result',async()=>{
  const handlers={},frame={url:'https://quizfromnotes.com/'},contents={isDestroyed:()=>false,mainFrame:frame}
  let resolve
  installNativeBridge({ipcMain:{handle:(name,fn)=>{handlers[name]=fn}},getWindow:()=>({webContents:contents}),
    getSession:()=>({}),getAccount:()=>({request:()=>new Promise(r=>{resolve=r})}),openAccountWebsite:()=>{}})
  const result=handlers['qfn:request']({sender:contents,senderFrame:frame},{path:'/api/decks'})
  frame.url='https://evil.test';resolve('private deck');await assert.rejects(result)
})

test('Local AI bridge requires an enrolled account and exposes only manager results', async () => {
  const handlers = {}, frame = { url: 'https://quizfromnotes.com/settings/local-ai' }
  const contents = { isDestroyed: () => false, mainFrame: frame }
  let account = null
  const local = {
    load: async () => ({ phase: 'idle', model: { ready: false }, secretPath: undefined }),
    startDownload: async () => ({ phase: 'downloading', model: { ready: false } }),
    cancelDownload: async () => ({ phase: 'idle', model: { ready: false } }),
    removeModel: async () => ({ phase: 'idle', model: { ready: false } }),
    quizStatus: async () => ({ available: true, reason: null, busy: false }),
    generateQuiz: async value => ({ title: 'Fixture', questions: [], received: value.pages?.length }),
    cancelQuiz: async () => {},
  }
  let allowDownload = false
  let allowRemoval = false
  let lastMode = 'gpu'
  local.lastAccelerationMode = () => lastMode
  installNativeBridge({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn } },
    getWindow: () => ({ webContents: contents }),
    getSession: () => ({}),
    getAccount: () => ({ current: () => account }),
    getLocalAi: () => local,
    confirmLocalAiDownload: async () => allowDownload,
    confirmLocalAiRemoval: async () => allowRemoval,
    openAccountWebsite: () => {},
  })
  const event = { sender: contents, senderFrame: frame }
  await assert.rejects(handlers['qfn:localAiStatus'](event), /Sign in/)
  account = { userId: 'user', enrolled: true }
  assert.deepEqual(await handlers['qfn:localAiStatus'](event),
    { phase: 'idle', model: { ready: false }, secretPath: undefined, lastAccelerationMode: 'gpu' })
  lastMode = 'Vulkan1'
  assert.equal((await handlers['qfn:startLocalAiModelDownload'](event)).lastAccelerationMode, null)
  allowDownload = true
  lastMode = 'cpu'
  assert.equal((await handlers['qfn:startLocalAiModelDownload'](event)).lastAccelerationMode, 'cpu')
  assert.equal((await handlers['qfn:cancelLocalAiModelDownload'](event)).lastAccelerationMode, 'cpu')
  local.load = async () => ({ phase: 'idle', model: { ready: true } })
  assert.equal((await handlers['qfn:removeLocalAiModel'](event)).model.ready, true)
  allowRemoval = true
  assert.equal((await handlers['qfn:removeLocalAiModel'](event)).phase, 'idle')
})


test('Local AI quiz IPC requires one bounded request and returns sanitized failures', async () => {
  const handlers = {}, frame = { url: 'https://quizfromnotes.com/' }
  const contents = { isDestroyed: () => false, mainFrame: frame }
  let account = { userId: 'user', enrolled: true }
  let received
  const local = {
    load: async () => ({ model: { ready: true } }),
    startDownload: async () => ({}),
    cancelDownload: async () => {},
    removeModel: async () => ({}),
    quizStatus: async () => ({ available: true, reason: null, busy: false }),
    generateQuiz: async value => {
      received = value
      return { title: 'Fixture', questions: [] }
    },
    cancelQuiz: async () => {},
  }
  installNativeBridge({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn } },
    getWindow: () => ({ webContents: contents }),
    getSession: () => ({}),
    getAccount: () => ({ current: () => account }),
    getLocalAi: () => local,
    openAccountWebsite: () => {},
  })
  const event = { sender: contents, senderFrame: frame }
  const request = {
    pages: [{ pageNumber: 1, text: 'study text' }],
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  }
  assert.deepEqual(await handlers['qfn:localAiQuizStatus'](event),
    { available: true, reason: null, busy: false })
  const generated = await handlers['qfn:generateLocalAiQuiz'](event, request)
  assert.equal(generated.ok, true)
  assert.deepEqual(received, request)
  await assert.rejects(handlers['qfn:generateLocalAiQuiz'](event), /not permitted/)
  await assert.rejects(handlers['qfn:generateLocalAiQuiz'](event, request, request), /not permitted/)

  local.generateQuiz = async () => {
    throw Object.assign(new Error('private C:\\model.gguf secret'), { code: 'runtime_invalid' })
  }
  assert.deepEqual(await handlers['qfn:generateLocalAiQuiz'](event, request),
    { ok: false, error: 'runtime_invalid' })

  local.generateQuiz = async () => {
    throw Object.assign(new Error('private'), { code: 'private_path' })
  }
  assert.deepEqual(await handlers['qfn:generateLocalAiQuiz'](event, request),
    { ok: false, error: 'generation_failed' })

  account = null
  await assert.rejects(handlers['qfn:localAiQuizStatus'](event), /Sign in/)
})

test('local PDF quiz IPC bounds file bytes, requires the local account path and never calls cloud request', async () => {
  const handlers = {}, frame = { url: 'https://quizfromnotes.com/' }
  const contents = { isDestroyed: () => false, mainFrame: frame }
  let account = { userId: 'user', enrolled: true }
  let received
  let cloudCalls = 0
  const result = {
    processing: 'local', documentSha256: 'a'.repeat(64), pageCount: 1,
    selectedPages: [1], quiz: { title: 'Fixture', questions: [] },
  }
  const local = {
    generateDocumentQuiz: async value => { received = value; return result },
    cancelQuiz: async () => {},
  }
  installNativeBridge({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn } },
    getWindow: () => ({ webContents: contents }), getSession: () => ({}),
    getAccount: () => ({ current: () => account, request: async () => { cloudCalls++; throw new Error('cloud must not run') } }),
    getLocalAi: () => local, openAccountWebsite: () => {},
  })
  const event = { sender: contents, senderFrame: frame }
  const request = {
    bytes: new Uint8Array(Buffer.from('%PDF-1.7 local')),
    filename: 'notes.pdf', selectedPages: [1], questionCount: 5,
    difficulty: 'medium', questionType: 'multiple_choice',
  }
  assert.deepEqual(await handlers['qfn:generateLocalDocumentQuiz'](event, request), { ok: true, ...result })
  assert.deepEqual(received, request)
  assert.equal(cloudCalls, 0)
  assert.deepEqual(await handlers['qfn:generateLocalDocumentQuiz'](event, {
    ...request, bytes: new Uint8Array(15 * 1024 * 1024 + 1),
  }), { ok: false, error: 'invalid_request' })
  assert.deepEqual(await handlers['qfn:generateLocalDocumentQuiz'](event, { ...request, extra: 'not permitted' }),
    { ok: false, error: 'invalid_request' })
  await assert.rejects(handlers['qfn:generateLocalDocumentQuiz'](event), /not permitted/)
  await assert.rejects(handlers['qfn:generateLocalDocumentQuiz'](event, request, request), /not permitted/)

  local.generateDocumentQuiz = async () => { throw Object.assign(new Error('private path'), { code: 'processing_failed' }) }
  assert.deepEqual(await handlers['qfn:generateLocalDocumentQuiz'](event, request), { ok: false, error: 'processing_failed' })

  account = null
  await assert.rejects(handlers['qfn:generateLocalDocumentQuiz'](event, request), /Sign in/)
  assert.equal(cloudCalls, 0)
})

test('local PDF preprocessing stays on the desktop and rejects oversized input', async () => {
  const handlers = {}, frame = { url: 'https://quizfromnotes.com/' }
  const contents = { isDestroyed: () => false, mainFrame: frame }
  const account = { userId: 'user', enrolled: true }
  let received
  const local = {
    processDocument: async value => {
      received = value
      return { processing: 'local', pdfSha256: 'a'.repeat(64), pageCount: 1, pages: [{ pageNumber: 1, text: 'local extracted text' }] }
    },
  }
  installNativeBridge({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn } },
    getWindow: () => ({ webContents: contents }), getSession: () => ({}),
    getAccount: () => ({ current: () => account, request: async () => { throw new Error('cloud must not run') } }),
    getLocalAi: () => local, openAccountWebsite: () => {},
  })
  const event = { sender: contents, senderFrame: frame }
  const request = { bytes: new Uint8Array(Buffer.from('%PDF-1.7 local')), filename: 'notes.pdf', selectedPages: [1] }
  const result = await handlers['qfn:processLocalPdf'](event, request)
  assert.equal(result.ok, true)
  assert.equal(result.document.processing, 'local')
  assert.deepEqual(received, request)
  assert.deepEqual(await handlers['qfn:processLocalPdf'](event, { ...request, extra: true }), { ok: false, error: 'invalid_request' })
  assert.deepEqual(await handlers['qfn:processLocalPdf'](event, { ...request, bytes: new Uint8Array(15 * 1024 * 1024 + 1) }), { ok: false, error: 'invalid_request' })
  await assert.rejects(handlers['qfn:processLocalPdf'](event), /not permitted/)
})


test('source-page cache IPC is fixed, single-argument and does not expose a write primitive', async () => {
  const handlers = {}
  const frame = { url: 'https://quizfromnotes.com/' }
  const contents = { isDestroyed: () => false, mainFrame: frame }
  let received
  installNativeBridge({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn } },
    getWindow: () => ({ webContents: contents }),
    getSession: () => ({}),
    getAccount: () => ({}),
    getSourceTextCache: () => ({
      load: async value => {
        received = value
        return 'cached source'
      },
    }),
    openAccountWebsite: () => {},
  })
  const event = { sender: contents, senderFrame: frame }
  const value = { documentSha256: 'a'.repeat(64), pageNumber: 2 }
  assert.equal(await handlers['qfn:loadSourcePageText'](event, value), 'cached source')
  assert.deepEqual(received, value)
  await assert.rejects(handlers['qfn:loadSourcePageText'](event), /not permitted/)
  await assert.rejects(handlers['qfn:loadSourcePageText'](event, value, value), /not permitted/)
  assert.equal(handlers['qfn:saveSourcePageText'], undefined)
})
