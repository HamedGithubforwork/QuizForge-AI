'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { inspectGithubNativePreflight } = require('../github-native-preflight.cjs')
const root = 'https://api.github.com/repos/HamedGithubforwork/QuizForge-AI'
const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const prNumber = 999
const runId = 123456
const ciWorkflowPath = '.github/workflows/ci.yml'

function pageUrl(suffix, page) {
  return root + suffix + '?per_page=100&page=' + page
}

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
  const run = {id:runId,workflow_id:330113334,path:ciWorkflowPath,
    event:'pull_request',head_sha:head,check_suite_id:111,
    status:'completed',conclusion:'success',repository:{id:repo.id},
    pull_requests:[{number:prNumber,head:{sha:head,repo:{id:repo.id}},
      base:{ref:'main',sha:base,repo:{id:repo.id}}}]}
  const values = {
    [root]:repo,
    [root+'/pulls/'+prNumber]:pr,
    [root+'/branches/main']:main,
    [root+'/rulesets/21886458']:rules,
    [pageUrl('/commits/'+head+'/check-runs',1)]:checks,
    [pageUrl('/commits/'+head+'/pulls',1)]:association,
    [root+'/contents/'+ciWorkflowPath+'?ref='+base]:{type:'file',sha:'c'.repeat(40)},
    [root+'/contents/'+ciWorkflowPath+'?ref='+head]:{type:'file',sha:'c'.repeat(40)},
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
  assert.equal(r.status,'OBSERVATION_ONLY')
  assert.equal(Object.hasOwn(r,'verified'),false)
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
  ['workflow run missing PR association', f=>delete f.run.pull_requests,'ci_run_unverified'],
  ['workflow run associated with another PR', f=>f.run.pull_requests[0].number=998,'ci_run_unverified'],
  ['workflow run associated with another PR base', f=>f.run.pull_requests[0].base.sha='c'.repeat(40),'ci_run_unverified'],
  ['workflow run associated with another target', f=>f.run.pull_requests[0].base.ref='release','ci_run_unverified'],
  ['workflow run associated with another head', f=>f.run.pull_requests[0].head.sha='c'.repeat(40),'ci_run_unverified'],
  ['workflow run associated with another repository', f=>f.run.pull_requests[0].base.repo.id=9,'ci_run_unverified'],
  ['missing PR association', f=>f.association.splice(0),'github_check_or_pr_association_unverified'],
  ['ambiguous required check', f=>{f.checks.check_runs.push({...f.gate});f.checks.total_count=2},'required_gate_unverified'],
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
test('required gate changing during final revalidation fails closed',async()=>{
  const f=fixture();let count=0
  const checksUrl=pageUrl('/commits/'+head+'/check-runs',1)
  const r=await inspect(f,async url=>{
    if(url===checksUrl&&++count===2) {
      const checks=structuredClone(f.values[url])
      checks.check_runs[0].conclusion='failure'
      return checks
    }
    return structuredClone(f.values[url])
  })
  assert.equal(r.status,'UNVERIFIED')
  assert.equal(r.reason,'state_changed_during_preflight')
  assert.equal(r.mergeAuthorized,false)
})
test('workflow PR association changing during final revalidation fails closed',async()=>{
  const f=fixture();let count=0
  const runUrl=root+'/actions/runs/'+runId
  const r=await inspect(f,async url=>{
    if(url===runUrl&&++count===2) {
      const run=structuredClone(f.values[url])
      run.pull_requests[0].base.sha='c'.repeat(40)
      return run
    }
    return structuredClone(f.values[url])
  })
  assert.equal(r.status,'UNVERIFIED')
  assert.equal(r.reason,'state_changed_during_preflight')
  assert.equal(r.mergeAuthorized,false)
})
test('API outage fails closed without merge authority',async()=>{
  const r=await inspect(fixture(),async()=>{throw Error('API outage')})
  assert.deepEqual(r,{status:'UNVERIFIED',mergeAuthorized:false,reason:'github_unavailable_or_invalid'})
})
test('invalid PR number never invokes GitHub',async()=>{
  const r=await inspectGithubNativePreflight({prNumber:0,read:async()=>{throw Error('called')}})
  assert.equal(r.reason,'invalid_input')
})
test('undefined options fail closed without throwing', async()=>{
  const r = await inspectGithubNativePreflight()
  assert.deepEqual(r,{status:'UNVERIFIED',mergeAuthorized:false,reason:'invalid_input'})
})

test('null options fail closed without throwing', async()=>{
  const r = await inspectGithubNativePreflight(null)
  assert.deepEqual(r,{status:'UNVERIFIED',mergeAuthorized:false,reason:'invalid_input'})
})

test('changed CI workflow blob is not trusted', async()=>{
  const f=fixture()
  f.values[root+'/contents/'+ciWorkflowPath+'?ref='+head].sha='d'.repeat(40)
  const r=await inspect(f)
  assert.equal(r.reason,'ci_workflow_definition_changed_or_unverified')
  assert.equal(r.mergeAuthorized,false)
})

test('CI workflow change during final revalidation invalidates evidence', async()=>{
  const f=fixture();let headWorkflowReads=0
  const url=root+'/contents/'+ciWorkflowPath+'?ref='+head
  const r=await inspect(f,async requestUrl=>{
    if(requestUrl===url&&++headWorkflowReads===2) return {type:'file',sha:'d'.repeat(40)}
    return structuredClone(f.values[requestUrl])
  })
  assert.equal(r.status,'UNVERIFIED')
  assert.equal(r.reason,'state_changed_during_preflight')
  assert.equal(r.mergeAuthorized,false)
})

test('missing or malformed CI workflow identity fails closed', async t=>{
  for (const [name, value] of [
    ['missing', undefined], ['wrong type', {type:'dir',sha:'c'.repeat(40)}],
    ['invalid blob SHA', {type:'file',sha:'not-a-sha'}],
  ]) {
    await t.test(name, async()=>{
      const f=fixture()
      f.values[root+'/contents/'+ciWorkflowPath+'?ref='+base]=value
      const r=await inspect(f)
      assert.equal(r.reason,'ci_workflow_definition_changed_or_unverified')
      assert.equal(r.mergeAuthorized,false)
    })
  }
})

test('workflow path is checked against the observed GitHub API format', async()=>{
  const f=fixture()
  // Live GET /actions/runs evidence for run 44029170185 reports this exact,
  // unsuffixed path. A guessed @refs/... suffix is not accepted as evidence.
  const accepted=await inspect(f)
  assert.equal(accepted.status,'OBSERVATION_ONLY')
  f.run.path=ciWorkflowPath+'@refs/pull/711/merge'
  const rejected=await inspect(f)
  assert.equal(rejected.reason,'ci_run_unverified')
  assert.equal(rejected.mergeAuthorized,false)
})

test('check-run pagination finds the unique required gate on a later page', async()=>{
  const f=fixture()
  const dummies=Array.from({length:100},(_,i)=>({id:1000+i,name:'other check '+i,
    head_sha:head,status:'completed',conclusion:'success'}))
  f.values[pageUrl('/commits/'+head+'/check-runs',1)]={total_count:101,check_runs:dummies}
  f.values[pageUrl('/commits/'+head+'/check-runs',2)]={total_count:101,check_runs:[f.gate]}
  const r=await inspect(f)
  assert.equal(r.status,'OBSERVATION_ONLY')
  assert.equal(r.mergeAuthorized,false)
})

test('associated PR pagination finds the candidate on a later page', async()=>{
  const f=fixture()
  const unrelated=Array.from({length:100},(_,i)=>({number:i+1,
    head:{sha:'d'.repeat(40)},base:{ref:'other',repo:{id:1307099196}}}))
  f.values[pageUrl('/commits/'+head+'/pulls',1)]=unrelated
  f.values[pageUrl('/commits/'+head+'/pulls',2)]=f.association
  const r=await inspect(f)
  assert.equal(r.status,'OBSERVATION_ONLY')
  assert.equal(r.mergeAuthorized,false)
})

test('incomplete check-run pagination fails closed', async()=>{
  const f=fixture()
  f.values[pageUrl('/commits/'+head+'/check-runs',1)]={total_count:101,check_runs:[f.gate]}
  const r=await inspect(f)
  assert.equal(r.status,'UNVERIFIED')
  assert.equal(r.reason,'required_gate_unverified')
  assert.equal(r.mergeAuthorized,false)
})

test('inconsistent check-run page totals fail closed', async()=>{
  const f=fixture()
  const dummies=Array.from({length:100},(_,i)=>({id:1000+i,name:'other check '+i,
    head_sha:head,status:'completed',conclusion:'success'}))
  f.values[pageUrl('/commits/'+head+'/check-runs',1)]={total_count:101,check_runs:dummies}
  f.values[pageUrl('/commits/'+head+'/check-runs',2)]={total_count:102,check_runs:[f.gate]}
  const r=await inspect(f)
  assert.equal(r.status,'UNVERIFIED')
  assert.equal(r.reason,'required_gate_unverified')
})

test('final default branch change invalidates ruleset evidence', async()=>{
  const f=fixture();let count=0
  const r=await inspect(f,async url=>{
    if(url===root&&++count===2) return {...f.repo,default_branch:'release'}
    return structuredClone(f.values[url])
  })
  assert.equal(r.reason,'state_changed_during_preflight')
  assert.equal(r.mergeAuthorized,false)
})

test('final PR head repository change invalidates evidence', async()=>{
  const f=fixture();let count=0
  const r=await inspect(f,async url=>{
    if(url===root+'/pulls/'+prNumber&&++count===2) {
      return {...f.pr,head:{...f.pr.head,repo:{id:9}}}
    }
    return structuredClone(f.values[url])
  })
  assert.equal(r.reason,'state_changed_during_preflight')
  assert.equal(r.mergeAuthorized,false)
})
