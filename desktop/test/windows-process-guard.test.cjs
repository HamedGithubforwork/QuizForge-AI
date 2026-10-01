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
  process.stdout = new PassThrough()
  process.exitCode = null
  process.signalCode = null
  process.kill = () => {
    process.signalCode = 'SIGTERM'
    queueMicrotask(() => process.emit('close'))
    return true
  }
  return process
}

test('watchdog environment contains only system paths and process identities', () => {
  const env = watchdogEnvironment(123, 456, {
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    OPENAI_API_KEY: 'secret',
    LLAMA_API_KEY: 'secret',
    HTTP_PROXY: 'remote',
    NODE_OPTIONS: '--require bad',
  })
  assert.deepEqual(Object.keys(env).sort(),
    ['PATH', 'QFN_CHILD_PID', 'QFN_PARENT_PID', 'SystemRoot', 'TEMP'])
  assert.equal(env.QFN_PARENT_PID, '123')
  assert.equal(env.QFN_CHILD_PID, '456')
})

test('guard waits for assignment handshake and disposes the watchdog', async () => {
  const watchdog = fakeWatchdog()
  let executable, args, options
  const promise = createWindowsProcessGuard({ pid: 456 }, {
    platform: 'win32',
    parentPid: 123,
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
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore'])
  assert.equal('LLAMA_API_KEY' in options.env, false)
  await guard.dispose()
  assert.equal(watchdog.signalCode, 'SIGTERM')
})

test('guard fails closed when the watchdog exits before assignment', async () => {
  const watchdog = fakeWatchdog()
  await assert.rejects(createWindowsProcessGuard({ pid: 456 }, {
    platform: 'win32',
    parentPid: 123,
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
