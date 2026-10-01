'use strict'

const { MAX_PLAINTEXT_BYTES } = require('./snapshot-store.cjs')
const { validateEnvelope } = require('./snapshot-validation.cjs')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Main-process-only: identity, paths and content never come from renderer input.
// No background persistence, authentication-token storage or review replay.
function createAccountSnapshots({ account, store, now = () => performance.now() }) {
  let busy = false
  async function run(operation) {
    if (busy) throw new Error('A local study copy operation is already running.')
    const identity = account.current()
    if (!identity?.enrolled) throw new Error('Sign in to your desktop account first.')
    const generation = account.generation()
    const deadline = now() + 120000
    const assertCurrent = () => {
      if (now() > deadline) throw new Error('The local copy request expired. Try again.')
      const current = account.current()
      if (account.generation() !== generation || !current?.enrolled || current.userId !== identity.userId) {
        throw new Error('Your desktop account changed. Try again after signing in.')
      }
    }
    busy = true
    try {
      await account.verify()
      assertCurrent()
      const result = await operation(identity.userId, assertCurrent)
      assertCurrent()
      return result
    } finally { busy = false }
  }
  async function read(path, assertCurrent) {
    const response = await account.request({ path })
    assertCurrent()
    if (response.status !== 200) throw new Error('Could not read all decks. The previous local copy is unchanged.')
    try { return JSON.parse(response.body) }
    catch { throw new Error('Invalid study response. The previous local copy is unchanged.') }
  }
  return {
    status: () => ({ busy }),
    save: ({ offlineAccess = false } = {}) => run(async (ownerId, assertCurrent) => {
      const summaries = await read('/api/decks', assertCurrent)
      if (!Array.isArray(summaries) || summaries.length > 1000) throw new Error('Invalid or oversized deck list.')
      const ids = new Set()
      for (const summary of summaries) {
        if (!summary || typeof summary.id !== 'string' || !UUID.test(summary.id) || ids.has(summary.id.toLowerCase())) {
          throw new Error('Invalid deck list.')
        }
        ids.add(summary.id.toLowerCase())
      }
      const decks = []
      let bytes = 0
      for (const summary of summaries) {
        const deck = await read('/api/decks/' + summary.id, assertCurrent)
        if (deck?.id?.toLowerCase() !== summary.id.toLowerCase()) throw new Error('Invalid deck response.')
        bytes += Buffer.byteLength(JSON.stringify(deck))
        if (bytes > MAX_PLAINTEXT_BYTES) throw new Error('The local study copy is too large.')
        validateEnvelope({ schema: 1, ownerId, savedAt: new Date().toISOString(), decks: [deck] }, ownerId)
        decks.push(deck)
      }
      // Recheck online access after collecting data; the store also guards the
      // atomic replacement after encryption, not just before asynchronous work.
      await account.verify()
      assertCurrent()
      await store.save(ownerId, decks, assertCurrent, { offlineAccess })
      return { deckCount: decks.length, cardCount: decks.reduce((sum, deck) => sum + deck.cards.length, 0) }
    }),
    remove: () => run(async (ownerId, assertCurrent) => { await store.remove(ownerId, assertCurrent) }),
  }
}

module.exports = { createAccountSnapshots }
