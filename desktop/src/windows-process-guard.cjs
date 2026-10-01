'use strict'

const path = require('node:path')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')

const fail = code => Object.assign(new Error('Windows process guard: ' + code), { code })

// The watchdog blocks on stdin. Abrupt parent termination closes the inherited
// pipe, which releases ReadLine and triggers verified child termination.
// If the watchdog dies unexpectedly, the parent-side AbortSignal fails the
// runtime closed and its normal cleanup kills the child.
const SOURCE = String.raw`$ErrorActionPreference = 'Stop'
$childId = [uint32]$env:QFN_CHILD_PID
$childStart = ([Diagnostics.Process]::GetProcessById($childId)).StartTime.ToFileTimeUtc()
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
try {
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line -or $line -eq 'STOP') { break }
  }
} finally {
  try {
    $child = [Diagnostics.Process]::GetProcessById($childId)
    if ($child.StartTime.ToFileTimeUtc() -eq $childStart) {
      $child.Kill()
      $child.WaitForExit(5000) | Out-Null
    }
  } catch {}
}`

function watchdogEnvironment(childPid, source = process.env) {
  if (!Number.isSafeInteger(childPid) || childPid < 1) throw fail('invalid_process')
  const env = { QFN_CHILD_PID: String(childPid) }
  for (const expected of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    const found = Object.keys(source).find(name => name.toLowerCase() === expected.toLowerCase())
    if (found && typeof source[found] === 'string') env[expected] = source[found]
  }
  if (!env.SystemRoot || !path.isAbsolute(env.SystemRoot)) throw fail('watchdog_unavailable')
  env.PATH = path.join(env.SystemRoot, 'System32')
  return env
}

function encodedSource() {
  return Buffer.from(SOURCE, 'utf16le').toString('base64')
}

async function createWindowsProcessGuard(child, {
  platform = process.platform,
  environment = process.env,
  spawnProcess = spawn,
  readyTimeoutMs = 10000,
} = {}) {
  if (platform !== 'win32') throw fail('unsupported_platform')
  const childPid = child?.pid
  const env = watchdogEnvironment(childPid, environment)
  const executable = path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const watchdog = spawnProcess(executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedSource()],
    { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'], env })
  if (!watchdog?.stdin || !watchdog?.stdout || typeof watchdog.kill !== 'function') {
    throw fail('watchdog_failed')
  }

  let output = ''
  let readySettled = false
  let disposing = false
  const lost = new AbortController()
  const closed = new Promise(resolve => watchdog.once('close', resolve))
  watchdog.once('close', () => {
    if (!disposing) lost.abort(fail('watchdog_failed'))
  })
  watchdog.once('error', () => {
    if (!disposing) lost.abort(fail('watchdog_failed'))
  })

  const ready = new Promise((resolve, reject) => {
    const rejectOnce = error => {
      if (readySettled) return
      readySettled = true
      reject(error)
    }
    watchdog.once('error', () => rejectOnce(fail('watchdog_failed')))
    watchdog.once('close', () => rejectOnce(fail('watchdog_failed')))
    watchdog.stdout.on('data', chunk => {
      if (readySettled) return
      output += String(chunk)
      if (output.length > 64) {
        rejectOnce(fail('watchdog_failed'))
        return
      }
      if (output.split(/\r?\n/).includes('READY')) {
        readySettled = true
        resolve()
      }
    })
  })

  try {
    await Promise.race([
      ready,
      delay(readyTimeoutMs).then(() => { throw fail('watchdog_timeout') }),
    ])
  } catch (error) {
    disposing = true
    watchdog.stdin.destroy()
    if (watchdog.exitCode === null && watchdog.signalCode === null) watchdog.kill()
    await Promise.race([closed, delay(2000)]).catch(() => {})
    throw error
  }

  return Object.freeze({
    signal: lost.signal,
    async dispose() {
      if (disposing) return
      disposing = true
      if (watchdog.exitCode !== null || watchdog.signalCode !== null) return
      watchdog.stdin.end('STOP\n')
      if (await Promise.race([closed.then(() => true), delay(3000, false)])) return
      watchdog.kill()
      if (!await Promise.race([closed.then(() => true), delay(2000, false)])) {
        throw fail('watchdog_shutdown_failed')
      }
    },
  })
}

module.exports = {
  createWindowsProcessGuard,
  watchdogEnvironment,
}
