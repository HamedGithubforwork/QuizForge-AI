'use strict'

function createSnapshotMenu({ account, snapshots, dialog, getWindow, changed = () => {} }) {
  let busy = false
  return async function run(action) {
    if (busy || !['save', 'remove', 'sync'].includes(action)) return
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    const generation = account.generation()
    const identity = account.current()
    busy = true
    try {
      if (!identity?.enrolled) {
        await dialog.showMessageBox(window, { type: 'info', title: 'Local study copy',
          message: 'Sign in to your desktop account first.', buttons: ['OK'] })
        return
      }
      const current = () => !window.isDestroyed() && getWindow() === window &&
        account.generation() === generation && account.current()?.userId === identity.userId
      if (action === 'sync') {
        const confirm = await dialog.showMessageBox(window, { type: 'question', title: 'Sync offline reviews',
          message: 'Apply this account’s saved ratings to its online review schedule?',
          detail: 'Changed or unavailable cards may need reconciliation. Failed or unconfirmed ratings remain saved for retry.',
          buttons: ['Sync reviews', 'Cancel'], defaultId: 1, cancelId: 1 })
        if (confirm.response !== 0 || !current()) return
        const result = await snapshots.sync()
        changed()
        if (current()) await dialog.showMessageBox(window, { type: 'info', title: 'Offline reviews synced',
          message: `${result.synced} reviews synchronized.`, detail: 'Save a fresh offline library to get current cards and schedules.', buttons: ['OK'] })
        return
      }
      const { response } = await dialog.showMessageBox(window, {
        type: 'question', title: 'Local study copy',
        message: action === 'save' ? 'Enable offline study for this account on this Windows profile?' : 'Remove this account’s local study copy?',
        detail: action === 'save'
          ? 'Anyone using this Windows login can open these decks without internet or account sign-in, including after sign-out or restart. This replaces the previous local copy and stores questions, answers and source references encrypted on this profile. Remove the local copy to disable offline access. Offline ratings are saved locally until you choose Sync offline reviews. Pending ratings must be synced before replacing this copy. Your server decks are unchanged.'
          : 'This account’s encrypted copy and any unsynced ratings on this computer will be permanently removed. Your server decks and other accounts’ copies are unchanged.',
        buttons: [action === 'save' ? 'Save local copy' : 'Remove local copy', 'Cancel'], defaultId: 1, cancelId: 1,
      })
      if (response !== 0 || !current()) return
      const result = action === 'save' ? await snapshots.save({ offlineAccess: true }) : await snapshots.remove()
      changed()
      if (!current()) return
      await dialog.showMessageBox(window, { type: 'info', title: 'Local study copy',
        message: action === 'save' ? `Encrypted copy saved: ${result.deckCount} decks, ${result.cardCount} cards.` : 'Local study copy removed.',
        detail: 'Your server decks are unchanged.', buttons: ['OK'] })
    } catch {
      if (!window.isDestroyed()) await dialog.showMessageBox(window, { type: 'warning', title: 'Local study copy',
        message: 'The local study copy operation could not be completed.',
        detail: 'Check your connection, desktop sign-in and secure Windows storage. Sync pending ratings before replacing a copy. Some sync requests may already have succeeded; retrying will not count them twice. Unconfirmed ratings remain saved. Changed online cards may require removing the local copy (discarding unsynced ratings) and saving it again.', buttons: ['OK'] })
    } finally { busy = false }
  }
}

module.exports = { createSnapshotMenu }
