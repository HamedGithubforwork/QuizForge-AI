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
