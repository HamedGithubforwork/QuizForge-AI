'use strict'

function createSnapshotMenu({ account, snapshots, dialog, getWindow }) {
  let busy = false
  return async function run(action) {
    if (busy || !['save', 'remove'].includes(action)) return
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
      const { response } = await dialog.showMessageBox(window, {
        type: 'question', title: 'Local study copy',
        message: action === 'save' ? 'Save an encrypted copy of this account’s decks on this computer?' : 'Remove this account’s local study copy?',
        detail: action === 'save'
          ? 'This replaces this account’s previous local copy. The copy includes questions, answers and source references, remains on this Windows profile after sign-out, and is not a portable backup. Offline browsing and review synchronization are not enabled yet. Your server decks are unchanged.'
          : 'Only this account’s encrypted copy on this computer will be removed. Your server decks and other accounts’ copies are unchanged.',
        buttons: [action === 'save' ? 'Save local copy' : 'Remove local copy', 'Cancel'], defaultId: 1, cancelId: 1,
      })
      if (response !== 0 || !current()) return
      const result = await snapshots[action]()
      if (!current()) return
      await dialog.showMessageBox(window, { type: 'info', title: 'Local study copy',
        message: action === 'save' ? `Encrypted copy saved: ${result.deckCount} decks, ${result.cardCount} cards.` : 'Local study copy removed.',
        detail: 'Your server decks are unchanged.', buttons: ['OK'] })
    } catch {
      if (!window.isDestroyed()) await dialog.showMessageBox(window, { type: 'warning', title: 'Local study copy',
        message: 'The local study copy operation could not be completed.',
        detail: 'Check your connection and desktop sign-in, then try again. Secure Windows storage must be available. Your server decks are unchanged.', buttons: ['OK'] })
    } finally { busy = false }
  }
}

module.exports = { createSnapshotMenu }
