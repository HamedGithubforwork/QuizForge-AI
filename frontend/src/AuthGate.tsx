import { lazy, Suspense } from 'react'
import { desktopBridge } from './lib/desktop'
import { authProvider } from './lib/authSession'

const Gate = lazy(() => desktopBridge() ? import('./DesktopAuthGate') : authProvider === 'cognito'
  ? import('./CognitoAuthGate') : import('./SupabaseAuthGate'))

export default function AuthGate() {
  return <Suspense fallback={<p role="status">Loading account…</p>}><Gate /></Suspense>
}
