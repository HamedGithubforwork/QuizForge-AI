'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { EventEmitter } = require('node:events')
const { createHash } = require('node:crypto')
const { createLocalRuntime, createWarmLocalRuntime, verifyRuntime, runtimeEnvironment, request } = require('../src/local-runtime.cjs')

test('runtime verification rejects changed, missing and unexpected library files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-runtime-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const bytes = Buffer.from('synthetic runtime')
  const manifest = { files: Object.fromEntries(['llama-server.exe', 'llama.dll'].map(name => [name,
    { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }])) }
  for (const name of Object.keys(manifest.files)) await fs.writeFile(path.join(directory, name), bytes)
  assert.equal(await verifyRuntime(directory, manifest), path.join(directory, 'llama-server.exe'))
  await fs.writeFile(path.join(directory, 'llama.dll'), 'tampered runtime!')
  await assert.rejects(verifyRuntime(directory, manifest), { code: 'invalid_runtime' })
  await fs.writeFile(path.join(directory, 'llama.dll'), bytes)
  await fs.writeFile(path.join(directory, 'injected.dll'), bytes)
  await assert.rejects(verifyRuntime(directory, manifest), { code: 'unexpected_files' })
  await fs.unlink(path.join(directory, 'injected.dll'))
  await fs.unlink(path.join(directory, 'llama.dll'))
  await assert.rejects(verifyRuntime(directory, manifest), { code: 'unexpected_files' })
})

test('child receives only explicit runtime environment', () => {
  const env = runtimeEnvironment('ephemeral', { SystemRoot: 'C:\\Windows', TEMP: 'temporary',
    OPENAI_API_KEY: 'private', LLAMA_ARG_HOST: '0.0.0.0', LLAMA_ARG_API_KEY: 'old',
    HTTP_PROXY: 'remote', NODE_OPTIONS: '--require unwanted', PATH: 'untrusted' })
  assert.deepEqual(Object.keys(env).sort(), ['LLAMA_API_KEY', 'PATH', 'SystemRoot', 'TEMP'])
  assert.equal(env.LLAMA_API_KEY, 'ephemeral')
  assert.equal(env.PATH, path.join('C:\\Windows', 'System32'))
})

async function server(t, handler) {
  const instance = http.createServer(handler)
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => instance.close(resolve)))
  return instance.address().port
}

test('loopback client authenticates and does not follow redirects', async t => {
  let calls = 0
  const port = await server(t, (req, res) => {
    calls++
    assert.equal(req.headers.authorization, 'Bearer ephemeral')
    res.writeHead(302, { Location: 'https://example.invalid/' }); res.end()
  })
  await assert.rejects(request(port, 'ephemeral', '/v1/models', undefined, AbortSignal.timeout(1000)), { code: 'request_failed' })
  assert.equal(calls, 1)
  await assert.rejects(request(port, '', '/other'), { code: 'invalid_route' })
})

test('loopback client bounds response bytes, request bytes and cancellation', async t => {
  const port = await server(t, (req, res) => res.end('x'.repeat(262145)))
  await assert.rejects(request(port, '', '/v1/models', undefined, AbortSignal.timeout(1000)), { code: 'response_too_large' })
  await assert.rejects(request(port, '', '/v1/chat/completions', { content: 'x'.repeat(65536) }), { code: 'request_too_large' })
  await assert.rejects(request(port, '', '/v1/models', undefined, AbortSignal.abort()))
})


function fakeChild({ exited = false } = {}) {
  const child = new EventEmitter()
  child.pid = 4242
  child.exitCode = exited ? 1 : null
  child.signalCode = null
  child.kills = []
  child.kill = signal => {
    child.kills.push(signal ?? 'SIGTERM')
    if (child.exitCode === null && child.signalCode === null) {
      child.signalCode = signal ?? 'SIGTERM'
      queueMicrotask(() => child.emit('close', null, child.signalCode))
    }
    return true
  }
  return child
}

function runtimeFixture(overrides = {}) {
  const child = overrides.child ?? fakeChild()
  const alias = 'qfn-' + 'ab'.repeat(16)
  const modelStore = { status: async () => ({ ready: true, path: 'C:\\models\\model.gguf' }) }
  const runtime = createLocalRuntime({
    directory: 'C:\\runtime',
    modelStore,
    platform: 'win32',
    arch: 'x64',
    verifyRuntimeFn: async () => 'C:\\runtime\\llama-server.exe',
    freePortFn: async () => 43123,
    randomBytesFn: size => Buffer.alloc(size, 0xab),
    spawnProcess: () => child,
    guardProcess: async () => ({ signal: new AbortController().signal, dispose: async () => {} }),
    requestFn: async (_port, _key, route) => route === '/v1/models'
      ? { data: [{ id: alias }] }
      : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] },
    ...overrides.options,
  })
  return { child, runtime }
}

test('runtime lifecycle exposes bounded busy state and cleans successful sessions', async () => {
  const { child, runtime } = runtimeFixture()
  const result = runtime.complete({ messages: [{ role: 'user', content: 'test' }] })
  assert.deepEqual(runtime.status(), { busy: true, closed: false })
  assert.equal((await result).choices[0].message.content, 'ok')
  assert.equal(runtime.lastAccelerationMode(), 'cpu')
  assert.deepEqual(runtime.status(), { busy: false, closed: false })
  assert.equal(child.kills.length, 1)
})

test('one scoped quiz session reuses a single private model launch across three inferences', async () => {
  const child = fakeChild()
  let launches = 0
  let requests = 0
  let savedCompletion
  const alias = 'qfn-' + 'ab'.repeat(16)
  const { runtime } = runtimeFixture({
    child,
    options: {
      spawnProcess: () => { launches++; return child },
      requestFn: async (_port, _key, route) => {
        if (route === '/v1/models') return { data: [{ id: alias }] }
        requests++
        return { choices: [{ message: { content: 'batch-' + requests }, finish_reason: 'stop' }] }
      },
    },
  })
  const session = runtime.withSession(async complete => {
    savedCompletion = complete
    assert.equal((await complete({ messages: [{ role: 'user', content: 'one' }] })).choices[0].message.content, 'batch-1')
    assert.deepEqual(runtime.status(), { busy: true, closed: false })
    await assert.rejects(runtime.complete({ messages: [{ role: 'user', content: 'intrusion' }] }), { code: 'busy' })
    await complete({ messages: [{ role: 'user', content: 'two' }] })
    await complete({ messages: [{ role: 'user', content: 'three' }] })
    return requests
  })
  assert.equal(await session, 3)
  assert.equal(launches, 1)
  assert.equal(requests, 3)
  assert.equal(child.kills.length, 1)
  assert.equal(runtime.lastAccelerationMode(), 'cpu')
  assert.deepEqual(runtime.status(), { busy: false, closed: false })
  await assert.rejects(savedCompletion({ messages: [] }), { code: 'runtime_closed' })
})

test('scoped quiz sessions honor abort and clean up even when a later batch fails', async () => {
  const controller = new AbortController()
  const { child, runtime } = runtimeFixture()
  await assert.rejects(runtime.withSession(async complete => {
    await complete({ messages: [{ role: 'user', content: 'first batch' }] })
    controller.abort()
    await complete({ messages: [{ role: 'user', content: 'must not run' }] })
  }, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(child.kills.length, 1)
  assert.deepEqual(runtime.status(), { busy: false, closed: false })
})

test('shutdown cancels an active session, waits for cleanup and prevents restart', async () => {
  let started
  const reachedCompletion = new Promise(resolve => { started = resolve })
  const { child, runtime } = runtimeFixture({
    options: {
      requestFn: async (_port, _key, route, _payload, signal) => {
        if (route === '/v1/models') return { data: [{ id: 'qfn-' + 'ab'.repeat(16) }] }
        started()
        return await new Promise((_resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        })
      },
    },
  })
  const operation = runtime.complete({ messages: [{ role: 'user', content: 'test' }] })
  operation.catch(() => {})
  await reachedCompletion
  await runtime.shutdown()
  await assert.rejects(operation, { name: 'AbortError' })
  assert.deepEqual(runtime.status(), { busy: false, closed: true })
  assert.equal(child.kills.length, 1)
  await assert.rejects(
    runtime.complete({ messages: [{ role: 'user', content: 'again' }] }),
    { code: 'runtime_closed' },
  )
  await runtime.shutdown()
})

test('runtime preserves timeout cause when HTTP reports a generic abort', async () => {
  const controller = new AbortController()
  const { runtime } = runtimeFixture({
    options: {
      requestFn: async (_port, _key, route, _payload, signal) => {
        if (route === '/v1/models') return { data: [{ id: 'qfn-' + 'ab'.repeat(16) }] }
        return new Promise((_resolve, reject) => {
          const onAbort = () => reject(new DOMException('Request aborted', 'AbortError'))
          signal.addEventListener('abort', onAbort, { once: true })
          controller.abort(new DOMException('Deadline exceeded', 'TimeoutError'))
        })
      },
    },
  })
  await assert.rejects(runtime.complete({ messages: [{ role: 'user', content: 'test' }] }, {
    signal: controller.signal,
  }), { name: 'TimeoutError' })
  assert.equal(runtime.status().busy, false)
})

test('a runtime process that exits during startup fails closed', async () => {
  const child = fakeChild({ exited: true })
  const { runtime } = runtimeFixture({ child })
  await assert.rejects(
    runtime.complete({ messages: [{ role: 'user', content: 'test' }] }),
    { code: 'startup_failed' },
  )
  assert.deepEqual(runtime.status(), { busy: false, closed: false })
})

test('GPU launch uses Vulkan offload settings, then falls back to bounded CPU threads on startup failure', async () => {
  const launches = []
  const children = [fakeChild({ exited: true }), fakeChild()]
  const { runtime } = runtimeFixture({
    options: {
      accelerationMode: () => 'gpu',
      gpuDevice: () => 'Vulkan1',
      cpuThreadCount: () => 6,
      spawnProcess: (_executable, args) => {
        launches.push(args)
        return children[launches.length - 1]
      },
    },
  })
  await runtime.complete({ messages: [{ role: 'user', content: 'test' }] })
  assert.equal(launches.length, 2)
  assert.ok(launches[0].includes('Vulkan1'))
  assert.ok(launches[0].includes('99'))
  assert.ok(launches[1].includes('none'))
  assert.ok(launches[1].includes('0'))
  assert.equal(launches[0][launches[0].indexOf('-t') + 1], '6')
  assert.equal(launches[1][launches[1].indexOf('-t') + 1], '6')
  assert.equal(runtime.lastAccelerationMode(), 'cpu')
})

test('successful GPU inference records the actual selected backend and device', async () => {
  const launches = []
  const { runtime } = runtimeFixture({
    options: {
      accelerationMode: () => 'gpu',
      gpuDevice: () => 'Vulkan1',
      spawnProcess: (_executable, args) => {
        launches.push(args)
        const child = fakeChild()
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        queueMicrotask(() => {
          child.stderr.emit('data', Buffer.from('load_tensors: offloaded 35/35 la'))
          child.stderr.emit('data', Buffer.from('yers to GPU\n'))
        })
        return child
      },
    },
  })
  assert.equal(runtime.lastAccelerationMode(), null)
  await runtime.complete({ messages: [{ role: 'user', content: 'test' }] })
  assert.equal(launches.length, 1)
  assert.equal(launches[0][launches[0].indexOf('--device') + 1], 'Vulkan1')
  assert.equal(runtime.lastAccelerationMode(), 'gpu')
})

test('GPU launch without a layer offload report is not presented as confirmed GPU use', async () => {
  const { runtime } = runtimeFixture({
    options: {
      accelerationMode: () => 'gpu',
      spawnProcess: () => {
        const child = fakeChild()
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        return child
      },
    },
  })
  await runtime.complete({ messages: [{ role: 'user', content: 'test' }] })
  assert.equal(runtime.lastAccelerationMode(), 'unknown')
})

test('GPU launch reporting zero offloaded layers is recorded as CPU inference', async () => {
  const { runtime } = runtimeFixture({
    options: {
      accelerationMode: () => 'gpu',
      spawnProcess: () => {
        const child = fakeChild()
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        queueMicrotask(() => child.stderr.emit('data', 'load_tensors: offloaded 0/35 layers to GPU\n'))
        return child
      },
    },
  })
  await runtime.complete({ messages: [{ role: 'user', content: 'test' }] })
  assert.equal(runtime.lastAccelerationMode(), 'cpu')
})

test('CPU thread count uses available capacity with an eight-thread cap', () => {
  const { boundedCpuThreads } = require('../src/local-runtime.cjs')
  assert.equal(boundedCpuThreads(1), 1)
  assert.equal(boundedCpuThreads(2), 2)
  assert.equal(boundedCpuThreads(4), 4)
  assert.equal(boundedCpuThreads(64), 8)
})

test('GPU generation failures after server startup are not retried on CPU', async () => {
  let launches = 0
  const { runtime } = runtimeFixture({
    options: {
      accelerationMode: () => 'gpu',
      spawnProcess: () => { launches++; return fakeChild() },
      requestFn: async (_port, _key, route) => {
        if (route === '/v1/models') return { data: [{ id: 'qfn-' + 'ab'.repeat(16) }] }
        throw Object.assign(new Error('generation failed'), { code: 'request_failed' })
      },
    },
  })
  await assert.rejects(runtime.complete({ messages: [{ role: 'user', content: 'test' }] }),
    { code: 'request_failed' })
  assert.equal(launches, 1)
})


test('runtime does not contact the local server until process ownership is established', async () => {
  let requests = 0
  const child = fakeChild()
  const runtime = createLocalRuntime({
    directory: 'C:\\runtime',
    modelStore: { status: async () => ({ ready: true, path: 'C:\\models\\model.gguf' }) },
    platform: 'win32',
    arch: 'x64',
    verifyRuntimeFn: async () => 'C:\\runtime\\llama-server.exe',
    freePortFn: async () => 43123,
    randomBytesFn: size => Buffer.alloc(size, 0xab),
    spawnProcess: () => child,
    guardProcess: async () => { throw Object.assign(new Error('guard failed'), { code: 'watchdog_failed' }) },
    requestFn: async () => { requests++; return {} },
  })
  await assert.rejects(
    runtime.complete({ messages: [{ role: 'user', content: 'test' }] }),
    { code: 'watchdog_failed' },
  )
  assert.equal(requests, 0)
  assert.notEqual(child.signalCode, null)
  assert.deepEqual(runtime.status(), { busy: false, closed: false })
})


test('unexpected watchdog loss aborts the active runtime and cleans its child', async () => {
  let guardAbort
  let enteredRequest
  const reachedRequest = new Promise(resolve => { enteredRequest = resolve })
  const child = fakeChild()
  const runtime = createLocalRuntime({
    directory: 'C:\\runtime',
    modelStore: { status: async () => ({ ready: true, path: 'C:\\models\\model.gguf' }) },
    platform: 'win32',
    arch: 'x64',
    verifyRuntimeFn: async () => 'C:\\runtime\\llama-server.exe',
    freePortFn: async () => 43123,
    randomBytesFn: size => Buffer.alloc(size, 0xab),
    spawnProcess: () => child,
    guardProcess: async () => {
      guardAbort = new AbortController()
      return { signal: guardAbort.signal, dispose: async () => {} }
    },
    requestFn: async (_port, _key, route, _payload, signal) => {
      if (route === '/v1/models') return { data: [{ id: 'qfn-' + 'ab'.repeat(16) }] }
      enteredRequest()
      return await new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    },
  })
  const operation = runtime.complete({ messages: [{ role: 'user', content: 'test' }] })
  operation.catch(() => {})
  await reachedRequest
  guardAbort.abort(Object.assign(new Error('lost'), { code: 'watchdog_failed' }))
  await assert.rejects(operation)
  assert.notEqual(child.signalCode, null)
  assert.deepEqual(runtime.status(), { busy: false, closed: false })
})

test('partial Vulkan offload retries a smaller allocation before CPU', async () => {
  const launches = []
  const failures = []
  const children = [fakeChild({ exited: true }), fakeChild()]
  const { runtime } = runtimeFixture({
    options: {
      accelerationMode: () => 'gpu',
      gpuLayerCount: () => 24,
      gpuFallbackLayers: () => [8, 0],
      onGpuStartupFailure: layers => failures.push(layers),
      spawnProcess: (_exe, args) => {
        launches.push(args)
        return children[launches.length - 1]
      },
    },
  })
  await runtime.complete({ messages: [{ role: 'user', content: 'test' }] })
  assert.equal(launches.length, 2)
  assert.equal(launches[0][launches[0].indexOf('-ngl') + 1], '24')
  assert.equal(launches[1][launches[1].indexOf('-ngl') + 1], '8')
  assert.deepEqual(failures, [24])
})

test('GPU OOM-like early startup exits fall back to CPU after bounded partial attempts', async () => {
  const launches = []
  const failures = []
  const children = [fakeChild({ exited: true }), fakeChild({ exited: true }), fakeChild()]
  const { runtime } = runtimeFixture({
    options: {
      accelerationMode: () => 'gpu',
      gpuLayerCount: () => 24,
      gpuFallbackLayers: () => [8, 0],
      onGpuStartupFailure: layers => failures.push(layers),
      spawnProcess: (_exe, args) => {
        launches.push(args)
        return children[launches.length - 1]
      },
    },
  })
  await runtime.complete({ messages: [{ role: 'user', content: 'test' }] })
  assert.deepEqual(launches.map(args => args[args.indexOf('-ngl') + 1]), ['24', '8', '0'])
  assert.deepEqual(failures, [24, 8])
  assert.equal(runtime.lastAccelerationMode(), 'cpu')
})

test('runtime performance callback receives only bounded timing and token counts', async () => {
  const observations = []
  const { runtime } = runtimeFixture({
    options: {
      onInferenceCompleted: value => observations.push(value),
      requestFn: async (_port, _key, route) => route === '/v1/models'
        ? { data: [{ id: 'qfn-' + 'ab'.repeat(16) }] }
        : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 250, completion_tokens: 120 },
            timings: { prompt_ms: 0, predicted_ms: 0 } },
    },
  })
  await runtime.complete({ messages: [{ role: 'user', content: 'private notes' }] })
  assert.equal(observations.length, 1)
  assert.deepEqual(Object.keys(observations[0]).sort(),
    ['acceleration', 'completionTokens', 'decodeMs', 'elapsedMs', 'layers', 'prefillMs', 'promptTokens', 'threads'])
  assert.equal(observations[0].layers, 0)
  assert.equal(observations[0].completionTokens, 120)
  assert.equal(observations[0].promptTokens, 250)
  assert.equal(observations[0].prefillMs, 0)
  assert.equal(observations[0].decodeMs, 0)
  assert.ok(observations[0].threads >= 1 && observations[0].threads <= 8,
    'thread selection must stay within the safe CPU bound')
  assert.ok(observations[0].elapsedMs >= 0)
})

test('diagnostics distinguish runtime startup, inference failure and private error content', async () => {
  const events = []
  const fixture = runtimeFixture({ options: {
    onDiagnostic: (event, fields) => events.push({ event, ...fields }),
    requestFn: async (_port, _key, route) => {
      if (route === '/v1/models') return { data: [{ id: 'qfn-' + 'ab'.repeat(16) }] }
      throw Object.assign(new Error('private prompt and credential'), { code: 'request_failed' })
    },
  } })
  await assert.rejects(fixture.runtime.complete({ messages: [] }), { code: 'request_failed' })
  assert.deepEqual(events.map(x => x.event), ['runtime_launch', 'runtime_ready', 'runtime_failed'])
  assert.ok(events.find(x => x.event === 'runtime_ready').startupMs >= 0)
  assert.equal(events.at(-1).stage, 'inference')
  assert.equal(events.at(-1).reason, 'request_failed')
  assert.doesNotMatch(JSON.stringify(events), /private|credential/)
})

test('warm runtime reuses process between quizzes and releases it at idle timeout', async () => {
  let launches = 0, stops = 0, inferCalls = 0
  const timers = new Map()
  let timerId = 0
  const base = {
    async withSession(callback) {
      launches++
      try { await callback(async () => { inferCalls++; return { ok: true } }) }
      finally { stops++ }
    },
    async shutdown() {},
    lastAccelerationMode: () => 'cpu',
  }
  const warm = createWarmLocalRuntime(base, {
    idleMs: 180000, freeMemory: () => 8 * 1024 ** 3,
    setTimer: cb => { const id = ++timerId; timers.set(id, cb); return id },
    clearTimer: id => timers.delete(id),
  })
  assert.deepEqual(await warm.complete({ messages: [] }), { ok: true })
  assert.equal(launches, 1)
  assert.equal(stops, 0)
  assert.equal(warm.status().warm, true)
  await warm.withSession(async complete => {
    await complete({ messages: [] })
    await complete({ messages: [] })
  })
  assert.equal(launches, 1)
  assert.equal(inferCalls, 3)
  const expiry = [...timers.values()][0]
  expiry()
  // Give the underlying session's asynchronous finally block a microtask.
  await warm.cooldown()
  assert.equal(stops, 1)
  await warm.complete({ messages: [] })
  assert.equal(launches, 2)
  await warm.shutdown()
  assert.equal(stops, 2)
  assert.equal(warm.status().closed, true)
  await assert.rejects(warm.complete({ messages: [] }), { code: 'runtime_closed' })
})

test('warm runtime does not retain a model when memory is low or account changes', async () => {
  let starts = 0, stops = 0
  const base = {
    async withSession(fn) {
      starts++
      try { await fn(async () => ({ choices: [] })) } finally { stops++ }
    },
    shutdown: async () => {},
    lastAccelerationMode: () => 'cpu',
  }
  let free = 8 * 1024 ** 3
  let profile = 'gpu-99'
  const warm = createWarmLocalRuntime(base, {
    profile: () => profile, freeMemory: () => free,
  })
  await warm.complete({})
  profile = 'cpu-0'
  await warm.complete({})
  assert.equal(starts, 2, 'hardware profile changes require a new process')
  assert.equal(stops, 1)
  free = 256 * 1024 ** 2
  await warm.complete({})
  await warm.cooldown()
  assert.equal(stops, 3)
  assert.equal(warm.status().warm, false)
  await warm.shutdown()
})

test('warm shutdown unblocks a held native session and exits without waiting for idle timeout', async () => {
  let worker = null
  let stopped = 0
  const fake = {
    async withSession(callback) {
      worker = Promise.resolve().then(() => callback(async () => ({ choices: [] })))
      try { await worker } finally { stopped++ }
    },
    async shutdown() {
      // Same dependency as the real native runtime: shutdown awaits its
      // outstanding session callback. Old warm.shutdown deadlocked here.
      if (worker) await worker
    },
    lastAccelerationMode: () => 'cpu',
  }
  const warm = createWarmLocalRuntime(fake, { idleMs: 180000 })
  await warm.complete({ messages: [] })
  assert.equal(warm.status().warm, true)
  const shutdown = warm.shutdown()
  const settled = await Promise.race([
    shutdown.then(() => 'closed'),
    new Promise(resolve => setTimeout(() => resolve('deadlock'), 1500)),
  ])
  assert.equal(settled, 'closed', 'release warm session hold before native shutdown')
  assert.equal(stopped, 1)
  assert.equal(warm.status().closed, true)
})

test('warm shutdown interrupts active scoped request and releases its native hold', async () => {
  let finishRequest = null, enteredRequest
  const entered = new Promise(resolve => { enteredRequest = resolve })
  let worker = null
  const fake = {
    async withSession(callback) {
      worker = callback(async () => {
        enteredRequest()
        return new Promise(resolve => { finishRequest = resolve })
      })
      await worker
    },
    async shutdown() {
      finishRequest?.({ choices: [] })
      if (worker) await worker
    },
    lastAccelerationMode: () => 'cpu',
  }
  const warm = createWarmLocalRuntime(fake, { idleMs: 180000 })
  const pending = warm.withSession(async complete => complete({ messages: [] }))
  await entered
  const outcome = await Promise.race([
    warm.shutdown().then(() => 'closed'),
    new Promise(resolve => setTimeout(() => resolve('deadlock'), 1500)),
  ])
  assert.equal(outcome, 'closed')
  await pending.catch(() => {})
  assert.equal(warm.status().warm, false)
})
