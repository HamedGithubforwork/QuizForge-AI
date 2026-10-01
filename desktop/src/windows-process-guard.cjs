'use strict'

const path = require('node:path')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')

const fail = code => Object.assign(new Error('Windows process guard: ' + code), { code })

const SOURCE = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QfnJob {
  [StructLayout(LayoutKind.Sequential)]
  public struct BasicLimit {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct ExtendedLimit {
    public BasicLimit BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
$parentId = [uint32]$env:QFN_PARENT_PID
$childId = [uint32]$env:QFN_CHILD_PID
$job = [QfnJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw 'job-create' }
$memory = [IntPtr]::Zero
try {
  $basic = New-Object QfnJob+BasicLimit
  $basic.LimitFlags = 0x00002000
  $limits = New-Object QfnJob+ExtendedLimit
  $limits.BasicLimitInformation = $basic
  $size = [Runtime.InteropServices.Marshal]::SizeOf($limits)
  $memory = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  [Runtime.InteropServices.Marshal]::StructureToPtr($limits, $memory, $false)
  if (-not [QfnJob]::SetInformationJobObject($job, 9, $memory, [uint32]$size)) {
    throw 'job-policy'
  }
  $process = [QfnJob]::OpenProcess(0x00000101, $false, $childId)
  if ($process -eq [IntPtr]::Zero) { throw 'child-open' }
  try {
    if (-not [QfnJob]::AssignProcessToJobObject($job, $process)) { throw 'job-assign' }
  } finally {
    [void][QfnJob]::CloseHandle($process)
  }
  $parentStart = ([Diagnostics.Process]::GetProcessById($parentId)).StartTime.ToFileTimeUtc()
  $childStart = ([Diagnostics.Process]::GetProcessById($childId)).StartTime.ToFileTimeUtc()
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  while ($true) {
    Start-Sleep -Milliseconds 200
    try {
      $parent = [Diagnostics.Process]::GetProcessById($parentId)
      if ($parent.StartTime.ToFileTimeUtc() -ne $parentStart) { break }
    } catch { break }
    try {
      $child = [Diagnostics.Process]::GetProcessById($childId)
      if ($child.StartTime.ToFileTimeUtc() -ne $childStart) { break }
    } catch { break }
  }
} finally {
  if ($memory -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($memory) }
  if ($job -ne [IntPtr]::Zero) { [void][QfnJob]::CloseHandle($job) }
}`

function watchdogEnvironment(parentPid, childPid, source = process.env) {
  if (!Number.isSafeInteger(parentPid) || parentPid < 1 ||
      !Number.isSafeInteger(childPid) || childPid < 1) throw fail('invalid_process')
  const env = {
    QFN_PARENT_PID: String(parentPid),
    QFN_CHILD_PID: String(childPid),
  }
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
  parentPid = process.pid,
  environment = process.env,
  spawnProcess = spawn,
  readyTimeoutMs = 10000,
} = {}) {
  if (platform !== 'win32') throw fail('unsupported_platform')
  const childPid = child?.pid
  const env = watchdogEnvironment(parentPid, childPid, environment)
  const executable = path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const watchdog = spawnProcess(executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedSource()],
    { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'], env })
  if (!watchdog?.stdout || typeof watchdog.kill !== 'function') throw fail('watchdog_failed')

  let output = ''
  let settled = false
  const closed = new Promise(resolve => watchdog.once('close', resolve))
  const ready = new Promise((resolve, reject) => {
    const rejectOnce = error => {
      if (settled) return
      settled = true
      reject(error)
    }
    watchdog.once('error', () => rejectOnce(fail('watchdog_failed')))
    watchdog.once('close', () => rejectOnce(fail('watchdog_failed')))
    watchdog.stdout.on('data', chunk => {
      if (settled) return
      output += String(chunk)
      if (output.length > 64) {
        rejectOnce(fail('watchdog_failed'))
        return
      }
      if (output.split(/\r?\n/).includes('READY')) {
        settled = true
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
    if (watchdog.exitCode === null && watchdog.signalCode === null) watchdog.kill()
    await Promise.race([closed, delay(2000)]).catch(() => {})
    throw error
  }

  return Object.freeze({
    async dispose() {
      if (watchdog.exitCode !== null || watchdog.signalCode !== null) return
      watchdog.kill()
      if (!await Promise.race([closed.then(() => true), delay(3000, false)])) {
        throw fail('watchdog_shutdown_failed')
      }
    },
  })
}

module.exports = {
  createWindowsProcessGuard,
  watchdogEnvironment,
}
