// Map native IPC errors to safe, actionable UI text. Never echo raw
// provider URLs, tokens, or Electron stack/IPC implementation details.
export function desktopSignInErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/cancelled or expired|Invalid or expired native sign-in response/i.test(message)) {
    return 'This sign-in attempt expired or was cancelled. Click Continue with Google to try again; you do not need to restart the app.'
  }
  if (/already in progress|Sign-in is already open/i.test(message)) {
    return 'Another sign-in attempt is still open. Cancel that attempt, then try again.'
  }
  if (/could not be verified|Desktop account access is not available|session changed/i.test(message)) {
    return 'Sign-in returned, but the desktop app could not verify your session. Try signing in again.'
  }
  if (/desktop sign-in test first/i.test(message)) {
    return 'Finish or cancel the desktop sign-in test under Help before signing in.'
  }
  return 'Desktop sign-in could not finish. Try again, and allow your browser to open Quiz From Notes Preview.'
}
