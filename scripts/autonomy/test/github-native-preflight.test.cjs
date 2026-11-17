'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { inspectGithubNativePreflight } = require('../github-native-preflight.cjs')
const root = 'https://api.github.com/repos/HamedGithubforwork/QuizForge-AI'
const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const prNumber = 999
const runId = 123456

function fixture() {
  const repo = { id:1307099196, owner:{id:148009407}, full_name:'HamedGithubforwork/QuizForge-AI',
    default_branch:'main', allow_auto_merge:false }
  const pr = { number:prNumber,state:'open',draft:false,merged:false,mergeable:true,
    head:{sha:head,repo:{id:repo.id}},base:{ref:'main',sha:base,repo:{id:repo.id}} }
  const main = { protected:true, commit:{sha:base} }
  const rules = {
    id:21886458,source_type:'Repository',source:repo.full_name,target:'branch',
    enforcement:'active',bypass_actors:[],conditions:{ref_name:{include:['~DEFAULT_BRANCH'],exclude:[]}},
    rules:[
      {type:'pull_request'}, {type:'merge_queue'},
      {type:'required_status_checks',parameters:{strict_required_status_checks_policy:true,
        required_status_checks:[{context:'Required PR gate',integration_id:15368}]}},
    ],
  }
  const gate = { id:77,name:'Required PR gate',head_sha:head,status:'completed',
    conclusion:'success',app:{id:15368},check_suite:{id:111},
    details_url:'https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/'+runId+'/job/3' }
  const checks = { total_count:1,check_runs:[gate] }
  const association = [{number:prNumber,head:{sha:head},base:{ref:'main',repo:{id:repo.id}}}]
  const run = {id:runId,workflow_id:330113334,path:'.github/workflows/ci.yml',
    event:'pull_request',head_sha:head,check_suite_id:111,
    status:'completed',conclusion:'success',repository:{id:repo.id}}
  const values = {
    [root]:repo,
    [root+'/pulls/'+prNumber]:pr,
    [root+'/branches/main']:main,
    [root+'/rulesets/21886458']:rules,
    [root+'/commits/'+head+'/check-runs?per_page=100']:checks,
    [root+'/commits/'+head+'/pulls?per_page=100']:association,
    [root+'/actions/runs/'+runId]:run,
  }
  return {values,repo,pr,main,rules,gate,checks,association,run}
}
async function inspect(f, read) {
  return inspectGithubNativePreflight({
    prNumber,read:read || (async url => structuredClone(f.values[url])),
  })
}

test('successful GitHub preflight is never automatic merge authority',async()=>{
  const r=await inspect(fixture())
  assert.equal(r.verified,true)
  assert.equal(r.mergeAuthorized,false)
  assert.equal(r.reason,'read_only_preflight_only')
  assert.equal(r.headSha,head)
  assert.equal(r.baseSha,base)
})
const cases = [
  ['repository identity', f=>f.repo.id=9,'repository_identity_or_settings_mismatch'],
  ['auto-merge turned on', f=>f.repo.allow_auto_merge=true,'repository_identity_or_settings_mismatch'],
  ['retargeted PR', f=>f.pr.base.ref='release','pr_head_base_or_scope_unverified'],
  ['outdated base', f=>f.pr.base.sha='c'.repeat(40),'pr_head_base_or_scope_unverified'],
  ['unmergeable PR', f=>f.pr.mergeable=null,'pr_head_base_or_scope_unverified'],
  ['wrong check app', f=>f.gate.app.id=123,'required_gate_unverified'],
  ['skipped required check', f=>f.gate.conclusion='skipped','required_gate_unverified'],
  ['check from another head', f=>f.gate.head_sha='c'.repeat(40),'required_gate_unverified'],
  ['forged check URL', f=>f.gate.details_url='https://evil.example/run/1','required_gate_unverified'],
  ['wrong workflow identity', f=>f.run.workflow_id=1234,'ci_run_unverified'],
  ['failed workflow', f=>f.run.conclusion='failure','ci_run_unverified'],
  ['check suite mismatch', f=>f.run.check_suite_id=222,'ci_run_unverified'],
  ['missing PR association', f=>f.association.splice(0),'github_check_or_pr_association_unverified'],
  ['ambiguous required check', f=>{f.checks.check_runs.push({...f.gate});f.checks.total_count=2},'required_gate_ambiguous_or_missing'],
  ['queue not enforced', f=>f.rules.rules=f.rules.rules.filter(x=>x.type!=='merge_queue'),'merge_queue_not_enforced'],
  ['required check removed', f=>f.rules.rules.find(x=>x.type==='required_status_checks').parameters.required_status_checks=[],'required_gate_not_enforced'],
  ['branch bypass allowed', f=>f.rules.bypass_actors.push({actor_id:3}),'protections_unverified'],
  ['ruleset excludes main', f=>f.rules.conditions.ref_name.exclude.push('refs/heads/main'),'protections_unverified'],
]
for (const [name,modify,reason] of cases) {
  test(name,async()=>{
    const f=fixture()
    modify(f)
    const r=await inspect(f)
    assert.equal(r.mergeAuthorized,false)
    assert.equal(r.reason,reason)
  })
}
test('PR head moving during inspection fails closed',async()=>{
  const f=fixture();let count=0
  const r=await inspect(f,async url=>{
    if(url===root+'/pulls/'+prNumber&&++count===2) {
      return {...f.pr,head:{...f.pr.head,sha:'c'.repeat(40)}}
    }
    return structuredClone(f.values[url])
  })
  assert.equal(r.reason,'state_changed_during_preflight')
  assert.equal(r.mergeAuthorized,false)
})
test('ruleset changing during inspection fails closed',async()=>{
  const f=fixture();let count=0
  const r=await inspect(f,async url=>{
    if(url===root+'/rulesets/21886458'&&++count===2) {
      return {...f.rules,bypass_actors:[{actor_id:3}]}
    }
    return structuredClone(f.values[url])
  })
  assert.equal(r.reason,'state_changed_during_preflight')
})
test('repo settings changing during inspection fails closed',async()=>{
  const f=fixture();let count=0
  const r=await inspect(f,async url=>{
    if(url===root&&++count===2) return {...f.repo,allow_auto_merge:true}
    return structuredClone(f.values[url])
  })
  assert.equal(r.reason,'state_changed_during_preflight')
})
test('API outage fails closed without merge authority',async()=>{
  const r=await inspect(fixture(),async()=>{throw Error('API outage')})
  assert.deepEqual(r,{verified:false,mergeAuthorized:false,reason:'github_unavailable_or_invalid'})
})
test('invalid PR number never invokes GitHub',async()=>{
  const r=await inspectGithubNativePreflight({prNumber:0,read:async()=>{throw Error('called')}})
  assert.equal(r.reason,'invalid_input')
})
