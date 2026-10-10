'use strict'
const { APP_ORIGIN, LOCAL_RENDERER_ORIGIN } = require('./policy.cjs')
const { MAX_LOCAL_PDF_BYTES } = require('./local-document-processing.cjs')
const { MAX_SELECTED_PAGES } = require('./local-document-quiz-service.cjs')

function validLocalDocumentRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['bytes', 'filename', 'selectedPages', 'questionCount', 'difficulty', 'questionType'].includes(key)) ||
      !(value.bytes instanceof Uint8Array) || value.bytes.byteLength < 8 ||
      value.bytes.byteLength > MAX_LOCAL_PDF_BYTES ||
      (value.filename !== undefined && value.filename !== null && (typeof value.filename !== 'string' || value.filename.length > 255)) ||
      (value.selectedPages !== undefined && value.selectedPages !== null &&
        (!Array.isArray(value.selectedPages) || value.selectedPages.length < 1 ||
          value.selectedPages.length > MAX_SELECTED_PAGES ||
          value.selectedPages.some(page => !Number.isSafeInteger(page) || page < 1) ||
          new Set(value.selectedPages).size !== value.selectedPages.length)) ||
      value.questionCount !== 5 || !['easy', 'medium', 'hard'].includes(value.difficulty) ||
      value.questionType !== 'multiple_choice') return false
  return true
}

function installNativeBridge({ ipcMain, getWindow, getSession, getAccount, getReminders, getLocalAi = () => null, getSourceTextCache = () => null, confirmLocalAiDownload = async () => false, confirmLocalAiRemoval = async () => false, canSignIn = () => true, openAccountWebsite }) {
  function trusted(event) {
    const contents = getWindow()?.webContents
    const frame = event.senderFrame
    if (!contents || contents.isDestroyed() || event.sender !== contents || !frame || frame !== contents.mainFrame) return false
    try {
      const url = new URL(frame.url)
      return !url.username && !url.password &&
        (url.origin === APP_ORIGIN || (url.protocol === 'qfn:' && url.hostname === 'app' && !url.port))
    } catch { return false }
  }
  function localAi() {
    const account = getAccount()?.current()
    if (!account?.userId || account.enrolled !== true) throw new Error('Sign in to manage Local AI on this desktop.')
    const manager = getLocalAi()
    if (!manager) throw new Error('Local AI is not available in this desktop build.')
    return manager
  }
  function localAiSnapshot(manager, status) {
    const mode = manager.lastAccelerationMode?.()
    return { ...status, lastAccelerationMode:
      mode === 'cpu' || mode === 'gpu' || mode === 'unknown' ? mode : null }
  }
  function sourceTextCache() {
    const cache = getSourceTextCache()
    if (!cache) throw new Error('Desktop source-text cache is not available.')
    return cache
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
    signOut: async () => { await Promise.allSettled([getLocalAi()?.cancelDownload?.(), getLocalAi()?.cancelQuiz?.()]); getAccount()?.clear(); await getSession()?.signOut() },
    request: value => {
      const account = getAccount()
      if (!account) throw new Error('Sign in to your desktop account first.')
      return account.request(value)
    },
    loadSourcePageText: value => sourceTextCache().load(value),
    reminderStatus: () => getReminders()?.status() ?? { supported: false, enabled: false },
    enableReminders: () => getReminders()?.enable(),
    disableReminders: () => getReminders()?.disable(),
    localAiStatus: async () => {
      const manager = localAi()
      return localAiSnapshot(manager, await manager.load())
    },
    startLocalAiModelDownload: async () => {
      const manager = localAi()
      const status = await manager.load()
      if (status.model?.ready) return localAiSnapshot(manager, status)
      return localAiSnapshot(manager,
        await confirmLocalAiDownload(status) ? await manager.startDownload() : status)
    },
    cancelLocalAiModelDownload: async () => {
      const manager = localAi()
      return localAiSnapshot(manager, await manager.cancelDownload())
    },
    removeLocalAiModel: async () => {
      const manager = localAi()
      const status = await manager.load()
      if (!status.model?.ready && status.model?.state !== 'invalid') return localAiSnapshot(manager, status)
      return localAiSnapshot(manager,
        await confirmLocalAiRemoval(status) ? await manager.removeModel() : status)
    },
    localAiQuizStatus: () => localAi().quizStatus(),
    processLocalPdf: async value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).some(key => !['bytes', 'filename', 'selectedPages'].includes(key)) ||
          !(value.bytes instanceof Uint8Array) || value.bytes.byteLength < 8 ||
          value.bytes.byteLength > MAX_LOCAL_PDF_BYTES ||
          (value.filename !== undefined && value.filename !== null && typeof value.filename !== 'string') ||
          (value.selectedPages !== undefined && value.selectedPages !== null &&
            (!Array.isArray(value.selectedPages) || value.selectedPages.length < 1 ||
              value.selectedPages.length > 100 || value.selectedPages.some(page => !Number.isSafeInteger(page) || page < 1) ||
              new Set(value.selectedPages).size !== value.selectedPages.length))) {
        return { ok: false, error: 'invalid_request' }
      }
      try {
        const result = await localAi().processDocument({
          bytes: value.bytes,
          filename: value.filename ?? null,
          selectedPages: value.selectedPages ?? null,
        })
        return { ok: true, document: result }
      } catch (error) {
        const allowed = new Set(['cancelled', 'busy', 'invalid_input', 'invalid_selection', 'input_too_large', 'too_many_pages', 'text_too_large', 'processing_failed', 'runtime_unavailable'])
        return { ok: false, error: allowed.has(error?.code) ? error.code : 'processing_failed' }
      }
    },
    generateLocalAiQuiz: async value => {
      try {
        return { ok: true, quiz: await localAi().generateQuiz(value) }
      } catch (error) {
        const allowed = new Set([
          'cancelled', 'timed_out', 'busy', 'model_missing', 'invalid_model',
          'runtime_invalid', 'runtime_unavailable', 'source_too_large',
          'unsupported_quiz_mode', 'quiz_validation_failed', 'insufficient_source', 'invalid_request',
          'invalid_response', 'generation_failed',
        ])
        return { ok: false, error: allowed.has(error?.code) ? error.code : 'generation_failed' }
      }
    },
    generateLocalDocumentQuiz: async value => {
      if (!validLocalDocumentRequest(value)) return { ok: false, error: 'invalid_request' }
      const manager = localAi()
      if (typeof manager.generateDocumentQuiz !== 'function') {
        return { ok: false, error: 'runtime_unavailable' }
      }
      try {
        const result = await manager.generateDocumentQuiz(value)
        return { ok: true, ...result }
      } catch (error) {
        const allowed = new Set([
          'cancelled', 'timed_out', 'busy', 'model_missing', 'invalid_model',
          'runtime_invalid', 'runtime_unavailable', 'source_too_large',
          'document_too_large', 'insufficient_source', 'invalid_request',
          'invalid_response', 'quiz_validation_failed', 'generation_failed', 'too_many_pages',
          'processing_failed',
        ])
        return { ok: false, error: allowed.has(error?.code) ? error.code : 'generation_failed' }
      }
    },
    cancelLocalAiQuiz: () => localAi().cancelQuiz(),
    openAccountWebsite: () => openAccountWebsite(),
  }
  const argumentCounts = Object.freeze({ request: 1, loadSourcePageText: 1, processLocalPdf: 1, generateLocalAiQuiz: 1, generateLocalDocumentQuiz: 1 })
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('qfn:' + name, async (event, ...args) => {
      if (!trusted(event) || args.length !== (argumentCounts[name] ?? 0)) throw new Error('Desktop command is not permitted.')
      const frame = event.senderFrame
      const result = await handler(...args)
      if (!trusted(event) || event.senderFrame !== frame) throw new Error('Desktop page changed.')
      return result
    })
  }
}
module.exports = { installNativeBridge }
