'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { REPOSITORY, parseGhResult, resolveGh, verify } = require('../github-manual-preflight.cjs')

const script = path.join(__dirname, '..', 'github-manual-preflight.cjs')
const repoApi = `repos/${REPOSITORY}`
const branchApi = `${repoApi}/branches/main`
const classicApi = `${branchApi}/protection`
const effectiveApi = `${repoApi}/rules/branches/main`
const rulesetApi = `${repoApi}/rulesets/21886458`
const extraRulesetApi = `${repoApi}/rulesets/91234`
const sha = 'a'.repeat(40)

function expectedRules() {
  return [
    { type: 'deletion', ruleset_id: 21886458, ruleset_source_type: 'Repository', ruleset_source: REPOSITORY },
    { type: 'non_fast_forward', ruleset_id: 21886458, ruleset_source_type: 'Repository', ruleset_source: REPOSITORY },
    { type: 'pull_request', ruleset_id: 21886458, parameters: { required_approving_review_count: 0,
      dismiss_stale_reviews_on_push: false, required_reviewers: [], require_code_owner_review: false,
      require_last_push_approval: false, required_review_thread_resolution: false,
      require_extra_approval_for_unattributed_changes: false,
      allowed_merge_methods: ['merge', 'squash', 'rebase'] },
      ruleset_source_type: 'Repository', ruleset_source: REPOSITORY },
    { type: 'required_status_checks', ruleset_id: 21886458,
      parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: false,
        required_status_checks: [{ context: 'Required PR gate', integration_id: 15368 }] },
      ruleset_source_type: 'Repository', ruleset_source: REPOSITORY },
  ]
}

function fixtures(overrides = {}) {
  return {
    user: { status: 200, body: { login: 'HamedGithubforwork' } },
    [repoApi]: { status: 200, body: { full_name: REPOSITORY, default_branch: 'main', permissions: { admin: true } } },
    [branchApi]: { status: 200, body: { name: 'main', commit: { sha } } },
    [classicApi]: { status: 404, body: { message: 'Branch not protected', status: '404' } },
    [effectiveApi]: { status: 200, body: expectedRules() },
    [rulesetApi]: { status: 200, body: { id: 21886458, name: 'Protect main', target: 'branch',
      source_type: 'Repository', source: REPOSITORY, enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        { type: 'pull_request', parameters: { required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false, required_reviewers: [], require_code_owner_review: false,
          require_last_push_approval: false, required_review_thread_resolution: false,
          require_extra_approval_for_unattributed_changes: false,
          allowed_merge_methods: ['merge', 'squash', 'rebase'] } },
        { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: [{ context: 'Required PR gate', integration_id: 15368 }] } },
      ],
      bypass_actors: [], current_user_can_bypass: 'never' } },
    ...overrides,
  }
}

function fakeRunner(responses) {
  const counts = new Map()
  return endpoint => {
    const count = (counts.get(endpoint) ?? 0) + 1
    counts.set(endpoint, count)
    let fixture = responses[endpoint]
    if (Array.isArray(fixture)) fixture = fixture[Math.min(count - 1, fixture.length - 1)]
    return fixture ?? { status: null, body: null, unavailable: 'unexpected_endpoint' }
  }
}

test('successful preflight reports complete live config without credential-like fields', async () => {
  const report = await verify({ run: fakeRunner(fixtures()) })
  assert.equal(report.status, 'VERIFIED')
  assert.equal(report.account, 'HamedGithubforwork')
  assert.equal(report.repositoryPermission, 'admin')
  assert.equal(report.branch, 'main')
  assert.equal(report.classicProtection.httpStatus, 404)
  assert.equal(report.classicProtection.applies, false)
  assert.equal(report.strictRequiredStatusChecks, true)
  assert.equal(report.rulesets[0].bypassActorCount, 0)
  assert.equal(report.rulesets[0].canCurrentUserBypass, 'never')
  assert.equal(report.configuration.effectiveRules.length, 4)
  assert.equal(report.configuration.rulesets[0].rules.length, 4)
  assert.match(report.configurationSha256, /^[a-f0-9]{64}$/)
  assert.equal(report.automaticMergeEligible, false)
  assert.doesNotMatch(JSON.stringify(report), /gho_[A-Za-z0-9_]+/)
})

test('non-Windows CLI invocation is UNVERIFIED without invoking PATH binaries', t => {
  if (process.platform === 'win32') return t.skip('Windows host uses the pinned GitHub CLI installation path')
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: '/tmp/untrusted-bin' } })
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'UNVERIFIED')
  assert.equal(report.reason, 'unsupported_platform')
  assert.equal(report.automaticMergeEligible, false)
})

test('a verified 404 for classic protection is accepted only with verified repository, admin, and branch identity', async () => {
  const result = await verify({ run: fakeRunner(fixtures()) })
  assert.equal(result.status, 'VERIFIED')
  assert.equal(result.classicProtection.httpStatus, 404)
})

test('permission denied is UNVERIFIED and never interpreted as absent protection', async () => {
  const result = await verify({ run: endpoint => endpoint === 'user'
    ? { status: 200, body: { login: 'HamedGithubforwork' } }
    : { status: 403, body: { message: 'Forbidden' } } })
  assert.equal(result.status, 'UNVERIFIED')
  assert.equal(result.reason, 'permission_denied')
  assert.equal(result.automaticMergeEligible, false)
})

test('expired CLI authentication is UNVERIFIED', async () => {
  const result = await verify({ run: () => ({ status: 401, body: { message: 'Bad credentials' } }) })
  assert.equal(result.status, 'UNVERIFIED')
  assert.equal(result.reason, 'authentication_failed')
})

test('missing GitHub CLI is UNVERIFIED', async () => {
  const result = await verify({ run: () => ({ status: null, body: null, unavailable: 'missing_cli' }) })
  assert.equal(result.status, 'UNVERIFIED')
  assert.equal(result.reason, 'missing_cli')
})

test('API outage and rate limit are UNVERIFIED', async t => {
  for (const status of [503, 429]) {
    await t.test(`HTTP ${status}`, async () => {
      const result = await verify({ run: () => ({ status, body: { message: 'unavailable' } }) })
      assert.equal(result.status, 'UNVERIFIED')
      assert.equal(result.automaticMergeEligible, false)
    })
  }
})

test('changed check, integration identity, pull-request rule, missing guard, or extra ruleset is BLOCKED', async t => {
  const badCheck = fixtures({ [effectiveApi]: { status: 200, body: expectedRules().map(rule => rule.type === 'required_status_checks'
    ? { ...rule, parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'Other gate' }] } }
    : rule) } })
  const badRuleset = fixtures({ [rulesetApi]: { status: 200, body: { id: 21886458, name: 'Changed',
    enforcement: 'active', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [], current_user_can_bypass: 'never' } } })
  const badIntegration = fixtures({ [effectiveApi]: { status: 200, body: expectedRules().map(rule => rule.type === 'required_status_checks'
    ? { ...rule, parameters: { ...rule.parameters,
      required_status_checks: [{ context: 'Required PR gate', integration_id: 99999 }] } }
    : rule) } })
  const badReview = fixtures({ [effectiveApi]: { status: 200, body: expectedRules().map(rule => rule.type === 'pull_request'
    ? { ...rule, parameters: { ...rule.parameters, required_approving_review_count: 1 } } : rule) } })
  const missingGuard = fixtures({ [effectiveApi]: { status: 200, body: expectedRules().filter(rule => rule.type !== 'deletion') } })
  const extraRuleset = fixtures({ [effectiveApi]: { status: 200,
    body: [...expectedRules(), { type: 'required_linear_history', ruleset_id: 91234,
      ruleset_source_type: 'Repository', ruleset_source: REPOSITORY }] },
  [extraRulesetApi]: { status: 200, body: { id: 91234, name: 'Additional rule set', target: 'branch',
    source_type: 'Repository', source: REPOSITORY, enforcement: 'active',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [{ type: 'required_linear_history' }], bypass_actors: [], current_user_can_bypass: 'never' } } })
  for (const [name, responses] of [['required check', badCheck], ['integration identity', badIntegration],
    ['pull-request rule', badReview], ['missing guard', missingGuard], ['additional ruleset', extraRuleset], ['ruleset', badRuleset]]) {
    await t.test(name, async () => {
      const report = await verify({ run: fakeRunner(responses) })
      assert.equal(report.status, 'BLOCKED')
      assert.equal(report.automaticMergeEligible, false)
    })
  }
})

test('unexpected repository or target branch is blocked before any GitHub request', async () => {
  let calls = 0
  for (const scope of [{ repository: 'attacker/other' }, { branch: 'release' }]) {
    const result = await verify({ ...scope, run: () => { calls += 1 } })
    assert.equal(result.status, 'BLOCKED')
    assert.equal(result.reason, 'unexpected_repository_or_target_branch')
    assert.equal(result.automaticMergeEligible, false)
  }
  assert.equal(calls, 0)
})

test('a change between the two live reads blocks the snapshot', async () => {
  const responses = fixtures({ [branchApi]: [
    { status: 200, body: { name: 'main', commit: { sha } } },
    { status: 200, body: { name: 'main', commit: { sha: 'b'.repeat(40) } } },
  ] })
  const result = await verify({ run: fakeRunner(responses) })
  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.reason, 'github_evidence_changed_during_preflight')
  assert.equal(result.automaticMergeEligible, false)
})

test('a protection change before the final assessment is caught by a fresh preflight', async () => {
  let current = fixtures()
  const first = await verify({ run: fakeRunner(current) })
  assert.equal(first.status, 'VERIFIED')
  current = fixtures({ [effectiveApi]: { status: 200, body: expectedRules().map(rule => rule.type === 'required_status_checks'
    ? { ...rule, parameters: { strict_required_status_checks_policy: false,
      required_status_checks: [{ context: 'Required PR gate', integration_id: 15368 }] } }
    : rule) } })
  const finalAssessment = await verify({ run: fakeRunner(current) })
  assert.equal(finalAssessment.status, 'BLOCKED')
  assert.equal(finalAssessment.reason, 'required_strict_status_check_missing')
  assert.equal(finalAssessment.automaticMergeEligible, false)
})

test('all newly applicable rulesets are fetched before the unexpected configuration is blocked', async () => {
  const responses = fixtures({ [effectiveApi]: { status: 200,
    body: [...expectedRules(), { type: 'required_linear_history', ruleset_id: 91234,
      ruleset_source_type: 'Repository', ruleset_source: REPOSITORY }] },
  [extraRulesetApi]: { status: 200, body: { id: 91234, name: 'Additional rule set', target: 'branch',
    source_type: 'Repository', source: REPOSITORY, enforcement: 'active',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [{ type: 'required_linear_history' }], bypass_actors: [], current_user_can_bypass: 'never' } } })
  const calls = []
  const result = await verify({ run: endpoint => {
    calls.push(endpoint)
    return fakeRunner(responses)(endpoint)
  } })
  assert.equal(result.status, 'BLOCKED')
  assert.ok(calls.includes(extraRulesetApi), 'fetch the additional effective ruleset before blocking the changed set')
  assert.equal(result.automaticMergeEligible, false)
})

test('HTTP 404 without the precise Branch not protected response remains UNVERIFIED', async () => {
  const responses = fixtures({ [classicApi]: { status: 404, body: { message: 'Not Found' } } })
  const result = await verify({ run: fakeRunner(responses) })
  assert.equal(result.status, 'UNVERIFIED')
  assert.equal(result.reason, 'resource_not_found')
})

test('a 200 classic protection response blocks with sanitized field details', async () => {
  const responses = fixtures({ [classicApi]: { status: 200, body: { required_status_checks: {}, enforce_admins: { enabled: true } } } })
  const result = await verify({ run: fakeRunner(responses) })
  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.reason, 'classic_protection_present_requires_manual_configuration_review')
  assert.deepEqual(result.classicConfiguration, { required_status_checks: {}, enforce_admins: { enabled: true } })
  assert.equal(result.automaticMergeEligible, false)
})

test('a nonzero CLI exit cannot validate a parsed HTTP 200 while errors retain their HTTP status', () => {
  const successText = 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}'
  const deniedText = 'HTTP/2.0 403 Forbidden\r\nContent-Type: application/json\r\n\r\n{"message":"Forbidden"}'
  assert.deepEqual(parseGhResult({ status: 1, stdout: successText }), {
    status: null, body: null, unavailable: 'cli_failed_after_http_success',
  })
  assert.deepEqual(parseGhResult({ status: 1, stdout: deniedText }), { status: 403, body: { message: 'Forbidden' } })
})

test('authenticated account, repository, and branch mismatches are BLOCKED', async t => {
  for (const [name, responses] of [
    ['account', fixtures({ user: { status: 200, body: { login: 'someone-else' } } })],
    ['repository permission', fixtures({ [repoApi]: { status: 200, body: { full_name: REPOSITORY, default_branch: 'main', permissions: { admin: false } } } })],
    ['branch identity', fixtures({ [branchApi]: { status: 200, body: { name: 'develop', commit: { sha } } } })],
  ]) {
    await t.test(name, async () => {
      const report = await verify({ run: fakeRunner(responses) })
      assert.equal(report.status, 'BLOCKED')
      assert.equal(report.automaticMergeEligible, false)
    })
  }
})

test('Windows CLI resolution prefers only the official install path over PATH shims', () => {
  const official = resolveGh({ platform: 'win32', env: { PATH: 'D:\\gh-bin', ProgramFiles: 'C:\\Program Files' },
    exists: candidate => candidate === 'D:\\gh-bin\\gh.exe' || candidate === 'C:\\Program Files\\GitHub CLI\\gh.exe' })
  assert.equal(official, 'C:\\Program Files\\GitHub CLI\\gh.exe')
  const pathOnly = resolveGh({ platform: 'win32', env: { PATH: 'D:\\gh-bin', ProgramFiles: 'C:\\Program Files' },
    exists: candidate => candidate === 'D:\\gh-bin\\gh.exe' })
  assert.equal(pathOnly, null)
  const missing = resolveGh({ platform: 'win32', env: { PATH: '', ProgramFiles: 'C:\\Program Files' }, exists: () => false })
  assert.equal(missing, null)
  assert.equal(resolveGh({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: () => true }), null)
})
