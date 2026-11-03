'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const {selectEvidencePages}=require('../src/local-source-selection.cjs')
const {MAX_SOURCE_BYTES}=require('../src/local-quiz-service.cjs')
const paragraph=(name,index)=>
  'The '+name+' preserves useful information about topic '+index+'.'
test('small page selection passes through unchanged',()=>{
  const pages=[{pageNumber:2,text:paragraph('museum',1)}]
  const output=selectEvidencePages(pages)
  assert.equal(output.pages,pages)
  assert.equal(output.metadata.trimmed,false)
})
test('oversized page is compressed into exact source evidence, preserving real PDF page',()=>{
  const text=Array.from({length:270},(_,i)=>paragraph('museum',i)).join('\n')
  const output=selectEvidencePages([{pageNumber:7,text}])
  assert.equal(output.metadata.trimmed,true)
  assert.ok(output.metadata.originalBytes>MAX_SOURCE_BYTES)
  assert.ok(output.metadata.selectedBytes<=MAX_SOURCE_BYTES)
  assert.ok(output.pages.length===1)
  assert.equal(output.pages[0].pageNumber,7)
  assert.ok(output.metadata.sourceFacts>0)
  for(const quote of output.pages[0].text.split('\n'))
    assert.ok(text.includes(quote),'must be exact source quote')
})
test('multiple long pages receive balanced coverage and preserve each citation',()=>{
  const pages=[1,2,3,4].map(i=>({pageNumber:i,
    text:Array.from({length:110},(_,j)=>paragraph('archive '+i,j)).join('\n')}))
  const out=selectEvidencePages(pages)
  assert.equal(out.metadata.trimmed,true)
  assert.ok(out.pages.length>=3)
  assert.ok(out.metadata.topicCount>=3)
  assert.ok(out.metadata.selectedBytes<=8000)
  for(const page of out.pages){
    const original=pages.find(p=>p.pageNumber===page.pageNumber).text
    for(const quote of page.text.split('\n'))assert.ok(original.includes(quote))
  }
})
test('unsupported oversized source abstains rather than fabricating excerpts',()=>{
  const data=[{pageNumber:1,text:'A'.repeat(12000)}]
  const output=selectEvidencePages(data)
  assert.equal(output.pages.length,0)
  assert.equal(output.metadata.sourceFacts,0)
  assert.equal(output.metadata.trimmed,true)
})
test('safety limits prevent arbitrary source changes and duplicate page identities',()=>{
  assert.throws(()=>selectEvidencePages([{pageNumber:1,text:'a'},{
    pageNumber:1,text:'b'}]))
  assert.throws(()=>selectEvidencePages([{pageNumber:1,text:'a'}],{
    maxBytes:8001}))
})
