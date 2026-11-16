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

const FULL_SHA = /^[0-9a-f]{40}$/
function requireSha(value, description) {
  if (typeof value !== 'string' || !FULL_SHA.test(value)) {
    throw new Error(`${description} must be a full lowercase 40-character commit SHA.`)
  }
}

function requireBranch(value, description) {
  const components = typeof value === 'string' ? value.split('/') : []
  if (typeof value !== 'string' || value.length === 0 || value === '@' || /[\u0000-\u0020\u007f~^:?*\\[\\]/.test(value) ||
      value.startsWith('refs/') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') ||
      value.includes('..') || value.includes('//') || value.includes('@{') ||
      components.some(component => component.startsWith('.') || component.endsWith('.lock'))) {
    throw new Error(`${description} is missing or invalid.`)
  }
}

function verifyCiContext(env) {
  if (env.CI_REPOSITORY !== EXPECTED_IDENTITY.repository ||
      String(env.CI_REPOSITORY_ID) !== EXPECTED_IDENTITY.repositoryId ||
      String(env.CI_OWNER_ID) !== EXPECTED_IDENTITY.ownerId) {
    throw new Error('CI repository identity mismatch.')
  }

  if (env.CI_EVENT_NAME === 'pull_request') {
    if (String(env.CI_PR_BASE_REPOSITORY_ID) !== EXPECTED_IDENTITY.repositoryId) {
      throw new Error('Pull request base repository identity mismatch.')
    }
    requireBranch(env.CI_TARGET_REF, 'Pull request target branch')
    if (!/^[1-9][0-9]*$/.test(env.CI_PR_NUMBER || '') ||
        env.CI_REF !== `refs/pull/${env.CI_PR_NUMBER}/merge`) {
      throw new Error('Pull request ref does not match its event identity.')
    }
    requireSha(env.CI_PR_BASE_SHA, 'Pull request base SHA')
    requireSha(env.CI_PR_HEAD_SHA, 'Pull request head SHA')
    requireSha(env.CI_SHA, 'Pull request checked-out SHA')
    return
  }

  if (env.CI_EVENT_NAME === 'merge_group') {
    if (env.CI_TARGET_REF !== 'refs/heads/main') {
      throw new Error('Merge group must target refs/heads/main.')
    }
    if (typeof env.CI_REF !== 'string' ||
        !/^refs\/heads\/gh-readonly-queue\/main\/.+$/.test(env.CI_REF) ||
        env.CI_GROUP_HEAD_REF !== env.CI_REF) {
      throw new Error('Merge-group ref does not match the queue head ref.')
    }
    requireSha(env.CI_GROUP_BASE_SHA, 'Merge-group base SHA')
    requireSha(env.CI_GROUP_HEAD_SHA, 'Merge-group head SHA')
    requireSha(env.CI_SHA, 'Merge-group checked-out SHA')
    if (env.CI_GROUP_HEAD_SHA !== env.CI_SHA) {
      throw new Error('Merge-group head SHA does not match the checked-out SHA.')
    }
    return
  }

  if (env.CI_EVENT_NAME === 'push') {
    if (env.CI_REF !== 'refs/heads/main') {
      throw new Error('Push CI gate is restricted to refs/heads/main.')
    }
    requireSha(env.CI_AFTER_SHA, 'Push after SHA')
    requireSha(env.CI_SHA, 'Push checked-out SHA')
    if (env.CI_AFTER_SHA !== env.CI_SHA) {
      throw new Error('Push after SHA does not match the checked-out SHA.')
    }
    return
  }

  throw new Error('Unsupported CI event.')
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

module.exports = { verifyRequiredPrGate }
