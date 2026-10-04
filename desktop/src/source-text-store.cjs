'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

const CACHE_SCHEMA = 1
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ENTRIES = 64
const MAX_TEXT_BYTES = 256 * 1024
const MAX_PLAINTEXT_BYTES = 4 * 1024 * 1024
const MAX_ENCRYPTED_BYTES = 6 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/

const fail = code => Object.assign(new Error('Source-text cache: ' + code), { code })

function ownerKey(ownerId) {
  if (typeof ownerId !== 'string' || ownerId.length < 1 || ownerId.length > 256 ||
      /[\x00-\x1f]/.test(ownerId)) throw fail('invalid_owner')
  return createHash('sha256').update(ownerId).digest('hex') + '.qfn-cache'
}

function normalizeKey(documentSha256, pageNumber) {
  const sha = typeof documentSha256 === 'string' ? documentSha256.trim().toLowerCase() : ''
  if (!SHA256.test(sha) || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 10000) {
    throw fail('invalid_key')
  }
  return { documentSha256: sha, pageNumber }
}

function isoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validateEnvelope(value, ownerId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'entries,ownerId,schema,updatedAt' ||
      value.schema !== CACHE_SCHEMA || value.ownerId !== ownerId ||
      !isoTimestamp(value.updatedAt) || !Array.isArray(value.entries) ||
      value.entries.length > MAX_ENTRIES) throw fail('invalid_cache')

  const keys = new Set()
  for (const entry of value.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).sort().join(',') !== 'cachedAt,documentSha256,pageNumber,text' ||
        !SHA256.test(entry.documentSha256) ||
        !Number.isSafeInteger(entry.pageNumber) || entry.pageNumber < 1 || entry.pageNumber > 10000 ||
        typeof entry.text !== 'string' || Buffer.byteLength(entry.text) > MAX_TEXT_BYTES ||
        !isoTimestamp(entry.cachedAt)) throw fail('invalid_cache')
    const key = entry.documentSha256 + ':' + entry.pageNumber
    if (keys.has(key)) throw fail('invalid_cache')
    keys.add(key)
  }
  return value
}

function createSourceTextStore({
  directory,
  encryption,
  now = () => new Date(),
} = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) ||
      !encryption || typeof encryption.available !== 'function' ||
      typeof encryption.encrypt !== 'function' || typeof encryption.decrypt !== 'function') {
    throw fail('invalid_configuration')
  }

  let pending = Promise.resolve()
  const serial = operation => {
    const next = pending.then(operation)
    pending = next.catch(() => {})
    return next
  }

  async function ready() {
    if (!await encryption.available()) throw fail('encryption_unavailable')
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await fs.lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('unsafe_directory')
  }

  async function regularFile(filename) {
    try {
      const info = await fs.lstat(filename)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ENCRYPTED_BYTES) throw fail('unsafe_file')
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }

  async function read(ownerId, filename) {
    if (!await regularFile(filename)) return null
    try {
      const encrypted = await fs.readFile(filename)
      const plaintext = await encryption.decrypt(encrypted)
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES) {
        throw fail('invalid_cache')
      }
      return validateEnvelope(JSON.parse(plaintext), ownerId)
    } catch (error) {
      if (error?.code === 'unsafe_file') throw error
      // This is a disposable cache, not canonical user data. Corrupt or
      // undecryptable entries are removed so the caller can safely refetch.
      await fs.rm(filename, { force: true }).catch(() => {})
      return null
    }
  }

  async function write(filename, envelope) {
    validateEnvelope(envelope, envelope.ownerId)
    const plaintext = JSON.stringify(envelope)
    if (Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES) throw fail('cache_too_large')
    const encrypted = await encryption.encrypt(plaintext)
    if (!Buffer.isBuffer(encrypted) || encrypted.length > MAX_ENCRYPTED_BYTES) throw fail('invalid_encryption')
    const temporary = path.join(directory, randomUUID() + '.tmp')
    let handle
    try {
      handle = await fs.open(temporary, 'wx', 0o600)
      await handle.writeFile(encrypted)
      await handle.sync()
      await handle.close()
      handle = undefined
      await fs.rename(temporary, filename)
    } finally {
      if (handle) await handle.close()
      await fs.rm(temporary, { force: true }).catch(() => {})
    }
  }

  function fresh(entries) {
    const cutoff = now().getTime() - CACHE_TTL_MS
    return entries.filter(entry => Date.parse(entry.cachedAt) >= cutoff)
  }

  return Object.freeze({
    get(ownerId, documentSha256, pageNumber) {
      const key = normalizeKey(documentSha256, pageNumber)
      const filename = path.join(directory, ownerKey(ownerId))
      return serial(async () => {
        await ready()
        const envelope = await read(ownerId, filename)
        if (!envelope) return null
        const entries = fresh(envelope.entries)
        if (entries.length !== envelope.entries.length) {
          if (entries.length === 0) {
            await fs.rm(filename, { force: true })
          } else {
            await write(filename, {
              ...envelope,
              updatedAt: now().toISOString(),
              entries,
            })
          }
        }
        const entry = entries.find(item =>
          item.documentSha256 === key.documentSha256 && item.pageNumber === key.pageNumber)
        return entry?.text ?? null
      })
    },

    put(ownerId, documentSha256, pageNumber, text) {
      const key = normalizeKey(documentSha256, pageNumber)
      if (typeof text !== 'string') throw fail('invalid_text')
      const textBytes = Buffer.byteLength(text)
      if (textBytes > MAX_TEXT_BYTES) return Promise.resolve(false)
      const filename = path.join(directory, ownerKey(ownerId))
      return serial(async () => {
        await ready()
        const previous = await read(ownerId, filename)
        const cachedAt = now().toISOString()
        let entries = fresh(previous?.entries ?? []).filter(item =>
          item.documentSha256 !== key.documentSha256 || item.pageNumber !== key.pageNumber)
        entries.push({ ...key, text, cachedAt })
        entries.sort((a, b) => Date.parse(a.cachedAt) - Date.parse(b.cachedAt))
        while (entries.length > MAX_ENTRIES) entries.shift()

        let envelope
        for (;;) {
          envelope = { schema: CACHE_SCHEMA, ownerId, updatedAt: cachedAt, entries }
          if (Buffer.byteLength(JSON.stringify(envelope)) <= MAX_PLAINTEXT_BYTES) break
          if (!entries.length) return false
          entries.shift()
        }
        await write(filename, envelope)
        return true
      })
    },

    remove(ownerId) {
      const filename = path.join(directory, ownerKey(ownerId))
      return serial(async () => {
        await ready()
        await fs.rm(filename, { force: true })
      })
    },
  })
}

module.exports = {
  CACHE_TTL_MS,
  MAX_ENTRIES,
  MAX_TEXT_BYTES,
  createSourceTextStore,
}
