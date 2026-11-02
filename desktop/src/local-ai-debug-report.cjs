'use strict'
const fs = require('node:fs/promises')
function createLocalAiDebugReport() {
  let armed = false, active = false, report = null
  return {
    arm() { armed = true; active = false; report = null },
    begin(settings) {
      if (!armed) return
      armed = false; active = true
      report = { schema: 1, createdAt: new Date().toISOString(), settings, rejected: [] }
    },
    record(item) {
      if (!active || report.rejected.length >= 30) return
      if (JSON.stringify(report).length + JSON.stringify(item).length > 200000) return
      report.rejected.push(item)
    },
    finish() { active = false },
    clear() { armed = false; active = false; report = null },
    report: () => report ? JSON.stringify(report, null, 2) : null,
  }
}
async function armDebugReport({ dialog, manager }) {
  if (!manager) return
  const { response } = await dialog.showMessageBox({ type: 'question',
    message: 'Record details for the next Local AI quiz?',
    detail: 'Rejected questions, answers and cited study text will be held in memory for one quiz. Nothing is uploaded or saved until you export. Closing the app or signing out clears these details.',
    buttons: ['Cancel', 'Record next quiz'], defaultId: 0, cancelId: 0 })
  if (response === 1) manager.armDetailedDebug()
}
async function saveDebugReport({ dialog, manager }) {
  const report = manager?.detailedDebugReport()
  if (!report) {
    await dialog.showMessageBox({ message: 'No detailed report recorded yet.', detail: 'Choose Record next Local AI quiz, then generate a quiz before saving its report.', buttons: ['Close'] })
    return
  }
  const { response } = await dialog.showMessageBox({ type: 'warning',
    message: 'This report contains study material.', detail: 'It includes rejected questions, generated answers and cited source text. Share it only if you want that content reviewed.',
    buttons: ['Cancel', 'Save report'], defaultId: 0, cancelId: 0 })
  if (response !== 1) return
  const selected = await dialog.showSaveDialog({ defaultPath: 'local-ai-detailed-debug.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
  if (selected.canceled || !selected.filePath) return
  try { await fs.writeFile(selected.filePath, report, { mode: 0o600 }) }
  catch { await dialog.showMessageBox({ message: 'Could not save the debug report. Try another location.', buttons: ['Close'] }) }
}
module.exports = { createLocalAiDebugReport, armDebugReport, saveDebugReport }
