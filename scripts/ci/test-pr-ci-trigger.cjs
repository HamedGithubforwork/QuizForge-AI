const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { verifyRequiredPrGate } = require('./verify-required-pr-gate.cjs')

const repositoryRoot = path.resolve(__dirname, '../..')
const workflowPath = path.join(repositoryRoot, '.github/workflows/ci.yml')
const requiredGateName = 'Required PR gate'

function pullRequestTriggerBlock(workflowText) {
  const lines = workflowText.split(/\r?\n/)
  const triggerLine = lines.findIndex(line => /^  pull_request:\s*$/.test(line))
  assert.notEqual(triggerLine, -1, 'CI workflow must declare pull_request')

  const body = []
  for (const line of lines.slice(triggerLine + 1)) {
    if (line.trim() && !/^\s{4,}/.test(line)) break
    body.push(line)
  }
  return body.join('\n')
}

function mergeGroupTriggerBlock(workflowText) {
  const lines = workflowText.split(/\r?\n/)
  const triggerLine = lines.findIndex(line => /^  merge_group:\s*$/.test(line))
  assert.notEqual(triggerLine, -1, 'CI workflow must declare merge_group')

  const body = []
  for (const line of lines.slice(triggerLine + 1)) {
    if (line.trim() && !/^\s{4,}/.test(line)) break
    body.push(line)
  }
  return body.join('\n')
}

function configuredList(block, key) {
  const inline = block.match(new RegExp(`^    ${key}:\\s*\\[([^\\]]*)\\]`, 'm'))
  if (inline) return inline[1].split(',').map(value => value.trim()).filter(Boolean)

  const list = block.match(new RegExp(`^    ${key}:\\s*\\n((?:      - [^\\n]+\\n?)+)`, 'm'))
  return list ? [...list[1].matchAll(/^      - ([^\r\n]+)$/gm)].map(match => match[1].trim()) : null
}

function allowsPullRequestActivity(workflowText, baseBranch, activity) {
  const block = pullRequestTriggerBlock(workflowText)
  const branches = configuredList(block, 'branches')
  const explicitTypes = configuredList(block, 'types')
  const activityTypes = explicitTypes ?? ['opened', 'synchronize', 'reopened']
  const branchAllowed = branches === null || branches.includes(baseBranch)
  return branchAllowed && activityTypes.includes(activity)
}

test('CI runs a PR-associated gate for stacked PR opened, synchronize, and reopened events', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  for (const action of ['opened', 'synchronize', 'reopened']) {
    assert.equal(allowsPullRequestActivity(workflow, 'codex/stacked-parent', action), true, action)
  }
  assert.equal(allowsPullRequestActivity(workflow, 'main', 'opened'), true)
  // Retargeting produces an edited event; this workflow intentionally does not
  // rely on that operation as a trigger for required checks.
  assert.equal(allowsPullRequestActivity(workflow, 'main', 'edited'), false)
  assert.match(workflow, /name:\s*Required PR gate/)
  assert.match(workflow, /required-pr-gate:/)
})

test('CI retains ordinary PR events and requests checks for merge groups targeting main', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  for (const action of ['opened', 'synchronize', 'reopened']) {
    assert.equal(allowsPullRequestActivity(workflow, 'codex/stacked-parent', action), true, action)
  }

  const mergeGroup = mergeGroupTriggerBlock(workflow)
  assert.match(mergeGroup, /^    types: \[checks_requested\]$/m)
  assert.match(mergeGroup, /^    branches: \[main\]$/m)
  assert.equal(mergeGroup.includes('branches: [codex/stacked-parent]'), false)

  const classifier = workflow.slice(workflow.indexOf('  changes:'), workflow.indexOf('  backend-tests:'))
  assert.match(classifier, /EVENT_NAME.*== "merge_group"/)
  assert.match(classifier, /MERGE_GROUP_BASE_SHA/)
  assert.match(classifier, /MERGE_GROUP_HEAD_SHA/)
  assert.match(classifier, /\[\[ "\$\{MERGE_GROUP_HEAD_SHA\}" == "\$\{CURRENT_SHA\}" \]\]/)
  assert.match(classifier, /git diff --name-only "\$\{MERGE_GROUP_BASE_SHA\}" "\$\{MERGE_GROUP_HEAD_SHA\}"/)
  assert.match(classifier, /git fetch --no-tags origin "\$\{MERGE_GROUP_BASE_SHA\}"/)
  assert.match(classifier, /Invalid merge-group (base|head) SHA/)
})

test('regression model rejects the prior main-only retarget procedure', () => {
  const priorMainOnlyWorkflow = `on:\n  pull_request:\n    branches:\n      - main\n`
  assert.equal(allowsPullRequestActivity(priorMainOnlyWorkflow, 'codex/stacked-parent', 'opened'), false)
  assert.equal(allowsPullRequestActivity(priorMainOnlyWorkflow, 'main', 'edited'), false)
})

test('workflow policy test runs unconditionally and is connected to the existing Required PR gate', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  const jobStart = workflow.indexOf('  workflow-policy-tests:')
  const gateStart = workflow.indexOf('  required-pr-gate:', jobStart)
  assert.notEqual(jobStart, -1)
  assert.notEqual(gateStart, -1)
  const policyJob = workflow.slice(jobStart, gateStart)
  assert.match(policyJob, /name: CI trigger policy tests/)
  assert.doesNotMatch(policyJob, /^\s+if:/m, 'policy test must not depend on the classifier it checks')
  assert.doesNotMatch(policyJob, /^\s+needs:/m, 'policy test must run even if change detection fails')
  const gate = workflow.slice(workflow.indexOf('  required-pr-gate:'))
  assert.match(gate, /- workflow-policy-tests/)
  assert.match(gate, /WORKFLOW_POLICY_RESULT/)
  assert.match(gate, /needs\.workflow-policy-tests\.result/)
  assert.match(gate, /BACKEND_REQUIRED: \$\{\{ needs\.changes\.outputs\.backend \}\}/)
  assert.match(gate, /FRONTEND_REQUIRED: \$\{\{ needs\.changes\.outputs\.frontend \}\}/)
  assert.match(gate, /PLAYWRIGHT_REQUIRED: \$\{\{ needs\.changes\.outputs\.playwright \}\}/)
  assert.match(gate, /DESKTOP_DIAGNOSTIC_REQUIRED: \$\{\{ needs\.changes\.outputs\.desktop_diagnostic \}\}/)
  assert.match(gate, /AUTONOMY_REQUIRED: \$\{\{ needs\.changes\.outputs\.autonomy_tests \}\}/)
  assert.match(gate, /uses: actions\/checkout@v7[\s\S]*uses: actions\/setup-node@v7/)
  assert.match(gate, /run: node scripts\/ci\/verify-required-pr-gate\.cjs/)
})

test('integration coordinator source and tests trigger autonomy verification', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  const pushStart = workflow.indexOf('  push:')
  const pullRequestStart = workflow.indexOf('  pull_request:', pushStart)
  assert.notEqual(pushStart, -1, 'CI workflow must declare push')
  assert.ok(pullRequestStart > pushStart, 'push filters must precede pull_request filters')
  const pushBlock = workflow.slice(pushStart, pullRequestStart)
  const coordinatorPaths = [
    'scripts/autonomy/integration-coordinator.cjs',
    'scripts/autonomy/test/integration-coordinator.test.cjs',
    'scripts/autonomy/trusted-integration-verifier.cjs',
    'scripts/autonomy/test/trusted-integration-verifier.test.cjs',
    'docs/autonomy/integration-task-graph.json',
  ]
  for (const changedPath of coordinatorPaths) {
    assert.ok(pushBlock.split(/\r?\n/).includes(`      - "${changedPath}"`), `${changedPath} must trigger push CI`)
  }
  assert.ok(workflow.includes(`${coordinatorPaths[0]}|${coordinatorPaths[1]}`), 'both paths must mark autonomy tests relevant')
  const classifierStart = workflow.indexOf('          while IFS= read -r file; do')
  const classifierEnd = workflow.indexOf('          done < changed-files.txt', classifierStart)
  const classifier = workflow.slice(classifierStart, classifierEnd)
  for (const changedPath of coordinatorPaths) {
    assert.ok(classifier.includes(changedPath), `${changedPath} must mark autonomy tests relevant`)
  }
  assert.match(workflow, /autonomy_tests=true/)
  const ciWorkflowCase = classifier.match(/\.github\/workflows\/ci\.yml\)\r?\n([\s\S]*?)\r?\n\s+;;/)
  assert.ok(ciWorkflowCase, 'CI workflow changes must be classified')
  assert.match(ciWorkflowCase[1], /autonomy_tests=true/, 'CI workflow changes must run autonomy tests')
  assert.match(workflow, /name: Optimization orchestrator tests/)
  assert.match(workflow, /if: needs\.changes\.outputs\.autonomy_tests == 'true'/)
  const autonomyJobStart = workflow.indexOf('  autonomy-tests:')
  const requiredGateStart = workflow.indexOf('  required-pr-gate:', autonomyJobStart)
  const autonomyJob = workflow.slice(autonomyJobStart, requiredGateStart)
  assert.match(autonomyJob, /node --test scripts\/autonomy\/test\/optimization-orchestrator\.test\.cjs scripts\/autonomy\/test\/integration-coordinator\.test\.cjs scripts\/autonomy\/test\/trusted-integration-verifier\.test\.cjs/,
    'autonomy CI must execute the trusted integration verifier regression suite when classified relevant')
})

function successfulGateInputs(overrides = {}) {
  return {
    EVENT_NAME: 'pull_request',
    REPOSITORY_ID: '1307099196',
    BASE_REPOSITORY_ID: '1307099196',
    PR_BASE_REF: 'codex/stacked-parent',
    GIT_REF: 'refs/heads/main',
    CHANGES_RESULT: 'success',
    BACKEND_RESULT: 'success',
    BACKEND_REQUIRED: 'true',
    FRONTEND_RESULT: 'success',
    FRONTEND_REQUIRED: 'true',
    PLAYWRIGHT_RESULT: 'success',
    PLAYWRIGHT_REQUIRED: 'true',
    DESKTOP_DIAGNOSTIC_RESULT: 'success',
    DESKTOP_DIAGNOSTIC_REQUIRED: 'true',
    AUTONOMY_RESULT: 'success',
    AUTONOMY_REQUIRED: 'true',
    WORKFLOW_POLICY_RESULT: 'success',
    ...overrides,
  }
}

test('Required PR gate accepts a verified merge-group context for main', () => {
  assert.doesNotThrow(() => verifyRequiredPrGate(successfulGateInputs({
    EVENT_NAME: 'merge_group',
    MERGE_GROUP_BASE_REF: 'refs/heads/main',
    BASE_REPOSITORY_ID: undefined,
    PR_BASE_REF: undefined,
  })))
})

test('Required PR gate accepts a main push for the expected repository', () => {
  assert.doesNotThrow(() => verifyRequiredPrGate(successfulGateInputs({
    EVENT_NAME: 'push',
    GIT_REF: 'refs/heads/main',
    BASE_REPOSITORY_ID: undefined,
    PR_BASE_REF: undefined,
  })))
})

test('stacked PR target refs with valid plus and at-sign characters are accepted', () => {
  assert.doesNotThrow(() => verifyRequiredPrGate(successfulGateInputs({
    PR_BASE_REF: 'release/+candidate@v2',
  })))
})

test('wrong repository, PR base repository, or merge-group branch identity fails closed', () => {
  for (const overrides of [
    { REPOSITORY_ID: '999999999' },
    { BASE_REPOSITORY_ID: '999999999' },
    { PR_BASE_REF: '' },
    { EVENT_NAME: 'merge_group', MERGE_GROUP_BASE_REF: 'refs/heads/release' },
    { EVENT_NAME: 'merge_group', MERGE_GROUP_BASE_REF: undefined },
    { EVENT_NAME: 'push', GIT_REF: 'refs/heads/release' },
    { EVENT_NAME: 'push', GIT_REF: undefined },
  ]) {
    assert.throws(() => verifyRequiredPrGate(successfulGateInputs(overrides)), /identity|target/i, JSON.stringify(overrides))
  }
})

test('unsupported events cannot produce a passing Required PR gate', () => {
  assert.throws(() => verifyRequiredPrGate(successfulGateInputs({ EVENT_NAME: 'workflow_dispatch' })), /Unsupported event/)
})

test('a skipped CI trigger policy test cannot pass the Required PR gate', () => {
  assert.throws(
    () => verifyRequiredPrGate(successfulGateInputs({ WORKFLOW_POLICY_RESULT: 'skipped' })),
    /CI trigger policy tests must run and pass/,
  )
})

test('relevant conditional jobs cannot be skipped', () => {
  for (const [resultKey, requiredKey] of [
    ['BACKEND_RESULT', 'BACKEND_REQUIRED'],
    ['FRONTEND_RESULT', 'FRONTEND_REQUIRED'],
    ['PLAYWRIGHT_RESULT', 'PLAYWRIGHT_REQUIRED'],
    ['DESKTOP_DIAGNOSTIC_RESULT', 'DESKTOP_DIAGNOSTIC_REQUIRED'],
    ['AUTONOMY_RESULT', 'AUTONOMY_REQUIRED'],
  ]) {
    assert.throws(
      () => verifyRequiredPrGate(successfulGateInputs({ [resultKey]: 'skipped' })),
      /did not succeed despite its change relevance/,
      requiredKey,
    )
  }
})

test('non-relevant conditional jobs may be skipped', () => {
  assert.doesNotThrow(() => verifyRequiredPrGate(successfulGateInputs({
    BACKEND_RESULT: 'skipped',
    BACKEND_REQUIRED: 'false',
    PLAYWRIGHT_RESULT: 'skipped',
    PLAYWRIGHT_REQUIRED: 'false',
    DESKTOP_DIAGNOSTIC_RESULT: 'skipped',
    DESKTOP_DIAGNOSTIC_REQUIRED: 'false',
    AUTONOMY_RESULT: 'skipped',
    AUTONOMY_REQUIRED: 'false',
  })))
})

test('missing, failed, and cancelled conditional jobs fail the gate', () => {
  for (const [resultKey] of [
    ['BACKEND_RESULT'], ['FRONTEND_RESULT'], ['PLAYWRIGHT_RESULT'],
    ['DESKTOP_DIAGNOSTIC_RESULT'], ['AUTONOMY_RESULT'],
  ]) {
    for (const result of [undefined, 'failure', 'cancelled']) {
      assert.throws(
        () => verifyRequiredPrGate(successfulGateInputs({ [resultKey]: result })),
        /did not succeed despite its change relevance/,
        `${resultKey}=${result}`,
      )
    }
  }
})

test('missing or invalid change-relevance outputs fail closed', () => {
  for (const requiredKey of [
    'BACKEND_REQUIRED', 'FRONTEND_REQUIRED', 'PLAYWRIGHT_REQUIRED',
    'DESKTOP_DIAGNOSTIC_REQUIRED', 'AUTONOMY_REQUIRED',
  ]) {
    assert.throws(
      () => verifyRequiredPrGate(successfulGateInputs({ [requiredKey]: undefined })),
      /relevance output must be true or false/,
      requiredKey,
    )
    assert.throws(
      () => verifyRequiredPrGate(successfulGateInputs({ [requiredKey]: 'yes' })),
      /relevance output must be true or false/,
      requiredKey,
    )
  }
})

test('Coordinator and CI assessors require actual event and check evidence', () => {
  const policies = [
    ['AGENTS.md', /actual completed Actions run/i, /activity types/i, /Required PR gate/i],
    ['.codex/agents/reviewer.toml', /actual completed Actions run/i, /activity types/i, /merge context/i],
    ['.codex/agents/qa.toml', /actual completed Actions run/i, /base-branch\/path\/label filters/i, /Required PR gate association/i],
    ['.codex/agents/release-reliability-engineer.toml', /actual Actions run/i, /event and activity types/i, /downstream/i],
    ['.codex/agents/merge-manager.toml', /actual completed Required PR gate/i, /event\/activity types/i, /present base/i],
  ]

  for (const [relativePath, ...requirements] of policies) {
    const contents = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8')
    for (const requirement of requirements) {
      assert.match(contents, requirement, `${relativePath} must include ${requirement}`)
    }
  }
})

test('Merge Manager requires fresh authenticated evidence when classic protection API is inaccessible', () => {
  const contents = fs.readFileSync(path.join(repositoryRoot, '.codex/agents/merge-manager.toml'), 'utf8')
  assert.match(contents, /user explicitly approves merging THIS specific repository and PR number/i)
  assert.match(contents, /Record the approved PR\/head SHA/i)
  assert.match(contents, /if the head, target branch, or relevant protection requirements change, require fresh explicit approval/i)
  assert.match(contents, /all effective branch protections and rulesets respected/i)
  assert.match(contents, /Never use admin\/bypass privileges/i)
  for (const requirement of [
    /classic branch protection/i,
    /returns 403/i,
    /active rulesets/i,
    /authenticated repository owner or administrator/i,
    /current conversation/i,
    /verified role/i,
    /prior 7 calendar days/i,
    /GitHub Settings → Branches/i,
    /inspection date/i,
    /exact repository and branch/i,
    /confirm the inspected settings remain unchanged/i,
    /screenshot alone/i,
    /stale evidence/i,
    /conflicts? with live rulesets/i,
    /UNVERIFIED and STOP/i,
    /never bypasses or relaxes protections/i,
    /direct read-only `gh api` procedure/,
    /not cryptographic account pinning/,
    /does not authenticate evidence to repository code/,
    /HTTP 403 is permission denied unless response headers\/message identify a primary or secondary rate limit/,
    /past observations are not permanent facts/i,
    /`trusted_live_verification_unavailable` result remains a hard stop/,
  ]) {
    assert.match(contents, requirement, `Merge Manager must include ${requirement}`)
  }
})

test('supervised manual gh api procedure is time-scoped and separate from automatic eligibility', () => {
  const runbook = fs.readFileSync(path.join(repositoryRoot, 'docs/autonomy/supervised-merge.md'), 'utf8')
  assert.match(runbook, /Authenticated manual protection preflight/)
  assert.match(runbook, /C:\\Program Files\\GitHub CLI\\gh\.exe/)
  assert.match(runbook, /Get-AuthenticodeSignature/)
  assert.match(runbook, /& \$gh auth status --hostname github\.com/)
  assert.match(runbook, /& \$gh api user --jq \.login/)
  assert.match(runbook, /permissions\.admin/)
  assert.match(runbook, /api --paginate --slurp repos\/HamedGithubforwork\/QuizForge-AI\/rules\/branches\/main/)
  assert.match(runbook, /effective = @\(\$effectivePages \| ForEach-Object/)
  assert.match(runbook, /rulesets\/\$id/)
  assert.match(runbook, /A classic-protection 200[\s\S]*alongside effective rules and ruleset details/)
  assert.match(runbook, /A 403 is permission\s+denied unless GitHub's response headers\/message reliably identify a primary or\s+secondary rate limit/)
  assert.match(runbook, /repeat `& \$gh auth status[\s\S]*repository permission read/)
  assert.match(runbook, /not cryptographic proof/)
  assert.match(runbook, /Do not reuse cached output/)
  assert.match(runbook, /Never pass CLI output, credentials, or checkpoint copies into the automatic/)
  assert.match(runbook, /`trusted_live_verification_unavailable` result remains a\s+hard stop/)
  assert.doesNotMatch(runbook, /github-manual-preflight\.cjs/)
  assert.doesNotMatch(runbook, /snapshotSha256/)
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'scripts/autonomy/github-manual-preflight.cjs')), false)
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'scripts/autonomy/test/github-manual-preflight.test.cjs')), false)
})
