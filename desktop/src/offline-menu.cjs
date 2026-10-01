'use strict'
function createOfflineMenu({ store, reader, dialog, getWindow }) {
  let busy = false, generation = 0
  return {
    clear() { generation++; reader.close() },
    async open() {
      if (busy) return
      const window = getWindow(), epoch = generation
      if (!window || window.isDestroyed()) return
      const current = () => epoch === generation && !window.isDestroyed() && getWindow() === window
      busy = true
      try {
        const copies = await store.listOffline()
        if (!current()) return
        if (!copies.length) {
          await dialog.showMessageBox(window, { type: 'info', title: 'Offline study',
            message: 'No library has been enabled for offline study yet.',
            detail: 'While online, sign in and choose Save for offline study from the Quiz From Notes menu. Older local copies need to be saved again to enable offline access.', buttons: ['OK'] })
          return
        }
        let index = 0
        while (current()) {
          const copy = copies[index]
          const result = await dialog.showMessageBox(window, { type: 'question', title: 'Offline study',
            message: `Saved library ${index + 1} of ${copies.length}: ${copy.label}`,
            detail: `${copy.deckCount} decks · Saved ${copy.savedAt}\nThis library is unlocked by your Windows login. Practice does not save or synchronize progress yet.`,
            buttons: ['Open library', 'Next library', 'Remove local copy', 'Cancel'], defaultId: 3, cancelId: 3 })
          if (!current() || result.response === 3) return
          if (result.response === 1) { index = (index + 1) % copies.length; continue }
          if (result.response === 2) {
            const confirm = await dialog.showMessageBox(window, { type: 'warning', title: 'Remove offline library',
              message: 'Remove this saved library from this Windows profile?', detail: 'Your online decks will not be changed.',
              buttons: ['Remove local copy', 'Cancel'], defaultId: 1, cancelId: 1 })
            if (!current() || confirm.response !== 0) return
            reader.close()
            await store.remove(copy.ownerId, () => { if (!current()) throw Error('Cancelled') })
            return
          }
          if (result.response !== 0) return
          const snapshot = await store.load(copy.ownerId)
          if (!current()) return
          if (!snapshot || snapshot.offlineAccess !== true) throw Error('Offline access unavailable')
          await reader.open(snapshot)
          if (!current()) reader.close()
          return
        }
      } catch {
        if (current()) await dialog.showMessageBox(window, { type: 'warning', title: 'Offline study',
          message: 'Could not unlock the saved library.', detail: 'Use the Windows profile that saved it. If the copy is damaged, reconnect and save it again. No server data was changed.', buttons: ['OK'] })
      } finally { busy = false }
    },
  }
}
module.exports = { createOfflineMenu }
