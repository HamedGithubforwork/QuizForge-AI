'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { APP_ORIGIN, AUTH_ORIGIN, allowedNavigation, windowOptions } = require('../src/policy.cjs')

test('keeps application routes and existing PKCE login/logout redirects in the same window', () => {
  for (const url of [APP_ORIGIN, `${APP_ORIGIN}/auth/callback?code=test&state=test`,
    `${APP_ORIGIN}/decks`, `${AUTH_ORIGIN}/oauth2/authorize?client_id=test`,
    `${AUTH_ORIGIN}/login`, `${AUTH_ORIGIN}/signup`, `${AUTH_ORIGIN}/logout`]) {
    assert.equal(allowedNavigation(url), true, url)
  }
})

test('rejects native protocols, embedded credentials, lookalike hosts and unreviewed auth pages', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hello',
    'http://quizfromnotes.com', 'https://quizfromnotes.com.evil.test',
    'https://quizfromnotes.com@evil.test', 'https://user:pass@quizfromnotes.com',
    'https://quizfromnotes.com:444', 'https://evil.test', `${AUTH_ORIGIN}/unreviewed`,
    'https://other.auth.ca-central-1.amazoncognito.com/login', 'not a url']) {
    assert.equal(allowedNavigation(url), false, url)
  }
})

test('remote renderer has no Node, preload, webview or persistent token store', () => {
  const prefs = windowOptions().webPreferences
  assert.equal(prefs.sandbox, true)
  assert.equal(prefs.contextIsolation, true)
  assert.equal(prefs.webSecurity, true)
  for (const key of ['nodeIntegration', 'nodeIntegrationInWorker', 'nodeIntegrationInSubFrames',
    'webviewTag', 'allowRunningInsecureContent', 'devTools']) assert.equal(prefs[key], false)
  assert.equal(prefs.preload, undefined)
  assert.equal(prefs.partition.startsWith('persist:'), false)
})
