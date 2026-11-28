'use strict'

// Read-only GitHub-native evidence preflight. This is NOT an automatic-merge
// authorizer. Never run privileged code from an untrusted PR checkout.
const REPOSITORY = 'HamedGithubforwork/QuizForge-AI'
const REPOSITORY_ID = 1307099196
const OWNER_ID = 148009407
const TARGET = 'main'
const RULESET_ID = 21886458
const REQUIRED_GATE = 'Required PR gate'
const GITHUB_ACTIONS_APP_ID = 15368
const CI_WORKFLOW_ID = 330113334
const CI_WORKFLOW_PATH = '.github/workflows/ci.yml'
const API = 'https://api.github.com/repos/' + REPOSITORY
const SHA = /^[a-f0-9]{40}$/
const MAX_API_PAGES = 10
const MAX_API_ITEMS = MAX_API_PAGES * 100

async function readGithub(url) {
  // No token or write access is required for this public-repository preflight.
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'QuizForge-github-native-read-only-preflight',
      'Cache-Control': 'no-cache',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error('GitHub read failed: HTTP ' + response.status)
  return response.json()
}

function blocked(reason) {
  return Object.freeze({ status: 'UNVERIFIED', mergeAuthorized: false, reason })
}

function ruleAppliesToMain(ruleset) {
  const refs = ruleset?.conditions?.ref_name
  return refs && Array.isArray(refs.include) && Array.isArray(refs.exclude) &&
    refs.exclude.length === 0 && refs.include.includes('~DEFAULT_BRANCH')
}

function checkRuleset(ruleset) {
  if (ruleset?.id !== RULESET_ID || ruleset.enforcement !== 'active' ||
      ruleset.source_type !== 'Repository' || ruleset.source !== REPOSITORY ||
      ruleset.target !== 'branch' || !ruleAppliesToMain(ruleset) ||
      !Array.isArray(ruleset.bypass_actors) || ruleset.bypass_actors.length !== 0 ||
      !Array.isArray(ruleset.rules)) return 'protections_unverified'
  const required = ruleset.rules.find(rule => rule.type === 'required_status_checks')?.parameters
  if (!required || required.strict_required_status_checks_policy !== true ||
      !Array.isArray(required.required_status_checks) ||
      !required.required_status_checks.some(check => check.context === REQUIRED_GATE &&
        check.integration_id === GITHUB_ACTIONS_APP_ID)) return 'required_gate_not_enforced'
  if (!ruleset.rules.some(rule => rule.type === 'pull_request')) return 'pr_protection_missing'
  if (!ruleset.rules.some(rule => rule.type === 'merge_queue')) return 'merge_queue_not_enforced'
  return null
}

function runIncludesExactPullRequest(run, { prNumber, headSha, baseSha }) {
  if (!Array.isArray(run?.pull_requests) || run.pull_requests.length > MAX_API_ITEMS) return false
  return run.pull_requests.some(pr => pr?.number === prNumber &&
    pr.head?.repo?.id === REPOSITORY_ID && pr.head?.sha === headSha &&
    pr.base?.repo?.id === REPOSITORY_ID && pr.base?.ref === TARGET && pr.base?.sha === baseSha)
}

function exactRequiredGate(checks, expected) {
  if (!Number.isInteger(checks?.total_count) || checks.total_count < 1 ||
      checks.total_count > MAX_API_ITEMS || !Array.isArray(checks.check_runs) ||
      checks.check_runs.length !== checks.total_count) return null
  const gates = checks.check_runs.filter(check => check.name === REQUIRED_GATE)
  if (gates.length !== 1) return null
  const gate = gates[0]
  const urlMatch = typeof gate.details_url === 'string' && gate.details_url.match(
    /^https:\/\/github\.com\/HamedGithubforwork\/QuizForge-AI\/actions\/runs\/([1-9][0-9]*)\/job\/[1-9][0-9]*$/)
  if (gate.app?.id !== GITHUB_ACTIONS_APP_ID || gate.head_sha !== expected.headSha ||
      gate.status !== 'completed' || gate.conclusion !== 'success' ||
      !Number.isSafeInteger(gate.check_suite?.id) || !urlMatch ||
      (expected.checkId !== undefined && gate.id !== expected.checkId) ||
      (expected.checkSuiteId !== undefined && gate.check_suite.id !== expected.checkSuiteId) ||
      (expected.runId !== undefined && Number(urlMatch[1]) !== expected.runId)) return null
  return { gate, runId: Number(urlMatch[1]) }
}

async function readAllCheckRuns(headSha, read) {
  const runs = []
  const ids = new Set()
  let totalCount
  for (let page = 1; page <= MAX_API_PAGES; page += 1) {
    const response = await read(API + '/commits/' + headSha + '/check-runs?per_page=100&page=' + page)
    if (!Number.isSafeInteger(response?.total_count) || response.total_count < 0 ||
        response.total_count > MAX_API_ITEMS || !Array.isArray(response.check_runs) ||
        response.check_runs.length > 100 ||
        (totalCount !== undefined && response.total_count !== totalCount)) return null
    totalCount = response.total_count
    for (const check of response.check_runs) {
      if (!Number.isSafeInteger(check?.id) || ids.has(check.id)) return null
      ids.add(check.id)
      runs.push(check)
    }
    if (runs.length === totalCount) return { total_count: totalCount, check_runs: runs }
    if (runs.length > totalCount || response.check_runs.length === 0 || page === MAX_API_PAGES) return null
  }
  return null
}

async function readAllAssociatedPullRequests(headSha, read) {
  const pulls = []
  const numbers = new Set()
  for (let page = 1; page <= MAX_API_PAGES; page += 1) {
    const response = await read(API + '/commits/' + headSha + '/pulls?per_page=100&page=' + page)
    if (!Array.isArray(response) || response.length > 100) return null
    for (const pull of response) {
      if (!Number.isSafeInteger(pull?.number) || numbers.has(pull.number)) return null
      numbers.add(pull.number)
      pulls.push(pull)
    }
    if (response.length < 100) return pulls
  }
  return null
}

function exactWorkflowDefinition(file) {
  return file?.type === 'file' && typeof file.sha === 'string' && SHA.test(file.sha)
}

async function readUnchangedCiWorkflow(baseSha, headSha, read) {
  const baseFileUrl = API + '/contents/' + CI_WORKFLOW_PATH + '?ref=' + baseSha
  const headFileUrl = API + '/contents/' + CI_WORKFLOW_PATH + '?ref=' + headSha
  const [baseFile, headFile] = await Promise.all([read(baseFileUrl), read(headFileUrl)])
  return exactWorkflowDefinition(baseFile) && exactWorkflowDefinition(headFile) &&
    baseFile.sha === headFile.sha
}

function exactCiRun(run, expected) {
  return run?.id === expected.runId && run.workflow_id === CI_WORKFLOW_ID &&
    // The live Actions API response for run 44029170185 reports the bare path
    // `.github/workflows/ci.yml`; do not infer an undocumented ref suffix.
    run.path === CI_WORKFLOW_PATH && run.event === 'pull_request' &&
    run.head_sha === expected.headSha && run.check_suite_id === expected.checkSuiteId &&
    run.status === 'completed' && run.conclusion === 'success' &&
    run.repository?.id === REPOSITORY_ID &&
    runIncludesExactPullRequest(run, expected)
}

async function inspectGithubNativePreflight(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    return blocked('invalid_input')
  }
  const { prNumber, read = readGithub } = options
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || typeof read !== 'function') {
    return blocked('invalid_input')
  }
  try {
    const [repo, pr, main, ruleset] = await Promise.all([
      read(API), read(API + '/pulls/' + prNumber),
      read(API + '/branches/' + TARGET), read(API + '/rulesets/' + RULESET_ID),
    ])
    if (repo?.id !== REPOSITORY_ID || repo?.owner?.id !== OWNER_ID ||
        repo.full_name !== REPOSITORY || repo.default_branch !== TARGET ||
        repo.allow_auto_merge !== false) return blocked('repository_identity_or_settings_mismatch')
    const base = main?.commit?.sha
    const head = pr?.head?.sha
    if (main?.protected !== true || !SHA.test(base ?? '') ||
        pr?.number !== prNumber || pr.state !== 'open' || pr.draft !== false ||
        pr.merged !== false || pr.mergeable !== true ||
        pr.base?.ref !== TARGET || pr.base?.repo?.id !== REPOSITORY_ID ||
        pr.head?.repo?.id !== REPOSITORY_ID || !SHA.test(head ?? '') ||
        pr.base.sha !== base) return blocked('pr_head_base_or_scope_unverified')

    // A candidate cannot change the workflow definition whose success is used
    // as evidence. Compare the GitHub API blob identities at protected main
    // and the candidate head; unavailable or malformed content fails closed.
    if (!await readUnchangedCiWorkflow(base, head, read)) {
      return blocked('ci_workflow_definition_changed_or_unverified')
    }

    // Verify check issuer, suite, run, and PR association, not a supplied URL.
    const [checks, associated] = await Promise.all([
      readAllCheckRuns(head, read),
      readAllAssociatedPullRequests(head, read),
    ])
    if (!Array.isArray(associated) ||
        !associated.some(p => p.number === prNumber &&
          p.head?.sha === head && p.base?.repo?.id === REPOSITORY_ID && p.base?.ref === TARGET)) {
      return blocked('github_check_or_pr_association_unverified')
    }
    const gateResult = exactRequiredGate(checks, { headSha: head })
    if (!gateResult) return blocked('required_gate_unverified')
    const { gate, runId } = gateResult
    const run = await read(API + '/actions/runs/' + runId)
    const runScope = { runId, prNumber, headSha: head, baseSha: base, checkSuiteId: gate.check_suite.id }
    if (!exactCiRun(run, runScope)) return blocked('ci_run_unverified')

    const ruleFailure = checkRuleset(ruleset)
    if (ruleFailure) return blocked(ruleFailure)

    // Multi-read TOCTOU guard. A future privileged executor needs atomic queue
    // admission as well; this read-only observation cannot authorize a merge.
    const [finalPr, finalMain, finalRules, finalRepo, finalChecks, finalWorkflowUnchanged] = await Promise.all([
      read(API + '/pulls/' + prNumber), read(API + '/branches/' + TARGET),
      read(API + '/rulesets/' + RULESET_ID), read(API),
      readAllCheckRuns(head, read), readUnchangedCiWorkflow(base, head, read),
    ])
    const finalGateResult = exactRequiredGate(finalChecks, {
      headSha: head, checkId: gate.id, checkSuiteId: gate.check_suite.id, runId,
    })
    const finalRun = await read(API + '/actions/runs/' + runId)
    if (finalPr?.head?.sha !== head || finalPr?.base?.sha !== base ||
        finalPr?.state !== 'open' || finalPr?.draft !== false ||
        finalPr?.merged !== false || finalPr?.mergeable !== true ||
        finalPr?.base?.ref !== TARGET || finalPr?.base?.repo?.id !== REPOSITORY_ID ||
        finalPr?.head?.repo?.id !== REPOSITORY_ID ||
        finalMain?.commit?.sha !== base || finalMain?.protected !== true ||
        finalRepo?.id !== REPOSITORY_ID || finalRepo?.owner?.id !== OWNER_ID ||
        finalRepo?.default_branch !== TARGET || finalRepo?.allow_auto_merge !== false ||
        !finalWorkflowUnchanged || checkRuleset(finalRules) ||
        !finalGateResult || !exactCiRun(finalRun, runScope)) {
      return blocked('state_changed_during_preflight')
    }

    return Object.freeze({
      status: 'OBSERVATION_ONLY', mergeAuthorized: false, reason: 'read_only_preflight_only',
      repositoryId: REPOSITORY_ID, prNumber, headSha: head, baseSha: base,
      requiredGateCheckId: gate.id, ciRunId: run.id, rulesetId: RULESET_ID,
    })
  } catch {
    return blocked('github_unavailable_or_invalid')
  }
}

module.exports = { inspectGithubNativePreflight }
