'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  inspectGithubPrRiskReview, classifyRisk, TRUSTED_WORKFLOW_BLOBS,
} = require('../github-pr-risk-review.cjs')

const repoRoot = 'https://api.github.com/repos/HamedGithubforwork/QuizForge-AI'
const repositoryId = 1307099196
const ownerId = 148009407
const prNumber = 42
const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const gateRunId = 9812
const gateCheckId = 9912

function fixture(changes = [{filename:'docs/feature.md',status:'added',sha:'c'.repeat(40),
  additions:1,deletions:0,changes:1,patch:'+note'}]) {
  let currentHead = head
  let currentBase = base
  let currentFiles = changes
  let reviews = [{id:5,state:'APPROVED',commit_id:head,submitted_at:'2026-11-16T00:00:00Z',
    body:'',author_association:'OWNER',user:{id:8,login:'reviewer',type:'User'}}]
  let comments = []
  let checkRuns = [{id:gateCheckId,name:'Required PR gate',head_sha:head,status:'completed',
    conclusion:'success',app:{id:15368},details_url:`https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/${gateRunId}/job/22`}]
  let run = {id:gateRunId,workflow_id:330113334,path:'.github/workflows/ci.yml',event:'pull_request',
    head_sha:head,status:'completed',conclusion:'success',repository:{id:repositoryId},
    pull_requests:[{number:prNumber,head:{repo:{id:repositoryId},sha:head},
      base:{repo:{id:repositoryId},ref:'main',sha:base}}]}
  let ruleset = {id:21886458,source_type:'Repository',source:'HamedGithubforwork/QuizForge-AI',
    target:'branch',enforcement:'active',bypass_actors:[],
    conditions:{ref_name:{include:['~DEFAULT_BRANCH'],exclude:[]}},
    rules:[{type:'pull_request',parameters:{required_approving_review_count:1,required_reviewers:[]}},
      {type:'required_status_checks',parameters:{strict_required_status_checks_policy:true,
        required_status_checks:[{context:'Required PR gate',integration_id:15368}]}}]}
  const activeRulesetSummary = [{id:21886458,name:'Protect main',target:'branch',source_type:'Repository',
    source:'HamedGithubforwork/QuizForge-AI',enforcement:'active'}]
  const effectiveRules = [
    {type:'deletion',ruleset_id:21886458,ruleset_source_type:'Repository',ruleset_source:'HamedGithubforwork/QuizForge-AI'},
    {type:'non_fast_forward',ruleset_id:21886458,ruleset_source_type:'Repository',ruleset_source:'HamedGithubforwork/QuizForge-AI'},
    {type:'pull_request',ruleset_id:21886458,ruleset_source_type:'Repository',ruleset_source:'HamedGithubforwork/QuizForge-AI',
      parameters:{required_approving_review_count:1,required_reviewers:[]}},
    {type:'required_status_checks',ruleset_id:21886458,ruleset_source_type:'Repository',ruleset_source:'HamedGithubforwork/QuizForge-AI',
      parameters:{strict_required_status_checks_policy:true,
        required_status_checks:[{context:'Required PR gate',integration_id:15368}]}},
  ]
  const workflowInventory = Object.entries(TRUSTED_WORKFLOW_BLOBS).map(([path,sha]) => ({type:'file',path,sha}))
  const codeSha = 'd'.repeat(40)
  const calls = new Map()

  function route(url) {
    const parsed = new URL(url)
    const path = parsed.pathname.replace('/repos/HamedGithubforwork/QuizForge-AI','')
    const page = Number(parsed.searchParams.get('page') ?? '1')
    if (path === '') return {id:repositoryId,owner:{id:ownerId},full_name:'HamedGithubforwork/QuizForge-AI',
      default_branch:'main',allow_auto_merge:false}
    if (path === `/pulls/${prNumber}`) return {number:prNumber,state:'open',draft:false,merged:false,
      mergeable:true,mergeable_state:'clean',
      changed_files:currentFiles.length,user:{id:7},head:{sha:currentHead,repo:{id:repositoryId}},
      base:{ref:'main',sha:currentBase,repo:{id:repositoryId}}}
    if (path === '/branches/main') return {protected:true,commit:{sha:currentBase}}
    if (path === '/branches/main/protection') return {__httpStatus:404}
    if (path === '/rulesets/21886458') return ruleset
    if (path === '/rulesets') return activeRulesetSummary
    if (path === '/rules/branches/main') return effectiveRules
    if (path === `/pulls/${prNumber}/files`) return currentFiles.slice((page - 1) * 100,page * 100)
    if (path === `/pulls/${prNumber}/reviews`) return page === 1 ? reviews : []
    if (path === `/pulls/${prNumber}/comments`) return page === 1 ? comments : []
    if (path === `/issues/${prNumber}/comments`) return []
    if (path === `/commits/${currentHead}/check-runs`) return {total_count:checkRuns.length,
      check_runs:checkRuns.slice((page - 1) * 100,page * 100)}
    if (path === `/actions/runs/${gateRunId}`) return run
    if (path === '/contents/.github/workflows') return workflowInventory
    if (path.startsWith('/contents/')) return {type:'file',sha:codeSha}
    throw new Error(`Unexpected read URL: ${url}`)
  }
  return {
    read: async url => {
      const key = new URL(url).pathname + new URL(url).search
      calls.set(key,(calls.get(key) ?? 0) + 1)
      return structuredClone(route(url))
    },
    setFiles(value) { currentFiles = value },
    setReviews(value) { reviews = value },
    setComments(value) { comments = value },
    setChecks(value) { checkRuns = value },
    getCheck() { return structuredClone(checkRuns[0]) },
    setRun(value) { run = value },
    getRun() { return structuredClone(run) },
    setRuleset(value) { ruleset = value },
    setHead(value) { currentHead = value },
    setBase(value) { currentBase = value },
    calls,
  }
}

async function inspectWithRead(read) {
  const previousFetch = global.fetch
  global.fetch = async url => {
    const value = await read(String(url))
    if (value?.__httpStatus) return {ok:false,status:value.__httpStatus,json:async () => value}
    return {ok:true,status:200,json:async () => value}
  }
  try { return await inspectGithubPrRiskReview({prNumber}) }
  finally { global.fetch = previousFetch }
}

test('clean evidence is observation-only and cannot authorize a merge', async () => {
  const data = fixture()
  const result = await inspectWithRead(data.read)
  assert.equal(result.status,'OBSERVATION_ONLY')
  assert.equal(result.mergeAuthorized,false)
  assert.equal(result.headSha,head)
  assert.equal(result.baseSha,base)
  assert.match(result.diffSha256,/^[a-f0-9]{64}$/)
  assert.match(result.reviewEvidenceSha256,/^[a-f0-9]{64}$/)
  assert.match(result.rulesetSha256,/^[a-f0-9]{64}$/)
})

test('incomplete file pagination cannot produce a low-risk observation', async () => {
  const data = fixture()
  data.setFiles(Array.from({length:101},(_,index) => ({filename:`docs/${index}.md`,status:'added',
    sha:String(index).padStart(40,'0'),additions:1,deletions:0,changes:1,patch:'+doc'}))
  )
  const result = await inspectWithRead(async url => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/files') && parsed.searchParams.get('page') === '2') return []
    return data.read(url)
  })
  assert.equal(result.status,'UNVERIFIED')
  assert.equal(result.mergeAuthorized,false)
})

test('spoofed, stale, or requested-changes reviews fail closed', async t => {
  const cases = [
    ['bot approval', [{id:1,state:'APPROVED',commit_id:head,submitted_at:'2026-11-16T00:00:00Z',body:'',
      author_association:'COLLABORATOR',user:{id:8,login:'bot',type:'Bot'}}]],
    ['approval on old head', [{id:1,state:'APPROVED',commit_id:'e'.repeat(40),submitted_at:'2026-11-16T00:00:00Z',body:'',
      author_association:'OWNER',user:{id:8,login:'reviewer',type:'User'}}]],
    ['changes requested', [{id:1,state:'CHANGES_REQUESTED',commit_id:head,submitted_at:'2026-11-16T00:00:00Z',body:'',
      author_association:'OWNER',user:{id:8,login:'reviewer',type:'User'}}]],
  ]
  for (const [name,reviews] of cases) await t.test(name,async () => {
    const data = fixture(); data.setReviews(reviews)
    const result = await inspectWithRead(data.read)
    assert.equal(result.status,'UNVERIFIED'); assert.equal(result.mergeAuthorized,false)
  })
})

test('forged check issuer, failed check, and mismatched workflow run are rejected', async t => {
  const cases = [
    ['wrong app', data => { data.setChecks([{...data.getCheck(),app:{id:1}}]) }],
    ['missing check identity', data => { const item = data.getCheck(); delete item.id; data.setChecks([item]) }],
    ['failed check', data => { data.setChecks([{...data.getCheck(),conclusion:'failure'}]) }],
    ['wrong event', data => { data.setRun({...data.getRun(),event:'workflow_dispatch'}) }],
    ['wrong associated base', data => {
      const mismatched = {number:prNumber,head:{repo:{id:repositoryId},sha:head},
        base:{repo:{id:repositoryId},ref:'other',sha:base}}
      data.setRun({...data.getRun(),pull_requests:[mismatched]})
    }],
  ]
  for (const [name,mutate] of cases) await t.test(name,async () => {
    const data = fixture()
    const proxy = new Proxy(data,{get(target,key) { return key === 'read' ? target.read : target[key] }})
    mutate(proxy)
    const result = await inspectWithRead(proxy.read)
    assert.equal(result.status,'UNVERIFIED'); assert.equal(result.mergeAuthorized,false)
  })
  await t.test('truncated check-run pagination is rejected',async () => {
    const data = fixture()
    data.setChecks(Array.from({length:101},(_,index) => ({id:2000 + index,name:'optional-' + index,
      head_sha:head,status:'completed',conclusion:'success',app:{id:15368}})))
    data.setChecks([{id:gateCheckId,name:'Required PR gate',head_sha:head,status:'completed',
      conclusion:'success',app:{id:15368},details_url:`https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/${gateRunId}/job/22`},
      ...Array.from({length:100},(_,index) => ({id:2000 + index,name:'optional-' + index,
        head_sha:head,status:'completed',conclusion:'success',app:{id:15368}}))])
    const result = await inspectWithRead(async url => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/check-runs') && parsed.searchParams.get('page') === '2') {
        return {total_count:101,check_runs:[]}
      }
      return data.read(url)
    })
    assert.equal(result.status,'UNVERIFIED'); assert.equal(result.mergeAuthorized,false)
  })
})

test('risky, unknown, renamed, and side-effect files cannot be low risk', () => {
  const file = (filename,status='modified',previous_filename=null,patch='+change') => ({filename,status,previous_filename,patch})
  for (const path of ['.github/workflows/new.yml','backend/app.py','infra/aws/main.tf','docs/autonomy/policy.md',
    'backend/migrations/001.sql','scripts/production/lightsail/test_style_cognito_hosted_ui.py']) {
    assert.notEqual(classifyRisk([file(path)]).risk,'low_risk',path)
  }
  assert.equal(classifyRisk([file('docs/new.md','renamed','docs/old.md')]).risk,'unknown')
  assert.equal(classifyRisk([file('docs/new.md','renamed','infra/aws/old.tf')]).risk,'high_risk')
  const sideEffect = classifyRisk([file('frontend/src/styles/theme.css','modified',null,'+body { color:red }')])
  assert.equal(sideEffect.risk,'high_risk')
  assert.ok(sideEffect.workflowEffects.some(effect => effect.workflow === 'lightsail-release-candidate-build.yml'))
  const effectCases = [
    ['backend/service.py','aws_ecr_publish'],
    ['infra/aws/main.tf','aws_terraform_apply'],
    ['.github/staging-update-requests/approved.json','aws_staging_mutation'],
    ['scripts/production/lightsail/style_cognito_hosted_ui.py','production_cognito_ui_mutation'],
    ['infra/aws/lightsail-production/main.tf','aws_read_only_terraform_plan'],
  ]
  for (const [path,effect] of effectCases) {
    const risk = classifyRisk([file(path)])
    assert.equal(risk.risk,'high_risk',path)
    assert.ok(risk.workflowEffects.some(item => item.effect === effect),path)
  }
  for (const credential of ['AWS_SECRET_ACCESS_KEY=abc123','AWS_ACCESS_KEY_ID=AKIA1234567890123456',
    'api_key=abc123','bearer_token=abc123','github_pat_abcd123456789012345678901234567890']) {
    assert.equal(classifyRisk([file('docs/setup.md','added',null,'+' + credential)]).risk,'high_risk',credential)
  }
})

test('inline comments and verification workflow/code changes fail closed', async t => {
  await t.test('unresolved-thread status is unavailable from REST',async () => {
    const data = fixture(); data.setComments([{id:9,user:{id:1},body:'comment'}])
    const result = await inspectWithRead(data.read)
    assert.equal(result.status,'UNVERIFIED'); assert.equal(result.mergeAuthorized,false)
  })
  await t.test('review findings in body cannot be silently treated as clear',async () => {
    const data = fixture()
    data.setReviews([{id:5,state:'APPROVED',commit_id:head,submitted_at:'2026-11-16T00:00:00Z',
      body:'Please fix the authentication bypass.',author_association:'OWNER',user:{id:8,login:'reviewer',type:'User'}}])
    const result = await inspectWithRead(data.read)
    assert.equal(result.status,'UNVERIFIED'); assert.equal(result.mergeAuthorized,false)
  })
  await t.test('candidate workflow inventory differs from pinned main',async () => {
    const data = fixture()
    const result = await inspectWithRead(async url => {
      if (new URL(url).searchParams.get('ref') === head && new URL(url).pathname.endsWith('/.github/workflows')) {
        return [...Object.entries(TRUSTED_WORKFLOW_BLOBS).map(([path,sha]) => ({type:'file',path,sha})),
          {type:'file',path:'.github/workflows/new.yml',sha:'f'.repeat(40)}]
      }
      return data.read(url)
    })
    assert.equal(result.status,'UNVERIFIED'); assert.equal(result.mergeAuthorized,false)
  })
  await t.test('modified trusted verifier is not trusted to verify itself',async () => {
    const data = fixture()
    const result = await inspectWithRead(async url => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/github-native-preflight.cjs') && parsed.searchParams.get('ref') === head) {
        return {type:'file',sha:'f'.repeat(40)}
      }
      return data.read(url)
    })
    assert.equal(result.status,'UNVERIFIED'); assert.equal(result.mergeAuthorized,false)
  })
})

test('incomplete effective protection evidence fails closed', async t => {
  await t.test('unexpected active ruleset',async () => {
    const data = fixture()
    const result = await inspectWithRead(async url => {
      if (new URL(url).pathname.endsWith('/rulesets')) return [
        {id:21886458,target:'branch',source_type:'Repository',source:'HamedGithubforwork/QuizForge-AI',enforcement:'active'},
        {id:88,target:'branch',source_type:'Organization',source:'HamedGithubforwork',enforcement:'active'},
      ]
      return data.read(url)
    })
    assert.equal(result.status,'UNVERIFIED'); assert.equal(result.mergeAuthorized,false)
  })
  await t.test('effective rules disagree with ruleset configuration',async () => {
    const data = fixture()
    const result = await inspectWithRead(async url => {
      if (new URL(url).pathname.endsWith('/rules/branches/main')) return []
      return data.read(url)
    })
    assert.equal(result.status,'UNVERIFIED'); assert.equal(result.mergeAuthorized,false)
  })
  await t.test('classic protection exists and requires separate interpretation',async () => {
    const data = fixture()
    const result = await inspectWithRead(async url => {
      if (new URL(url).pathname.endsWith('/branches/main/protection')) return {required_status_checks:{strict:true,contexts:[]}}
      return data.read(url)
    })
    assert.equal(result.status,'UNVERIFIED'); assert.equal(result.mergeAuthorized,false)
  })
})

test('changed PR state between complete snapshots is rejected', async () => {
  const data = fixture()
  let reads = 0
  const result = await inspectWithRead(async url => {
    reads += 1
    if (reads > 12 && new URL(url).pathname.endsWith(`/pulls/${prNumber}`)) {
      data.setHead('f'.repeat(40))
    }
    return data.read(url)
  })
  assert.equal(result.status,'UNVERIFIED')
  assert.equal(result.mergeAuthorized,false)
})

test('malformed and unavailable evidence is unverified; missing options are safe', async t => {
  assert.equal((await inspectGithubPrRiskReview()).status,'UNVERIFIED')
  assert.equal((await inspectGithubPrRiskReview({prNumber,read:async () => ({})})).status,'UNVERIFIED')
  assert.equal((await inspectGithubPrRiskReview({prNumber,extraEvidence:true})).status,'UNVERIFIED')
  for (const read of [async () => null,async () => {throw new Error('offline')}]) {
    const result = await inspectWithRead(read)
    assert.equal(result.status,'UNVERIFIED'); assert.equal(result.mergeAuthorized,false)
  }
})
