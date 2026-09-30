'use strict'
const { contextBridge, ipcRenderer } = require('electron')
// Sandboxed preload: no Node APIs exposed, no generic send/invoke/listener API.
if (process.isMainFrame && location.origin === 'https://quizfromnotes.com') {
  contextBridge.exposeInMainWorld('quizFromNotesDesktop', Object.freeze({
    version: 1,
    status: () => ipcRenderer.invoke('qfn:status'),
    signIn: () => ipcRenderer.invoke('qfn:signIn'),
    signOut: () => ipcRenderer.invoke('qfn:signOut'),
    request: value => ipcRenderer.invoke('qfn:request', value),
    reminderStatus: () => ipcRenderer.invoke('qfn:reminderStatus'),
    enableReminders: () => ipcRenderer.invoke('qfn:enableReminders'),
    disableReminders: () => ipcRenderer.invoke('qfn:disableReminders'),
    openAccountWebsite: () => ipcRenderer.invoke('qfn:openAccountWebsite'),
  }))
}
