'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024
const MAX_ENCRYPTED_BYTES = 12 * 1024 * 1024

function ownerKey(ownerId) {
  if (typeof ownerId !== 'string' || ownerId.length < 1 || ownerId.length > 256 || /[\x00-\x1f]/.test(ownerId)) {
    throw new Error('Invalid snapshot account.')
  }
  return createHash('sha256').update(ownerId).digest('hex') + '.qfn'
}

function validateEnvelope(value, ownerId) {
  if (!value || value.schema !== 1 || value.ownerId !== ownerId ||
      typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt)) ||
      !Array.isArray(value.decks) || value.decks.length > 1000 ||
      value.decks.some(deck => !deck || typeof deck.id !== 'string' ||
        typeof deck.name !== 'string' || !Array.isArray(deck.cards))) {
    throw new Error('Invalid or incompatible study snapshot.')
  }
  return value
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
  async function writeEnvelope(file, envelope) {
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
      await fs.rename(temporary, file)
    } finally {
      if (handle) await handle.close()
      await fs.rm(temporary, { force: true })
    }
  }
  return {
    save(ownerId, decks) {
      const filename = ownerKey(ownerId)
      // Freeze caller-owned input before queued work; persist only the envelope.
      const json = JSON.stringify({ schema: 1, ownerId, savedAt: new Date().toISOString(), decks })
      if (Buffer.byteLength(json) > MAX_PLAINTEXT_BYTES) throw new Error('Study snapshot is too large.')
      const envelope = validateEnvelope(JSON.parse(json), ownerId)
      return serial(async () => {
        await ready()
        const file = path.join(directory, filename)
        await regularFile(file)
        await writeEnvelope(file, envelope)
      })
    },
    load(ownerId) {
      const filename = ownerKey(ownerId)
      return serial(async () => {
        await ready()
        const file = path.join(directory, filename)
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
      })
    },
    remove(ownerId) {
      const filename = ownerKey(ownerId)
      return serial(async () => {
        await ready()
        const file = path.join(directory, filename)
        if (await regularFile(file)) await fs.unlink(file)
      })
    },
  }
}

module.exports = { createSnapshotStore, MAX_PLAINTEXT_BYTES }
