'use strict'

// Supervised, read-only GitHub CLI preflight. This script is deliberately not
// imported by either merge policy evaluator and cannot authorize or perform a
// merge. Every invocation fetches live state twice so changes during a check
// fail closed instead of reusing cached observations.
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')

const REPOSITORY = 'HamedGithubforwork/QuizForge-AI'
const BRANCH = 'main'
const EXPECTED_LOGIN = 'HamedGithubforwork'
const REQUIRED_CHECK = 'Required PR gate'
const REQUIRED_RULESET_ID = 21886458
const EXPECTED_RULESET = {
  id: REQUIRED_RULESET_ID,
  name: 'Protect main',
  target: 'branch',
  source_type: 'Repository',
  source: REPOSITORY,
  enforcement: 'active',
  conditions: { ref_name: { exclude: [], include: ['~DEFAULT_BRANCH'] } },
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    { type: 'pull_request', parameters: {
      required_approving_review_count: 0,
      dismiss_stale_reviews_on_push: false,
      required_reviewers: [],
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_review_thread_resolution: false,
      require_extra_approval_for_unattributed_changes: false,
      allowed_merge_methods: ['merge', 'squash', 'rebase'],
    } },
    { type: 'required_status_checks', parameters: {
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: false,
      required_status_checks: [{ context: REQUIRED_CHECK, integration_id: 15368 }],
    } },
  ],
  bypass_actors: [],
  current_user_can_bypass: 'never',
}
const EXPECTED_EFFECTIVE_RULES = EXPECTED_RULESET.rules.map(rule => ({
  ...rule,
  ruleset_id: REQUIRED_RULESET_ID,
  ruleset_source_type: 'Repository',
  ruleset_source: REPOSITORY,
}))
const SHA1 = /^[a-f0-9]{40}$/

function parseArguments(args) {
  const result = { repository: REPOSITORY, branch: BRANCH }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--repo' && args[index + 1]) result.repository = args[++index]
    else if (args[index] === '--branch' && args[index + 1]) result.branch = args[++index]
    else throw new Error('Usage: github-manual-preflight.cjs [--repo OWNER/REPO] [--branch BRANCH]')
  }
  return result
}

function readHttpResponse(stdout) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout ?? '')
  const matches = [...text.matchAll(/HTTP\/\d(?:\.\d)?\s+(\d{3})[^\r\n]*\r?\n/g)]
  if (!matches.length) return null
  const last = matches[matches.length - 1]
  const afterStatus = text.slice(last.index)
  const separator = afterStatus.search(/\r?\n\r?\n/)
  if (separator < 0) return null
  const bodyText = afterStatus.slice(separator).replace(/^\r?\n\r?\n/, '').trim()
  let body
  try { body = JSON.parse(bodyText) } catch { return null }
  return { status: Number(last[1]), body }
}

function parseGhResult(result) {
  if (result.error) {
    return { status: null, body: null, unavailable: result.error.code === 'ENOENT' ? 'missing_cli' : 'cli_error' }
  }
  const response = readHttpResponse(result.stdout)
  if (!response) return { status: null, body: null, unavailable: 'no_http_response' }
  if (response.status === 200 && result.status !== 0) {
    return { status: null, body: null, unavailable: 'cli_failed_after_http_success' }
  }
  return response
}

function resolveGh({ platform = process.platform, env = process.env, exists = require('node:fs').existsSync } = {}) {
  if (platform !== 'win32') return null
  const programFiles = env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files'
  const installed = require('node:path').join(programFiles, 'GitHub CLI', 'gh.exe')
  // Prefer the standard official Winget location over a PATH-resolved
  // executable, which could shadow the authenticated CLI with a shim.
  if (exists(installed)) return installed
  return null
}

function runGh(endpoint) {
  const executable = resolveGh()
  if (!executable) return { status: null, body: null, unavailable: process.platform === 'win32' ? 'missing_cli' : 'unsupported_platform' }
  const args = ['api', '--include', '--method', 'GET', '--hostname', 'github.com',
    '-H', 'Cache-Control: no-cache', endpoint]
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    shell: false,
    maxBuffer: 4 * 1024 * 1024,
  })
  return parseGhResult(result)
}

function endpointFor(path) {
  return `repos/${REPOSITORY}/${path}`
}

function unresolved(result, endpoint) {
  const status = result?.status
  const reason = status === 401 ? 'authentication_failed' :
    status === 403 ? 'permission_denied' :
      status === 429 ? 'rate_limited' :
        status === 404 ? 'resource_not_found' :
          status === null ? (result?.unavailable ?? 'request_failed') : 'github_api_error'
  return { status: 'UNVERIFIED', reason, failedEndpoint: endpoint, httpStatus: status ?? undefined }
}

function sanitizedClassicConfiguration(configuration = {}) {
  const allowedFields = [
    'required_status_checks', 'enforce_admins', 'required_pull_request_reviews', 'restrictions',
    'required_signatures', 'required_linear_history', 'allow_force_pushes', 'allow_deletions',
    'block_creations', 'required_conversation_resolution', 'lock_branch', 'allow_fork_syncing',
    'required_deployments',
  ]
  return Object.fromEntries(allowedFields.filter(key => Object.hasOwn(configuration, key))
    .map(key => [key, configuration[key]]))
}

async function collectSnapshot(run) {
  const userEndpoint = 'user'
  const user = run(userEndpoint)
  if (user.status !== 200 || !user.body || typeof user.body.login !== 'string') return unresolved(user, userEndpoint)
  const account = user.body.login
  if (account.toLowerCase() !== EXPECTED_LOGIN.toLowerCase()) {
    return { status: 'BLOCKED', reason: 'authenticated_account_mismatch', failedEndpoint: userEndpoint }
  }

  const repoEndpoint = `repos/${REPOSITORY}`
  const repo = run(repoEndpoint)
  if (repo.status !== 200 || repo.body?.full_name?.toLowerCase() !== REPOSITORY.toLowerCase() ||
      repo.body?.permissions?.admin !== true || repo.body?.default_branch !== BRANCH) {
    if (repo.status !== 200) return unresolved(repo, repoEndpoint)
    return { status: 'BLOCKED', reason: 'repository_identity_or_admin_permission_mismatch', failedEndpoint: repoEndpoint }
  }

  const branchEndpoint = endpointFor(`branches/${BRANCH}`)
  const branch = run(branchEndpoint)
  if (branch.status !== 200) return unresolved(branch, branchEndpoint)
  if (branch.body?.name !== BRANCH) {
    return { status: 'BLOCKED', reason: 'unexpected_target_branch', failedEndpoint: branchEndpoint }
  }
  if (!SHA1.test(branch.body?.commit?.sha ?? '')) {
    return { status: 'UNVERIFIED', reason: 'branch_identity_or_revision_unavailable', failedEndpoint: branchEndpoint }
  }

  const classicEndpoint = endpointFor(`branches/${BRANCH}/protection`)
  const classic = run(classicEndpoint)
  const classicAbsent = classic.status === 404 && classic.body?.message === 'Branch not protected'
  if (classic.status !== 200 && !classicAbsent) return unresolved(classic, classicEndpoint)
  if (classic.status === 200) {
    return { status: 'BLOCKED', reason: 'classic_protection_present_requires_manual_configuration_review',
      failedEndpoint: classicEndpoint, classicConfiguration: sanitizedClassicConfiguration(classic.body),
      unrecognizedConfigurationFields: Object.keys(classic.body ?? {}).filter(key =>
        !['url', 'required_status_checks', 'enforce_admins', 'required_pull_request_reviews', 'restrictions',
          'required_signatures', 'required_linear_history', 'allow_force_pushes', 'allow_deletions',
          'block_creations', 'required_conversation_resolution', 'lock_branch', 'allow_fork_syncing',
          'required_deployments', 'name', 'protection_url'].includes(key)).sort() }
  }

  const effectiveEndpoint = endpointFor(`rules/branches/${BRANCH}`)
  const effective = run(effectiveEndpoint)
  if (effective.status !== 200 || !Array.isArray(effective.body)) return unresolved(effective, effectiveEndpoint)

  const requiredRules = effective.body.filter(rule => rule?.type === 'required_status_checks')
  const checkConfigured = requiredRules.some(rule => rule.parameters?.strict_required_status_checks_policy === true &&
    Array.isArray(rule.parameters?.required_status_checks) &&
    rule.parameters.required_status_checks.some(check => check?.context === REQUIRED_CHECK &&
      check.integration_id === 15368))
  if (!checkConfigured) {
    return { status: 'BLOCKED', reason: 'required_strict_status_check_missing', failedEndpoint: effectiveEndpoint }
  }

  const ids = [...new Set(effective.body.map(rule => rule?.ruleset_id).filter(id => Number.isSafeInteger(id)))]
  if (effective.body.some(rule => !Number.isSafeInteger(rule?.ruleset_id))) {
    return { status: 'BLOCKED', reason: 'unattributed_effective_rule', failedEndpoint: effectiveEndpoint }
  }

  const rulesets = []
  const rulesetConfigurations = []
  for (const id of ids.sort((a, b) => a - b)) {
    const endpoint = endpointFor(`rulesets/${id}`)
    const response = run(endpoint)
    if (response.status !== 200) return unresolved(response, endpoint)
    const ruleset = response.body
    const config = {
      id: ruleset?.id,
      name: ruleset?.name,
      target: ruleset?.target,
      source_type: ruleset?.source_type,
      source: ruleset?.source,
      enforcement: ruleset?.enforcement,
      conditions: ruleset?.conditions,
      rules: ruleset?.rules,
      bypass_actors: ruleset?.bypass_actors,
      current_user_can_bypass: ruleset?.current_user_can_bypass,
    }
    if (stableDigest(config) !== stableDigest(EXPECTED_RULESET)) {
      const bypassFound = Array.isArray(ruleset?.bypass_actors) && ruleset.bypass_actors.length > 0
      return { status: 'BLOCKED',
        reason: bypassFound ? 'ruleset_has_bypass_actors' : 'ruleset_configuration_changed_or_unverified',
        failedEndpoint: endpoint }
    }
    rulesetConfigurations.push(config)
    rulesets.push({
      id,
      name: typeof ruleset.name === 'string' ? ruleset.name : null,
      enforcement: ruleset.enforcement,
      bypassActorCount: ruleset.bypass_actors.length,
      canCurrentUserBypass: ruleset.current_user_can_bypass,
    })
  }
  if (stableDigest(effective.body) !== stableDigest(EXPECTED_EFFECTIVE_RULES)) {
    return { status: 'BLOCKED', reason: 'effective_branch_rule_configuration_changed', failedEndpoint: effectiveEndpoint }
  }
  if (ids.length !== 1 || ids[0] !== REQUIRED_RULESET_ID) {
    return { status: 'BLOCKED', reason: 'applicable_ruleset_set_changed', failedEndpoint: effectiveEndpoint }
  }

  const configuration = {
    repository: REPOSITORY,
    branch: BRANCH,
    branchSha: branch.body.commit.sha,
    classicProtection: { httpStatus: classic.status, applies: !classicAbsent },
    effectiveRules: effective.body,
    rulesets: rulesetConfigurations,
  }
  return {
    status: 'SNAPSHOT',
    account,
    repository: REPOSITORY,
    repositoryPermission: 'admin',
    branch: BRANCH,
    branchSha: branch.body.commit.sha,
    classicProtection: { httpStatus: classic.status, applies: !classicAbsent },
    requiredCheck: REQUIRED_CHECK,
    strictRequiredStatusChecks: true,
    effectiveRuleTypes: [...new Set(effective.body.map(rule => rule.type).filter(type => typeof type === 'string'))].sort(),
    rulesets,
    configuration,
    configurationSha256: stableDigest(configuration),
  }
}

function stableDigest(value) {
  function canonical(input) {
    if (Array.isArray(input)) return input.map(canonical)
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])]))
    }
    return input
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

async function verify({ repository = REPOSITORY, branch = BRANCH, run = runGh, now = () => new Date() } = {}) {
  const startedAt = now().toISOString()
  if (repository.toLowerCase() !== REPOSITORY.toLowerCase() || branch !== BRANCH) {
    return { status: 'BLOCKED', reason: 'unexpected_repository_or_target_branch', repository, branch, startedAt,
      automaticMergeEligible: false }
  }
  const first = await collectSnapshot(run)
  if (first.status !== 'SNAPSHOT') {
    return { ...first, repository: REPOSITORY, branch: BRANCH, startedAt, finishedAt: now().toISOString(),
      automaticMergeEligible: false }
  }
  const second = await collectSnapshot(run)
  const finishedAt = now().toISOString()
  if (second.status !== 'SNAPSHOT') {
    return { ...second, repository: REPOSITORY, branch: BRANCH, startedAt, finishedAt,
      automaticMergeEligible: false }
  }
  const firstDigest = stableDigest(first)
  const secondDigest = stableDigest(second)
  if (firstDigest !== secondDigest) {
    return { status: 'BLOCKED', reason: 'github_evidence_changed_during_preflight', repository: REPOSITORY,
      branch: BRANCH, startedAt, finishedAt, firstSnapshotSha256: firstDigest, secondSnapshotSha256: secondDigest,
      automaticMergeEligible: false }
  }
  return { ...second, status: 'VERIFIED', startedAt, finishedAt, snapshotSha256: secondDigest,
    automaticMergeEligible: false }
}

async function main() {
  let scope
  try { scope = parseArguments(process.argv.slice(2)) } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'BLOCKED', reason: 'invalid_scope_arguments',
      automaticMergeEligible: false })}\n`)
    process.exitCode = 2
    return
  }
  const result = await verify({ repository: scope.repository, branch: scope.branch })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.status !== 'VERIFIED') process.exitCode = 1
}

if (require.main === module) main().catch(() => {
  process.stdout.write(`${JSON.stringify({ status: 'UNVERIFIED', reason: 'unexpected_preflight_failure',
    automaticMergeEligible: false })}\n`)
  process.exitCode = 1
})

module.exports = { BRANCH, EXPECTED_LOGIN, REPOSITORY, REQUIRED_CHECK, REQUIRED_RULESET_ID,
  parseArguments, parseGhResult, readHttpResponse, resolveGh, verify }
