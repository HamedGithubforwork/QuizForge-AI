'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

// Experimental evaluation candidate, not an enabled feature or a chosen default.
const CANDIDATE = Object.freeze({
  id: 'qwen3-4b-q4-k-m', bytes: 2497280256,
  sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
  url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf',
})
function approvedHost(hostname) {
  return hostname === 'huggingface.co' ||
    hostname.endsWith('.huggingface.co') ||
    hostname.endsWith('.hf.co')
}
const RESERVE = 512 * 1024 * 1024
const failure = code => Object.assign(new Error('Local model operation failed: ' + code), { code })

function reviewedUrl(value) {
  let url
  try { url = new URL(value) } catch { throw failure('unapproved_download') }
  if (url.protocol !== 'https:' || !approvedHost(url.hostname) || url.port || url.username || url.password || url.hash) {
    throw failure('unapproved_download')
  }
  return url.href
}

// Main-process-only storage. Test injection is not a renderer-selectable model URL.
function createLocalModelStore({ directory, fetch: fetcher = globalThis.fetch, model = CANDIDATE }) {
  if (!path.isAbsolute(directory) || !/^[a-f0-9]{64}$/.test(model.sha256) ||
      !Number.isSafeInteger(model.bytes) || model.bytes < 4 || model.bytes > 8 * 1024 ** 3) throw failure('invalid_configuration')
  const spec = Object.freeze({ ...model, url: reviewedUrl(model.url) })
  const filename = path.join(directory, spec.sha256 + '.gguf')
  let pending = Promise.resolve()
  function serial(operation) {
    const next = pending.then(operation); pending = next.catch(() => {}); return next
  }
  async function ready() {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await fs.lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('unsafe_directory')
  }
  async function inspect(signal) {
    signal?.throwIfAborted()
    let info
    try { info = await fs.lstat(filename) } catch (error) {
      if (error.code === 'ENOENT') return { ready: false }
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size !== spec.bytes) throw failure('invalid_model')
    const handle = await fs.open(filename, 'r')
    try {
      const opened = await handle.stat()
      if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== spec.bytes) throw failure('invalid_model')
      const hash = createHash('sha256')
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        signal?.throwIfAborted(); hash.update(chunk)
      }
      if (hash.digest('hex') !== spec.sha256) throw failure('invalid_model')
      return { ready: true, path: filename, bytes: spec.bytes }
    } finally { await handle.close() }
  }
  async function response(signal) {
    let url = spec.url
    for (let redirects = 0; redirects <= 5; redirects++) {
      const result = await fetcher(url, { redirect: 'manual', credentials: 'omit', signal })
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        const location = result.headers.get('location')
        await result.body?.cancel()
        if (!location || redirects === 5) throw failure('unapproved_download')
        url = reviewedUrl(new URL(location, url).href)
        continue
      }
      if (result.status !== 200 || !result.body ||
          (result.headers.has('content-length') && Number(result.headers.get('content-length')) !== spec.bytes)) {
        await result.body?.cancel(); throw failure('invalid_download')
      }
      return result
    }
  }
  return {
    status({ signal } = {}) {
      return serial(async () => { await ready(); return inspect(signal) })
    },
    download({ signal, progress = () => {} } = {}) {
      return serial(async () => {
        const bounded = AbortSignal.any([AbortSignal.timeout(20 * 60 * 1000), ...(signal ? [signal] : [])])
        bounded.throwIfAborted(); await ready()
        const existing = await inspect(bounded)
        if (existing.ready) return existing
        const disk = await fs.statfs(directory)
        if (disk.bavail * disk.bsize < spec.bytes + RESERVE) throw failure('insufficient_disk')
        const temporary = path.join(directory, randomUUID() + '.part')
        let handle, reader, created = false
        try {
          const result = await response(bounded)
          reader = result.body.getReader()
          handle = await fs.open(temporary, 'wx', 0o600); created = true
          let bytes = 0
          const hash = createHash('sha256')
          for (;;) {
            bounded.throwIfAborted()
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.byteLength
            if (bytes > spec.bytes) throw failure('invalid_download')
            hash.update(value); await handle.writeFile(value)
            progress({ receivedBytes: bytes, totalBytes: spec.bytes })
          }
          if (bytes !== spec.bytes || hash.digest('hex') !== spec.sha256) throw failure('invalid_download')
          await handle.sync(); await handle.close(); handle = undefined
          bounded.throwIfAborted()
          // Link publishes a complete file atomically without replacing another file.
          await fs.link(temporary, filename)
          return { ready: true, path: filename, bytes }
        } finally {
          await reader?.cancel().catch(() => {})
          if (handle) await handle.close()
          if (created) await fs.rm(temporary, { force: true })
        }
      })
    },
    // Explicit caller action only; removes this reproducible model, never study data.
    remove() {
      return serial(async () => {
        await ready()
        try {
          const info = await fs.lstat(filename)
          if (!info.isFile() || info.isSymbolicLink()) throw failure('unsafe_model')
          await fs.unlink(filename)
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      })
    },
  }
}

module.exports = { CANDIDATE, approvedHost, createLocalModelStore, reviewedUrl }
