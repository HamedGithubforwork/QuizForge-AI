'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const {inspectStatus,boundedSeconds}=
  require('../scripts/inspect-model-download-status.cjs')
const model={url:'https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/main/file.gguf',
  bytes:1282439264}
function response(status,headers={}){
  return {status,headers:new Headers(headers),
    body:{async cancel(){}}}
}
test('bounded upstream result only includes status and length, never redirect secrets',async()=>{
  const signed='https://cdn-lfs.hf.co/pinned.gguf?X-Secret=must-never-log'
  let calls=0
  const result=await inspectStatus(model,{fetcher:async url=>{
    calls++
    return calls===1?response(302,{location:signed}):
      response(429,{'retry-after':'120'})
  }})
  assert.deepEqual(result,{result:'response',httpStatus:429,
    contentLength:'unknown',retryAfterSeconds:120,hops:1})
  assert.equal(calls,2)
  assert.doesNotMatch(JSON.stringify(result),/Secret|http|signed|hf\.co/i)
})
test('exact length is distinguishable from unexpected or missing content',async()=>{
  const good=await inspectStatus(model,{fetcher:async()=>response(200,{
    'content-length':String(model.bytes),
  })})
  assert.equal(good.contentLength,'expected')
  const mismatch=await inspectStatus(model,{fetcher:async()=>response(200,{
    'content-length':'100',
  })})
  assert.equal(mismatch.contentLength,'mismatch')
})
test('unapproved redirect blocked without logging target',async()=>{
  const res=await inspectStatus(model,{fetcher:async()=>response(302,{
    location:'https://attacker.invalid/stolen?token=private',
  })})
  assert.equal(res.result,'unapproved_redirect')
  assert.doesNotMatch(JSON.stringify(res),/private|attacker/i)
})
test('unknown retry after and network failures do not reveal private exceptions',async()=>{
  assert.equal(boundedSeconds('untrusted'),null)
  const result=await inspectStatus(model,{fetcher:async()=>{
    throw new Error('private URL, key, prompts')
  }})
  assert.deepEqual(result,{result:'network_error',hops:0})
})
