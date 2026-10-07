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
  lastMode = 'unknown'
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
