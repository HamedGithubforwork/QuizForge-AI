const OPTIONAL_JOB_RESULTS = Object.freeze([
  ['Backend tests', 'BACKEND_RESULT'],
  ['Frontend checks', 'FRONTEND_RESULT'],
  ['Playwright E2E', 'PLAYWRIGHT_RESULT'],
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

  for (const [name, key] of OPTIONAL_JOB_RESULTS) {
    const result = env[key]
    console.log(`${name}: ${result}`)
    if (result !== 'success' && result !== 'skipped') {
      throw new Error(`${name} did not succeed or was not intentionally skipped.`)
    }
  }

  console.log('All required jobs passed; other relevant jobs passed or were intentionally skipped.')
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
