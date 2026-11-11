'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DEFAULT_CHECKPOINT, loadCheckpoint, resumeWithTrustedGitHub } = require('../integration-coordinator.cjs')

const repository = 'HamedGithubforwork/QuizForge-AI'
const mainSha = '4213fe2b7160bdc2e12c5e9661611544e251ae48'
const merge678 = '46f3412f673b0522cc1dfce2769e7e8d7d9d6aff'
const head678 = 'def1a9eb7a382df53246943fb4235d6407aff4b6'
const base678 = 'aad0afeda769a6715f2ba8351294b61839ff5fe6'
const merge695 = mainSha
const head695 = '176fc7961781d622519597a4c8268b33d40d4514'
const base695 = merge678
const graphPath = path.join(__dirname, '..', '..', '..', 'docs', 'autonomy', 'integration-task-graph.json')

function sha1Blob(text) {
  return crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')
}

function ruleset() {
  return {
    id: 21886458, enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [],
    rules: [
      { type: 'required_status_checks', parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{ context: 'Required PR gate', integration_id: 15368 }],
      } },
      { type: 'pull_request', parameters: { required_approving_review_count: 0 } },
    ],
  }
}

function pr(number, headSha, baseSha, mergeSha) {
  return {
    number, state: 'closed', merged: true, merged_at: '2026-11-09T12:00:00Z',
    merge_commit_sha: mergeSha,
    base: { ref: 'main', repo: { full_name: repository } },
    head: { sha: headSha, repo: { full_name: repository } },
  }
}

function fixtureApi({ graphText, failPr = new Set(), moveMain = false, badRuleset = false, badAncestry = false,
  missingManifest = false, apiOutage = false, badPrScope = false, badParent = false,
  integrationId = 15368, onRequest } = {}) {
  const canonicalGraph = graphText ?? require(graphPath)
  const text = typeof canonicalGraph === 'string' ? canonicalGraph : `${JSON.stringify(canonicalGraph, null, 2)}\n`
  const protectedRuleset = ruleset()
  if (badRuleset) protectedRuleset.bypass_actors = [{ actor_id: 1, bypass_mode: 'always' }]
  if (integrationId === null) delete protectedRuleset.rules[0].parameters.required_status_checks[0].integration_id
  else protectedRuleset.rules[0].parameters.required_status_checks[0].integration_id = integrationId
  const calls = []
  const originalFetch = global.fetch
  global.fetch = async url => {
    calls.push(String(url))
    await onRequest?.(String(url))
    if (apiOutage) return { ok: false, status: 429, json: async () => ({}) }
    const route = new URL(String(url)).pathname.replace(`/repos/${repository}`, '')
    let body
    if (route === '/branches/main') {
      const number = calls.filter(item => item.includes('/branches/main')).length
      body = { protected: true, commit: { sha: moveMain && number > 1 ? 'c'.repeat(40) : mainSha } }
    } else if (route === '/rulesets') body = [{ id: 21886458 }]
    else if (route === '/rulesets/21886458') body = protectedRuleset
    else if (route.startsWith('/contents/') && missingManifest) {
      return { ok: false, status: 404, json: async () => ({}) }
    }
    else if (route.startsWith('/contents/')) body = {
      type: 'file', path: 'docs/autonomy/integration-task-graph.json', encoding: 'base64',
      content: Buffer.from(text).toString('base64'), sha: sha1Blob(text),
    }
    else if (route === '/pulls/678') {
      if (failPr.has(678)) return { ok: false, status: 503, json: async () => ({}) }
      body = pr(678, head678, base678, merge678)
      if (badPrScope) body.head.sha = 'c'.repeat(40)
    } else if (route === '/pulls/695') {
      if (failPr.has(695)) return { ok: false, status: 503, json: async () => ({}) }
      body = pr(695, head695, base695, merge695)
      if (badPrScope) body.head.sha = 'c'.repeat(40)
    } else if (route === `/commits/${merge678}`) body = { sha: merge678, parents: [{ sha: base678 }, { sha: badParent ? 'c'.repeat(40) : head678 }] }
    else if (route === `/commits/${merge695}`) body = { sha: merge695, parents: [{ sha: base695 }, { sha: badParent ? 'c'.repeat(40) : head695 }] }
    else if (route.startsWith('/compare/')) body = { status: badAncestry ? 'diverged' : 'ahead', behind_by: 0 }
    else throw new Error(`Unexpected GitHub request ${route}`)
    return { ok: true, status: 200, json: async () => body }
  }
  return { calls, restore: () => { global.fetch = originalFetch } }
}

async function tempCheckpoint() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-trusted-reconcile-'))
  const file = path.join(dir, 'checkpoint.json')
  await fs.copyFile(DEFAULT_CHECKPOINT, file)
  return { dir, file }
}

test('live protected GitHub merge facts unlock the real historical dependency chain without persisting trust claims', async () => {
  const temp = await tempCheckpoint()
  const original = await fs.readFile(DEFAULT_CHECKPOINT)
  const api = fixtureApi()
  try {
    const before = await fs.readFile(temp.file)
    const result = await resumeWithTrustedGitHub(temp.file)
    assert.equal(result.task.id, 'pr-695-reconcile')
    assert.equal(result.reason, 'selected')
    assert.equal(result.state.tasks.find(item => item.id === 'pr-678-complete').status, 'completed')
    assert.equal(result.state.tasks.find(item => item.id === 'pr-695-merge').status, 'completed')
    const after = JSON.parse(await fs.readFile(temp.file, 'utf8'))
    assert.equal(JSON.stringify(after).includes('verifiedHistoricalMerges'), false)
    assert.equal(JSON.stringify(after).includes('trustedMergeIds'), false)
    assert.deepEqual(await fs.readFile(DEFAULT_CHECKPOINT), original)
    assert.ok(api.calls.some(url => url.includes(`/contents/docs/autonomy/integration-task-graph.json?ref=${mainSha}`)))
    assert.ok(api.calls.some(url => url.endsWith('/pulls/678')))
    assert.ok(api.calls.some(url => url.endsWith('/pulls/695')))
    assert.notDeepEqual(before, await fs.readFile(temp.file))
  } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
})

test('fresh session resume repeats live verification instead of trusting prior in-memory state', async () => {
  const temp = await tempCheckpoint()
  const api = fixtureApi()
  try {
    await resumeWithTrustedGitHub(temp.file)
    const firstCount = api.calls.length
    const reloaded = await loadCheckpoint(temp.file)
    // Ordinary checkpoint restoration intentionally has no in-memory trust.
    assert.equal(reloaded.selectedTaskId, null)
    // A second resume uses the same preserved checkpoint but performs a new
    // authoritative read before any continuation decision.
    const resumed = await resumeWithTrustedGitHub(temp.file)
    assert.equal(resumed.task.id, 'pr-695-reconcile')
    assert.ok(api.calls.length > firstCount)
    assert.ok(api.calls.slice(firstCount).some(url => url.endsWith('/pulls/678')))
  } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
})

test('checkpoint merge SHAs and forged completion events cannot replace failed live PR verification', async () => {
  const temp = await tempCheckpoint()
  const checkpoint = JSON.parse(await fs.readFile(temp.file, 'utf8'))
  checkpoint.tasks.find(item => item.id === 'pr-678-complete').pr.mergeCommitSha = 'f'.repeat(40)
  checkpoint.tasks.find(item => item.id === 'pr-678-complete').result.mergeCommitSha = 'f'.repeat(40)
  checkpoint.events.push({ sequence: checkpoint.events.length + 1, type: 'historical_merge_confirmed',
    taskId: 'pr-678-complete', evidenceRef: 'docs/autonomy/integration-workflow.md', headSha: head678, targetBranch: 'main' })
  await fs.writeFile(temp.file, `${JSON.stringify(checkpoint, null, 2)}\n`)
  const before = await fs.readFile(temp.file)
  const api = fixtureApi({ failPr: new Set([678, 695]) })
  try {
    const result = await resumeWithTrustedGitHub(temp.file)
    assert.notEqual(result.task?.id, 'pr-695-reconcile')
    assert.equal(result.state.selectedTaskId, null)
    const after = JSON.parse(await fs.readFile(temp.file, 'utf8'))
    assert.notDeepEqual(await fs.readFile(temp.file), before) // unverified work claims are reset
    assert.equal(after.tasks.find(item => item.id === 'pr-678-complete').pr.mergeCommitSha, 'f'.repeat(40))
    assert.ok(after.events.some(item => item.type === 'historical_merge_confirmed' && item.taskId === 'pr-678-complete'))
    assert.notEqual(after.selectedTaskId, 'pr-695-reconcile')
  } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
})

test('tampered task IDs or dependency edges fail before selecting work', async () => {
  const temp = await tempCheckpoint()
  const checkpoint = JSON.parse(await fs.readFile(temp.file, 'utf8'))
  checkpoint.tasks.find(item => item.id === 'pr-690-reconcile').dependencies = []
  await fs.writeFile(temp.file, `${JSON.stringify(checkpoint, null, 2)}\n`)
  const before = await fs.readFile(temp.file)
  const api = fixtureApi()
  try {
    await assert.rejects(resumeWithTrustedGitHub(temp.file), /task IDs, kinds, PR scopes, or dependency edges differ/)
    assert.deepEqual(await fs.readFile(temp.file), before)
  } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
})

test('canonical graph rejects a merge task relabelled as work or scoped to another PR', async t => {
  for (const tamper of [
    task => { task.kind = 'work' },
    task => { task.pr.number = 699 },
  ]) {
    await t.test(tamper.toString().includes('kind') ? 'kind change' : 'PR identity change', async () => {
      const temp = await tempCheckpoint()
      const checkpoint = await loadCheckpoint(temp.file)
      tamper(checkpoint.tasks.find(item => item.id === 'pr-695-merge'))
      const api = fixtureApi()
      try {
        const { verifyTrustedHistoricalMerges } = require('../trusted-integration-verifier.cjs')
        await assert.rejects(verifyTrustedHistoricalMerges(checkpoint), /kinds, PR scopes/)
      } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
    })
  }
})

test('canonical historical merge cannot be reassigned to a mismatched task node', async t => {
  for (const tamper of [
    graph => { graph.historicalMerges[1].taskId = 'pr-690-merge' },
    graph => { graph.historicalMerges[1].taskId = 'pr-695-reconcile' },
  ]) {
    await t.test(tamper.toString().includes('pr-690-merge') ? 'different PR identity' : 'work node kind', async () => {
      const temp = await tempCheckpoint()
      const checkpoint = await loadCheckpoint(temp.file)
      const graph = JSON.parse(await fs.readFile(graphPath, 'utf8'))
      tamper(graph)
      const api = fixtureApi({ graphText: graph })
      try {
        const { verifyTrustedHistoricalMerges } = require('../trusted-integration-verifier.cjs')
        await assert.rejects(verifyTrustedHistoricalMerges(checkpoint), /historical merge does not match its task/)
      } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
    })
  }
})

test('mutating a trusted resume object invalidates its capability before exported advance', async () => {
  const temp = await tempCheckpoint()
  const api = fixtureApi()
  try {
    const result = await resumeWithTrustedGitHub(temp.file)
    const mergeTask = result.state.tasks.find(item => item.id === 'pr-695-merge')
    mergeTask.kind = 'work'
    mergeTask.pr = null
    mergeTask.result = null
    mergeTask.dependencies = []
    const reconcile = result.state.tasks.find(item => item.id === 'pr-695-reconcile')
    reconcile.status = 'completed'
    reconcile.dependencies = []
    const { advance } = require('../integration-coordinator.cjs')
    assert.throws(() => advance(result.state), /changed after verification/)
    assert.notEqual(result.state.selectedTaskId, 'pr-690-reconcile')
  } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
})

test('caller-added serialization hooks cannot hide mutation from trusted state fingerprinting', async () => {
  const temp = await tempCheckpoint()
  const api = fixtureApi()
  try {
    const resumed = await resumeWithTrustedGitHub(temp.file)
    const { advance } = require('../integration-coordinator.cjs')
    Object.defineProperty(resumed.state, 'toJSON', { value: () => ({ forged: 'same-looking-state' }) })
    assert.throws(() => advance(resumed.state), /changed after verification/)
  } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
})

test('nested Proxy cannot forge a completed task behind normal-looking descriptors', async () => {
  const temp = await tempCheckpoint()
  const api = fixtureApi()
  try {
    const resumed = await resumeWithTrustedGitHub(temp.file)
    const target = resumed.state.tasks.find(item => item.id === 'pr-690-reconcile')
    let statusReads = 0
    const forged = new Proxy(target, {
      get(object, property, receiver) {
        if (property === 'status') { statusReads += 1; return 'completed' }
        return Reflect.get(object, property, receiver)
      },
      getOwnPropertyDescriptor: (object, property) => Reflect.getOwnPropertyDescriptor(object, property),
      ownKeys: object => Reflect.ownKeys(object),
    })
    resumed.state.tasks[resumed.state.tasks.indexOf(target)] = forged
    const { advance } = require('../integration-coordinator.cjs')
    assert.throws(() => advance(resumed.state), /changed after verification/)
    assert.equal(statusReads, 0)
    assert.notEqual(resumed.state.selectedTaskId, 'pr-691-reconcile')
  } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
})

test('relabelled unmerged merge task cannot advance its dependent after trusted resume', async () => {
  const temp = await tempCheckpoint()
  const api = fixtureApi()
  try {
    const resumed = await resumeWithTrustedGitHub(temp.file)
    const forged = resumed.state.tasks.find(item => item.id === 'pr-690-merge')
    forged.kind = 'work'
    forged.pr = null
    forged.result = null
    forged.approval = null
    forged.status = 'completed'
    const { advance, begin } = require('../integration-coordinator.cjs')
    assert.throws(() => advance(resumed.state), /changed after verification/)
    assert.throws(() => begin(resumed.state), /changed after verification/)
    assert.notEqual(resumed.state.selectedTaskId, 'pr-691-reconcile')
  } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
})

test('tampered loaded state cannot enter trusted transition when live PR verification is unavailable', async () => {
  const temp = await tempCheckpoint()
  const api = fixtureApi({ failPr: new Set([678, 695]) })
  try {
    const fabricated = await loadCheckpoint(temp.file)
    fabricated.tasks.find(item => item.id === 'pr-695-reconcile').status = 'completed'
    fabricated.tasks.find(item => item.id === 'pr-695-reconcile').dependencies = []
    const { transitionAndSaveWithTrustedGitHub } = require('../integration-coordinator.cjs')
    await assert.rejects(transitionAndSaveWithTrustedGitHub(temp.file, fabricated, { type: 'begin' }),
      /unmodified state from trusted resume/)
    assert.equal(fabricated.selectedTaskId, null)
  } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
})

test('ordinary loaded-checkpoint transition cannot advance relabelled merge completion claims', async () => {
  const temp = await tempCheckpoint()
  try {
    const checkpoint = JSON.parse(await fs.readFile(temp.file, 'utf8'))
    const fakeMerge = checkpoint.tasks.find(item => item.id === 'pr-690-merge')
    fakeMerge.kind = 'work'
    fakeMerge.pr = null
    fakeMerge.result = { evidenceRef: 'docs/autonomy/integration-workflow.md' }
    fakeMerge.status = 'completed'
    const fakePrerequisite = checkpoint.tasks.find(item => item.id === 'pr-690-reconcile')
    fakePrerequisite.status = 'completed'
    fakePrerequisite.dependencies = []
    await fs.writeFile(temp.file, `${JSON.stringify(checkpoint, null, 2)}\n`)
    const fabricated = await loadCheckpoint(temp.file)
    const { transitionAndSave } = require('../integration-coordinator.cjs')
    const result = await transitionAndSave(temp.file, fabricated, { type: 'begin' })
    assert.notEqual(fabricated.selectedTaskId, 'pr-691-reconcile')
    assert.notEqual(result.task?.id, 'pr-691-reconcile')
    assert.equal(result.reason, 'blocked')
  } finally { await fs.rm(temp.dir, { recursive: true, force: true }) }
})

test('mutated resumed completion claim cannot be refreshed by trusted transition after PR API failure', async () => {
  const temp = await tempCheckpoint()
  const api = fixtureApi()
  try {
    const resumed = await resumeWithTrustedGitHub(temp.file)
    resumed.state.tasks.find(item => item.id === 'pr-695-reconcile').status = 'completed'
    const { transitionAndSaveWithTrustedGitHub } = require('../integration-coordinator.cjs')
    await assert.rejects(transitionAndSaveWithTrustedGitHub(temp.file, resumed.state, { type: 'begin' }),
      /changed after verification/)
    assert.equal(resumed.state.selectedTaskId, 'pr-695-reconcile')
  } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
})

test('trusted transition aborts when fetch mutates state or checkpoint during verification', async () => {
  const temp = await tempCheckpoint()
  let resumedState
  let changed = false
  const api = fixtureApi({ onRequest: async () => {
    if (!resumedState || changed) return
    changed = true
    resumedState.tasks.find(item => item.id === 'pr-695-reconcile').status = 'completed'
    const disk = JSON.parse(await fs.readFile(temp.file, 'utf8'))
    disk.tasks.find(item => item.id === 'pr-695-reconcile').status = 'completed'
    await fs.writeFile(temp.file, `${JSON.stringify(disk, null, 2)}\n`)
  } })
  try {
    const resume = await resumeWithTrustedGitHub(temp.file)
    resumedState = resume.state
    // The first simulated fetch on the next transition mutates both objects.
    const { transitionAndSaveWithTrustedGitHub } = require('../integration-coordinator.cjs')
    const beforeTransition = await fs.readFile(temp.file)
    await assert.rejects(transitionAndSaveWithTrustedGitHub(temp.file, resumedState, { type: 'begin' }),
      /changed after verification|changed during trusted GitHub verification/)
    const after = await fs.readFile(temp.file)
    assert.notDeepEqual(after, beforeTransition) // only the injected concurrent edit persists
    assert.equal(JSON.parse(after).selectedTaskId, 'pr-695-reconcile')
    assert.equal(resumedState.selectedTaskId, 'pr-695-reconcile')
  } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
})

test('trusted transition aborts when the caller changes the operation during GitHub verification', async () => {
  const temp = await tempCheckpoint()
  let transition
  const api = fixtureApi({ onRequest: async () => {
    if (transition) {
      transition.taskId = 'pr-698-review'
      transition = null
    }
  } })
  try {
    const resumed = await resumeWithTrustedGitHub(temp.file)
    const before = await fs.readFile(temp.file)
    transition = {
      type: 'complete', taskId: 'pr-695-reconcile',
      payload: { evidenceRef: 'docs/autonomy/integration-workflow.md' },
    }
    const { transitionAndSaveWithTrustedGitHub } = require('../integration-coordinator.cjs')
    await assert.rejects(transitionAndSaveWithTrustedGitHub(temp.file, resumed.state, transition),
      /transition changed during trusted GitHub verification/)
    assert.deepEqual(await fs.readFile(temp.file), before)
    assert.equal(resumed.state.selectedTaskId, 'pr-695-reconcile')
  } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
})

test('trusted transition rechecks its operation after the final checkpoint read await', async () => {
  const temp = await tempCheckpoint()
  const api = fixtureApi()
  let transition
  const originalReadFile = fs.readFile
  let checkpointReads = 0
  try {
    const resumed = await resumeWithTrustedGitHub(temp.file)
    const before = await originalReadFile(temp.file)
    transition = {
      type: 'complete', taskId: 'pr-695-reconcile',
      payload: { evidenceRef: 'docs/autonomy/integration-workflow.md' },
    }
    fs.readFile = async (file, ...args) => {
      const result = await originalReadFile(file, ...args)
      if (path.resolve(String(file)) === path.resolve(temp.file)) {
        checkpointReads += 1
        if (checkpointReads === 2) transition.taskId = 'pr-698-review'
      }
      return result
    }
    const { transitionAndSaveWithTrustedGitHub } = require('../integration-coordinator.cjs')
    await assert.rejects(transitionAndSaveWithTrustedGitHub(temp.file, resumed.state, transition),
      /transition changed during trusted GitHub verification/)
    assert.deepEqual(await originalReadFile(temp.file), before)
    assert.equal(resumed.state.selectedTaskId, 'pr-695-reconcile')
  } finally {
    fs.readFile = originalReadFile
    api.restore()
    await fs.rm(temp.dir, { recursive: true, force: true })
  }
})

test('resume refuses to overwrite a checkpoint replaced during GitHub verification', async () => {
  const temp = await tempCheckpoint()
  let changed = false
  const api = fixtureApi({ onRequest: async () => {
    if (changed) return
    changed = true
    const disk = JSON.parse(await fs.readFile(temp.file, 'utf8'))
    disk.tasks.find(item => item.id === 'pr-695-reconcile').status = 'ready'
    await fs.writeFile(temp.file, `${JSON.stringify(disk, null, 2)}\n`)
  } })
  try {
    const before = await fs.readFile(temp.file)
    await assert.rejects(resumeWithTrustedGitHub(temp.file), /changed while trusted GitHub verification was in progress/)
    assert.notDeepEqual(await fs.readFile(temp.file), before)
    assert.equal(JSON.parse(await fs.readFile(temp.file, 'utf8')).revision, JSON.parse(before).revision)
  } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
})

test('an unmodified trusted session preserves verified merge dependencies through a Coordinator transition', async () => {
  const temp = await tempCheckpoint()
  const api = fixtureApi()
  try {
    const resumed = await resumeWithTrustedGitHub(temp.file)
    assert.equal(resumed.task.id, 'pr-695-reconcile')
    const { transitionAndSaveWithTrustedGitHub } = require('../integration-coordinator.cjs')
    const next = await transitionAndSaveWithTrustedGitHub(temp.file, resumed.state, {
      type: 'complete', taskId: 'pr-695-reconcile',
      payload: { evidenceRef: 'docs/autonomy/integration-workflow.md' },
    })
    assert.equal(next.task.id, 'pr-698-review')
    assert.equal(next.reason, 'selected')
    const downstream = await transitionAndSaveWithTrustedGitHub(temp.file, resumed.state, {
      type: 'complete', taskId: 'pr-698-review',
      payload: { evidenceRef: 'docs/autonomy/integration-workflow.md' },
    })
    assert.equal(downstream.task.id, 'pr-690-reconcile')
    assert.equal(downstream.reason, 'selected')
  } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
})

test('missing main manifest, API outage, ruleset bypass, moving main, and bad ancestry fail closed', async t => {
  const scenarios = [
    ['manifest absent on main', { missingManifest: true }],
    ['API outage or rate limit', { apiOutage: true }],
    ['ruleset bypass configured', { badRuleset: true }],
    ['required check integration ID missing', { integrationId: null }],
    ['required check integration ID changed', { integrationId: 1 }],
    ['main moves during verification', { moveMain: true }],
    ['merge ancestry fails', { badAncestry: true }],
    ['changed PR head scope', { badPrScope: true }],
    ['wrong merge commit parents', { badParent: true }],
  ]
  for (const [label, options] of scenarios) {
    await t.test(label, async () => {
      const temp = await tempCheckpoint()
      const before = await fs.readFile(temp.file)
      const api = fixtureApi(options)
      try {
        if (['merge ancestry fails', 'changed PR head scope', 'wrong merge commit parents'].includes(label)) {
          const result = await resumeWithTrustedGitHub(temp.file)
          assert.notEqual(result.task?.id, 'pr-695-reconcile')
          assert.equal(result.state.automaticMergePolicy.status, 'disabled')
        } else {
          await assert.rejects(resumeWithTrustedGitHub(temp.file))
          assert.deepEqual(await fs.readFile(temp.file), before)
        }
      } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
    })
  }
})

test('unverified merge dependencies do not prevent an independent task from advancing', async () => {
  const temp = await tempCheckpoint()
  const checkpoint = JSON.parse(await fs.readFile(temp.file, 'utf8'))
  // This added task is a test-only independent graph node; the authenticated
  // canonical response below contains the identical graph and blob digest.
  checkpoint.tasks.push({ id: 'independent-safe-work', title: 'Independent safe work', priority: 100,
    dependencies: [], status: 'ready', attempts: 0, kind: 'work', blockerCode: null, retryExhausted: false,
    result: null, rejection: null, pr: null, approval: null, automaticMergeDecision: null, evidenceRefs: [] })
  checkpoint.maxSelections = Math.max(checkpoint.maxSelections, checkpoint.selections + 1)
  await fs.writeFile(temp.file, `${JSON.stringify(checkpoint, null, 2)}\n`)
  const graph = JSON.parse(await fs.readFile(graphPath, 'utf8'))
  graph.tasks.push({ id: 'independent-safe-work', kind: 'work', dependencies: [], pr: null })
  const api = fixtureApi({ graphText: graph, failPr: new Set([678, 695]) })
  try {
    const result = await resumeWithTrustedGitHub(temp.file)
    assert.equal(result.task.id, 'independent-safe-work')
    assert.equal(result.reason, 'selected')
    const { transitionAndSaveWithTrustedGitHub } = require('../integration-coordinator.cjs')
    const next = await transitionAndSaveWithTrustedGitHub(temp.file, result.state, {
      type: 'complete', taskId: 'independent-safe-work',
      payload: { evidenceRef: 'docs/autonomy/integration-workflow.md' },
    })
    assert.equal(next.reason, 'blocked')
  } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
})

test('clearing completed work claims also clears stale objective-complete status before selection', async () => {
  const temp = await tempCheckpoint()
  const checkpoint = JSON.parse(await fs.readFile(temp.file, 'utf8'))
  checkpoint.status = 'completed'
  checkpoint.stopReason = 'objective_complete'
  await fs.writeFile(temp.file, `${JSON.stringify(checkpoint, null, 2)}\n`)
  const api = fixtureApi({ failPr: new Set([678, 695]) })
  try {
    const result = await resumeWithTrustedGitHub(temp.file)
    assert.equal(result.task, null)
    assert.equal(result.reason, 'blocked')
    assert.equal(result.state.status, 'blocked')
    assert.equal(result.state.stopReason, 'no_actionable_task')
  } finally { api.restore(); await fs.rm(temp.dir, { recursive: true, force: true }) }
})
