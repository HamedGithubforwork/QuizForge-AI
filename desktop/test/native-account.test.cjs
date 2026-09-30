'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createNativeAccount, validateRequest } = require('../src/native-account.cjs')
function fixture() {
  let generation = 1, token = 'private-token', signedIn = true
  const session = { generation: () => generation, status: () => ({ signedIn }),
    session: async refresh => ({ userId: 'verified-id', email: 'verified@example.test', accessToken: refresh ? 'refreshed-private' : token }),
    signOut: async () => { generation++; signedIn = false },
  }
  const calls = []
  let fetcher = async () => Response.json({ id: 'verified-id', email: 'verified@example.test', enrolled: true })
  const account = createNativeAccount({ session, fetch: (...args) => { calls.push(args); return fetcher(...args) } })
  return { session, account, calls, setFetch: value => { fetcher = value }, switchAccount: () => { generation++; token = 'other-private' } }
}
test('online identity gates study requests; tokens stay main-only and URLs/headers are pinned', async () => {
  const f = fixture()
  await assert.rejects(f.account.request({path:'/api/decks'}))
  const identity = await f.account.verify()
  assert.deepEqual(identity, { userId:'verified-id', email:'verified@example.test', enrolled:true })
  f.setFetch(async () => Response.json([]))
  assert.deepEqual(await f.account.request({path:'/api/decks'}), {status:200,body:'[]',contentType:'application/json'})
  const [url, init] = f.calls[1]
  assert.equal(url,'https://api.quizfromnotes.com/api/decks')
  assert.equal(init.headers.Authorization,'Bearer private-token')
  assert.equal(init.headers.Origin,'https://quizfromnotes.com')
  assert.equal(init.redirect,'error'); assert.equal(init.credentials,'omit')
  assert.equal(JSON.stringify(identity).includes('private-token'),false)
})
test('rejects traversal, non-allowlisted operations, query injection, token/header/URL control and oversized bodies', () => {
  for (const value of [
    {path:'https://evil.test/api/decks'}, {path:'//evil.test/api/decks'}, {path:'/api/decks/../health'},
    {path:'/api/%64ecks'}, {path:'/api/decks#x'}, {path:'/api/admin/metrics'},
    {path:'/api/decks?redirect=https://evil.test'}, {path:'/api/decks',headers:{Authorization:'evil'}},
    {path:'/api/decks',method:'POST',body:'invalid'}, {path:'/api/decks',method:'GET',body:'{}'},
    {path:'/api/study-analytics/summary?timezone=UTC&timezone=Europe/London'},
    {path:'/api/decks',method:'POST',body:' '.repeat(32*1024*1024+1)},
    {path:'/api/quizzes/generate',method:'POST',form:[{name:'file',bytes:new Uint8Array([1]),filename:'../x.pdf'}]},
  ]) assert.throws(() => validateRequest(value))
})
test('refreshes once on 401; repeated rejection clears the session', async () => {
  const f = fixture(); await f.account.verify()
  let n=0
  f.setFetch(async (_url, init) => { n++; if(n === 1)return new Response('',{status:401});assert.equal(init.headers.Authorization,'Bearer refreshed-private');return Response.json([]) })
  assert.equal((await f.account.request({path:'/api/decks'})).status,200)
  assert.equal(n,2)
  f.setFetch(async()=>new Response('',{status:401}))
  await assert.rejects(f.account.request({path:'/api/decks'}))
  assert.equal(f.account.current(),null)
  assert.equal(f.session.status().signedIn,false)
})
test('discard delayed data after account switch, including switch back to the same subject', async () => {
  const f=fixture();await f.account.verify()
  let resolve
  f.setFetch(()=>new Promise(r=>{resolve=r}))
  const result=f.account.request({path:'/api/decks'})
  await new Promise(r=>setImmediate(r))
  f.switchAccount();resolve(Response.json([{private:'old account'}]))
  await assert.rejects(result,/session changed/)
  assert.equal(f.account.current(),null)
})
test('sign-out aborts in-flight transport and identity mismatch cannot bind account data', async () => {
  const f=fixture();await f.account.verify()
  let signal
  f.setFetch((_url,init)=>{signal=init.signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('private details'))))})
  const request=f.account.request({path:'/api/decks'}); await new Promise(r=>setImmediate(r))
  f.account.clear();await f.session.signOut();assert.equal(signal.aborted,true);await assert.rejects(request)
  const other=fixture();other.setFetch(async()=>Response.json({id:'other',email:'verified@example.test',enrolled:true}))
  await assert.rejects(other.account.verify());assert.equal(other.account.current(),null)
  assert.equal(other.session.status().signedIn,false)
})
test('multipart serialization accepts bounded PDF bytes without renderer headers', () => {
  const request=validateRequest({path:'/api/documents/upload',method:'POST',form:[{name:'file',filename:'notes.pdf',bytes:new Uint8Array([1,2])}]})
  assert.equal(request.body.get('file').size,2); assert.deepEqual(request.headers,{})
})
