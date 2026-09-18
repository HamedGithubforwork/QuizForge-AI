import { lazy, Suspense } from 'react'
import { authProvider } from './lib/authSession'

const Gate = lazy(() => authProvider === 'cognito'
  ? import('./CognitoAuthGate') : import('./SupabaseAuthGate'))

export default function AuthGate() {
  return <Suspense fallback={<p role="status">Loading account…</p>}><Gate /></Suspense>
}
