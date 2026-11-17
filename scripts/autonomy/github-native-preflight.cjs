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
const API = 'https://api.github.com/repos/' + REPOSITORY
const SHA = /^[a-f0-9]{40}$/

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
  return Object.freeze({ verified: false, mergeAuthorized: false, reason })
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

async function inspectGithubNativePreflight({ prNumber, read = readGithub } = {}) {
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

    // Verify check issuer, suite, run, and PR association, not a supplied URL.
    const [checks, associated] = await Promise.all([
      read(API + '/commits/' + head + '/check-runs?per_page=100'),
      read(API + '/commits/' + head + '/pulls?per_page=100'),
    ])
    if (!Number.isInteger(checks?.total_count) || checks.total_count < 1 ||
        checks.total_count > 100 || !Array.isArray(checks.check_runs) ||
        checks.check_runs.length !== checks.total_count || !Array.isArray(associated) ||
        associated.length > 100 || !associated.some(p => p.number === prNumber &&
          p.head?.sha === head && p.base?.repo?.id === REPOSITORY_ID && p.base?.ref === TARGET)) {
      return blocked('github_check_or_pr_association_unverified')
    }
    const gates = checks.check_runs.filter(check => check.name === REQUIRED_GATE)
    if (gates.length !== 1) return blocked('required_gate_ambiguous_or_missing')
    const gate = gates[0]
    const urlMatch = typeof gate.details_url === 'string' && gate.details_url.match(
      /^https:\/\/github\.com\/HamedGithubforwork\/QuizForge-AI\/actions\/runs\/([1-9][0-9]*)\/job\/[1-9][0-9]*$/)
    if (gate.app?.id !== GITHUB_ACTIONS_APP_ID || gate.head_sha !== head ||
        gate.status !== 'completed' || gate.conclusion !== 'success' ||
        !Number.isSafeInteger(gate.check_suite?.id) || !urlMatch) return blocked('required_gate_unverified')
    const run = await read(API + '/actions/runs/' + urlMatch[1])
    if (run?.id !== Number(urlMatch[1]) || run.workflow_id !== CI_WORKFLOW_ID ||
        run.path !== '.github/workflows/ci.yml' || run.event !== 'pull_request' ||
        run.head_sha !== head || run.check_suite_id !== gate.check_suite.id ||
        run.status !== 'completed' || run.conclusion !== 'success' ||
        run.repository?.id !== REPOSITORY_ID) return blocked('ci_run_unverified')

    const ruleFailure = checkRuleset(ruleset)
    if (ruleFailure) return blocked(ruleFailure)

    // Multi-read TOCTOU guard. A future privileged executor needs atomic queue
    // admission as well; this read-only observation cannot authorize a merge.
    const [finalPr, finalMain, finalRules, finalRepo] = await Promise.all([
      read(API + '/pulls/' + prNumber), read(API + '/branches/' + TARGET),
      read(API + '/rulesets/' + RULESET_ID), read(API),
    ])
    if (finalPr?.head?.sha !== head || finalPr?.base?.sha !== base ||
        finalPr?.state !== 'open' || finalPr?.draft !== false ||
        finalPr?.merged !== false || finalPr?.mergeable !== true ||
        finalPr?.base?.ref !== TARGET || finalPr?.base?.repo?.id !== REPOSITORY_ID ||
        finalMain?.commit?.sha !== base || finalMain?.protected !== true ||
        finalRepo?.id !== REPOSITORY_ID || finalRepo?.owner?.id !== OWNER_ID ||
        finalRepo?.allow_auto_merge !== false || checkRuleset(finalRules)) {
      return blocked('state_changed_during_preflight')
    }

    return Object.freeze({
      verified: true, mergeAuthorized: false, reason: 'read_only_preflight_only',
      repositoryId: REPOSITORY_ID, prNumber, headSha: head, baseSha: base,
      requiredGateCheckId: gate.id, ciRunId: run.id, rulesetId: RULESET_ID,
    })
  } catch {
    return blocked('github_unavailable_or_invalid')
  }
}

module.exports = { inspectGithubNativePreflight }
