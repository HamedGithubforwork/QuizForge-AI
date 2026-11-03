'use strict'
const { test }=require('node:test')
const assert=require('node:assert/strict')
const {CASES,MODEL_ID,assertExtracted,assertQuiz,reason,extractionMetrics}=
 require('../scripts/verify-real-pdf-desktop-lifecycle.cjs')
test('two real PDF origins and pinned experimental model',()=>{
  assert.equal(MODEL_ID,'qwen3-1p7b-q4-k-m')
  assert.equal(CASES.length,2)
  assert.equal(new Set(CASES.map(c=>new URL(c.url).hostname)).size,2)
  assert.ok(CASES.every(c=>c.url.startsWith('https://')&&c.filename.endsWith('.pdf')))
  assert.equal(CASES[0].allowPartial,undefined)
  assert.equal(CASES[1].allowPartial,true)
})
test('PDF.js extraction requires text and selected-page fidelity',()=>{
  const tc=CASES[0]
  const page={pageNumber:1,text:'earthquake shaking '.repeat(10)}
  const doc={processing:'local',scannedLikely:false,characterCount:175,pages:[page]}
  assert.doesNotThrow(()=>assertExtracted(doc,tc))
  assert.throws(()=>assertExtracted({...doc,scannedLikely:true},tc))
  assert.throws(()=>assertExtracted({...doc,pages:[{...page,pageNumber:2}]},tc))
  const m=extractionMetrics(doc,tc)
  assert.equal(m.anchorChecks.every(Boolean),true)
  assert.ok(m.sourceUtf8Bytes<8000)
  assert.throws(()=>assertExtracted({...doc,pages:[{
    ...page,text:page.text+'X'.repeat(10000)}]},tc))
})
test('quiz acceptance rejects duplicates, wrong count and unsupported citations',()=>{
  const data={questions:Array.from({length:5},(_,i)=>({
    question_type:'short_answer',question:'What was fact '+i+'?',
    correct_answer:'fact '+i,source_pages:[1]}))}
  assert.doesNotThrow(()=>assertQuiz(data,[1]))
  assert.throws(()=>assertQuiz({questions:data.questions.slice(1)},[1]))
  assert.doesNotThrow(()=>assertQuiz({questions:data.questions.slice(1)},[1],
    {allowPartial:true}))
  assert.throws(()=>assertQuiz({questions:[]},[1],{allowPartial:true}))
  assert.throws(()=>assertQuiz({questions:[...data.questions.slice(0,4),data.questions[0]]},[1]))
  assert.throws(()=>assertQuiz({questions:[...data.questions.slice(0,4),
    {...data.questions[4],source_pages:[2]}]},[1]))
})
test('private errors never enter public report reason fields',()=>{
  assert.equal(reason({code:'quiz_validation_failed',message:'secret text'}),'quiz_validation_failed')
  assert.equal(reason({code:'secret',message:'private source'}),'unclassified')
  assert.equal(reason({code:'ERR_ASSERTION',message:'private PDF content'}),'source_validation_failed')
})
