const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')
const { verifyRequiredPrGate } = require('./verify-required-pr-gate.cjs')

const repositoryRoot = path.resolve(__dirname, '../..')
const workflowPath = path.join(repositoryRoot, '.github/workflows/ci.yml')
const classifierPath = path.join(repositoryRoot, 'scripts/ci/classify-changed-files.sh')
const mergeGroupValidatorPath = path.join(repositoryRoot, 'scripts/ci/validate-merge-group-commits.sh')
const requiredGateName = 'Required PR gate'

function bashExecutable() {
  return process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/bin/bash.exe')
    ? 'C:/Program Files/Git/bin/bash.exe'
    : 'bash'
}

function runClassifier(cwd, overrides = {}) {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'quizforge-ci-classifier-'))
  const changedFiles = path.join(outputDirectory, 'changed-files.txt')
  const githubOutput = path.join(outputDirectory, 'github-output.txt')
  fs.mkdirSync(path.join(cwd, 'scripts', 'ci'), { recursive: true })
  fs.copyFileSync(classifierPath, path.join(cwd, 'scripts', 'ci', 'classify-changed-files.sh'))
  fs.copyFileSync(mergeGroupValidatorPath, path.join(cwd, 'scripts', 'ci', 'validate-merge-group-commits.sh'))
  const result = spawnSync(bashExecutable(), ['scripts/ci/classify-changed-files.sh'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: githubOutput, CHANGED_FILES_PATH: changedFiles, ...overrides },
  })
  return {
    ...result,
    outputs: fs.existsSync(githubOutput) ? fs.readFileSync(githubOutput, 'utf8') : '',
    changed: fs.existsSync(changedFiles) ? fs.readFileSync(changedFiles, 'utf8').trimEnd().split(/\r?\n/).filter(Boolean) : [],
    cleanup: () => fs.rmSync(outputDirectory, { recursive: true, force: true }),
  }
}

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

test('backend ECR workflow changes use Required PR backend validation without duplicate builds', () => {
  const ciWorkflow = fs.readFileSync(workflowPath, 'utf8')
  const ecrWorkflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/backend-ecr.yml'), 'utf8')

  const pushStart = ciWorkflow.indexOf('  push:')
  const pullRequestStart = ciWorkflow.indexOf('  pull_request:', pushStart)
  const ciPushBlock = ciWorkflow.slice(pushStart, pullRequestStart)
  assert.ok(ciPushBlock.split(/\r?\n/).includes('      - ".github/workflows/backend-ecr.yml"'),
    'a main-branch edit to the ECR workflow must run credential-limited CI')
  for (const ciPolicyPath of [
    'scripts/ci/test-pr-ci-trigger.cjs',
    'scripts/ci/validate-merge-group-commits.sh',
    'scripts/ci/verify-required-pr-gate.cjs',
  ]) {
    assert.ok(ciPushBlock.split(/\r?\n/).includes(`      - "${ciPolicyPath}"`),
      `${ciPolicyPath} must run workflow-policy CI when changed on main`)
  }

  assert.ok(ciWorkflow.includes('bash scripts/ci/classify-changed-files.sh'),
    'CI must execute the same checked-in classifier exercised by tests')
  assert.ok(ciPushBlock.split(/\r?\n/).includes('      - "scripts/ci/classify-changed-files.sh"'),
    'classifier changes must trigger push CI')
  const classifier = fs.readFileSync(classifierPath, 'utf8')
  assert.match(classifier, /\.github\/workflows\/backend-ecr\.yml\)[\s\S]*?backend=true/,
    'ECR workflow edits must require the backend validation job')

  assert.doesNotMatch(ecrWorkflow, /^  pull_request:/m,
    'the ECR workflow must not duplicate CI backend builds on pull requests')
  const ecrPushBlock = ecrWorkflow.slice(ecrWorkflow.indexOf('  push:'), ecrWorkflow.indexOf('  workflow_dispatch:'))
  assert.match(ecrPushBlock, /branches:\s*\n\s+- main/)
  assert.match(ecrPushBlock, /- "backend\/\*\*"/)
  assert.doesNotMatch(ecrPushBlock, /backend-ecr\.yml/,
    'a workflow-file-only merge must not trigger an ECR publication')

  const pushJobStart = ecrWorkflow.search(/^  push:\r?\n    name: Push backend image to ECR/m)
  assert.notEqual(pushJobStart, -1, 'the ECR push job must remain present')
  const pushJob = ecrWorkflow.slice(pushJobStart)
  assert.match(pushJob, /\(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\) &&\s+github\.ref == 'refs\/heads\/main'/,
    'ECR publishing must remain limited to main push or manual runs on main')
  assert.match(pushJob, /id-token: write/)
  assert.match(pushJob, /role-to-assume: \$\{\{ vars\.AWS_ROLE_ARN \}\}/)
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
  const policyPaths = [
    'scripts/autonomy/automatic-merge-policy.cjs',
    'scripts/autonomy/test/automatic-merge-policy.test.cjs',
  ]
  for (const changedPath of [...coordinatorPaths, ...policyPaths]) {
    assert.ok(pushBlock.split(/\r?\n/).includes(`      - "${changedPath}"`), `${changedPath} must trigger push CI`)
  }
  const classifier = fs.readFileSync(classifierPath, 'utf8')
  assert.match(classifier, /scripts\/autonomy\/optimization-orchestrator\.cjs\|scripts\/autonomy\/test\/optimization-orchestrator\.test\.cjs/,
    'the classifier must group the orchestrator source and its tests')
  for (const changedPath of [...coordinatorPaths, ...policyPaths]) {
    assert.ok(classifier.includes(changedPath), `${changedPath} must mark autonomy tests relevant`)
  }
  assert.match(classifier, /autonomy_tests=true/)
  const ciWorkflowCase = classifier.match(/\.github\/workflows\/ci\.yml\)\r?\n([\s\S]*?)\r?\n\s+;;/)
  assert.ok(ciWorkflowCase, 'CI workflow changes must be classified')
  assert.match(ciWorkflowCase[1], /autonomy_tests=true/, 'CI workflow changes must run autonomy tests')
  assert.match(workflow, /name: Optimization orchestrator tests/)
  assert.match(workflow, /if: needs\.changes\.outputs\.autonomy_tests == 'true'/)
  const autonomyJobStart = workflow.indexOf('  autonomy-tests:')
  const requiredGateStart = workflow.indexOf('  required-pr-gate:', autonomyJobStart)
  const autonomyJob = workflow.slice(autonomyJobStart, requiredGateStart)
  assert.match(autonomyJob, /node --test scripts\/autonomy\/test\/optimization-orchestrator\.test\.cjs scripts\/autonomy\/test\/automatic-merge-policy\.test\.cjs scripts\/autonomy\/test\/integration-coordinator\.test\.cjs scripts\/autonomy\/test\/trusted-integration-verifier\.test\.cjs/,
    'autonomy CI must execute policy, coordinator, and verifier regression suites when classified relevant')
})

function successfulGateInputs(overrides = {}) {
  return {
    CI_EVENT_NAME: 'pull_request',
    CI_REPOSITORY: 'HamedGithubforwork/QuizForge-AI',
    CI_REPOSITORY_ID: '1307099196',
    CI_OWNER_ID: '148009407',
    CI_REF: 'refs/pull/42/merge',
    CI_SHA: 'a'.repeat(40),
    CI_AFTER_SHA: '',
    CI_PR_NUMBER: '42',
    CI_PR_BASE_REPOSITORY_ID: '1307099196',
    CI_PR_BASE_SHA: 'b'.repeat(40),
    CI_PR_HEAD_SHA: 'c'.repeat(40),
    CI_TARGET_REF: 'main',
    CI_GROUP_HEAD_REF: '',
    CI_GROUP_BASE_SHA: '',
    CI_GROUP_HEAD_SHA: '',
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

function mergeGroupInputs(overrides = {}) {
  const queueRef = 'refs/heads/gh-readonly-queue/main/pr-42-a1b2c3'
  return successfulGateInputs({
    CI_EVENT_NAME: 'merge_group',
    CI_REF: queueRef,
    CI_TARGET_REF: 'refs/heads/main',
    CI_GROUP_HEAD_REF: queueRef,
    CI_GROUP_BASE_SHA: 'b'.repeat(40),
    CI_GROUP_HEAD_SHA: 'c'.repeat(40),
    CI_SHA: 'c'.repeat(40),
    CI_PR_NUMBER: '',
    CI_PR_BASE_REPOSITORY_ID: '',
    CI_PR_BASE_SHA: '',
    CI_PR_HEAD_SHA: '',
    ...overrides,
  })
}

test('CI supports checks_requested for main merge groups and preserves ordinary PR triggers', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  assert.equal(allowsPullRequestActivity(workflow, 'codex/stacked-parent', 'opened'), true)
  assert.equal(allowsPullRequestActivity(workflow, 'codex/stacked-parent', 'synchronize'), true)
  assert.equal(allowsPullRequestActivity(workflow, 'codex/stacked-parent', 'reopened'), true)
  assert.match(workflow, /^  merge_group:\s*\n    types: \[checks_requested\]\s*\n    branches: \[main\]/m)
  assert.equal((workflow.match(/name: Required PR gate/g) || []).length, 1)
  assert.match(workflow, /- workflow-policy-tests/)
})

test('workflow delegates merge-group classification and ancestry checks to shared helpers', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  const classifierStart = workflow.indexOf('      - name: Classify changed files')
  const classifierEnd = workflow.indexOf('      - name:', classifierStart + 10)
  const step = workflow.slice(classifierStart, classifierEnd)
  assert.match(step, /MERGE_GROUP_BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}/)
  assert.match(step, /MERGE_GROUP_HEAD_SHA: \$\{\{ github\.event\.merge_group\.head_sha \}\}/)
  assert.match(step, /bash scripts\/ci\/classify-changed-files\.sh/)
  const classifier = fs.readFileSync(classifierPath, 'utf8')
  assert.match(classifier, /case "\$\{EVENT_NAME\}" in[\s\S]*merge_group\)/)
  assert.match(classifier, /bash "\$\{SCRIPT_DIR\}\/validate-merge-group-commits\.sh"/)
  const helper = fs.readFileSync(mergeGroupValidatorPath, 'utf8')
  assert.match(helper, /FETCH_TIMEOUT_SECONDS="\$\{FETCH_TIMEOUT_SECONDS:-120\}"/)
  assert.match(helper, /\^\(\[1-9\]\|\[1-9\]\[0-9\]\|1\[01\]\[0-9\]\|120\)\$/)
  assert.doesNotMatch(helper, /\(\(\s*FETCH_TIMEOUT_SECONDS/,
    'timeout input must be range-checked without shell arithmetic')
  assert.match(helper, /timeout --signal=TERM --kill-after=10s/)
  assert.match(helper, /git merge-base --is-ancestor "\$\{BASE_SHA\}" "\$\{HEAD_SHA\}"/)
})

test('actual merge-group shell validator handles local Git histories and failures', async t => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quizforge-merge-group-'))
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }))

  const runGit = (cwd, args, { allowFailure = false } = {}) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
    if (!allowFailure && result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`)
    }
    return result
  }
  const gitOutput = (cwd, args) => runGit(cwd, args).stdout.trim()
  const initRepo = (repoPath, bare = false) => {
    fs.mkdirSync(repoPath, { recursive: true })
    const args = bare ? ['init', '--bare', repoPath] : ['init', '-b', 'main', repoPath]
    const result = spawnSync('git', args, { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const commitFile = (repoPath, name, contents, message) => {
    const filePath = path.join(repoPath, name)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, contents)
    runGit(repoPath, ['add', name])
    runGit(repoPath, ['-c', 'user.name=QuizForge CI test', '-c', 'user.email=ci-test@example.invalid', 'commit', '-m', message])
    return gitOutput(repoPath, ['rev-parse', 'HEAD'])
  }
  const setupSource = (name, changedFiles = [['head.txt', 'head\n']]) => {
    const source = path.join(temporaryRoot, `${name}-source`)
    const remote = path.join(temporaryRoot, `${name}-remote.git`)
    initRepo(source)
    initRepo(remote, true)
    const baseSha = commitFile(source, 'base.txt', 'base\n', 'base')
    let headSha = baseSha
    const commitShas = []
    for (const [file, contents] of changedFiles) {
      headSha = commitFile(source, file, contents, `change ${file}`)
      commitShas.push(headSha)
    }
    runGit(source, ['remote', 'add', 'origin', remote])
    runGit(source, ['push', '-u', 'origin', 'main'])
    return { source, remote, baseSha, headSha, commitShas }
  }
  const clone = (remote, name) => {
    const destination = path.join(temporaryRoot, name)
    const result = spawnSync('git', ['clone', remote, destination], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return destination
  }
  const runValidator = (repoPath, values, remoteOverride, extraEnv = {}) => {
    if (remoteOverride) runGit(repoPath, ['remote', 'set-url', 'origin', remoteOverride])
    const helper = fs.readFileSync(path.join(repositoryRoot, 'scripts/ci/validate-merge-group-commits.sh'), 'utf8')
    return spawnSync(bashExecutable(), ['-s'], {
      cwd: repoPath,
      input: helper,
      encoding: 'utf8',
      env: { ...process.env, ...values, ...extraEnv },
    })
  }
  const baseEnvironment = (baseSha, headSha, currentSha = headSha) => ({
    MERGE_GROUP_BASE_SHA: baseSha,
    MERGE_GROUP_HEAD_SHA: headSha,
    CURRENT_SHA: currentSha,
  })

  await t.test('the workflow classifier handles relevant and unrelated changed paths from real temporary Git diffs', () => {
    const cases = [
      ['docs/only.md', 'docs\n', { backend: false, frontend: false, playwright: false, desktop_diagnostic: false, autonomy_tests: false }],
      ['.github/workflows/backend-ecr.yml', 'ecr workflow\n', { backend: true, frontend: false, playwright: false, desktop_diagnostic: false, autonomy_tests: false }],
      ['backend/api.py', 'backend\n', { backend: true, frontend: false, playwright: false, desktop_diagnostic: false, autonomy_tests: false }],
      ['frontend/src/page.tsx', 'frontend\n', { backend: true, frontend: true, playwright: true, desktop_diagnostic: false, autonomy_tests: false }],
      ['e2e/tests/quiz.spec.ts', 'e2e\n', { backend: true, frontend: true, playwright: true, desktop_diagnostic: false, autonomy_tests: false }],
      ['desktop/test/diagnose-targeted-practice.test.cjs', 'desktop\n', { backend: true, frontend: true, playwright: true, desktop_diagnostic: true, autonomy_tests: false }],
      ['scripts/autonomy/integration-coordinator.cjs', 'autonomy\n', { backend: true, frontend: true, playwright: true, desktop_diagnostic: true, autonomy_tests: true }],
      ['scripts/autonomy/automatic-merge-policy.cjs', 'merge policy\n', { backend: true, frontend: true, playwright: true, desktop_diagnostic: true, autonomy_tests: true }],
      ['scripts/autonomy/test/automatic-merge-policy.test.cjs', 'merge policy tests\n', { backend: true, frontend: true, playwright: true, desktop_diagnostic: true, autonomy_tests: true }],
    ]
    const history = setupSource('classifier-matrix', cases.map(([file, contents]) => [file, contents]))
    for (let index = 0; index < cases.length; index += 1) {
      const [file, , expected] = cases[index]
      const result = runClassifier(history.source, {
        EVENT_NAME: 'pull_request', BASE_SHA: history.baseSha, HEAD_SHA: history.commitShas[index],
      })
      try {
        assert.equal(result.status, 0, result.stderr)
        assert.deepEqual(result.changed.slice().sort(), cases.slice(0, index + 1).map(([changed]) => changed).sort(),
          'the complete changed-file list must contain only paths changed since the base')
        const outputs = Object.fromEntries(result.outputs.trim().split(/\r?\n/).map(line => line.split('=')))
        assert.deepEqual(outputs, Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, String(value)])),
          `relevance outputs for ${file}`)
      } finally {
        result.cleanup()
      }
    }
  })

  await t.test('merge-group classifier accepts valid context and rejects mismatched or unsupported events', () => {
    const history = setupSource('classifier-merge-group')
    const valid = runClassifier(history.source, {
      EVENT_NAME: 'merge_group',
      ...baseEnvironment(history.baseSha, history.headSha),
      MERGE_GROUP_BASE_SHA: history.baseSha,
      MERGE_GROUP_HEAD_SHA: history.headSha,
    })
    try {
      assert.equal(valid.status, 0, valid.stderr)
      assert.deepEqual(valid.changed, ['head.txt'])
      assert.match(valid.outputs, /^backend=false$/m)
    } finally {
      valid.cleanup()
    }

    for (const env of [
      { EVENT_NAME: 'merge_group', ...baseEnvironment(history.baseSha, history.headSha, 'd'.repeat(40)), MERGE_GROUP_BASE_SHA: history.baseSha, MERGE_GROUP_HEAD_SHA: history.headSha },
      { EVENT_NAME: 'merge_group', CURRENT_SHA: history.headSha, MERGE_GROUP_BASE_SHA: 'bad', MERGE_GROUP_HEAD_SHA: history.headSha },
      { EVENT_NAME: 'not_merge_group', CURRENT_SHA: history.headSha },
    ]) {
      const invalid = runClassifier(history.source, env)
      try {
        assert.notEqual(invalid.status, 0)
        assert.equal(invalid.outputs, '')
      } finally {
        invalid.cleanup()
      }
    }
  })

  await t.test('valid base/head verifies ancestry and emits the changed path', () => {
    const history = setupSource('valid')
    const checkout = clone(history.remote, 'valid-checkout')
    const result = runValidator(checkout, baseEnvironment(history.baseSha, history.headSha))
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.stdout.trim().split(/\r?\n/).sort(), ['head.txt'])
  })

  await t.test('missing local base is fetched and then verified', () => {
    const history = setupSource('fetchable')
    const checkout = path.join(temporaryRoot, 'fetchable-shallow')
    initRepo(checkout)
    runGit(checkout, ['remote', 'add', 'origin', pathToFileURL(history.remote).href])
    runGit(checkout, ['fetch', '--depth=1', 'origin', 'main'])
    runGit(checkout, ['checkout', '--detach', 'FETCH_HEAD'])
    assert.equal(gitOutput(checkout, ['rev-parse', '--is-shallow-repository']), 'true')
    assert.notEqual(runGit(checkout, ['cat-file', '-e', `${history.baseSha}^{commit}`], { allowFailure: true }).status, 0)

    const result = runValidator(checkout, baseEnvironment(history.baseSha, history.headSha))
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.stdout.trim().split(/\r?\n/).sort(), ['head.txt'])
    assert.equal(runGit(checkout, ['cat-file', '-e', `${history.baseSha}^{commit}`]).status, 0)
  })

  await t.test('base that cannot be fetched exits nonzero', () => {
    const history = setupSource('unavailable')
    const checkout = path.join(temporaryRoot, 'unavailable-shallow')
    const emptyRemote = path.join(temporaryRoot, 'empty-remote.git')
    initRepo(checkout)
    initRepo(emptyRemote, true)
    runGit(checkout, ['remote', 'add', 'origin', pathToFileURL(history.remote).href])
    runGit(checkout, ['fetch', '--depth=1', 'origin', 'main'])
    runGit(checkout, ['checkout', '--detach', 'FETCH_HEAD'])
    runGit(checkout, ['remote', 'set-url', 'origin', pathToFileURL(emptyRemote).href])

    const result = runValidator(checkout, baseEnvironment(history.baseSha, history.headSha))
    assert.notEqual(result.status, 0)
  })

  await t.test('stalled fetch times out and unsuccessful fetch fails without exposing remote diagnostics', async () => {
    const history = setupSource('bounded-fetch')
    const checkout = path.join(temporaryRoot, 'bounded-fetch-checkout')
    initRepo(checkout)
    runGit(checkout, ['remote', 'add', 'origin', pathToFileURL(history.remote).href])
    runGit(checkout, ['fetch', '--depth=1', 'origin', 'main'])
    runGit(checkout, ['checkout', '--detach', 'FETCH_HEAD'])
    const server = http.createServer(() => {})
    server.listen(0, '127.0.0.1')
    await new Promise((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    runGit(checkout, ['remote', 'set-url', 'origin', `http://127.0.0.1:${server.address().port}/stalled.git`])
    const timedOut = runValidator(checkout, baseEnvironment(history.baseSha, history.headSha), undefined, {
      FETCH_TIMEOUT_SECONDS: '1',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    })
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
    assert.notEqual(timedOut.status, 0)
    assert.match(timedOut.stderr, /Timed out after 1s/)

    const emptyRemote = path.join(temporaryRoot, 'synthetic-only-empty.git')
    initRepo(emptyRemote, true)
    runGit(checkout, ['remote', 'set-url', 'origin', pathToFileURL(emptyRemote).href])
    const failed = runValidator(checkout, baseEnvironment(history.baseSha, history.headSha), undefined,
      { FETCH_TIMEOUT_SECONDS: '1' })
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /Could not fetch merge-group base history/)
    assert.doesNotMatch(failed.stderr, /synthetic-only|https?:\/\//)
  })

  await t.test('available but non-ancestor base exits nonzero', () => {
    const history = setupSource('non-ancestor')
    const unrelated = path.join(temporaryRoot, 'non-ancestor-unrelated')
    initRepo(unrelated)
    const unrelatedBaseSha = commitFile(unrelated, 'unrelated.txt', 'unrelated\n', 'unrelated root')
    const checkout = clone(history.remote, 'non-ancestor-checkout')
    // Keep the unrelated commit available locally but outside the head ancestry.
    const unrelatedRemote = path.join(temporaryRoot, 'unrelated-remote.git')
    initRepo(unrelatedRemote, true)
    runGit(unrelated, ['remote', 'add', 'origin', unrelatedRemote])
    runGit(unrelated, ['push', '-u', 'origin', 'main'])
    runGit(checkout, ['fetch', pathToFileURL(unrelatedRemote).href, 'main'])

    const result = runValidator(checkout, baseEnvironment(unrelatedBaseSha, history.headSha))
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /not an ancestor/)
  })

  await t.test('checked-out/event head mismatch exits nonzero', () => {
    const history = setupSource('head-mismatch')
    const checkout = clone(history.remote, 'head-mismatch-checkout')
    const result = runValidator(checkout, baseEnvironment(history.baseSha, history.headSha, history.baseSha))
    assert.equal(result.status, 2)
    assert.match(result.stderr, /does not match/)
  })

  await t.test('invalid, inconsistent, and unavailable SHAs fail nonzero', () => {
    const history = setupSource('invalid-shas')
    const checkout = clone(history.remote, 'invalid-shas-checkout')
    for (const values of [
      baseEnvironment('not-a-sha', history.headSha),
      baseEnvironment(history.baseSha, 'c'.repeat(39)),
      baseEnvironment(history.baseSha, history.headSha, 'd'.repeat(40)),
      baseEnvironment(history.baseSha, 'f'.repeat(40)),
    ]) {
      const result = runValidator(checkout, values)
      assert.notEqual(result.status, 0)
    }
  })

  await t.test('fetch timeout accepts only canonical decimal integers from 1 through 120 before SHA or Git validation', () => {
    const history = setupSource('fetch-timeout-bound')
    const checkout = clone(history.remote, 'fetch-timeout-bound-checkout')
    const tracePath = path.join(temporaryRoot, 'fetch-timeout-invalid-git-trace.log')
    const invalidBase = { ...baseEnvironment('not-a-sha', history.headSha) }

    for (const timeout of ['', '1', '60', '120']) {
      const accepted = runValidator(checkout, invalidBase, undefined, {
        FETCH_TIMEOUT_SECONDS: timeout,
        GIT_TRACE: tracePath,
      })
      assert.equal(accepted.status, 2, `timeout ${timeout || '<default>'} must reach SHA validation`)
      assert.match(accepted.stderr, /Merge-group base SHA must be a full lowercase 40-character commit SHA/,
        `timeout ${timeout || '<default>'} must not be rejected by the timeout guard`)
      assert.doesNotMatch(accepted.stderr, /Fetch timeout must be/)
      assert.equal(fs.existsSync(tracePath), false, `timeout ${timeout || '<default>'} must be rejected before Git commands`)
    }

    for (const timeout of ['0', '121', '-1', 'abc', '01', '0001', '+60', ' 60', '60\n', '18446744073709551616', '9'.repeat(100)]) {
      fs.rmSync(tracePath, { force: true })
      const rejected = runValidator(checkout, invalidBase, undefined, {
        FETCH_TIMEOUT_SECONDS: timeout,
        GIT_TRACE: tracePath,
      })
      assert.equal(rejected.status, 2, `timeout ${timeout} must be rejected`)
      assert.match(rejected.stderr, /Fetch timeout must be a canonical decimal integer from 1 through 120/,
        `timeout ${timeout} must fail at the timeout guard`)
      assert.doesNotMatch(rejected.stderr, /commit SHA|Could not fetch|Timed out/,
        `timeout ${timeout} must be rejected before SHA validation or fetch`)
      assert.equal(fs.existsSync(tracePath), false, `timeout ${timeout} must not start Git`)
    }
  })
})

test('gate accepts valid merge-group context and stacked pull-request targets', () => {
  for (const target of ['codex/stacked-parent', 'release/+candidate@v2', 'refs/topic', 'feature/@version', 'UPPER_case-1', '@']) {
    assert.equal(spawnSync('git', ['check-ref-format', '--branch', target]).status, 0, `${target} must be valid by Git branch rules`)
    assert.doesNotThrow(() => verifyRequiredPrGate(successfulGateInputs({ CI_TARGET_REF: target })), target)
  }
  assert.doesNotThrow(() => verifyRequiredPrGate(mergeGroupInputs()))
})

test('gate rejects invalid Git branch names while accepting refs-prefixed short names', () => {
  for (const target of ['', '-leading-dash', 'branch with spaces', 'refs//topic', 'name..part', 'trailing.', 'bad.lock', 'slash//again', 'name@{upstream}']) {
    assert.notEqual(spawnSync('git', ['check-ref-format', '--branch', target]).status, 0, `${target} must be invalid by Git branch rules`)
    assert.throws(() => verifyRequiredPrGate(successfulGateInputs({ CI_TARGET_REF: target })), undefined, JSON.stringify(target))
  }
})

test('gate rejects mismatched repository identity and malformed pull-request context', () => {
  for (const override of [
    { CI_REPOSITORY: 'QuizFromNotes/QuizForge-AI' },
    { CI_REPOSITORY: 'HamedGithubforwork/Other' },
    { CI_REPOSITORY_ID: '999999999' },
    { CI_OWNER_ID: '356387243' },
    { CI_PR_BASE_REPOSITORY_ID: '999999999' },
    { CI_PR_NUMBER: '' },
    { CI_REF: 'refs/pull/43/merge' },
    { CI_TARGET_REF: '' },
    { CI_TARGET_REF: 'branch with spaces' },
    { CI_PR_BASE_SHA: 'b'.repeat(39) },
    { CI_PR_HEAD_SHA: '' },
    { CI_SHA: 'not-a-sha' },
    { CI_EVENT_NAME: 'workflow_dispatch' },
  ]) assert.throws(() => verifyRequiredPrGate(successfulGateInputs(override)), undefined, JSON.stringify(override))
})

test('gate rejects malformed or inconsistent merge-group target, ref, and SHA data', () => {
  for (const override of [
    { CI_TARGET_REF: 'refs/heads/release' },
    { CI_TARGET_REF: 'main' },
    { CI_REF: 'refs/heads/main' },
    { CI_GROUP_HEAD_REF: 'refs/heads/gh-readonly-queue/release/pr-42-id' },
    { CI_GROUP_HEAD_REF: '' },
    { CI_GROUP_BASE_SHA: 'invalid' },
    { CI_GROUP_BASE_SHA: '' },
    { CI_GROUP_HEAD_SHA: 'c'.repeat(39) },
    { CI_GROUP_HEAD_SHA: '' },
    { CI_SHA: 'd'.repeat(40) },
  ]) assert.throws(() => verifyRequiredPrGate(mergeGroupInputs(override)), undefined, JSON.stringify(override))
})

test('gate validates main push after SHA and rejects stale or mismatched revisions', () => {
  const sha = 'e'.repeat(40)
  const common = {
    CI_EVENT_NAME: 'push', CI_REF: 'refs/heads/main', CI_SHA: sha, CI_AFTER_SHA: sha,
    CI_PR_NUMBER: '', CI_PR_BASE_REPOSITORY_ID: '', CI_PR_BASE_SHA: '', CI_PR_HEAD_SHA: '', CI_TARGET_REF: '',
  }
  assert.doesNotThrow(() => verifyRequiredPrGate(successfulGateInputs(common)))
  assert.throws(() => verifyRequiredPrGate(successfulGateInputs({ ...common, CI_AFTER_SHA: 'f'.repeat(40) })), /does not match/)
  assert.throws(() => verifyRequiredPrGate(successfulGateInputs({ ...common, CI_REF: 'refs/heads/feature' })), /restricted/)
})

test('merge-group Required PR gate rejects skipped relevant tests and policy checks', () => {
  assert.throws(() => verifyRequiredPrGate(mergeGroupInputs({
    BACKEND_RESULT: 'skipped', BACKEND_REQUIRED: 'true',
  })))
  assert.throws(() => verifyRequiredPrGate(mergeGroupInputs({
    WORKFLOW_POLICY_RESULT: 'skipped',
  })), /must run and pass/)
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
