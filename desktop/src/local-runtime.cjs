'use strict'

// Internal main-process component. Never expose configuration or credentials to IPC.
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { createHash, randomBytes } = require('node:crypto')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const MANIFEST = require('./local-runtime-manifest.json')
const fail = code => Object.assign(new Error('Local runtime: ' + code), { code })

async function verifyRuntime(directory, manifest = MANIFEST, signal) {
  if (!path.isAbsolute(directory)) throw fail('invalid_directory')
  const root = await fs.lstat(directory)
  if (!root.isDirectory() || root.isSymbolicLink()) throw fail('unsafe_directory')
  const names = await fs.readdir(directory)
  if (names.sort().join('\n') !== Object.keys(manifest.files).sort().join('\n')) throw fail('unexpected_files')
  for (const [name, spec] of Object.entries(manifest.files)) {
    signal?.throwIfAborted()
    if (path.basename(name) !== name || name.includes('\\')) throw fail('invalid_manifest')
    const filename = path.join(directory, name)
    const info = await fs.lstat(filename)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== spec.bytes) throw fail('invalid_runtime')
    const handle = await fs.open(filename, 'r')
    try {
      const opened = await handle.stat()
      if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== spec.bytes) throw fail('invalid_runtime')
      const hash = createHash('sha256')
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        signal?.throwIfAborted(); hash.update(chunk)
      }
      if (hash.digest('hex') !== spec.sha256) throw fail('invalid_runtime')
    } finally { await handle.close() }
  }
  return path.join(directory, 'llama-server.exe')
}

function runtimeEnvironment(key, source = process.env) {
  const env = { LLAMA_API_KEY: key }
  // No inherited provider keys, proxy, NODE_OPTIONS or LLAMA_ARG_* settings.
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    const found = Object.keys(source).find(k => k.toLowerCase() === name.toLowerCase())
    if (found) env[name] = source[found]
  }
  if (env.SystemRoot) env.PATH = path.join(env.SystemRoot, 'System32')
  return env
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

function request(port, key, route, payload, signal) {
  if (!['/v1/models', '/v1/chat/completions'].includes(route)) return Promise.reject(fail('invalid_route'))
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  if (body && Buffer.byteLength(body) > 65536) return Promise.reject(fail('request_too_large'))
  return new Promise((resolve, reject) => {
    // Literal loopback, direct node:http, no redirects, cookies or proxy discovery.
    const req = http.request({ hostname: '127.0.0.1', port, path: route,
      method: body ? 'POST' : 'GET', signal, agent: false,
      headers: { Authorization: 'Bearer ' + key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    }, response => {
      let bytes = 0; const chunks = []
      response.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 262144) { response.destroy(fail('response_too_large')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(fail('request_failed')); return }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(fail('invalid_response')) }
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function stop(child, closed) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  if (await Promise.race([closed.then(() => true), delay(3000, false)])) return
  child.kill('SIGKILL')
  if (!await Promise.race([closed.then(() => true), delay(3000, false)])) throw fail('shutdown_failed')
}

function createLocalRuntime({ directory, modelStore, spawnProcess = spawn }) {
  let busy = false
  return {
    async complete(payload, { signal } = {}) {
      if (busy) throw fail('busy')
      if (process.platform !== 'win32' || process.arch !== 'x64') throw fail('unsupported_platform')
      // Payload is produced by trusted main-process quiz logic, not passed through from a renderer.
      if (!payload || !Array.isArray(payload.messages) || payload.tools || payload.stream) throw fail('invalid_request')
      busy = true
      let child, closed
      const bounded = AbortSignal.any([AbortSignal.timeout(6 * 60 * 1000), ...(signal ? [signal] : [])])
      try {
        const executable = await verifyRuntime(directory, MANIFEST, bounded)
        const model = await modelStore.status({ signal: bounded })
        if (!model.ready) throw fail('model_missing')
        bounded.throwIfAborted()
        const key = randomBytes(32).toString('hex')
        const alias = 'qfn-' + randomBytes(16).toString('hex')
        const port = await freePort()
        child = spawnProcess(executable, ['-m', model.path, '--host', '127.0.0.1', '--port', String(port),
          '-c', '4096', '-t', '2', '-ngl', '0', '-np', '1', '--no-ui', '--no-agent',
          '--no-context-shift', '--cors-origins', 'https://local-model.quizfromnotes.invalid', '--alias', alias],
        { cwd: directory, windowsHide: true, shell: false, stdio: 'ignore', env: runtimeEnvironment(key) })
        let launchError
        child.on('error', () => { launchError = true })
        closed = new Promise(resolve => child.once('close', resolve))
        const startup = AbortSignal.any([bounded, AbortSignal.timeout(60000)])
        for (;;) {
          startup.throwIfAborted()
          if (launchError || child.exitCode !== null || child.signalCode !== null) throw fail('startup_failed')
          try {
            const models = await request(port, key, '/v1/models', undefined,
              AbortSignal.any([startup, AbortSignal.timeout(2000)]))
            if (models.data?.some(item => item.id === alias)) break
          } catch { startup.throwIfAborted() }
          await delay(100, undefined, { signal: startup })
        }
        return await request(port, key, '/v1/chat/completions', { ...payload, model: alias, stream: false, max_tokens: Math.min(payload.max_tokens || 1800, 1800) }, bounded)
      } finally {
        try { if (child && closed) await stop(child, closed) } finally { busy = false }
      }
    },
  }
}

module.exports = { createLocalRuntime, verifyRuntime, runtimeEnvironment, request, MANIFEST }
