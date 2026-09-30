'use strict'

const APP_ORIGIN = 'https://quizfromnotes.com'
// Public hosted-login origin used by the production frontend, not a credential.
const AUTH_ORIGIN = 'https://quizforge-399311815467.auth.ca-central-1.amazoncognito.com'
const AUTH_PATHS = new Set([
  '/oauth2/authorize', '/login', '/signup', '/confirmUser', '/forgotPassword',
  '/confirmforgotPassword', '/logout', '/mfa', '/mfa/register', '/mfa/verify',
])

function allowedNavigation(value) {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.protocol !== 'https:') return false
    if (url.origin === APP_ORIGIN) return true
    return url.origin === AUTH_ORIGIN && AUTH_PATHS.has(url.pathname)
  } catch {
    return false
  }
}

function windowOptions() {
  return {
    width: 1280, height: 850, minWidth: 800, minHeight: 600,
    title: 'Quiz From Notes Preview', show: false,
    webPreferences: {
      partition: 'quiz-from-notes-preview', // No persist: prefix; no auth on disk.
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
    },
  }
}

module.exports = { APP_ORIGIN, AUTH_ORIGIN, allowedNavigation, windowOptions }
