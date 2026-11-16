const CONDITIONAL_JOB_RESULTS = Object.freeze([
  ['Backend tests', 'BACKEND_RESULT', 'BACKEND_REQUIRED'],
  ['Frontend checks', 'FRONTEND_RESULT', 'FRONTEND_REQUIRED'],
  ['Playwright E2E', 'PLAYWRIGHT_RESULT', 'PLAYWRIGHT_REQUIRED'],
  ['Desktop diagnostic privacy tests', 'DESKTOP_DIAGNOSTIC_RESULT', 'DESKTOP_DIAGNOSTIC_REQUIRED'],
  ['Optimization orchestrator tests', 'AUTONOMY_RESULT', 'AUTONOMY_REQUIRED'],
])

const EXPECTED_IDENTITY = Object.freeze({
  repository: 'HamedGithubforwork/QuizForge-AI',
  repositoryId: '1307099196',
  ownerId: '148009407',
})

// The identity is intentionally source-only before transfer. A separately
// reviewed post-transfer PR must switch owner/name and ownerId; do not accept
// both identities indefinitely or infer transfer authorization from history.
function verifyCiContext(env) {
  if (env.CI_REPOSITORY !== EXPECTED_IDENTITY.repository ||
      String(env.CI_REPOSITORY_ID) !== EXPECTED_IDENTITY.repositoryId ||
      String(env.CI_OWNER_ID) !== EXPECTED_IDENTITY.ownerId) {
    throw new Error('CI repository identity mismatch.')
  }

  if (env.CI_EVENT_NAME === 'pull_request') {
    // Stacked PRs may legitimately target a branch other than main.
    if (typeof env.CI_TARGET_REF !== 'string' ||
        !/^[A-Za-z0-9._/-]+$/.test(env.CI_TARGET_REF) ||
        env.CI_TARGET_REF.startsWith('refs/')) {
      throw new Error('Pull-request target branch is missing or invalid.')
    }
  } else if (env.CI_EVENT_NAME === 'merge_group') {
    if (env.CI_TARGET_REF !== 'refs/heads/main') {
      throw new Error('Merge group must target protected main.')
    }
    if (typeof env.CI_REF !== 'string' ||
        !env.CI_REF.startsWith('refs/heads/gh-readonly-queue/main/') ||
        env.CI_GROUP_HEAD_REF !== env.CI_REF) {
      throw new Error('Merge-group head ref does not match the queue ref.')
    }
    if (!/^[a-f0-9]{40}$/.test(env.CI_GROUP_HEAD_SHA || '') ||
        env.CI_GROUP_HEAD_SHA !== env.CI_SHA) {
      throw new Error('Merge-group commit SHA mismatch.')
    }
  } else if (env.CI_EVENT_NAME === 'push') {
    if (env.CI_REF !== 'refs/heads/main') {
      throw new Error('Push CI gate is restricted to main.')
    }
  } else {
    throw new Error('Unsupported CI event.')
  }
}

function verifyRequiredPrGate(env = process.env) {
  verifyCiContext(env)
  console.log('Change detection: ' + env.CHANGES_RESULT)
  console.log('CI trigger policy tests: ' + env.WORKFLOW_POLICY_RESULT)

  if (env.CHANGES_RESULT !== 'success') {
    throw new Error('Change detection did not succeed.')
  }

  if (env.WORKFLOW_POLICY_RESULT !== 'success') {
    throw new Error('CI trigger policy tests must run and pass.')
  }

  for (const [name, resultKey, requiredKey] of CONDITIONAL_JOB_RESULTS) {
    const result = env[resultKey]
    const required = env[requiredKey]
    console.log(name + ': ' + result + ' (required=' + required + ')')

    if (required !== 'true' && required !== 'false') {
      throw new Error(name + ' relevance output must be true or false.')
    }

    if (result === 'success' || (result === 'skipped' && required === 'false')) continue
    throw new Error(name + ' did not succeed despite its change relevance, or failed.')
  }

  console.log('All required jobs passed; unrelated conditional jobs were skipped.')
}

if (require.main === module) {
  try {
    verifyRequiredPrGate()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { verifyRequiredPrGate, verifyCiContext }