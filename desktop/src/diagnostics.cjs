'use strict'

const MAX_COUNT = 1_000_000
const REASONS = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure'])
const version = value => typeof value === 'string' && /^\d{1,4}(\.\d{1,6}){1,3}(-[A-Za-z0-9.-]{1,40})?$/.test(value) ? value : 'unknown'
const choice = (value, allowed) => allowed.includes(value) ? value : 'unknown'

// Deliberately accepts no URL, error text, account identity or document content.
// State lives only in memory and is shared only by an explicit native menu action.
function createDiagnostics({ appVersion, electronVersion, chromeVersion, platform, arch, packaged }) {
  const metadata = {
    schema: 1, appVersion: version(appVersion), electronVersion: version(electronVersion),
    chromeVersion: version(chromeVersion), platform: choice(platform, ['win32', 'darwin', 'linux']),
    arch: choice(arch, ['x64', 'arm64', 'ia32']), packaged: packaged === true,
  }
  const counts = { pageLoads: 0, pageLoadFailures: 0, rendererExits: 0 }
  let lastRendererExit = 'none'
  return {
    attach(contents) {
      contents.on('did-finish-load', () => { counts.pageLoads = Math.min(MAX_COUNT, counts.pageLoads + 1) })
      contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
        // Cancellations (ERR_ABORTED) occur during normal login/navigation.
        if (isMainFrame === true && code !== -3) counts.pageLoadFailures = Math.min(MAX_COUNT, counts.pageLoadFailures + 1)
      })
      contents.on('render-process-gone', (_event, details) => {
        counts.rendererExits = Math.min(MAX_COUNT, counts.rendererExits + 1)
        lastRendererExit = REASONS.has(details?.reason) ? details.reason : 'unknown'
      })
    },
    report: () => JSON.stringify({ ...metadata, ...counts, lastRendererExit }, null, 2),
  }
}

async function showDiagnostics({ dialog, clipboard, diagnostics }) {
  const report = diagnostics.report()
  const { response } = await dialog.showMessageBox({
    type: 'info', title: 'Desktop diagnostics', message: 'Quiz From Notes desktop diagnostics',
    detail: 'These details stay on your computer until you choose Copy. They include app versions and session error counts, but no account information or study content. Counts reset when the app closes.\n\n' + report,
    buttons: ['Close', 'Copy'], defaultId: 0, cancelId: 0, noLink: true,
  })
  if (response === 1) {
    try { await clipboard.writeText(report) } catch {
      await dialog.showMessageBox({ type: 'warning', title: 'Could not copy diagnostics', message: 'Your clipboard is unavailable. Please try again.', buttons: ['Close'] })
    }
  }
}

module.exports = { createDiagnostics, showDiagnostics }
