'use strict'
const { APP_ORIGIN } = require('./policy.cjs')

function installNativeBridge({ ipcMain, getWindow, getSession, getAccount, getReminders, canSignIn = () => true, openAccountWebsite }) {
  function trusted(event) {
    const contents = getWindow()?.webContents
    const frame = event.senderFrame
    if (!contents || contents.isDestroyed() || event.sender !== contents || !frame || frame !== contents.mainFrame) return false
    try { const url = new URL(frame.url); return url.origin === APP_ORIGIN && !url.username && !url.password } catch { return false }
  }
  const handlers = {
    status: async () => ({ available: !!getSession(), account: getAccount()?.current() ?? null }),
    signIn: async () => {
      const session = getSession(), account = getAccount()
      if (session?.status().signingIn || !canSignIn()) throw new Error('Finish the desktop sign-in test first.')
      if (!session || !account) throw new Error('Desktop sign-in is not available.')
      account.clear()
      const operation = session.signIn()
      const generation = session.generation()
      await operation
      try { return await account.verify() }
      catch (error) {
        if (generation === session.generation()) { account.clear(); await session.signOut().catch(() => {}) }
        throw error
      }
    },
    signOut: async () => { getAccount()?.clear(); await getSession()?.signOut() },
    request: value => {
      const account = getAccount()
      if (!account) throw new Error('Sign in to your desktop account first.')
      return account.request(value)
    },
    reminderStatus: () => getReminders()?.status() ?? { supported: false, enabled: false },
    enableReminders: () => getReminders()?.enable(),
    disableReminders: () => getReminders()?.disable(),
    openAccountWebsite: () => openAccountWebsite(),
  }
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('qfn:' + name, async (event, ...args) => {
      if (!trusted(event) || args.length !== (name === 'request' ? 1 : 0)) throw new Error('Desktop command is not permitted.')
      const frame = event.senderFrame
      const result = await handler(...args)
      if (!trusted(event) || event.senderFrame !== frame) throw new Error('Desktop page changed.')
      return result
    })
  }
}
module.exports = { installNativeBridge }
