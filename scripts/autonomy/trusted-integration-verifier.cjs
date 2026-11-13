'use strict'

// Read-only trust provider for the fixed public repository. It never uses a
// token, accepts caller-supplied evidence, or performs a GitHub write.
const crypto = require('node:crypto')

const REPOSITORY = 'HamedGithubforwork/QuizForge-AI'
const DEFAULT_BRANCH = 'main'
const MANIFEST_PATH = 'docs/autonomy/integration-task-graph.json'
// Process-rooted identity for the graph introduced by the manually approved
// PR #699 merge. This is deliberately not read from the graph/checkpoint.
// Updating it requires a separately reviewed, explicitly authorized main PR.
const CANONICAL_GRAPH_APPROVAL_COMMIT = '662926ac46d2b1fbb2433f2405c299e08583ac44'
const CANONICAL_GRAPH_SHA256 = '4967b276a409a5f7836a6901af575f4e6d7fb1a9d7bf7f3c07c790008259b800'
const API_ROOT = `https://api.github.com/repos/${REPOSITORY}`
const SHA1 = /^[a-f0-9]{40}$/

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'QuizForge-integration-coordinator',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) {
    const apiPath = new URL(url).pathname
    throw new Error(`Trusted GitHub read failed (${response.status}) at ${apiPath}`)
  }
  return response.json()
}

function assertManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.repository !== REPOSITORY ||
      manifest.defaultBranch !== DEFAULT_BRANCH || manifest.objectiveId !== 'autonomous-integration' ||
      !Array.isArray(manifest.tasks) || !Array.isArray(manifest.historicalMerges)) {
    throw new Error('Canonical integration graph is malformed or out of scope')
  }
  const ids = new Set()
  const tasksById = new Map()
  for (const task of manifest.tasks) {
    if (!task || typeof task.id !== 'string' || ids.has(task.id) || !Array.isArray(task.dependencies) ||
        task.dependencies.some(id => typeof id !== 'string') || new Set(task.dependencies).size !== task.dependencies.length ||
        !['work', 'merge'].includes(task.kind) ||
        (task.pr !== null && (!task.pr || task.pr.repository !== REPOSITORY ||
          !Number.isSafeInteger(task.pr.number) || task.pr.number < 1 || typeof task.pr.baseRef !== 'string'))) {
      throw new Error('Canonical integration graph has invalid tasks')
    }
    ids.add(task.id)
    tasksById.set(task.id, task)
  }
  if (manifest.tasks.some(task => task.dependencies.some(id => !ids.has(id)))) {
    throw new Error('Canonical integration graph has a missing dependency')
  }
  const visiting = new Set()
  const visited = new Set()
  function visit(taskId) {
    if (visiting.has(taskId)) throw new Error('Canonical integration graph contains a dependency cycle')
    if (visited.has(taskId)) return
    visiting.add(taskId)
    for (const dependencyId of tasksById.get(taskId).dependencies) visit(dependencyId)
    visiting.delete(taskId)
    visited.add(taskId)
  }
  for (const taskId of ids) visit(taskId)

  const merges = new Set()
  const mergedPrNumbers = new Set()
  for (const merge of manifest.historicalMerges) {
    if (!merge || !ids.has(merge.taskId) || merges.has(merge.taskId) ||
        !Number.isSafeInteger(merge.prNumber) || merge.prNumber < 1 ||
        !SHA1.test(merge.headSha ?? '') || !SHA1.test(merge.baseSha ?? '') ||
        !SHA1.test(merge.mergeCommitSha ?? '') || merge.targetBranch !== DEFAULT_BRANCH) {
      throw new Error('Canonical historical merge scope is invalid')
    }
    const task = tasksById.get(merge.taskId)
    const expectedKind = merge.taskId === 'pr-678-complete' && merge.prNumber === 678 ? 'work' : 'merge'
    if (mergedPrNumbers.has(merge.prNumber) || task.kind !== expectedKind ||
        task.pr?.repository !== manifest.repository || task.pr?.number !== merge.prNumber ||
        task.pr?.baseRef !== merge.targetBranch) {
      throw new Error('Canonical historical merge does not match its task PR identity, target, and kind')
    }
    merges.add(merge.taskId)
    mergedPrNumbers.add(merge.prNumber)
  }
  return manifest
}

function assertCheckpointGraph(state, manifest) {
  if (state.objectiveId !== manifest.objectiveId || state.tasks.length !== manifest.tasks.length) {
    throw new Error('Checkpoint task graph differs from protected canonical graph')
  }
  const canonical = new Map(manifest.tasks.map(task => [task.id, task.dependencies]))
  const manifestTasks = new Map(manifest.tasks.map(task => [task.id, task]))
  for (const task of state.tasks) {
    const dependencies = canonical.get(task.id)
    const expected = manifestTasks.get(task.id)
    const prScope = task.pr ? {
      repository: task.pr.repository, number: task.pr.number, baseRef: task.pr.baseRef,
    } : null
    if (!dependencies || dependencies.length !== task.dependencies.length ||
        dependencies.some((id, index) => id !== task.dependencies[index]) ||
        expected.kind !== task.kind || JSON.stringify(expected.pr) !== JSON.stringify(prScope)) {
      throw new Error('Checkpoint task IDs, kinds, PR scopes, or dependency edges differ from protected canonical graph')
    }
  }
}

function assertGitBlobSha(bytes, expectedSha) {
  const actual = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  if (!SHA1.test(expectedSha ?? '') || actual !== expectedSha) throw new Error('Canonical graph Git blob integrity check failed')
}

function assertCanonicalGraphSha256(bytes) {
  const actual = crypto.createHash('sha256').update(bytes).digest('hex')
  if (actual !== CANONICAL_GRAPH_SHA256) {
    throw new Error('Canonical task graph does not match the pinned graph identity')
  }
  return actual
}

async function readPinnedGraphAt(ref) {
  const file = await getJson(`${API_ROOT}/contents/${MANIFEST_PATH}?ref=${encodeURIComponent(ref)}`)
  if (file?.type !== 'file' || file.path !== MANIFEST_PATH || file.encoding !== 'base64' ||
      typeof file.content !== 'string') throw new Error('Canonical graph is unavailable on protected main')
  const bytes = Buffer.from(file.content.replace(/\s/g, ''), 'base64')
  // Validate exact GitHub blob bytes. Do not hash a Windows checkout, whose
  // CRLF conversion gives it different bytes from the committed graph.
  assertGitBlobSha(bytes, file.sha)
  const graphSha256 = assertCanonicalGraphSha256(bytes)
  const content = bytes.toString('utf8')
  let manifest
  try { manifest = JSON.parse(content) } catch { throw new Error('Canonical graph JSON is invalid') }
  return { bytes, graphSha256, manifest: assertManifest(manifest) }
}

async function readCanonicalGraph() {
  const branch = await getJson(`${API_ROOT}/branches/${DEFAULT_BRANCH}`)
  const mainSha = branch?.commit?.sha
  if (!SHA1.test(mainSha ?? '') || branch.protected !== true) {
    throw new Error('GitHub did not confirm a protected main revision')
  }

  const approvedGraphAncestry = await getJson(
    `${API_ROOT}/compare/${CANONICAL_GRAPH_APPROVAL_COMMIT}...${mainSha}`)
  if (!['ahead', 'identical'].includes(approvedGraphAncestry?.status) ||
      approvedGraphAncestry.behind_by !== 0) {
    throw new Error('Protected main does not contain the approved canonical graph source commit')
  }

  const [approvedGraph, mainGraph] = await Promise.all([
    readPinnedGraphAt(CANONICAL_GRAPH_APPROVAL_COMMIT),
    readPinnedGraphAt(mainSha),
  ])
  if (approvedGraph.graphSha256 !== mainGraph.graphSha256 || !approvedGraph.bytes.equals(mainGraph.bytes)) {
    throw new Error('Canonical graph bytes changed from the approved source commit')
  }
  return { mainSha, manifest: mainGraph.manifest }
}

async function verifyHistoricalMerge(expected, mainSha) {
  const pr = await getJson(`${API_ROOT}/pulls/${expected.prNumber}`)
  if (pr?.number !== expected.prNumber || pr.state !== 'closed' || pr.merged !== true ||
      pr.base?.repo?.full_name !== REPOSITORY || pr.head?.repo?.full_name !== REPOSITORY ||
      pr.base?.ref !== expected.targetBranch || pr.head?.sha !== expected.headSha ||
      pr.merge_commit_sha !== expected.mergeCommitSha || !pr.merged_at) {
    throw new Error(`GitHub PR #${expected.prNumber} does not match the protected historical merge scope`)
  }

  const commit = await getJson(`${API_ROOT}/commits/${expected.mergeCommitSha}`)
  const parents = commit?.parents?.map(parent => parent.sha)
  if (commit?.sha !== expected.mergeCommitSha || !Array.isArray(parents) ||
      parents[0] !== expected.baseSha || parents[1] !== expected.headSha) {
    throw new Error(`GitHub merge commit for PR #${expected.prNumber} has unexpected parent scope`)
  }

  const ancestry = await getJson(`${API_ROOT}/compare/${expected.mergeCommitSha}...${mainSha}`)
  if (!['ahead', 'identical'].includes(ancestry?.status) || ancestry.behind_by !== 0) {
    throw new Error(`PR #${expected.prNumber} merge commit is not an ancestor of current main`)
  }
}

async function verifyTrustedHistoricalMerges(state) {
  const { mainSha, manifest } = await readCanonicalGraph()
  assertCheckpointGraph(state, manifest)
  const trustedTaskIds = []
  for (const merge of manifest.historicalMerges) {
    try {
      await verifyHistoricalMerge(merge, mainSha)
      trustedTaskIds.push(merge.taskId)
    } catch {
      // A missing, changed, or unavailable PR observation blocks this merge
      // and its descendants. It does not invalidate the independently
      // authenticated graph or strand unrelated ready work.
    }
  }

  // Recheck the main target after collecting PR evidence. The caller invokes
  // this provider again on every persisted transition and every session
  // resume; current bypass-actor state is intentionally outside this
  // historical-only proof and remains required for any future merge gate.
  const finalBranch = await getJson(`${API_ROOT}/branches/${DEFAULT_BRANCH}`)
  if (finalBranch?.protected !== true || finalBranch?.commit?.sha !== mainSha) {
    throw new Error('Protected main changed during historical merge reconciliation')
  }
  return Object.freeze(trustedTaskIds)
}

module.exports = { verifyTrustedHistoricalMerges }
