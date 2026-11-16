const CONDITIONAL_JOB_RESULTS = Object.freeze([
  ['Backend tests', 'BACKEND_RESULT', 'BACKEND_REQUIRED'],
  ['Frontend checks', 'FRONTEND_RESULT', 'FRONTEND_REQUIRED'],
  ['Playwright E2E', 'PLAYWRIGHT_RESULT', 'PLAYWRIGHT_REQUIRED'],
  ['Desktop diagnostic privacy tests', 'DESKTOP_DIAGNOSTIC_RESULT', 'DESKTOP_DIAGNOSTIC_REQUIRED'],
  ['Optimization orchestrator tests', 'AUTONOMY_RESULT', 'AUTONOMY_REQUIRED'],
])

const EXPECTED_REPOSITORY_ID = '1307099196'

function verifyEventIdentity(env) {
  if (env.REPOSITORY_ID !== EXPECTED_REPOSITORY_ID) {
    throw new Error('Workflow repository identity does not match QuizForge-AI.')
  }

  if (env.EVENT_NAME === 'pull_request') {
    if (env.BASE_REPOSITORY_ID !== EXPECTED_REPOSITORY_ID) {
      throw new Error('Pull request base repository identity does not match QuizForge-AI.')
    }
    if (typeof env.PR_BASE_REF !== 'string' || env.PR_BASE_REF.length === 0) {
      throw new Error('Pull request target branch identity is missing or invalid.')
    }
    return
  }

  if (env.EVENT_NAME === 'merge_group') {
    if (env.MERGE_GROUP_BASE_REF !== 'refs/heads/main') {
      throw new Error('Merge group must target refs/heads/main.')
    }
    return
  }

  if (env.EVENT_NAME === 'push') {
    if (env.GIT_REF !== 'refs/heads/main') {
      throw new Error('Push event must target refs/heads/main.')
    }
    return
  }

  throw new Error('Unsupported event for the Required PR gate.')
}

function verifyRequiredPrGate(env = process.env) {
  verifyEventIdentity(env)
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

module.exports = { verifyRequiredPrGate, verifyEventIdentity }
