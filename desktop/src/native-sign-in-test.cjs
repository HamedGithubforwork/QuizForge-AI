'use strict'

// A user-invoked acceptance check, separate from the hosted study-window login.
// No account information or token crosses into the remote renderer or report.
function createNativeSignInTest({ session, report, changed = () => {} }) {
  let running = false
  let cancelled = false
  let disposed = false
  let cancellation = null
  function notify() { try { changed() } catch {} }
  return {
    status: () => ({ running }),
    async run() {
      if (running || disposed) return
      running = true
      cancelled = false
      cancellation = null
      notify()
      let result = 'failed'
      try {
        await session.signIn()
        if (!cancelled && !disposed) {
          // Exercise verified refresh too; JWT account data remains main-only.
          const refreshed = await session.session(true)
          if (refreshed && !cancelled && !disposed) result = 'verified'
        }
      } catch { /* Generic, bounded report only. */ }
      finally {
        if (cancellation) await cancellation
        try { await session.signOut() } catch { result = 'revocation_unconfirmed' }
        if (session.status().revocationUnconfirmed) result = 'revocation_unconfirmed'
        running = false
        notify()
      }
      if (cancelled && result !== 'revocation_unconfirmed') result = 'cancelled'
      if (!disposed) await report(result)
    },
    async cancel() {
      if (!running) return
      cancelled = true
      cancellation ||= session.signOut().catch(() => {})
      await cancellation
    },
    async dispose() {
      disposed = true
      cancelled = true
      try { await session.signOut() } catch {}
    },
  }
}
module.exports = { createNativeSignInTest }
