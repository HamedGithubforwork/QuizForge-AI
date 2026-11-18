'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const {
  inspectGithubPrRiskReview, inspectGithubWorkflowRunRiskReview, classifyRisk, TRUSTED_WORKFLOW_BLOBS,
} = require('../github-pr-risk-review.cjs')
const { runTrustedGithubVerifier } = require('../run-trusted-github-verifier.cjs')

const repoRoot = 'https://api.github.com/repos/HamedGithubforwork/QuizForge-AI'
const repositoryId = 1307099196
const ownerId = 148009407
const prNumber = 42
const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const gateRunId = 9812
const gateCheckId = 9912
const testToken = 'github_pat_test_read_only_1234567890'

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
  // GitHub REST can omit pull_requests on an otherwise valid workflow run.
  let run = {id:gateRunId,workflow_id:330113334,path:'.github/workflows/ci.yml',event:'pull_request',
    head_sha:head,status:'completed',conclusion:'success',repository:{id:repositoryId},pull_requests:[]}
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
    if (path === `/commits/${currentHead}/pulls`) return [{number:prNumber,state:'open',
      head:{sha:currentHead,repo:{id:repositoryId}},
      base:{ref:'main',sha:currentBase,repo:{id:repositoryId}}}]
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

async function inspectWithFetch(fetchImplementation, token = testToken) {
  const previousFetch = global.fetch
  const hadToken = Object.hasOwn(process.env,'QUIZFORGE_GITHUB_READ_TOKEN')
  const previousToken = process.env.QUIZFORGE_GITHUB_READ_TOKEN
  if (token === undefined) delete process.env.QUIZFORGE_GITHUB_READ_TOKEN
  else process.env.QUIZFORGE_GITHUB_READ_TOKEN = token
  global.fetch = fetchImplementation
  try { return await inspectGithubPrRiskReview({prNumber}) }
  finally {
    global.fetch = previousFetch
    if (hadToken) process.env.QUIZFORGE_GITHUB_READ_TOKEN = previousToken
    else delete process.env.QUIZFORGE_GITHUB_READ_TOKEN
  }
}

async function inspectWithRead(read, token = testToken, onRequest) {
  return inspectWithFetch(async (url,init) => {
    onRequest?.(String(url),init)
    const value = await read(String(url))
    if (value?.__httpStatus) {
      const payload = {message:value.message}
      return {ok:false,status:value.__httpStatus,headers:new Headers(value.headers ?? {}),
        json:async () => payload,clone() { return this }}
    }
    return {ok:true,status:200,headers:new Headers(),json:async () => value}
  },token)
}

async function inspectWorkflowWithRead(read, workflowRunId = gateRunId, token = testToken) {
  const previousFetch = global.fetch
  const hadToken = Object.hasOwn(process.env,'QUIZFORGE_GITHUB_READ_TOKEN')
  const previousToken = process.env.QUIZFORGE_GITHUB_READ_TOKEN
  if (token === undefined) delete process.env.QUIZFORGE_GITHUB_READ_TOKEN
  else process.env.QUIZFORGE_GITHUB_READ_TOKEN = token
  global.fetch = async url => {
    const value = await read(String(url))
    if (value?.__httpStatus) return {ok:false,status:value.__httpStatus,headers:new Headers(value.headers ?? {}),
      json:async () => ({message:value.message}),clone() { return this }}
    return {ok:true,status:200,headers:new Headers(),json:async () => value}
  }
  try { return await inspectGithubWorkflowRunRiskReview({workflowRunId}) }
  finally {
    global.fetch = previousFetch
    if (hadToken) process.env.QUIZFORGE_GITHUB_READ_TOKEN = previousToken
    else delete process.env.QUIZFORGE_GITHUB_READ_TOKEN
  }
}

async function runVerifierWithEnvironment(env,token) {
  const names = ['GITHUB_EVENT_NAME','GITHUB_REPOSITORY','GITHUB_REF','GITHUB_SHA','GITHUB_EVENT_PATH',
    'QUIZFORGE_GITHUB_READ_TOKEN']
  const previous = new Map(names.map(name => [name,{present:Object.hasOwn(process.env,name),value:process.env[name]}]))
  for (const name of names) {
    if (name === 'QUIZFORGE_GITHUB_READ_TOKEN') {
      if (token === undefined) delete process.env[name]
      else process.env[name] = token
    } else if (env[name] === undefined) delete process.env[name]
    else process.env[name] = env[name]
  }
  try { return await runTrustedGithubVerifier() }
  finally {
    for (const [name,value] of previous) {
      if (value.present) process.env[name] = value.value
      else delete process.env[name]
    }
  }
}

test('clean evidence is observation-only and cannot authorize a merge', async () => {
  const data = fixture()
  const requests = []
  const result = await inspectWithRead(data.read,testToken,(url,init) => requests.push({url,init}))
  assert.equal(result.status,'OBSERVATION_ONLY')
  assert.equal(result.mergeAuthorized,false)
  assert.equal(result.headSha,head)
  assert.equal(result.baseSha,base)
  assert.match(result.diffSha256,/^[a-f0-9]{64}$/)
  assert.match(result.reviewEvidenceSha256,/^[a-f0-9]{64}$/)
  assert.match(result.rulesetSha256,/^[a-f0-9]{64}$/)
  assert.ok(requests.length > 1)
  assert.ok(requests.every(({url,init}) => url.startsWith(repoRoot) && init.method === 'GET' &&
    init.redirect === 'error' && init.headers.Authorization === 'Bearer ' + testToken))
  assert.equal(JSON.stringify(result).includes(testToken),false)
})

test('empty Actions run pull_requests is reconciled using the authenticated commit-to-PR endpoint', async () => {
  const data = fixture()
  const result = await inspectWithRead(data.read)
  assert.equal(data.getRun().pull_requests.length,0)
  assert.equal(result.status,'OBSERVATION_ONLY')
  assert.equal(result.mergeAuthorized,false)
  assert.equal(data.calls.get(`/repos/HamedGithubforwork/QuizForge-AI/commits/${head}/pulls?per_page=100&page=1`),2)
})

test('contradictory commit-to-PR association or run association fails closed', async t => {
  await t.test('no matching PR association', async () => {
    const data = fixture()
    const result = await inspectWithRead(async url => {
      if (new URL(url).pathname === `/repos/HamedGithubforwork/QuizForge-AI/commits/${head}/pulls`) return []
      return data.read(url)
    })
    assert.equal(result.status,'UNVERIFIED')
    assert.equal(result.mergeAuthorized,false)
  })
  await t.test('populated run association disagrees', async () => {
    const data = fixture()
    data.setRun({...data.getRun(),pull_requests:[{number:prNumber,head:{repo:{id:repositoryId},sha:'f'.repeat(40)},
      base:{repo:{id:repositoryId},ref:'main',sha:base}}]})
    const result = await inspectWithRead(data.read)
    assert.equal(result.status,'UNVERIFIED')
    assert.equal(result.mergeAuthorized,false)
  })
  await t.test('malformed present run associations are rejected', async () => {
    const data = fixture()
    const original = data.getRun()
    for (const malformed of [null,'not-an-array',{}]) {
      data.setRun({...original,pull_requests:malformed})
      const result = await inspectWithRead(data.read)
      assert.equal(result.status,'UNVERIFIED')
      assert.equal(result.mergeAuthorized,false)
    }
  })
})

test('trusted workflow_run entry point binds the event to a default-branch checkout and live run', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'qfn-trusted-runner-'))
  const eventPath = path.join(temp,'event.json')
  const checkedOutSha = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
  const event = {workflow_run:{id:gateRunId,workflow_id:330113334,event:'pull_request',head_sha:head,
    repository:{id:repositoryId},head_repository:{id:repositoryId}}}
  fs.writeFileSync(eventPath,JSON.stringify(event))
  const env = {GITHUB_EVENT_NAME:'workflow_run',GITHUB_REPOSITORY:'HamedGithubforwork/QuizForge-AI',
    GITHUB_REF:'refs/heads/main',GITHUB_SHA:checkedOutSha,GITHUB_EVENT_PATH:eventPath}
  const previousFetch = global.fetch
  const data = fixture()
  data.setBase(checkedOutSha)
  global.fetch = async url => {
    const value = await data.read(String(url))
    if (value?.__httpStatus) return {ok:false,status:value.__httpStatus,headers:new Headers(value.headers ?? {}),
      json:async () => ({message:value.message}),clone() { return this }}
    return {ok:true,status:200,headers:new Headers(),json:async () => value}
  }
  try {
    const result = await runVerifierWithEnvironment(env,testToken)
    assert.equal(result.status,'OBSERVATION_ONLY')
    assert.equal(result.mergeAuthorized,false)
    assert.equal(result.prNumber,prNumber)
    assert.equal(result.triggerWorkflowRunId,gateRunId)
    assert.equal(JSON.stringify(result).includes(testToken),false)
    data.setBase('b'.repeat(40))
    const staleMain = await runVerifierWithEnvironment(env,testToken)
    assert.equal(staleMain.status,'UNVERIFIED')
    assert.equal(staleMain.reason,'trusted_default_branch_revision_changed')
    await t.test('missing app credential remains unverified', async () => {
      const missing = await runVerifierWithEnvironment(env,undefined)
      assert.equal(missing.status,'UNVERIFIED')
      assert.equal(missing.mergeAuthorized,false)
      assert.equal(missing.reason,'authentication_context_missing')
    })
    await t.test('non-default ref and changed checkout SHA are rejected before API access', async () => {
      const oldFetch = global.fetch
      let calls = 0
      global.fetch = async () => { calls += 1; throw new Error('must not make API request') }
      try {
        assert.equal((await runVerifierWithEnvironment({...env,GITHUB_REF:'refs/heads/topic'},testToken)).reason,
          'trusted_default_branch_context_invalid')
        assert.equal((await runVerifierWithEnvironment({...env,GITHUB_SHA:'f'.repeat(40)},testToken)).reason,
          'trusted_checkout_sha_mismatch')
        assert.equal(calls,0)
      } finally { global.fetch = oldFetch }
    })
    await t.test('malformed trigger identity and malformed event fail closed', async () => {
      fs.writeFileSync(eventPath,JSON.stringify({...event,workflow_run:{...event.workflow_run,repository:{id:1}}}))
      assert.equal((await runVerifierWithEnvironment(env,testToken)).reason,'trigger_event_untrusted_or_incomplete')
      fs.writeFileSync(eventPath,JSON.stringify({...event,workflow_run:{...event.workflow_run,head_repository:{id:1}}}))
      assert.equal((await runVerifierWithEnvironment(env,testToken)).reason,'trigger_event_untrusted_or_incomplete')
      fs.writeFileSync(eventPath,'{')
      assert.equal((await runVerifierWithEnvironment(env,testToken)).reason,'event_payload_invalid')
    })
  } finally {
    global.fetch = previousFetch
    fs.rmSync(temp,{recursive:true,force:true})
  }
})

test('privileged workflow is main-revision-only, read-only, and never executes PR artifacts or code', () => {
  const workflowFile = path.join(__dirname,'../../../.github/workflows/trusted-github-pr-verification.yml')
  const workflow = fs.readFileSync(workflowFile,'utf8')
  assert.match(workflow,/workflow_run:[\s\S]*workflows:\s*\[CI\][\s\S]*types:\s*\[completed\]/)
  assert.match(workflow,/workflow_id == 330113334/)
  assert.match(workflow,/workflow_run\.event == 'pull_request'/)
  assert.match(workflow,/workflow_run\.conclusion == 'success'/)
  assert.match(workflow,/workflow_run\.head_repository\.id == 1307099196/)
  assert.match(workflow,/repository\.id == 1307099196/)
  assert.match(workflow,/uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/)
  assert.match(workflow,/ref: \$\{\{ github\.sha \}\}/)
  assert.match(workflow,/persist-credentials: false/)
  assert.match(workflow,/uses: actions\/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510/)
  for (const permission of ['actions','administration','checks','contents','pull-requests']) {
    assert.match(workflow,new RegExp(`permission-${permission}: read`))
  }
  assert.doesNotMatch(workflow,/permission-[a-z-]+:\s*write/)
  assert.doesNotMatch(workflow,/pull_request_target:|workflow_dispatch:|repository_dispatch:/)
  assert.doesNotMatch(workflow,/actions\/(?:upload|download)-artifact|actions\/cache/)
  assert.doesNotMatch(workflow,/aws|terraform|deploy|docker\/build-push/i)
  assert.doesNotMatch(workflow,/QUIZFORGE_GITHUB_READ_TOKEN:\s*\$\{\{\s*github\.token/)
  assert.match(workflow,/QUIZFORGE_GITHUB_READ_TOKEN:\s*\$\{\{\s*steps\.app-token\.outputs\.token\s*\}\}/)
  assert.match(workflow,/permissions:\s*\{\}/)
  assert.match(workflow,/contents: read/)
  for (const trustedWorkflow of [
    '.github/workflows/ci.yml',
    '.github/workflows/trusted-github-pr-verification.yml',
  ]) {
    const sourcePath = path.join(__dirname,'../../../',trustedWorkflow)
    const actualBlob = execFileSync('git',['hash-object',sourcePath],{encoding:'utf8'}).trim()
    assert.equal(TRUSTED_WORKFLOW_BLOBS[trustedWorkflow],actualBlob,
      `${trustedWorkflow} must match its independently reviewed source pin`)
  }
})

test('workflow_run live verifier is scoped to the successful PR Required PR gate run', async t => {
  await t.test('valid live-run correlation is observation-only',async () => {
    const data = fixture()
    const result = await inspectWorkflowWithRead(data.read)
    assert.equal(result.status,'OBSERVATION_ONLY')
    assert.equal(result.mergeAuthorized,false)
    assert.equal(result.workflowRunId,gateRunId)
    assert.equal(result.triggerWorkflowRunId,gateRunId)
  })
  await t.test('wrong workflow, event, repository, or conclusion is rejected',async () => {
    const data = fixture()
    const original = data.getRun()
    for (const change of [
      {workflow_id:7},{event:'push'},{repository:{id:1}},{conclusion:'failure'},
    ]) {
      data.setRun({...original,...change})
      const result = await inspectWorkflowWithRead(data.read)
      assert.equal(result.status,'UNVERIFIED')
      assert.equal(result.mergeAuthorized,false)
    }
  })
  await t.test('runtime run id must be the exact Required PR gate run',async () => {
    const data = fixture()
    const result = await inspectWorkflowWithRead(async url => {
      const parsed = new URL(url)
      if (parsed.pathname === `/repos/HamedGithubforwork/QuizForge-AI/actions/runs/${gateRunId}`) {
        return {...data.getRun(),id:gateRunId + 1}
      }
      return data.read(url)
    },gateRunId)
    assert.equal(result.status,'UNVERIFIED')
    assert.equal(result.mergeAuthorized,false)
  })
  assert.equal((await inspectGithubWorkflowRunRiskReview()).reason,'invalid_input')
  assert.equal((await inspectGithubWorkflowRunRiskReview({workflowRunId:gateRunId,prNumber})).reason,'invalid_input')
})

test('missing and malformed authentication contexts fail before network access', async t => {
  let calls = 0
  const fetch = async () => { calls += 1; throw new Error('unexpected request') }
  await t.test('missing credential',async () => {
    const result = await inspectWithFetch(fetch,'')
    assert.equal(result.reason,'authentication_context_missing')
    assert.equal(result.mergeAuthorized,false)
    assert.equal(calls,0)
  })
  await t.test('malformed credential',async () => {
    const result = await inspectWithFetch(fetch,'token\r\nAuthorization: Bearer compromised')
    assert.equal(result.reason,'authentication_context_invalid')
    assert.equal(result.mergeAuthorized,false)
    assert.equal(calls,0)
  })
  await t.test('caller cannot supply a token or alternate reader',async () => {
    assert.equal((await inspectGithubPrRiskReview({prNumber,token:testToken})).reason,'invalid_input')
    assert.equal(calls,0)
  })
})

test('expired, insufficient, and rate-limited auth responses fail closed without leaking response text',async t => {
  const cases = [
    ['expired credential',401,{}, {message:'Bad credentials'},'authentication_invalid_or_expired'],
    ['insufficient permission',403,{}, {message:'Resource not accessible by integration'},'github_permission_denied'],
    ['HTTP rate limit',429,{'retry-after':'60'}, {message:'too many requests'},'github_rate_limited'],
    ['primary rate limit',403,{'x-ratelimit-remaining':'0'}, {message:'API rate limit exceeded'},'github_rate_limited'],
    ['secondary rate limit',403,{'retry-after':'60'}, {message:'You have exceeded a secondary rate limit'},'github_rate_limited'],
  ]
  for (const [name,status,headers,payload,reason] of cases) await t.test(name,async () => {
    const result = await inspectWithFetch(async () => ({ok:false,status,headers:new Headers(headers),
      json:async () => payload,clone() { return this }}))
    assert.equal(result.reason,reason)
    assert.equal(result.mergeAuthorized,false)
    assert.equal(JSON.stringify(result).includes(payload.message),false)
    assert.equal(JSON.stringify(result).includes(testToken),false)
  })
})

test('HTTP 404 is accepted only as classic protection absence, never as general access evidence',async () => {
  const result = await inspectWithRead(async url => {
    if (new URL(url).pathname === repoRoot.replace('https://api.github.com','')) {
      return {__httpStatus:404,message:'repository not found'}
    }
    return fixture().read(url)
  })
  assert.equal(result.status,'UNVERIFIED')
  assert.equal(result.mergeAuthorized,false)
})

test('credential is pinned for the full two-snapshot operation despite environment replacement',async () => {
  const data = fixture()
  const seen = []
  const result = await inspectWithRead(data.read,testToken,(_url,init) => {
    seen.push(init.headers.Authorization)
    process.env.QUIZFORGE_GITHUB_READ_TOKEN = 'different_context_token_123456789'
  })
  assert.equal(result.status,'OBSERVATION_ONLY')
  assert.ok(seen.length > 1)
  assert.deepEqual([...new Set(seen)],['Bearer ' + testToken])
  assert.equal(result.mergeAuthorized,false)
})

test('revoked or compromised context during verification blocks the entire observation',async () => {
  const data = fixture()
  let rulesetReads = 0
  const result = await inspectWithRead(async url => {
    if (new URL(url).pathname.endsWith('/rulesets/21886458')) {
      rulesetReads += 1
      if (rulesetReads === 2) return {__httpStatus:403,message:'private token or server details must not escape'}
    }
    return data.read(url)
  })
  assert.equal(result.status,'UNVERIFIED')
  assert.equal(result.reason,'github_permission_denied')
  assert.equal(result.mergeAuthorized,false)
  assert.equal(JSON.stringify(result).includes('private token'),false)
})

test('network failures and malformed API responses never produce evidence',async t => {
  await t.test('redirect or network failure is rejected without exposing error text',async () => {
    const result = await inspectWithFetch(async (_url,init) => {
      assert.equal(init.redirect,'error')
      throw new Error('https://attacker.invalid redirected with token=secret')
    })
    assert.equal(result.status,'UNVERIFIED')
    assert.equal(result.reason,'github_unavailable_or_redirect_rejected')
    assert.equal(result.mergeAuthorized,false)
    assert.equal(JSON.stringify(result).includes('attacker.invalid'),false)
  })
  await t.test('malformed JSON response rejected',async () => {
    const result = await inspectWithFetch(async () => ({ok:true,status:200,headers:new Headers(),
      json:async () => {throw new Error('sensitive body detail')}}))
    assert.equal(result.status,'UNVERIFIED')
    assert.equal(result.mergeAuthorized,false)
    assert.equal(JSON.stringify(result).includes('sensitive body detail'),false)
  })
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
