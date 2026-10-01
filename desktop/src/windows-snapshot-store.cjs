"use strict"

const path = require('node:path')
const { createSnapshotStore } = require('./snapshot-store.cjs')

function createWindowsSnapshotStore({ app, safeStorage, platform = process.platform }) {
  if (platform !== 'win32' || !app.isReady()) throw new Error('Secure snapshots require a ready Windows app.')
  const encryption = {
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: value => safeStorage.encryptStringAsync(value),
    decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
  }
  const legacy = createSnapshotStore({ directory: path.join(app.getPath('userData'), 'study-snapshots-v1'), encryption })
  const current = createSnapshotStore({ directory: path.join(app.getPath('userData'), 'study-snapshots-v2'), encryption })
  let pending = Promise.resolve()
  const run = fn => { const next = pending.then(fn); pending = next.catch(() => {}); return next }
  async function migrate(owner, guard = () => {}) {
    if (await current.load(owner)) return
    const previous = await legacy.load(owner)
    guard()
    if (previous) await current.importSnapshot(owner, previous, guard)
  }
  const result = {}
  for (const name of ['save', 'load', 'recordReview', 'acknowledgeReview']) {
    result[name] = (...args) => run(async () => {
      // Import only when absent; older installers cannot overwrite v2 review data.
      await migrate(args[0])
      return current[name](...args)
    })
  }
  result.listOffline = () => run(async () => {
    for (const copy of await legacy.listOffline()) await migrate(copy.ownerId)
    return current.listOffline()
  })
  result.remove = (owner, guard = () => {}) => run(async () => {
    // Delete the fallback first so a later restart cannot resurrect it.
    await legacy.remove(owner, guard)
    await current.remove(owner, guard)
  })
  return result
}
module.exports = { createWindowsSnapshotStore }
