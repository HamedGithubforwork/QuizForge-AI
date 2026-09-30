'use strict'
const { CALLBACK_URL } = require('./native-auth-attempt.cjs')
const PROTOCOL = CALLBACK_URL.slice(0, CALLBACK_URL.indexOf(':'))

// OS arguments are untrusted. Never navigate to them or print them. An exact
// callback is only a candidate; the session still checks state, expiry and PKCE.
function callbackFromArguments(argv) {
  if (!Array.isArray(argv) || argv.length > 128) return null
  const candidates = argv.filter(value => typeof value === 'string' &&
    value.toLowerCase().startsWith(PROTOCOL + ':'))
  if (candidates.length !== 1) return null
  const raw = candidates[0]
  if (raw.length > 8192 || /[\x00-\x20\x7f]/.test(raw) ||
      !raw.startsWith(CALLBACK_URL + '?') || raw.includes('#')) return null
  return raw
}

function createCallbackReceiver({ getSession, focus }) {
  return async argv => {
    const raw = callbackFromArguments(argv)
    if (!raw) return false
    // A cold launch has no in-memory transaction. Do not buffer/replay it later.
    const session = getSession()
    if (!session?.status().signingIn) return false
    try {
      const accepted = await session.handleCallback(raw)
      if (accepted) focus()
      return accepted
    } catch { return false }
  }
}
module.exports = { PROTOCOL, callbackFromArguments, createCallbackReceiver }
