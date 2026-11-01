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
const { performance } = require('node:perf_hooks')
const MANIFEST = require('./local-runtime-manifest.json')
const { createWindowsProcessGuard } = require('./windows-process-guard.cjs')
const fail = code => Object.assign(new Error('Local runtime: ' + code), { code })

const verifiedRuntimeFingerprints = new Map()

async function verifyRuntime(directory, manifest = MANIFEST, signal) {
  if (!path.isAbsolute(directory)) throw fail('invalid_directory')
  const root = await fs.lstat(directory)
  if (!root.isDirectory() || root.isSymbolicLink()) throw fail('unsafe_directory')
  const names = await fs.readdir(directory)
  if (names.sort().join('\n') !== Object.keys(manifest.files).sort().join('\n')) throw fail('unexpected_files')

  const entries = []
  for (const [name, spec] of Object.entries(manifest.files)) {
    signal?.throwIfAborted()
    if (path.basename(name) !== name || name.includes('\\')) throw fail('invalid_manifest')
    const filename = path.join(directory, name)
    const info = await fs.lstat(filename)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== spec.bytes) throw fail('invalid_runtime')
    entries.push({ name, filename, spec, info })
  }

  // Always inspect directory entries and file metadata. Rehash large runtime
  // binaries only when their identity, size, or change times differ.
  const key = directory + ':' + JSON.stringify(manifest.files)
  const fingerprint = entries.map(({ name, info }) =>
    [name, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')).join('\n')
  if (verifiedRuntimeFingerprints.get(key) !== fingerprint) {
    verifiedRuntimeFingerprints.delete(key)
    for (const { filename, spec, info } of entries) {
      signal?.throwIfAborted()
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
    verifiedRuntimeFingerprints.set(key, fingerprint)
  }
  signal?.throwIfAborted()
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
  return Math.max(1, Math.min(8, count))
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
  gpuLayerCount = () => 99,
  gpuFallbackLayers = () => [0],
  onGpuStartupFailure = () => {},
  onInferenceCompleted = () => {},
  onDiagnostic = () => {},
  platform = process.platform,
  arch = process.arch,
  guardProcess = createWindowsProcessGuard,
}) {
  function diagnostic(event, fields) {
    try { onDiagnostic(event, fields) } catch {}
  }
  let active = null
  let closed = false
  let lastAccelerationMode = null
  const ownerAbort = new AbortController()

  async function runBackend(payload, bounded, mode, fallbackState = null, requestedLayers = 99, sessionCallback = null) {
    let child, childClosed, processGuard
    let stage = 'verification'
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
      const gpuLayers = Number.isSafeInteger(requestedLayers) && requestedLayers > 0 && requestedLayers <= 99
        ? requestedLayers : 99
      const gpuArgs = mode === 'gpu'
        ? ['--device', typeof selectedGpuDevice === 'string' && /^Vulkan\d+$/.test(selectedGpuDevice)
          ? selectedGpuDevice : 'Vulkan0', '-ngl', String(gpuLayers)]
        : ['--device', 'none', '-ngl', '0']
      if (fallbackState && mode === 'gpu') fallbackState.eligible = true
      stage = 'startup'
      diagnostic('runtime_launch', { acceleration: mode, layers: mode === 'gpu' ? gpuLayers : 0 })
      child = spawnProcess(executable, ['-m', model.path, '--host', '127.0.0.1', '--port', String(port),
        '-c', '12288', '-t', threads, ...gpuArgs, '-np', '1', '--no-ui', '--no-agent',
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
      stage = 'inference'
      diagnostic('runtime_ready', { acceleration: mode })
      async function infer(requestPayload, requestSignal = null) {
        const boundedRequest = requestSignal ? AbortSignal.any([owned, requestSignal]) : owned
        boundedRequest.throwIfAborted()
        const generationStarted = performance.now()
        const result = await requestFn(port, key, '/v1/chat/completions',
          { ...requestPayload, model: alias, stream: false,
            max_tokens: Math.min(requestPayload.max_tokens || 1800, 5200) },
          boundedRequest)
        const gpuOffloaded = offloadTracker.state()
        lastAccelerationMode = mode === 'cpu'
          ? 'cpu'
          : gpuOffloaded === true ? 'gpu' : gpuOffloaded === false ? 'cpu' : 'unknown'
        try {
          onInferenceCompleted(Object.freeze({
            layers: mode === 'gpu' ? gpuLayers : 0,
            acceleration: lastAccelerationMode,
            elapsedMs: performance.now() - generationStarted,
            completionTokens: result?.usage?.completion_tokens ?? null,
          }))
        } catch {}
        return result
      }
      if (sessionCallback) {
        let finished = false
        let inFlight = false
        // Never expose a reusable server beyond this single controlled quiz,
        // nor allow concurrent requests competing for model memory.
        const scopedComplete = async (requestPayload, { signal } = {}) => {
          if (finished || bounded.aborted) throw fail('runtime_closed')
          if (inFlight) throw fail('busy')
          if (!requestPayload || !Array.isArray(requestPayload.messages) ||
              requestPayload.tools || requestPayload.stream) throw fail('invalid_request')
          inFlight = true
          try { return await infer(requestPayload, signal) }
          finally { inFlight = false }
        }
        try { return await sessionCallback(scopedComplete) }
        finally { finished = true }
      }
      return infer(payload)
    } catch (error) {
      // Node's HTTP request abort can surface as AbortError even when the
      // bounded runtime timer was the real cause. Preserve the timeout reason
      // so callers can distinguish a slow inference from user cancellation.
      const cause = bounded.aborted && bounded.reason?.name === 'TimeoutError'
        ? bounded.reason : error
      diagnostic('runtime_failed', { stage, reason: cause?.name === 'TimeoutError' ? 'timed_out' : cause?.name === 'AbortError' ? 'cancelled' : cause?.code })
      throw cause
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
      if (cleanupError) {
        diagnostic('runtime_failed', { stage: 'cleanup', reason: cleanupError.code })
        throw cleanupError
      }
    }
  }

  async function run(payload, signal, sessionCallback = null) {
    const bounded = AbortSignal.any([
      // One quiz can issue up to three sequential five-question calls. Keep
      // a finite total session budget without forcing another model startup.
      AbortSignal.timeout(sessionCallback ? 12 * 60 * 1000 : 6 * 60 * 1000),
      ownerAbort.signal,
      ...(signal ? [signal] : []),
    ])
    const mode = accelerationMode() === 'gpu' ? 'gpu' : 'cpu'
    if (mode !== 'gpu') return runBackend(payload, bounded, 'cpu', null, 99, sessionCallback)
    const initial = gpuLayerCount()
    const first = Number.isSafeInteger(initial) && initial > 0 && initial <= 99 ? initial : 99
    let fallbacks
    try { fallbacks = gpuFallbackLayers() } catch { fallbacks = [0] }
    // Only step DOWN the layer count on startup failure. A failed higher
    // allocation must never lead to another, larger Vulkan allocation.
    const smaller = Array.isArray(fallbacks)
      ? [...new Set(fallbacks.filter(value => Number.isSafeInteger(value) && value >= 0 && value < first))]
          .sort((a, b) => b - a).slice(0, 2)
      : []
    const attempts = [first, ...smaller.filter(value => value !== 0), 0]
    for (const layers of attempts) {
      const fallbackState = { eligible: false, ready: false }
      try {
        return await runBackend(payload, bounded, layers > 0 ? 'gpu' : 'cpu', fallbackState, layers, sessionCallback)
      } catch (error) {
        const startupFailure = error?.code === 'startup_failed' || error?.name === 'TimeoutError'
        if (layers === 0 || !fallbackState.eligible || fallbackState.ready || bounded.aborted || !startupFailure) {
          throw error
        }
        try { onGpuStartupFailure(layers) } catch {}
      }
    }
    throw fail('startup_failed')
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

  function withSession(callback, { signal } = {}) {
    if (closed) return Promise.reject(fail('runtime_closed'))
    if (active) return Promise.reject(fail('busy'))
    if (platform !== 'win32' || arch !== 'x64') return Promise.reject(fail('unsupported_platform'))
    if (typeof callback !== 'function') return Promise.reject(fail('invalid_request'))
    const operation = run(null, signal, callback)
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

  return Object.freeze({ complete, withSession, shutdown, status, lastAccelerationMode: accelerationStatus })
}

module.exports = { createLocalRuntime, verifyRuntime, runtimeEnvironment, request, stop, boundedCpuThreads, MANIFEST }
