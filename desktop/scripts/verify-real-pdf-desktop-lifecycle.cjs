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
  { id:'usgs_water_cycle', filename:'usgs-water-cycle.pdf',
    url:'https://pubs.usgs.gov/gip/221/gip221_english.pdf',
    selectedPages:[1], anchors:['the water cycle','pools','human activities'] },
  { id:'loc_primary_sources', filename:'loc-primary-sources.pdf',
    url:'https://www.loc.gov/static/programs/teachers/getting-started-with-primary-sources/documents/Analyzing_Primary_Sources.pdf',
    selectedPages:[1], anchors:['observe','reflect','question'] },
])
const SAFE = new Set(['processing_failed','input_too_large','invalid_input',
  'invalid_selection','invalid_result','too_many_pages','source_too_large',
  'insufficient_source','document_too_large','runtime_unavailable',
  'runtime_invalid','model_missing','invalid_model','quiz_validation_failed',
  'generation_failed','insufficient_memory','busy','cancelled','not_ready'])
const reason = error => SAFE.has(error?.code) ? error.code : 'unclassified'
function assertExtracted(doc, testcase) {
  assert.equal(doc.processing,'local')
  assert.equal(doc.scannedLikely,false)
  assert.deepEqual(doc.pages.map(p=>p.pageNumber),testcase.selectedPages)
  assert.ok(doc.characterCount >=100 && doc.characterCount<=8000)
  const text=doc.pages.map(x=>x.text).join(' ').toLowerCase()
  for (const anchor of testcase.anchors) assert.ok(text.includes(anchor),'PDF source anchor missing')
}
function assertQuiz(quiz, selectedPages) {
  assert.ok(Array.isArray(quiz?.questions))
  assert.equal(quiz.questions.length,5)
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
    assertExtracted(extracted,tc)
    out.import='passed'
    out.pdfSha256=extracted.pdfSha256
    out.characters=extracted.characterCount
    out.stage='generating'
    const result=await stack.generateDocumentQuiz({
      ...docRequest,questionCount:5,difficulty:'easy',questionType:'short_answer'})
    assert.equal(result.processing,'local')
    assert.equal(result.documentSha256,extracted.pdfSha256)
    assert.deepEqual(result.selectedPages,tc.selectedPages)
    assertQuiz(result.quiz,tc.selectedPages)
    out.quiz='passed'
    out.questions=result.quiz.questions.length
    out.stage='completed'
    console.log('REAL PDF '+tc.id+' import=passed quiz=passed')
  } catch(error) {
    out.reason=reason(error)
    if(out.import!=='passed')out.import='failed'
    else out.quiz='failed'
    console.error('REAL PDF '+tc.id+' stage='+out.stage+' reason='+out.reason)
  }
  return out
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
module.exports={CASES,MODEL_ID,assertExtracted,assertQuiz,reason,main}
if(require.main===module)main().catch(()=>{
  console.error('Real PDF acceptance failure: unclassified')
  process.exitCode=1
})
