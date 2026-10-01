'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const {
  createWindowsProcessGuard,
  watchdogEnvironment,
} = require('../src/windows-process-guard.cjs')

function fakeWatchdog() {
  const process = new EventEmitter()
  process.stdin = new PassThrough()
  process.stdout = new PassThrough()
  process.exitCode = null
  process.signalCode = null
  process.kill = () => {
    process.signalCode = 'SIGTERM'
    queueMicrotask(() => process.emit('close'))
    return true
  }
  process.stdin.on('finish', () => {
    if (process.exitCode === null && process.signalCode === null) {
      process.exitCode = 0
      queueMicrotask(() => process.emit('close', 0))
    }
  })
  return process
}

test('watchdog environment contains only system paths and child identity', () => {
  const env = watchdogEnvironment(456, {
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    OPENAI_API_KEY: 'secret',
    LLAMA_API_KEY: 'secret',
    HTTP_PROXY: 'remote',
    NODE_OPTIONS: '--require bad',
  })
  assert.deepEqual(Object.keys(env).sort(),
    ['PATH', 'QFN_CHILD_PID', 'SystemRoot', 'TEMP'])
  assert.equal(env.QFN_CHILD_PID, '456')
})

test('guard waits for pipe handshake and closes cleanly through stdin', async () => {
  const watchdog = fakeWatchdog()
  let executable, args, options
  const promise = createWindowsProcessGuard({ pid: 456 }, {
    platform: 'win32',
    environment: { SystemRoot: 'C:\\Windows' },
    spawnProcess(file, argv, config) {
      executable = file
      args = argv
      options = config
      queueMicrotask(() => watchdog.stdout.write('READY\r\n'))
      return watchdog
    },
  })
  const guard = await promise
  assert.equal(executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(args.includes('-EncodedCommand'), true)
  assert.equal(options.shell, false)
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore'])
  assert.equal('LLAMA_API_KEY' in options.env, false)
  assert.equal(guard.signal.aborted, false)
  await guard.dispose()
  assert.equal(watchdog.exitCode, 0)
  assert.equal(guard.signal.aborted, false)
})

test('unexpected watchdog exit aborts the ownership signal', async () => {
  const watchdog = fakeWatchdog()
  const promise = createWindowsProcessGuard({ pid: 456 }, {
    platform: 'win32',
    environment: { SystemRoot: 'C:\\Windows' },
    spawnProcess() {
      queueMicrotask(() => watchdog.stdout.write('READY\r\n'))
      return watchdog
    },
  })
  const guard = await promise
  watchdog.exitCode = 7
  watchdog.emit('close', 7)
  assert.equal(guard.signal.aborted, true)
  assert.equal(guard.signal.reason?.code, 'watchdog_failed')
})

test('guard fails closed when the watchdog exits before handshake', async () => {
  const watchdog = fakeWatchdog()
  await assert.rejects(createWindowsProcessGuard({ pid: 456 }, {
    platform: 'win32',
    environment: { SystemRoot: 'C:\\Windows' },
    spawnProcess() {
      queueMicrotask(() => {
        watchdog.exitCode = 1
        watchdog.emit('close', 1)
      })
      return watchdog
    },
  }), { code: 'watchdog_failed' })
})
