'use strict'
const { APP_ORIGIN } = require('./policy.cjs')

function installNativeBridge({ ipcMain, getWindow, getSession, getAccount, getReminders, getLocalAi = () => null, confirmLocalAiDownload = async () => false, confirmLocalAiRemoval = async () => false, canSignIn = () => true, openAccountWebsite }) {
  function trusted(event) {
    const contents = getWindow()?.webContents
    const frame = event.senderFrame
    if (!contents || contents.isDestroyed() || event.sender !== contents || !frame || frame !== contents.mainFrame) return false
    try { const url = new URL(frame.url); return url.origin === APP_ORIGIN && !url.username && !url.password } catch { return false }
  }
  function localAi() {
    const account = getAccount()?.current()
    if (!account?.userId || account.enrolled !== true) throw new Error('Sign in to manage Local AI on this desktop.')
    const manager = getLocalAi()
    if (!manager) throw new Error('Local AI is not available in this desktop build.')
    return manager
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
    signOut: async () => { await Promise.allSettled([getLocalAi()?.cancelDownload?.(), getLocalAi()?.cancelGeneration?.()]); getAccount()?.clear(); await getSession()?.signOut() },
    request: value => {
      const account = getAccount()
      if (!account) throw new Error('Sign in to your desktop account first.')
      return account.request(value)
    },
    reminderStatus: () => getReminders()?.status() ?? { supported: false, enabled: false },
    enableReminders: () => getReminders()?.enable(),
    disableReminders: () => getReminders()?.disable(),
    localAiStatus: () => localAi().load(),
    startLocalAiModelDownload: async () => {
      const manager = localAi()
      const status = await manager.load()
      if (status.model?.ready) return status
      return await confirmLocalAiDownload(status) ? manager.startDownload() : status
    },
    cancelLocalAiModelDownload: () => localAi().cancelDownload(),
    removeLocalAiModel: async () => {
      const manager = localAi()
      const status = await manager.load()
      if (!status.model?.ready && status.model?.state !== 'invalid') return status
      return await confirmLocalAiRemoval(status) ? manager.removeModel() : status
    },
    localAiGenerationStatus: () => localAi().generationStatus(),
    generateLocalQuiz: value => localAi().generateQuiz(value),
    cancelLocalQuiz: () => localAi().cancelGeneration(),
    openAccountWebsite: () => openAccountWebsite(),
  }
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('qfn:' + name, async (event, ...args) => {
      const expectedArguments = name === 'request' || name === 'generateLocalQuiz' ? 1 : 0
      if (!trusted(event) || args.length !== expectedArguments) throw new Error('Desktop command is not permitted.')
      const frame = event.senderFrame
      const result = await handler(...args)
      if (!trusted(event) || event.senderFrame !== frame) throw new Error('Desktop page changed.')
      return result
    })
  }
}
module.exports = { installNativeBridge }
