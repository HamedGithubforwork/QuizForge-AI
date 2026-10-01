'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')

function execute(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, error => error ? reject(error) : resolve())
  })
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function readyLine(worker) {
  let output = ''
  return await Promise.race([
    new Promise((resolve, reject) => {
      worker.once('error', reject)
      worker.once('close', code => reject(new Error('Worker exited before ready: ' + code)))
      worker.stdout.on('data', chunk => {
        output += String(chunk)
        if (output.length > 128) reject(new Error('Unexpected worker output'))
        const line = output.split(/\r?\n/).find(value => value.startsWith('READY '))
        if (line) resolve(line)
      })
    }),
    delay(15000).then(() => { throw new Error('Parent-death worker timed out') }),
  ])
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only')
  const worker = spawn(process.execPath, [path.resolve(__dirname, 'parent-death-worker.cjs')],
    { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
  let childPid
  try {
    const line = await readyLine(worker)
    childPid = Number(line.slice('READY '.length))
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0)
    assert.equal(processExists(childPid), true)

    const taskkill = path.join(process.env.SystemRoot, 'System32', 'taskkill.exe')
    await execute(taskkill, ['/PID', String(worker.pid), '/F'], { windowsHide: true })
    const deadline = Date.now() + 10000
    while (Date.now() < deadline && processExists(childPid)) await delay(100)
    assert.equal(processExists(childPid), false,
      'Guarded child must exit after an abrupt parent termination')
    console.log('PASS: Windows Job Object watchdog removed guarded child after hard parent termination')
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) {
      try {
        const taskkill = path.join(process.env.SystemRoot, 'System32', 'taskkill.exe')
        await execute(taskkill, ['/PID', String(worker.pid), '/F'], { windowsHide: true })
      } catch {}
    }
    if (childPid && processExists(childPid)) {
      try {
        const taskkill = path.join(process.env.SystemRoot, 'System32', 'taskkill.exe')
        await execute(taskkill, ['/PID', String(childPid), '/F'], { windowsHide: true })
      } catch {}
    }
  }
}

main().catch(() => {
  console.error('Parent-death process-ownership validation failed')
  process.exitCode = 1
})
