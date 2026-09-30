'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createNativeSignInTest } = require('../src/native-sign-in-test.cjs')
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return {promise,resolve,reject} }

test('acceptance checks sign-in, forced refresh and revocation and reports no identity', async () => {
  const calls = [], reports = []
  const check = createNativeSignInTest({ session: { status: () => ({revocationUnconfirmed:false}),
    signIn: async () => calls.push('signIn'),
    session: async force => { assert.equal(force,true); calls.push('refresh'); return {accessToken:'private',email:'private'} },
    signOut: async () => calls.push('signOut'),
  }, report: value => reports.push(value) })
  await check.run()
  assert.deepEqual(calls,['signIn','refresh','signOut'])
  assert.deepEqual(reports,['verified'])
  assert.equal(check.status().running,false)
})

test('concurrent starts are ignored and cancellation cannot report success', async () => {
  const login = deferred(), reports = []
  let starts = 0, refreshes = 0
  const check = createNativeSignInTest({ session: { status: () => ({revocationUnconfirmed:false}),
    signIn: () => { starts++; return login.promise },
    session: async () => { refreshes++; return {} },
    signOut: async () => login.reject(Error('private cancellation')),
  }, report: value => reports.push(value) })
  const first = check.run()
  await check.run()
  await check.cancel()
  await first
  assert.equal(starts,1)
  assert.equal(refreshes,0)
  assert.deepEqual(reports,['cancelled'])
})

test('close suppresses late reports; refresh and revocation failures stay generic', async () => {
  for (const outcome of ['close','refresh','revoke']) {
    const refresh = deferred(), reports=[]
    const check=createNativeSignInTest({session:{status:()=>({revocationUnconfirmed:false}),signIn:async()=>{},session:()=>refresh.promise,
      signOut:async()=>{if(outcome==='revoke')throw Error('private token')}},report:v=>reports.push(v)})
    const running=check.run()
    await Promise.resolve()
    if(outcome==='close')await check.dispose()
    refresh.resolve(outcome==='refresh'?null:{accessToken:'private'})
    await running
    assert.deepEqual(reports,outcome==='close'?[]:[outcome==='revoke'?'revocation_unconfirmed':'failed'])
  }
})

test('cancellation preserves an unconfirmed remote revocation', async () => {
  const login=deferred(), reports=[]
  let unconfirmed=false
  const check=createNativeSignInTest({session:{
    signIn:()=>login.promise, session:async()=>null,
    status:()=>({revocationUnconfirmed:unconfirmed}),
    signOut:async()=>{unconfirmed=true;login.reject(Error('cancelled'));throw Error('private')},
  },report:v=>reports.push(v)})
  const running=check.run()
  await check.cancel()
  await running
  assert.deepEqual(reports,['revocation_unconfirmed'])
})

test('OS callback completes the real session lifecycle and acceptance check', async () => {
  const { createNativeSession } = require('../src/native-session.cjs')
  const { createCallbackReceiver } = require('../src/native-protocol.cjs')
  const { CALLBACK_URL } = require('../src/native-auth-attempt.cjs')
  const opened = deferred(), calls = [], reports = []
  const value = {accessToken:'synthetic-access',refreshToken:'synthetic-refresh',subject:'synthetic',
    userId:'synthetic-owner',email:'synthetic@example.test',expiresAt:Date.now()+300000}
  const session = createNativeSession({clientId:'syntheticclient',openBrowser:url=>opened.resolve(url),client:{
    exchange:async request=>{assert.equal(new URLSearchParams(request.body).get('code'),'synthetic');calls.push('exchange');return value},
    refresh:async previous=>{assert.equal(previous.refreshToken,'synthetic-refresh');calls.push('refresh');return value},
    revoke:async token=>{assert.equal(token,'synthetic-refresh');calls.push('revoke')},
  }})
  const check=createNativeSignInTest({session,report:v=>reports.push(v)})
  const receive=createCallbackReceiver({getSession:()=>session,focus:()=>{}})
  const run=check.run()
  const authorization=new URL(await opened.promise)
  const callback=CALLBACK_URL+'?code=synthetic&state='+authorization.searchParams.get('state')
  assert.equal(await receive(['app.exe',callback]),true)
  await run
  assert.deepEqual(calls,['exchange','refresh','revoke'])
  assert.deepEqual(reports,['verified'])
  assert.equal(await session.session(),null)
  assert.equal(await receive(['app.exe',callback]),false)
})

test('cancellation waits for remote revocation before reporting its outcome', async () => {
  const login=deferred(), revoke=deferred(), reports=[]
  let unconfirmed=false, outs=0
  const check=createNativeSignInTest({session:{signIn:()=>login.promise,session:async()=>null,
    status:()=>({revocationUnconfirmed:unconfirmed}),
    signOut:async()=>{if(++outs===1){login.reject(Error('cancelled'));await revoke.promise;unconfirmed=true;throw Error('private')}},
  },report:v=>reports.push(v)})
  const run=check.run(), cancel=check.cancel()
  await Promise.resolve();await Promise.resolve()
  assert.deepEqual(reports,[])
  revoke.resolve()
  await cancel;await run
  assert.deepEqual(reports,['revocation_unconfirmed'])
})
