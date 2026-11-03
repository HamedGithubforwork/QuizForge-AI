'use strict'

// CI-only sanitized diagnostic after a verified Hugging Face download fails.
// Uses the same URL allowlist as the model store. Never print redirect URLs,
// signed query strings, headers other than bounded numeric status/length,
// model data, tokens, or raw exceptions. Cancels response bodies immediately.
const { getBenchmarkModel } = require('../src/local-benchmark-models.cjs')
const { reviewedUrl } = require('../src/local-model-store.cjs')
const REDIRECTS = new Set([301,302,303,307,308])
function boundedSeconds(value) {
  if(!/^\d{1,5}$/.test(String(value??''))) return null
  const number=Number(value)
  return Number.isSafeInteger(number)&&number>=0&&number<=86400?number:null
}
async function inspectStatus(model,{fetcher=globalThis.fetch}={}){
  let address=reviewedUrl(model.url)
  for(let i=0;i<6;i++){
    let response
    try {
      response=await fetcher(address,{
        method:'GET',redirect:'manual',credentials:'omit',
        signal:AbortSignal.timeout(10000),
      })
    } catch {return {result:'network_error',hops:i}}
    const status=Number.isInteger(response?.status)&&response.status>=100&&
      response.status<=599?response.status:null
    if(status===null)return {result:'invalid_response',hops:i}
    const lenText=response.headers?.get('content-length')
    const length=/^\d{1,15}$/.test(String(lenText??''))?Number(lenText):null
    const size=length===null?'unknown':
      length===model.bytes?'expected':'mismatch'
    const retryAfter=boundedSeconds(response.headers?.get('retry-after'))
    const location=REDIRECTS.has(status)?
      response.headers?.get('location'):null
    await response.body?.cancel?.().catch(()=>{})
    if(REDIRECTS.has(status)){
      if(!location)return {result:'missing_redirect',httpStatus:status,hops:i}
      try { address=reviewedUrl(new URL(location,address).href) }
      catch{return {result:'unapproved_redirect',httpStatus:status,hops:i}}
      continue
    }
    return {result:'response',httpStatus:status,contentLength:size,
      retryAfterSeconds:retryAfter,hops:i}
  }
  return {result:'too_many_redirects',hops:6}
}
async function main(){
  const model=getBenchmarkModel(process.argv[2])
  const result=await inspectStatus(model)
  console.log('PINNED MODEL UPSTREAM STATUS '+JSON.stringify(result))
}
module.exports={inspectStatus,boundedSeconds}
if(require.main===module)main().catch(()=>{
  console.error('PINNED MODEL UPSTREAM STATUS {"result":"unclassified"}')
  process.exitCode=1
})
