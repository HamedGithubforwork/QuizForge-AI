const CONDITIONAL_JOB_RESULTS = Object.freeze([
  ['Backend tests', 'BACKEND_RESULT', 'BACKEND_REQUIRED'],
  ['Frontend checks', 'FRONTEND_RESULT', 'FRONTEND_REQUIRED'],
  ['Playwright E2E', 'PLAYWRIGHT_RESULT', 'PLAYWRIGHT_REQUIRED'],
  ['Desktop diagnostic tests', 'DESKTOP_DIAGNOSTIC_RESULT', 'DESKTOP_DIAGNOSTIC_REQUIRED'],
  ['Autonomy tests', 'AUTONOMY_RESULT', 'AUTONOMY_REQUIRED'],
])

function verifyRequiredPrGate(env = process.env) {
  console.log(`Change detection: ${env.CHANGES_RESULT}`)
  console.log(`CI trigger policy tests: ${env.WORKFLOW_POLICY_RESULT}`)

  if (env.CHANGES_RESULT !== 'success') {
    throw new Error('Change detection did not succeed.')
  }

  if (env.WORKFLOW_POLICY_RESULT !== 'success') {
    throw new Error('CI trigger policy tests must run and pass.')
  }

  for (const [name, resultKey, requiredKey] of CONDITIONAL_JOB_RESULTS) {
    const result = env[resultKey]
    const required = env[requiredKey]
    console.log(`${name}: ${result} (required=${required})`)

    if (required !== 'true' && required !== 'false') {
      throw new Error(`${name} relevance output must be true or false.`)
    }

    if (result === 'success' || (result === 'skipped' && required === 'false')) continue
    throw new Error(`${name} did not succeed despite its change relevance, or failed.`)
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
