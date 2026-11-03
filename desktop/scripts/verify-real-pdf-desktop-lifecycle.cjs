'use strict'
// Real official PDF bytes -> PDF.js -> actual Windows Local AI document quiz.
// No UI/installer is simulated. Never log source text, prompt, answer, or raw errors.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createLocalDocumentProcessor } = require('../src/local-document-processing.cjs')
const { createPdfJsLocalEngine } = require('../src/pdfjs-local-engine.cjs')
const { createWindowsLocalAiStack } = require('../src/windows-local-ai-stack.cjs')
const MODEL_ID = 'qwen3-1p7b-q4-k-m'
const CASES = Object.freeze([
  { id:'usgs_earthquake_shaking', filename:'usgs-earthquake-shaking.pdf',
    url:'https://pubs.usgs.gov/fs/2001/fs001-01/fs001-01.pdf',
    selectedPages:[1], anchors:['earthquake','shaking'] },
  { id:'loc_primary_sources', filename:'loc-primary-sources.pdf',
    url:'https://www.loc.gov/static/programs/teachers/getting-started-with-primary-sources/documents/Analyzing_Primary_Sources.pdf',
    selectedPages:[1], anchors:['reflect','question'], allowPartial:true },
])
const SAFE = new Set(['processing_failed','input_too_large','invalid_input',
  'invalid_selection','invalid_result','too_many_pages','source_too_large',
  'insufficient_source','document_too_large','runtime_unavailable',
  'runtime_invalid','model_missing','invalid_model','quiz_validation_failed',
  'generation_failed','insufficient_memory','busy','cancelled','not_ready'])
const reason = error => error?.code === 'ERR_ASSERTION' ? 'source_validation_failed' :
  (SAFE.has(error?.code) ? error.code : 'unclassified')
const normalizedText = value => String(value).normalize('NFKC').toLowerCase()
  .replace(/\s+/g,' ').trim()
function extractionMetrics(doc,tc) {
  const selectedText=Array.isArray(doc?.pages)?doc.pages.map(p=>p.text).join(' '):''
  const content=normalizedText(selectedText)
  return {
    pageCount:doc?.pageCount??null,selectedPageCount:doc?.pages?.length??null,
    scannedLikely:doc?.scannedLikely===true,
    characterCount:doc?.characterCount??null,
    sourceUtf8Bytes:Buffer.byteLength(selectedText,'utf8'),
    selectedPages:Array.isArray(doc?.pages)?doc.pages.map(p=>p.pageNumber):[],
    anchorChecks:tc.anchors.map(a=>content.includes(normalizedText(a))),
  }
}
function assertExtracted(doc, testcase) {
  assert.equal(doc.processing,'local')
  assert.equal(doc.scannedLikely,false)
  assert.deepEqual(doc.pages.map(p=>p.pageNumber),testcase.selectedPages)
  assert.ok(doc.characterCount >= 100)
  const metrics=extractionMetrics(doc,testcase)
  assert.ok(metrics.sourceUtf8Bytes<=8000,'Local AI selected source size exceeded')
  assert.ok(metrics.anchorChecks.every(Boolean),'PDF source anchor missing')
}
function assertQuiz(quiz, selectedPages, { allowPartial = false } = {}) {
  assert.ok(Array.isArray(quiz?.questions))
  if (allowPartial) {
    assert.ok(quiz.questions.length >= 1 && quiz.questions.length <= 5,
      'partial quizzes must contain 1–5 verified questions')
  } else assert.equal(quiz.questions.length,5)
  const normalized=new Set()
  for (const question of quiz.questions) {
    assert.equal(question.question_type,'short_answer')
    assert.ok(typeof question.question==='string'&&question.question.trim().length>8)
    assert.ok(typeof question.correct_answer==='string'&&question.correct_answer.trim().length>0)
    assert.ok(Array.isArray(question.source_pages)&&question.source_pages.length>0)
    assert.ok(question.source_pages.every(p=>selectedPages.includes(p)))
    const key=question.question.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
    assert.ok(!normalized.has(key),'duplicate question')
    normalized.add(key)
  }
}
async function checkOne(stack,tc,dir) {
  const out={id:tc.id,officialSource:tc.url,selectedPages:tc.selectedPages,
    import:'pending',quiz:'pending',questions:0,reason:null,stage:'reading'}
  try {
    const bytes=new Uint8Array(await fs.readFile(path.join(dir,tc.filename)))
    assert.ok(bytes.length>=8&&bytes.length<=15*1024*1024)
    const docRequest={bytes,filename:tc.filename,selectedPages:tc.selectedPages}
    out.stage='extracting'
    const extracted=await stack.processDocument(docRequest)
    out.pdfSha256=extracted.pdfSha256
    out.extraction=extractionMetrics(extracted,tc)
    out.stage='checking_extraction'
    assertExtracted(extracted,tc)
    out.import='passed'
    out.stage='generating'
    const result=await stack.generateDocumentQuiz({
      ...docRequest,questionCount:5,difficulty:'easy',questionType:'short_answer'})
    assert.equal(result.processing,'local')
    assert.equal(result.documentSha256,extracted.pdfSha256)
    assert.deepEqual(result.selectedPages,tc.selectedPages)
    out.questions=Array.isArray(result.quiz?.questions)?
      result.quiz.questions.length:0
    const generation=result.quiz?.generation??{}
    out.generation={
      sourceGroundedExperimental:generation.sourceGroundedExperimental===true,
      requestedCount:generation.requestedCount??null,
      verifiedCount:generation.verifiedCount??null,
      partial:generation.partial===true,
      modelAcceptedCount:generation.modelAcceptedCount??null,
      repairedCount:generation.repairedCount??null,
      candidateCount:generation.candidateCount??null,
      replenishmentAttempted:generation.replenishmentAttempted===true,
      distinctness:generation.distinctness??'unavailable',
    }
    assert.equal(out.generation.sourceGroundedExperimental,true,
      'test must exercise the experimental desktop generator')
    assert.equal(out.generation.verifiedCount,out.questions)
    assert.equal(out.generation.requestedCount,5)
    assert.equal(out.generation.partial,out.questions<5)
    assert.equal(out.generation.modelAcceptedCount+
      out.generation.repairedCount,out.questions,
      'The final counters must exclude discarded duplicates')
    assertQuiz(result.quiz,tc.selectedPages,{allowPartial:tc.allowPartial===true})
    out.quiz='passed'
    out.stage='completed'
    console.log('REAL PDF '+tc.id+' import=passed quiz=passed count='+
      out.questions+' partial='+out.generation.partial+
      ' modelAccepted='+out.generation.modelAcceptedCount+
      ' repaired='+out.generation.repairedCount)
  } catch(error) {
    out.reason=reason(error)
    if(out.import!=='passed')out.import='failed'
    else out.quiz='failed'
    console.error('REAL PDF '+tc.id+' stage='+out.stage+' reason='+out.reason)
  }
  return out
}
// Run BEFORE runtime/model downloads. PDF text itself never enters the report.
async function preflight(pdfDir,output) {
  const processor=createLocalDocumentProcessor({engine:createPdfJsLocalEngine()})
  const report={schema:1,phase:'pdfjs_preflight',outcome:'incomplete',cases:[]}
  for(const tc of CASES){
    const row={id:tc.id,source:tc.url,result:'pending',reason:null}
    try {
      const bytes=new Uint8Array(await fs.readFile(path.join(pdfDir,tc.filename)))
      const doc=await processor.processPdf({
        bytes,filename:tc.filename,selectedPages:tc.selectedPages})
      row.extraction=extractionMetrics(doc,tc)
      row.pdfSha256=doc.pdfSha256
      assertExtracted(doc,tc)
      row.result='passed'
    }catch(error){
      row.result='failed'
      row.reason=reason(error)
    }
    report.cases.push(row)
    console.log('PDF PREFLIGHT '+row.id+' result='+row.result+
      ' reason='+(row.reason??'none')+
      ' characters='+(row.extraction?.characterCount??'unknown')+
      ' utf8Bytes='+(row.extraction?.sourceUtf8Bytes??'unknown')+
      ' anchors='+(row.extraction?.anchorChecks?.filter(Boolean).length??0)+
      '/'+tc.anchors.length)
  }
  report.outcome=report.cases.every(c=>c.result==='passed')?'passed':'failed'
  await fs.writeFile(path.resolve(output),JSON.stringify(report,null,2)+'\n')
  if(report.outcome!=='passed')process.exitCode=1
}
async function main(){
  assert.equal(process.platform,'win32')
  const [runtimeDir,modelDir,pdfDir,output]=process.argv.slice(2)
  assert.ok(runtimeDir&&modelDir&&pdfDir&&output)
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'qfn-pdf-e2e-'))
  const report={schema:1,modelId:MODEL_ID,pipeline:'windows_local_document_quiz',
    actualPdfBytes:true,guiTested:false,cloudAllowed:false,
    outcome:'incomplete',readiness:null,cases:[],diagnostics:[]}
  let stack
  const originalFetch=globalThis.fetch
  try {
    globalThis.fetch=async()=>{throw new Error('cloud_disabled')}
    stack=createWindowsLocalAiStack({
      userDataDirectory:tmp,modelDirectory:path.resolve(modelDir),
      runtimeDirectory:path.resolve(runtimeDir),benchmarkModelId:MODEL_ID,
      experimentalSourceGroundedPdf:true,
      documentProcessor:createLocalDocumentProcessor({engine:createPdfJsLocalEngine()}),
      onDiagnostic(event,fields) {
        if(!['operation_started','operation_completed','operation_failed',
          'validation_failed','question_rejected'].includes(event))return
        if(report.diagnostics.length>=25)return
        report.diagnostics.push({event,
          ...(SAFE.has(fields?.reason)?{reason:fields.reason}:{})})
      },
    })
    const status=await stack.quizStatus()
    report.readiness=status.available?'ready':reason({code:status.reason})
    for(const tc of CASES)report.cases.push(await checkOne(stack,tc,path.resolve(pdfDir)))
    report.outcome=report.readiness==='ready'&&
      report.cases.every(c=>c.import==='passed'&&c.quiz==='passed')?'passed':'failed'
  } catch(error){
    report.outcome='failed'
    report.fatalReason=reason(error)
  } finally {
    globalThis.fetch=originalFetch
    await stack?.dispose().catch(()=>{})
    await fs.writeFile(path.resolve(output),JSON.stringify(report,null,2)+'\n')
    await fs.rm(tmp,{recursive:true,force:true})
  }
  console.log('REAL PDF DESKTOP RESULT '+report.outcome+' successes='+
    report.cases.filter(c=>c.quiz==='passed').length+'/'+CASES.length)
  if(report.outcome!=='passed')process.exitCode=1
}
module.exports={CASES,MODEL_ID,assertExtracted,assertQuiz,reason,extractionMetrics,preflight,main}
if(require.main===module){
  const run=process.argv[2]==='--preflight'
    ? preflight(path.resolve(process.argv[3]),path.resolve(process.argv[4]))
    : main()
  run.catch(()=>{
    console.error('Real PDF acceptance failure: unclassified')
    process.exitCode=1
  })
}
