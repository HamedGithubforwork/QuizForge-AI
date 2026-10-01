'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { validateEnvelope } = require('./snapshot-validation.cjs')
const MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024
const MAX_ENCRYPTED_BYTES = 12 * 1024 * 1024

function ownerKey(ownerId) {
  if (typeof ownerId !== 'string' || ownerId.length < 1 || ownerId.length > 256 || /[\x00-\x1f]/.test(ownerId)) {
    throw new Error('Invalid snapshot account.')
  }
  return createHash('sha256').update(ownerId).digest('hex') + '.qfn'
}

// Main-process only. The caller must supply a verified account identity; this
// storage layer is not authentication and is intentionally not exposed via IPC.
function createSnapshotStore({ directory, encryption }) {
  if (!path.isAbsolute(directory)) throw new Error('Snapshot directory must be absolute.')
  let pending = Promise.resolve()
  function serial(operation) {
    const next = pending.then(operation)
    pending = next.catch(() => {})
    return next
  }
  async function ready() {
    if (!await encryption.available()) throw new Error('Secure local storage is unavailable.')
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await fs.lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe snapshot directory.')
  }
  async function regularFile(file) {
    try {
      const info = await fs.lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ENCRYPTED_BYTES) {
        throw new Error('Unsafe or oversized snapshot file.')
      }
      return true
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }
  async function writeEnvelope(file, envelope, assertCurrent) {
    const plaintext = JSON.stringify(envelope)
    if (Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES) throw new Error('Study snapshot is too large.')
    let ciphertext
    try { ciphertext = await encryption.encrypt(plaintext) }
    catch { throw new Error('Could not encrypt study snapshot.') }
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length > MAX_ENCRYPTED_BYTES) throw new Error('Invalid encrypted snapshot.')
    const temporary = path.join(directory, randomUUID() + '.tmp')
    let handle
    try {
      handle = await fs.open(temporary, 'wx', 0o600)
      await handle.writeFile(ciphertext)
      await handle.sync()
      await handle.close()
      handle = undefined
      assertCurrent()
      await fs.rename(temporary, file)
    } finally {
      if (handle) await handle.close()
      await fs.rm(temporary, { force: true })
    }
  }
  async function readEnvelope(file, ownerId) {
    if (!await regularFile(file)) return null
    let plaintext
    try { plaintext = await encryption.decrypt(await fs.readFile(file)) }
    catch { throw new Error('Could not unlock study snapshot.') }
    if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES) {
      throw new Error('Invalid or oversized study snapshot.')
    }
    let envelope
    try { envelope = JSON.parse(plaintext) }
    catch { throw new Error('Invalid or incompatible study snapshot.') }
    return validateEnvelope(envelope, ownerId)
  }
  return {
    importSnapshot(ownerId, value, assertCurrent = () => {}) {
      const filename = ownerKey(ownerId)
      const envelope = validateEnvelope(JSON.parse(JSON.stringify(value)), ownerId)
      return serial(async () => {
        assertCurrent(); await ready()
        const file = path.join(directory, filename)
        if (!await regularFile(file)) await writeEnvelope(file, envelope, assertCurrent)
      })
    },
    save(ownerId, decks, assertCurrent = () => {}, { offlineAccess = false } = {}) {
      const filename = ownerKey(ownerId)
      // Freeze caller-owned input before queued work; persist only the envelope.
      if (typeof offlineAccess !== 'boolean') throw new Error('Invalid offline-access option.')
      const json = JSON.stringify({ schema: 1, ownerId, savedAt: new Date().toISOString(), decks, ...(offlineAccess ? { offlineAccess: true } : {}) })
      if (Buffer.byteLength(json) > MAX_PLAINTEXT_BYTES) throw new Error('Study snapshot is too large.')
      const envelope = validateEnvelope(JSON.parse(json), ownerId)
      return serial(async () => {
        assertCurrent()
        await ready()
        const file = path.join(directory, filename)
        const previous = await readEnvelope(file, ownerId)
        if (previous?.reviews?.some(r => !r.synced)) throw new Error('Sync pending reviews before replacing this copy.')
        await writeEnvelope(file, envelope, assertCurrent)
      })
    },
    listOffline() {
      return serial(async () => {
        await ready()
        const files = (await fs.readdir(directory)).filter(name => /^[a-f0-9]{64}\.qfn$/.test(name)).sort()
        if (files.length > 100) throw new Error('Too many local study copies.')
        const copies = []
        for (const name of files) {
          const file = path.join(directory, name)
          await regularFile(file)
          let value
          try {
            const plaintext = await encryption.decrypt(await fs.readFile(file))
            if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES) throw Error()
            value = JSON.parse(plaintext)
            if (ownerKey(value.ownerId) !== name) throw Error()
            validateEnvelope(value, value.ownerId)
          } catch { throw new Error('Could not unlock a local study copy.') }
          if (value.offlineAccess === true) copies.push({ ownerId: value.ownerId, savedAt: value.savedAt,
            deckCount: value.decks.length, label: value.decks[0]?.name || 'Empty library' })
        }
        return copies
      })
    },
    load(ownerId) {
      const filename = ownerKey(ownerId)
      return serial(async () => {
        await ready()
        const file = path.join(directory, filename)
        if (!await regularFile(file)) return null
        return readEnvelope(file, ownerId)
      })
    },
    recordReview(ownerId, cardId, rating, savedAt, assertCurrent = () => {}) {
      const filename = ownerKey(ownerId)
      if (![1, 2, 3, 4].includes(rating)) throw new Error('Invalid review rating.')
      const reviewedAt = new Date().toISOString(), eventId = randomUUID()
      return serial(async () => {
        assertCurrent(); await ready()
        const file = path.join(directory, filename), value = await readEnvelope(file, ownerId)
        const deck = value?.decks.find(d => d.cards.some(c => c.id === cardId)), card = deck?.cards.find(c => c.id === cardId)
        if (!value?.offlineAccess || value.savedAt !== savedAt || !card || card.suspended ||
            Date.parse(card.due_at) > Date.parse(reviewedAt) || Date.parse(card.updated_at) > Date.parse(reviewedAt) ||
            value.reviews?.some(r => r.card_id === cardId)) throw new Error('This saved card cannot be reviewed now.')
        value.reviews ||= []
        value.reviews.push({ deck_id: deck.id, card_id: card.id, event_id: eventId, rating, reviewed_at: reviewedAt,
          expected_updated_at: card.updated_at, expected_study_intensity: deck.study_intensity, review_duration_ms: null, synced: false })
        validateEnvelope(value, ownerId)
        await writeEnvelope(file, value, assertCurrent)
        return value
      })
    },
    acknowledgeReview(ownerId, eventId, assertCurrent = () => {}) {
      const filename = ownerKey(ownerId)
      return serial(async () => {
        assertCurrent(); await ready()
        const file = path.join(directory, filename), value = await readEnvelope(file, ownerId)
        const event = value?.reviews?.find(r => r.event_id === eventId)
        if (!event) throw new Error('Local review no longer exists.')
        event.synced = true
        await writeEnvelope(file, value, assertCurrent)
      })
    },
    remove(ownerId, assertCurrent = () => {}) {
      const filename = ownerKey(ownerId)
      return serial(async () => {
        await ready()
        const file = path.join(directory, filename)
        if (await regularFile(file)) {
          assertCurrent()
          await fs.unlink(file)
        }
      })
    },
  }
}

module.exports = { createSnapshotStore, MAX_PLAINTEXT_BYTES }
