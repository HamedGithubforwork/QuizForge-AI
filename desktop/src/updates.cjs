'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { load, JSON_SCHEMA } = require('js-yaml')

function approvedConfiguration(config) {
  const allowed = new Set(['provider', 'owner', 'repo', 'private', 'releaseType', 'publisherName', 'updaterCacheDirName'])
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(key => !allowed.has(key)) || config.provider !== 'github' ||
      config.owner !== 'HamedGithubforwork' || config.repo !== 'QuizForge-AI' || config.private !== false ||
      config.releaseType !== 'release' || config.updaterCacheDirName !== 'quiz-from-notes-desktop-updater') return false
  const names = Array.isArray(config.publisherName) ? config.publisherName : [config.publisherName]
  return names.length > 0 && names.length <= 4 && names.every(name =>
    typeof name === 'string' && name.trim() === name && name.length > 0 && name.length <= 256 && !/[\x00-\x1f\x7f]/.test(name))
}

// Unsigned previews have no approved feed. Never let electron-updater silently
// skip Authenticode verification because publisherName is absent.
function loadApprovedConfiguration(resourcesPath) {
  try {
    const file = path.join(resourcesPath, 'app-update.yml')
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) return false
    return approvedConfiguration(load(fs.readFileSync(file, 'utf8'), { schema: JSON_SCHEMA }))
  } catch { return false }
}

function createUpdates({ updater, prompt, beforeInstall, changed = () => {} }) {
  let phase = updater ? 'idle' : 'unavailable'
  let progress = 0
  let busy = false
  let disposed = false
  let cancellation = null
  function notify() { try { changed() } catch {} }
  function state(value) { phase = value; notify() }
  if (updater) {
    updater.logger = null
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowDowngrade = false
    updater.allowPrerelease = false
    updater.disableWebInstaller = true
    updater.forceDevUpdateConfig = false
    updater.on('error', () => {
      if (phase === 'installing' && !disposed) { state('error'); void Promise.resolve(prompt('error')).catch(() => {}) }
    }) // Download/check rejections below produce generic UI, never raw URLs/errors.
    updater.on('download-progress', value => {
      if (phase !== 'downloading' || !Number.isFinite(value.percent)) return
      progress = Math.max(0, Math.min(100, Math.floor(value.percent)))
      notify()
    })
  }
  async function restart() {
    if (disposed || busy || phase !== 'ready') return
    busy = true
    try {
      if (!await prompt('restart') || disposed) return
      await beforeInstall()
      if (!disposed) { state('installing'); updater.quitAndInstall(true, true) }
    } catch { if (!disposed) { state('error'); await prompt('error') } }
    finally { busy = false; notify() }
  }
  return {
    status: () => ({ phase, progress, busy }),
    restart,
    async check(interactive = false) {
      if (disposed || busy) return
      if (!updater) { if (interactive) await prompt('unavailable'); return }
      if (phase === 'ready') { if (interactive) await restart(); return }
      busy = true
      state('checking')
      try {
        const result = await updater.checkForUpdates()
        if (disposed) return
        if (!result || typeof result.isUpdateAvailable !== 'boolean') throw Error('No update result')
        if (!result.isUpdateAvailable) {
          state('idle')
          if (interactive) await prompt('current')
          return
        }
        cancellation = result.cancellationToken
        progress = 0
        state('downloading')
        await updater.downloadUpdate(cancellation)
        if (disposed) return
        state('ready')
      } catch {
        if (!disposed) { state('error'); if (interactive) await prompt('error') }
      } finally { cancellation = null; busy = false; notify() }
      if (interactive && phase === 'ready' && !disposed) await restart()
    },
    dispose() { disposed = true; cancellation?.cancel() },
  }
}
module.exports = { approvedConfiguration, loadApprovedConfiguration, createUpdates }
