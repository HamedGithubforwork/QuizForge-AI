'use strict'

// Experimental-only source evidence selection. Full PDF text is extracted
// locally but never passed to Qwen when above the strict 8 KB model limit.
// Page IDs and source quotes remain unchanged; no paraphrase or invented text.
const { MAX_SOURCE_BYTES }=require('./local-quiz-service.cjs')
const { extractSourceFacts, balanceSourceFacts, sourceTopicKey }=
  require('./local-source-facts.cjs')
const encoder=new TextEncoder()
const bytes=value=>encoder.encode(value).byteLength
function selectEvidencePages(pages,{maxBytes=MAX_SOURCE_BYTES}={}){
  if(!Array.isArray(pages)||!pages.length||pages.length>20||
    !Number.isSafeInteger(maxBytes)||maxBytes<100||maxBytes>MAX_SOURCE_BYTES||
    pages.some(p=>!Number.isSafeInteger(p?.pageNumber)||
      typeof p.text!=='string'||!p.text.trim())||
    new Set(pages.map(p=>p.pageNumber)).size!==pages.length){
    throw new TypeError('Invalid local source selection')
  }
  const originalBytes=pages.reduce((sum,p)=>sum+bytes(p.text),0)
  if(originalBytes<=maxBytes)return Object.freeze({
    pages,metadata:Object.freeze({trimmed:false,originalBytes,
      selectedBytes:originalBytes,originalPages:pages.length,
      selectedPages:pages.length,sourceFacts:0,topicCount:0}),
  })
  // Extraction is capped at 100 source facts, preventing a very large PDF
  // from turning into an unbounded prompt or giant fact inventory.
  const inventory=balanceSourceFacts(extractSourceFacts(pages,100))
  const selected=new Map(),topics=new Set(),selectedQuotes=new Set()
  let size=0,sourceFacts=0
  for(const f of inventory){
    const page=pages.find(p=>p.pageNumber===f.page)
    if(!page||!page.text.includes(f.quote))continue
    const key=f.page+'|'+f.quote
    if(selectedQuotes.has(key))continue
    const existing=selected.get(f.page)??''
    const joiner=existing?'\n':''
    const delta=bytes(joiner+f.quote)
    if(size+delta>maxBytes)continue
    selectedQuotes.add(key)
    selected.set(f.page,existing+joiner+f.quote)
    topics.add(sourceTopicKey(f))
    size+=delta
    sourceFacts++
    if(sourceFacts>=36)break
  }
  if(sourceFacts<1)return Object.freeze({
    pages:[],metadata:Object.freeze({trimmed:true,originalBytes,
      selectedBytes:0,originalPages:pages.length,selectedPages:0,
      sourceFacts:0,topicCount:0}),
  })
  const reduced=pages.filter(p=>selected.has(p.pageNumber)).map(p=>
    Object.freeze({pageNumber:p.pageNumber,text:selected.get(p.pageNumber)}))
  return Object.freeze({pages:Object.freeze(reduced),
    metadata:Object.freeze({trimmed:true,originalBytes,
      selectedBytes:size,originalPages:pages.length,
      selectedPages:reduced.length,sourceFacts,topicCount:topics.size})})
}
module.exports={selectEvidencePages}
