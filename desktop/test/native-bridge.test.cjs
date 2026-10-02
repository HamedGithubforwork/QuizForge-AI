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
  }
  let allowDownload = false
  let allowRemoval = false
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
    { phase: 'idle', model: { ready: false }, secretPath: undefined })
  assert.equal((await handlers['qfn:startLocalAiModelDownload'](event)).phase, 'idle')
  allowDownload = true
  assert.equal((await handlers['qfn:startLocalAiModelDownload'](event)).phase, 'downloading')
  assert.equal((await handlers['qfn:cancelLocalAiModelDownload'](event)).phase, 'idle')
  local.load = async () => ({ phase: 'idle', model: { ready: true } })
  assert.equal((await handlers['qfn:removeLocalAiModel'](event)).model.ready, true)
  allowRemoval = true
  assert.equal((await handlers['qfn:removeLocalAiModel'](event)).phase, 'idle')
})
