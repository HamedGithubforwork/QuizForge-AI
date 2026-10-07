'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { EventEmitter } = require('node:events')
const { createHash } = require('node:crypto')
const { createLocalRuntime, verifyRuntime, runtimeEnvironment, request } = require('../src/local-runtime.cjs')

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
        queueMicrotask(() => child.stderr.emit('data', 'load_tensors: offloaded 35/35 layers to GPU\n'))
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

test('CPU thread count is capped and leaves one logical CPU for the desktop', () => {
  const { boundedCpuThreads } = require('../src/local-runtime.cjs')
  assert.equal(boundedCpuThreads(1), 1)
  assert.equal(boundedCpuThreads(4), 3)
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
