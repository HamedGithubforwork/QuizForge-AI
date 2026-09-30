'use strict'
const { createAuthorizationAttempt, ATTEMPT_LIFETIME_MS } = require('./native-auth-attempt.cjs')
const cancelled = () => new Error('Native sign-in was cancelled or expired. Please start again.')
const revocationError = () => new Error('Local sign-out completed, but session revocation could not be confirmed.')

// Main-process-only lifecycle. No OS registration, browser/renderer IPC or disk IO.
function createNativeSession({ clientId, client, openBrowser, onChange = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  let epoch = 0
  let pending = null
  let current = null
  let refreshing = null
  let revocationUnconfirmed = false
  function changed() { try { onChange() } catch { /* Never log callback errors or tokens. */ } }
  function view() {
    return current ? { accessToken: current.accessToken, userId: current.userId, email: current.email } : null
  }
  async function revoke(value) {
    if (!value) return true
    try { await client.revoke(value.refreshToken); return true } catch {
      revocationUnconfirmed = true
      changed()
      return false
    }
  }
  function cancelPending() {
    if (!pending) return
    const old = pending
    pending = null
    old.attempt?.cancel()
    clearTimer(old.timer)
    old.reject(cancelled())
    changed()
  }
  function invalidate() {
    epoch++
    cancelPending()
    const old = current
    current = null
    refreshing = null
    changed()
    return old
  }
  return {
    signIn() {
      const old = invalidate()
      void revoke(old)
      const attempt = createAuthorizationAttempt({ clientId })
      const operationEpoch = epoch
      const completion = new Promise((resolve, reject) => {
        const entry = { attempt, resolve, reject, epoch: operationEpoch, timer: null }
        pending = entry
        entry.timer = setTimer(() => { if (pending === entry) { epoch++; cancelPending() } }, ATTEMPT_LIFETIME_MS)
        changed()
        // Only the internally constructed, pinned authorization URL is opened.
        Promise.resolve().then(() => {
          if (pending === entry) return openBrowser(attempt.authorizationUrl)
        }).catch(() => { if (pending === entry) { epoch++; cancelPending() } })
      })
      return completion
    },
    async handleCallback(raw) {
      const entry = pending
      if (!entry?.attempt) return false
      let request
      try { request = entry.attempt.consumeCallback(raw) } catch {
        if (!entry.attempt.isActive()) cancelPending()
        return false
      }
      // Duplicate callbacks cannot cancel an exchange already in flight.
      entry.attempt = null
      clearTimer(entry.timer)
      try {
        const result = await client.exchange(request)
        if (pending !== entry || epoch !== entry.epoch) { await revoke(result); return false }
        current = Object.freeze({ ...result })
        pending = null
        changed()
        entry.resolve()
        return true
      } catch {
        if (pending === entry) { epoch++; cancelPending() }
        return false
      }
    },
    async session(forceRefresh = false) {
      if (!current) return null
      if (!forceRefresh && current.expiresAt > now() + 30_000) return view()
      if (!refreshing) {
        const old = current
        const operationEpoch = epoch
        const operation = (async () => {
          try {
            const result = await client.refresh(old)
            if (epoch !== operationEpoch || current !== old) { await revoke(result); return null }
            current = Object.freeze({ ...result })
            changed()
            return view()
          } catch {
            if (epoch === operationEpoch && current === old) { invalidate(); await revoke(old) }
            return null
          } finally {
            if (refreshing === operation) refreshing = null
          }
        })()
        refreshing = operation
      }
      return refreshing
    },
    async signOut() {
      const old = invalidate()
      if (!await revoke(old)) throw revocationError()
    },
    generation: () => epoch,
    status: () => ({ signingIn: pending !== null, signedIn: current !== null, revocationUnconfirmed }),
  }
}
module.exports = { createNativeSession }
