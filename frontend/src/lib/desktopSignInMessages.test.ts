import test from 'node:test'
import assert from 'node:assert/strict'
import { desktopSignInErrorMessage } from './desktopSignInMessages.ts'

test('expired Google sign-in is actionable without restarting the app', () => {
  assert.match(desktopSignInErrorMessage(new Error(
    "Error invoking remote method 'qfn:signIn': Error: Native sign-in was cancelled or expired. Please start again."
  )), /do not need to restart the app/)
  assert.match(desktopSignInErrorMessage(new Error('Sign-in is already open.')), /Cancel that attempt/)
})

test('never echo sensitive or internal native IPC errors to the login screen', () => {
  const text = desktopSignInErrorMessage(new Error(
    'token=secret /Users/private/file error invoking qfn:signIn'
  ))
  assert.doesNotMatch(text, /token=|\/Users\/|qfn:signIn/)
  assert.match(text, /Try again/)
})

test('missing Windows callback registration has specific safe repair guidance', () => {
  const message = desktopSignInErrorMessage(new Error(
    "Error invoking remote method 'qfn:signIn': Error: Desktop sign-in callback is not registered to this installation. Repair or reinstall Quiz From Notes Preview."
  ))
  assert.match(message, /Windows is not sending sign-in links back/)
  assert.match(message, /repair or reinstall the latest preview/)
  assert.doesNotMatch(message, /qfn:signIn|token|client_id|state=/)
})
