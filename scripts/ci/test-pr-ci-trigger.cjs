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
  assert.match(gate, /uses: actions\/checkout@v7[\s\S]*uses: actions\/setup-node@v7/)
  assert.match(gate, /run: node scripts\/ci\/verify-required-pr-gate\.cjs/)
})

function successfulGateInputs(overrides = {}) {
  return {
    CHANGES_RESULT: 'success',
    BACKEND_RESULT: 'success',
    BACKEND_REQUIRED: 'true',
    FRONTEND_RESULT: 'success',
    FRONTEND_REQUIRED: 'true',
    PLAYWRIGHT_RESULT: 'success',
    PLAYWRIGHT_REQUIRED: 'true',
    WORKFLOW_POLICY_RESULT: 'success',
    ...overrides,
  }
}

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
  })))
})

test('missing, failed, and cancelled conditional jobs fail the gate', () => {
  for (const result of [undefined, 'failure', 'cancelled']) {
    assert.throws(
      () => verifyRequiredPrGate(successfulGateInputs({ BACKEND_RESULT: result })),
      /did not succeed despite its change relevance/,
      String(result),
    )
  }
})

test('missing or invalid change-relevance outputs fail closed', () => {
  assert.throws(
    () => verifyRequiredPrGate(successfulGateInputs({ BACKEND_REQUIRED: undefined })),
    /relevance output must be true or false/,
  )
  assert.throws(
    () => verifyRequiredPrGate(successfulGateInputs({ BACKEND_REQUIRED: 'yes' })),
    /relevance output must be true or false/,
  )
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
