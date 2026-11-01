'use strict'

const { createDiagnosticHistory } = require('./diagnostic-history.cjs')
const fs = require('node:fs/promises')

const MAX_COUNT = 1_000_000
const REASONS = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure'])
const version = value => typeof value === 'string' && /^\d{1,4}(\.\d{1,6}){1,3}(-[A-Za-z0-9.-]{1,40})?$/.test(value) ? value : 'unknown'
const choice = (value, allowed) => allowed.includes(value) ? value : 'unknown'

// Deliberately accepts no URL, error text, account identity or document content.
// Bounded history stays on this device and is shared only by a native menu action.
function createDiagnostics({ appVersion, electronVersion, chromeVersion, platform, arch, packaged }) {
  const metadata = {
    schema: 1, appVersion: version(appVersion), electronVersion: version(electronVersion),
    chromeVersion: version(chromeVersion), platform: choice(platform, ['win32', 'darwin', 'linux']),
    arch: choice(arch, ['x64', 'arm64', 'ia32']), packaged: packaged === true,
  }
  const counts = { pageLoads: 0, pageLoadFailures: 0, rendererExits: 0 }
  let lastRendererExit = 'none'
  let history = null
  return {
    startPersistence(directory) { history = createDiagnosticHistory({ directory, appVersion: metadata.appVersion }) },
    record(event, fields) { history?.record(event, fields) },
    attach(contents) {
      contents.on('did-finish-load', () => { counts.pageLoads = Math.min(MAX_COUNT, counts.pageLoads + 1) })
      contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
        // Cancellations (ERR_ABORTED) occur during normal login/navigation.
        if (isMainFrame === true && code !== -3) {
          counts.pageLoadFailures = Math.min(MAX_COUNT, counts.pageLoadFailures + 1)
          history?.record('page_load_failed')
        }
      })
      contents.on('render-process-gone', (_event, details) => {
        counts.rendererExits = Math.min(MAX_COUNT, counts.rendererExits + 1)
        lastRendererExit = REASONS.has(details?.reason) ? details.reason : 'unknown'
        history?.record('renderer_exited', { reason: lastRendererExit })
      })
    },
    report: () => JSON.stringify({ ...metadata, ...counts, lastRendererExit, ...(history ? { history: history.snapshot() } : {}) }, null, 2),
  }
}

async function showDiagnostics({ dialog, clipboard, diagnostics }) {
  const report = diagnostics.report()
  const { response } = await dialog.showMessageBox({
    type: 'info', title: 'Desktop diagnostics', message: 'Quiz From Notes desktop diagnostics',
    detail: 'These details stay on your computer until you choose Copy. They include app versions and session error counts, but no account information or study content. Session counts reset when the app closes. The latest 300 diagnostic events are retained across restarts; a started operation without a completion may indicate an interrupted attempt.\n\n' + report,
    buttons: ['Close', 'Copy', 'Save report…'], defaultId: 0, cancelId: 0, noLink: true,
  })
  if (response === 2) {
    try {
      const selected = await dialog.showSaveDialog({ title: 'Save diagnostic report', defaultPath: 'quiz-from-notes-diagnostics.json', filters: [{ name: 'JSON report', extensions: ['json'] }] })
      if (!selected.canceled && selected.filePath) await fs.writeFile(selected.filePath, report, { mode: 0o600 })
    } catch {
      await dialog.showMessageBox({ type: 'warning', title: 'Could not save diagnostics', message: 'The report could not be saved. Try another location or Copy.', buttons: ['Close'] })
    }
  }
  if (response === 1) {
    try { await clipboard.writeText(report) } catch {
      await dialog.showMessageBox({ type: 'warning', title: 'Could not copy diagnostics', message: 'Your clipboard is unavailable. Please try again.', buttons: ['Close'] })
    }
  }
}

module.exports = { createDiagnostics, showDiagnostics }
