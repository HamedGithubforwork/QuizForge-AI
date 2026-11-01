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
