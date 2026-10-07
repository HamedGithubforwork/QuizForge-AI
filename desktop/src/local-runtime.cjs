'use strict'

// Internal main-process component. Never expose configuration or credentials to IPC.
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { createHash, randomBytes } = require('node:crypto')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const MANIFEST = require('./local-runtime-manifest.json')
const { createWindowsProcessGuard } = require('./windows-process-guard.cjs')
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

function boundedCpuThreads(logicalCpuCount = os.cpus().length) {
  const count = Number.isSafeInteger(logicalCpuCount) && logicalCpuCount > 0 ? logicalCpuCount : 1
  return Math.max(1, Math.min(8, count - 1))
}

function trackGpuLayerOffload(child) {
  let pending = ''
  let offloaded = null
  function consume(chunk) {
    const lines = (pending + String(chunk)).split(/\r?\n/)
    pending = lines.pop().slice(-4096)
    for (const line of lines) {
      const match = line.match(/offloaded\s+(\d+)\s*\/\s*\d+\s+layers?\s+to GPU/i)
      if (match) offloaded = Number(match[1]) > 0
    }
  }
  for (const stream of [child?.stdout, child?.stderr]) {
    stream?.on?.('data', consume)
  }
  return Object.freeze({
    state() {
      if (pending) consume('\n')
      return offloaded
    },
  })
}

function createLocalRuntime({
  directory,
  modelStore,
  spawnProcess = spawn,
  verifyRuntimeFn = verifyRuntime,
  freePortFn = freePort,
  requestFn = request,
  randomBytesFn = randomBytes,
  onProcessChange = () => {},
  accelerationMode = () => 'cpu',
  gpuDevice = () => 'Vulkan0',
  cpuThreadCount = boundedCpuThreads,
  platform = process.platform,
  arch = process.arch,
  guardProcess = createWindowsProcessGuard,
}) {
  let active = null
  let closed = false
  let lastAccelerationMode = null
  const ownerAbort = new AbortController()

  async function runBackend(payload, bounded, mode, fallbackState = null) {
    let child, childClosed, processGuard
    try {
      const executable = await verifyRuntimeFn(directory, MANIFEST, bounded)
      const model = await modelStore.status({ signal: bounded })
      if (!model.ready) throw fail('model_missing')
      bounded.throwIfAborted()
      const key = randomBytesFn(32).toString('hex')
      const alias = 'qfn-' + randomBytesFn(16).toString('hex')
      const port = await freePortFn()
      const threads = String(cpuThreadCount())
      const selectedGpuDevice = gpuDevice()
      const gpuArgs = mode === 'gpu'
        ? ['--device', typeof selectedGpuDevice === 'string' && /^Vulkan\d+$/.test(selectedGpuDevice)
          ? selectedGpuDevice : 'Vulkan0', '-ngl', '99']
        : ['--device', 'none', '-ngl', '0']
      if (fallbackState && mode === 'gpu') fallbackState.eligible = true
      child = spawnProcess(executable, ['-m', model.path, '--host', '127.0.0.1', '--port', String(port),
        '-c', '4096', '-t', threads, ...gpuArgs, '-np', '1', '--no-ui', '--no-agent',
        '--no-context-shift', '--cors-origins', 'https://local-model.quizfromnotes.invalid', '--alias', alias],
      { cwd: directory, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: runtimeEnvironment(key) })
      const offloadTracker = trackGpuLayerOffload(child)
      try {
        if (Number.isSafeInteger(child?.pid) && child.pid > 0) onProcessChange(child.pid)
      } catch {}
      let launchError
      child.on('error', () => { launchError = true })
      childClosed = new Promise(resolve => child.once('close', resolve))
      processGuard = await guardProcess(child, { platform })
      const owned = AbortSignal.any([bounded, processGuard.signal])
      const startup = AbortSignal.any([owned, AbortSignal.timeout(60000)])
      for (;;) {
        startup.throwIfAborted()
        if (launchError || child.exitCode !== null || child.signalCode !== null) throw fail('startup_failed')
        try {
          const models = await requestFn(port, key, '/v1/models', undefined,
            AbortSignal.any([startup, AbortSignal.timeout(2000)]))
          if (models.data?.some(item => item.id === alias)) {
            if (fallbackState) fallbackState.ready = true
            break
          }
        } catch { startup.throwIfAborted() }
        await delay(100, undefined, { signal: startup })
      }
      const result = await requestFn(port, key, '/v1/chat/completions',
        { ...payload, model: alias, stream: false, max_tokens: Math.min(payload.max_tokens || 1800, 1800) },
        owned)
      const gpuOffloaded = offloadTracker.state()
      lastAccelerationMode = mode === 'cpu'
        ? 'cpu'
        : gpuOffloaded === true ? 'gpu' : gpuOffloaded === false ? 'cpu' : 'unknown'
      return result
    } finally {
      let cleanupError = null
      try {
        if (child && childClosed) await stop(child, childClosed)
      } catch (error) {
        cleanupError = error
      }
      try {
        await processGuard?.dispose()
      } catch (error) {
        cleanupError ||= error
      }
      if (child && childClosed &&
          child.exitCode === null && child.signalCode === null &&
          !await Promise.race([childClosed.then(() => true), delay(3000, false)])) {
        cleanupError ||= fail('shutdown_failed')
      }
      try { onProcessChange(null) } catch {}
      if (cleanupError) throw cleanupError
    }
  }

  async function run(payload, signal) {
    const bounded = AbortSignal.any([
      AbortSignal.timeout(6 * 60 * 1000),
      ownerAbort.signal,
      ...(signal ? [signal] : []),
    ])
    const mode = accelerationMode() === 'gpu' ? 'gpu' : 'cpu'
    if (mode !== 'gpu') return runBackend(payload, bounded, 'cpu')
    const fallbackState = { eligible: false, ready: false }
    try {
      return await runBackend(payload, bounded, 'gpu', fallbackState)
    } catch (error) {
      const startupFailure = error?.code === 'startup_failed' || error?.name === 'TimeoutError'
      if (!fallbackState.eligible || fallbackState.ready || bounded.aborted || !startupFailure) throw error
      return runBackend(payload, bounded, 'cpu')
    }
  }

  function complete(payload, { signal } = {}) {
    if (closed) return Promise.reject(fail('runtime_closed'))
    if (active) return Promise.reject(fail('busy'))
    if (platform !== 'win32' || arch !== 'x64') return Promise.reject(fail('unsupported_platform'))
    // Payload is produced by trusted main-process quiz logic, not passed through from a renderer.
    if (!payload || !Array.isArray(payload.messages) || payload.tools || payload.stream) {
      return Promise.reject(fail('invalid_request'))
    }
    const operation = run(payload, signal)
    active = operation
    void operation.finally(() => {
      if (active === operation) active = null
    }).catch(() => {})
    return operation
  }

  async function shutdown() {
    if (!closed) {
      closed = true
      ownerAbort.abort()
    }
    const operation = active
    if (!operation) return
    try {
      await operation
    } catch (error) {
      // Cancellation/startup/request failures are already reported to the request
      // caller. Shutdown itself only fails if native cleanup could not complete.
      if (error?.code === 'shutdown_failed') throw error
    }
  }

  function status() {
    return Object.freeze({ busy: active !== null, closed })
  }

  function accelerationStatus() {
    return lastAccelerationMode
  }

  return Object.freeze({ complete, shutdown, status, lastAccelerationMode: accelerationStatus })
}

module.exports = { createLocalRuntime, verifyRuntime, runtimeEnvironment, request, stop, boundedCpuThreads, MANIFEST }
