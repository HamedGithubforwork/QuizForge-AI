'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const LOCAL_RENDERER_SCHEME = 'qfn'
const LOCAL_RENDERER_HOST = 'app'
const LOCAL_RENDERER_ORIGIN = `${LOCAL_RENDERER_SCHEME}://${LOCAL_RENDERER_HOST}`
const LOCAL_RENDERER_URL = `${LOCAL_RENDERER_ORIGIN}/index.html`
const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
})
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function response(status, body = '', headers = {}) {
  return new Response(body, { status, headers })
}

function createLocalRendererHandler({ directory, readFile = fs.readFile, realpath = fs.realpath } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new TypeError('Local renderer directory must be an absolute path.')
  }

  return async request => {
    let url
    try { url = new URL(request.url) } catch { return response(400) }
    if (url.protocol !== `${LOCAL_RENDERER_SCHEME}:` || url.hostname !== LOCAL_RENDERER_HOST ||
        url.username || url.password || url.port || request.method !== 'GET' && request.method !== 'HEAD') {
      return response(404)
    }

    let pathname
    try { pathname = decodeURIComponent(url.pathname) } catch { return response(400) }
    if (pathname.includes('\\') || pathname.includes('\0')) return response(404)

    const root = await realpath(directory).catch(() => null)
    if (!root) return response(404)
    let relative = pathname.replace(/^\/+/, '')
    if (!relative) relative = 'index.html'
    let filename = path.resolve(root, relative)
    if (filename !== root && !filename.startsWith(root + path.sep)) return response(404)

    let resolved = await realpath(filename).catch(() => null)
    if (!resolved && !path.extname(relative)) {
      filename = path.join(root, 'index.html')
      resolved = await realpath(filename).catch(() => null)
    }
    if (!resolved || resolved !== root && !resolved.startsWith(root + path.sep)) return response(404)

    const extension = path.extname(resolved).toLowerCase()
    const contentType = CONTENT_TYPES[extension]
    if (!contentType) return response(404)
    const headers = { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' }
    if (path.basename(resolved) === 'index.html') {
      headers['Content-Security-Policy'] = CONTENT_SECURITY_POLICY
      headers['Cache-Control'] = 'no-store'
    } else {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    }
    if (request.method === 'HEAD') return response(200, '', headers)

    const body = await readFile(resolved).catch(() => null)
    return body ? response(200, body, headers) : response(404)
  }
}

function registerLocalRenderer(protocol, options) {
  if (!protocol || typeof protocol.handle !== 'function') {
    throw new TypeError('Electron protocol handler is unavailable.')
  }
  protocol.handle(LOCAL_RENDERER_SCHEME, createLocalRendererHandler(options))
  return LOCAL_RENDERER_URL
}

module.exports = {
  CONTENT_SECURITY_POLICY,
  LOCAL_RENDERER_HOST,
  LOCAL_RENDERER_ORIGIN,
  LOCAL_RENDERER_SCHEME,
  LOCAL_RENDERER_URL,
  createLocalRendererHandler,
  registerLocalRenderer,
}
