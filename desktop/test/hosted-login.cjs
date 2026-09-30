'use strict'
// Signed-out acceptance only: no account, password, token exchange or model call.
const assert = require('node:assert/strict')
const { app, BrowserWindow, session } = require('electron')
const { APP_ORIGIN, AUTH_ORIGIN, windowOptions } = require('../src/policy.cjs')
const { guardContents } = require('../src/guards.cjs')

app.enableSandbox()
let stage = 'starting'
const timeout = setTimeout(() => {
  console.error(`Hosted sign-in acceptance timed out at ${stage}`)
  app.exit(1)
}, 60000)

async function waitFor(check, label) {
  stage = label
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Hosted sign-in acceptance failed at ${label}`)
}

app.whenReady().then(async () => {
  const options = windowOptions()
  options.webPreferences.partition = 'qfn-hosted-login-acceptance'
  const browserSession = session.fromPartition(options.webPreferences.partition)
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.on('will-download', event => event.preventDefault())
  const window = new BrowserWindow(options)
  guardContents(window.webContents)
  let pkceVerified = false
  window.webContents.on('will-navigate', event => {
    const url = new URL(event.url)
    if (url.origin === AUTH_ORIGIN && url.pathname === '/oauth2/authorize') {
      const params = url.searchParams
      assert.equal(params.get('response_type'), 'code')
      assert.equal(params.get('redirect_uri'), APP_ORIGIN + '/auth/callback')
      assert.equal(params.get('code_challenge_method'), 'S256')
      assert.match(params.get('code_challenge') || '', /^[A-Za-z0-9_-]{43}$/)
      assert.ok(params.get('state'))
      assert.ok(params.get('nonce'))
      assert.equal(params.has('client_secret'), false)
      pkceVerified = true
    }
  })
  stage = 'loading application'
  await window.loadURL(APP_ORIGIN)
  await waitFor(() => window.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === 'Sign in')
  `), 'signed-out application')
  await window.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Sign in').click()
  `)
  await waitFor(async () => {
    const url = new URL(window.webContents.getURL())
    if (url.origin !== AUTH_ORIGIN || url.pathname !== '/login' || window.webContents.isLoading()) return false
    return window.webContents.executeJavaScript(`
      Boolean(document.querySelector('input[type="password"]')) &&
      Boolean(document.querySelector('input[name="username"], input[type="email"]')) &&
      typeof require === 'undefined' && typeof process === 'undefined'
    `)
  }, 'sandboxed Cognito login form')
  assert.equal(pkceVerified, true)
  await browserSession.clearStorageData()
  window.destroy()
  clearTimeout(timeout)
  console.log('Live signed-out desktop sign-in passed: S256 PKCE and expected Cognito form; no credentials entered.')
  app.exit(0)
}).catch(() => {
  // Do not log provider URLs, query strings, stack traces or page content.
  console.error(`Hosted sign-in acceptance failed at ${stage}`)
  clearTimeout(timeout)
  app.exit(1)
})
