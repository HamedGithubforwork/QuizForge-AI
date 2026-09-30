'use strict'
const API_ORIGIN = 'https://api.quizfromnotes.com'
const { APP_ORIGIN } = require('./policy.cjs')
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const rules = [
  ['GET|POST', '/api/decks', []],
  ['GET|PATCH|DELETE', `/api/decks/${UUID}`, []],
  ['GET|POST', `/api/decks/${UUID}/review`, ['limit']],
  ['POST', `/api/decks/${UUID}/(duplicate|cards)`, []],
  ['PATCH|DELETE', `/api/decks/${UUID}/cards/${UUID}`, []],
  ['POST', `/api/decks/${UUID}/cards/${UUID}/(move|suspend|resume|reset-progress)`, []],
  ['GET|PUT', '/api/study-notifications/preferences', []],
  ['GET', '/api/study-analytics/summary', ['timezone']],
  ['GET|POST', '/api/quiz-history', ['limit', 'cursor_created_at', 'cursor_id']],
  ['GET', '/api/quiz-history/document', ['source_filename', 'document_sha256', 'limit']],
  ['DELETE', `/api/quiz-history/${UUID}`, []],
  ['GET', '/api/documents/jobs', []],
  ['GET|DELETE', `/api/documents/jobs/${UUID}`, []],
  ['POST', '/api/documents/jobs/reuse', []],
  ['GET', '/api/documents/[a-f0-9]{64}/pages/[1-9][0-9]{0,5}', []],
  ['POST', '/api/(documents/upload|quizzes/generate|answers/review)', []],
].map(([methods, path, query]) => ({ methods: methods.split('|'), path: new RegExp(`^${path}$`), query }))
const invalid = () => new Error('Desktop request is not permitted.')
const expired = () => new Error('Your desktop session changed. Sign in again to continue.')
const LIMIT = 32 * 1024 * 1024

function validateRequest(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).some(k => !['path', 'method', 'body', 'form'].includes(k))) throw invalid()
  const { path, method = 'GET', body, form } = value
  if (typeof path !== 'string' || path.length > 4096 || !path.startsWith('/api/') || /[\\#\s]/.test(path)) throw invalid()
  const url = new URL(path, API_ORIGIN)
  if (url.origin !== API_ORIGIN || url.pathname !== path.split('?')[0]) throw invalid()
  const rule = rules.find(r => r.methods.includes(method) && r.path.test(url.pathname))
  if (!rule || [...url.searchParams.keys()].some(k => !rule.query.includes(k) || url.searchParams.getAll(k).length !== 1)) throw invalid()
  if (method !== 'GET' && url.search) throw invalid()
  if ((method === 'GET' || method === 'DELETE') && (body != null || form != null)) throw invalid()
  const headers = {}
  let data
  if (body != null) {
    if (form != null || typeof body !== 'string' || Buffer.byteLength(body) > LIMIT) throw invalid()
    try { JSON.parse(body) } catch { throw invalid() }
    headers['Content-Type'] = 'application/json'
    data = body
  }
  if (form != null) {
    if (!['/api/documents/upload', '/api/quizzes/generate'].includes(url.pathname) || !Array.isArray(form) || form.length > 40) throw invalid()
    data = new FormData()
    let size = 0
    for (const entry of form) {
      if (!entry || typeof entry.name !== 'string' || !/^[a-z_]{1,80}$/.test(entry.name)) throw invalid()
      if (typeof entry.value === 'string' && Object.keys(entry).sort().join(',') === 'name,value') {
        size += Buffer.byteLength(entry.value)
        data.append(entry.name, entry.value)
      } else if (entry.bytes instanceof Uint8Array && Object.keys(entry).sort().join(',') === 'bytes,filename,name') {
        if (entry.name !== 'file' || typeof entry.filename !== 'string' || entry.filename.length > 255 || /[\r\n\0/\\]/.test(entry.filename)) throw invalid()
        size += entry.bytes.byteLength
        data.append(entry.name, new Blob([entry.bytes], { type: 'application/pdf' }), entry.filename)
      } else throw invalid()
      if (size > LIMIT) throw invalid()
    }
  }
  return { path, method, body: data, headers }
}

async function boundedText(response) {
  if (Number(response.headers.get('content-length')) > LIMIT) throw invalid()
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks = []; let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > LIMIT) throw invalid()
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await reader.cancel().catch(() => {}) }
}

// Main-only token adapter. The renderer can request reviewed API operations,
// but cannot select a host, headers, bearer token, redirect or credentials mode.
function createNativeAccount({ session, fetch: fetcher = globalThis.fetch }) {
  let account = null
  let accountGeneration = -1
  let inFlight = 0
  const pending = new Set()
  function generation() { return session.generation() }
  function assertCurrent(g) { if (g !== generation() || !session.status().signedIn) throw expired() }
  function clear() {
    account = null; accountGeneration = -1
    for (const controller of pending) controller.abort()
  }
  async function send(request, g) {
    assertCurrent(g)
    const controller = new AbortController()
    pending.add(controller)
    const timeout = setTimeout(() => controller.abort(), 120000)
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await session.session(attempt === 1)
        assertCurrent(g)
        if (!current) throw expired()
        const response = await fetcher(API_ORIGIN + request.path, {
          method: request.method, body: request.body,
          headers: { ...request.headers, Authorization: `Bearer ${current.accessToken}`, Origin: APP_ORIGIN },
          redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        })
        const body = await boundedText(response)
        assertCurrent(g)
        if (response.status === 401 && attempt === 0) continue
        if (response.status === 401) { clear(); await session.signOut().catch(() => {}); throw expired() }
        return { status: response.status, body, contentType: 'application/json' }
      }
    } catch (error) {
      if (g !== generation()) throw expired()
      // Never forward transport/provider exceptions, which may contain private data.
      throw new Error('Could not complete the desktop request. Check your connection and sign in again if needed.')
    } finally { clearTimeout(timeout); pending.delete(controller) }
  }
  return {
    clear,
    generation,
    current() { return accountGeneration === generation() && session.status().signedIn ? account : null },
    async verify() {
      const g = generation()
      const result = await send({ path: '/identity/session', method: 'GET', headers: {} }, g)
      if (result.status !== 200) throw new Error('Desktop account access is not available yet. Your browser account remains available.')
      let value
      try { value = JSON.parse(result.body) } catch { throw invalid() }
      const current = await session.session()
      assertCurrent(g)
      if (!current || value.id !== current.userId || value.email !== current.email || typeof value.enrolled !== 'boolean') {
        clear(); await session.signOut().catch(() => {}); throw expired()
      }
      account = Object.freeze({ userId: value.id, email: value.email, enrolled: value.enrolled })
      accountGeneration = g
      return account
    },
    async request(value) {
      const request = validateRequest(value)
      const g = generation()
      if (accountGeneration !== g || !account?.enrolled) throw expired()
      if (inFlight >= 8) throw new Error('Too many desktop requests. Try again shortly.')
      inFlight++
      try { return await send(request, g) } finally { inFlight-- }
    },
  }
}
module.exports = { createNativeAccount, validateRequest, boundedText }
