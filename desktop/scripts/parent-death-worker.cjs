'use strict'

const path = require('node:path')
const { spawn } = require('node:child_process')
const { createWindowsProcessGuard } = require('../src/windows-process-guard.cjs')

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only')
  const root = process.env.SystemRoot
  if (!root) throw new Error('SystemRoot unavailable')
  const powershell = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const child = spawn(powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 60'],
    { windowsHide: true, shell: false, stdio: 'ignore',
      env: { SystemRoot: root, PATH: path.join(root, 'System32') } })
  child.once('error', () => process.exit(2))
  await createWindowsProcessGuard(child)
  process.stdout.write('READY ' + child.pid + '\n')
  setInterval(() => {}, 1000)
}

main().catch(() => process.exit(1))
