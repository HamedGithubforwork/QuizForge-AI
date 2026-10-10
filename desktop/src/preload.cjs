'use strict'
const { contextBridge, ipcRenderer } = require('electron')
// Sandboxed preload: no Node APIs exposed, no generic send/invoke/listener API.
const trustedRenderer = location.origin === 'https://quizfromnotes.com' ||
  (location.protocol === 'qfn:' && location.hostname === 'app' && !location.port)
if (process.isMainFrame && trustedRenderer) {
  contextBridge.exposeInMainWorld('quizFromNotesDesktop', Object.freeze({
    version: 1,
    status: () => ipcRenderer.invoke('qfn:status'),
    signIn: () => ipcRenderer.invoke('qfn:signIn'),
    signOut: () => ipcRenderer.invoke('qfn:signOut'),
    request: value => ipcRenderer.invoke('qfn:request', value),
    loadSourcePageText: value => ipcRenderer.invoke('qfn:loadSourcePageText', value),
    reminderStatus: () => ipcRenderer.invoke('qfn:reminderStatus'),
    enableReminders: () => ipcRenderer.invoke('qfn:enableReminders'),
    disableReminders: () => ipcRenderer.invoke('qfn:disableReminders'),
    localAiStatus: () => ipcRenderer.invoke('qfn:localAiStatus'),
    startLocalAiModelDownload: () => ipcRenderer.invoke('qfn:startLocalAiModelDownload'),
    cancelLocalAiModelDownload: () => ipcRenderer.invoke('qfn:cancelLocalAiModelDownload'),
    removeLocalAiModel: () => ipcRenderer.invoke('qfn:removeLocalAiModel'),
    localAiQuizStatus: () => ipcRenderer.invoke('qfn:localAiQuizStatus'),
    processLocalPdf: value => ipcRenderer.invoke('qfn:processLocalPdf', value),
    generateLocalAiQuiz: value => ipcRenderer.invoke('qfn:generateLocalAiQuiz', value),
    generateLocalDocumentQuiz: value => ipcRenderer.invoke('qfn:generateLocalDocumentQuiz', value),
    cancelLocalAiQuiz: () => ipcRenderer.invoke('qfn:cancelLocalAiQuiz'),
    openAccountWebsite: () => ipcRenderer.invoke('qfn:openAccountWebsite'),
  }))
}
