import { useEffect, useState, type FormEvent } from 'react'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import App from './App'
import './AuthGate.css'
import { config, identityRequest, initialize, manager, session, signIn, signOut, signUp } from './lib/cognitoBrowser'
import { secureEndpoint } from './lib/authConfig'

export default function CognitoAuthGate() {
  const [account, setAccount] = useState<{ email: string; enrolled: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'enroll' | 'link'>('link')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [legacy, setLegacy] = useState<{ client: SupabaseClient; factor: string } | null>(null)
  const [confirmation, setConfirmation] = useState<{ nonce: string; mode: 'enroll' | 'link'; token?: string } | null>(null)
  const linkingAvailable = Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY)

  async function load() {
    if (await session()) setAccount(await identityRequest('/identity/session'))
    else setAccount(null)
  }
  useEffect(() => {
    let active = true
    void initialize().then(async () => {
      const current = await session()
      const next = current ? await identityRequest('/identity/session') : null
      if (active) setAccount(next)
    }).catch(() => { if (active) setError('Sign-in could not be verified. Sign out and start again.') })
      .finally(() => { if (active) setLoading(false) })
    const unloaded = () => { setAccount(null); setConfirmation(null); setLegacy(null); setPassword(''); setCode('') }
    manager.events.addUserUnloaded(unloaded)
    return () => { active = false; manager.events.removeUserUnloaded(unloaded) }
  }, [])

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : 'Please try again.') }
    finally { setBusy(false) }
  }
  async function requestConfirmation(token?: string) {
    const result = await identityRequest('/identity/challenge', { mode }, token)
    setConfirmation({ nonce: result.nonce, mode, token })
  }
  async function begin(event: FormEvent) {
    event.preventDefault()
    await run(async () => {
      if (mode === 'enroll') return requestConfirmation()
      if (!linkingAvailable) throw new Error('Existing-account linking is not configured.')
      // A separate, non-persistent client never changes the production browser session.
      const client = createClient(secureEndpoint(import.meta.env.VITE_SUPABASE_URL), import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
          storageKey: 'quizforge-link-proof' } })
      const result = await client.auth.signInWithPassword({ email: email.trim(), password })
      setPassword('')
      if (result.error || !result.data.session) throw new Error('Existing-account sign-in failed.')
      const factors = await client.auth.mfa.listFactors()
      if (factors.error) throw new Error('Could not check existing-account MFA.')
      const factor = factors.data.totp.find(item => item.status === 'verified')
      if (factor) { setLegacy({ client, factor: factor.id }); return }
      await requestConfirmation(result.data.session.access_token)
    })
  }
  async function verifyMfa(event: FormEvent) {
    event.preventDefault()
    await run(async () => {
      if (!legacy) return
      const result = await legacy.client.auth.mfa.challengeAndVerify({ factorId: legacy.factor, code })
      setCode('')
      if (result.error) throw new Error('Authenticator verification failed.')
      setLegacy(null)
      await requestConfirmation(result.data.access_token)
    })
  }
  if (loading) return <p role="status">Checking account…</p>
  const logout = <button className="sign-out-button" type="button" disabled={busy} onClick={() => void run(signOut)}>Sign out</button>
  if (account?.enrolled) return <>
    <div className="account-bar"><div className="account-bar-inner"><span>Signed in as {account.email}</span>{logout}</div></div>
    {error && <p role="alert">{error}</p>}<App />
  </>
  if (!account) return <main className="auth-page auth-page-welcome">
    <div className="auth-login-shell">
      <section className="auth-hero-panel" aria-label="Quiz From Notes overview">
        <div className="auth-wordmark">
          <span className="auth-wordmark-mark">QF</span>
          <span>{config.environment === 'staging' ? 'Quiz From Notes staging' : 'Quiz From Notes'}</span>
        </div>

        <div className="auth-hero-copy">
          <span className="auth-eyebrow">STUDY SMARTER</span>
          <h1>Turn your study material into practice that sticks.</h1>
          <p>
            Upload your notes or PDFs and build focused quizzes in seconds,
            with question types that match the way you want to study.
          </p>
        </div>

        <ul className="auth-benefit-list">
          <li><span aria-hidden="true">✓</span> Create quizzes from your own material</li>
          <li><span aria-hidden="true">✓</span> Practice multiple-choice and short-answer questions</li>
          <li><span aria-hidden="true">✓</span> Keep your account and progress protected</li>
        </ul>
      </section>

      <section className="auth-login-panel">
        <div className="auth-login-panel-inner">
          <span className="auth-login-kicker">WELCOME TO QUIZ FROM NOTES</span>
          <h2>Choose how to continue.</h2>
          <p className="auth-login-copy">
            Use your existing account or start a new one. Both paths use Cognito
            for secure email verification and authenticator-based sign-in.
          </p>

          {error && <div className="auth-error auth-login-error" role="alert">{error}</div>}

          <div className="auth-entry-actions">
            <button className="auth-entry-action auth-entry-action-primary" disabled={busy}
              onClick={() => void run(signIn)}>
              <span className="auth-entry-action-copy">
                <strong>Sign in</strong>
                <small>Continue to your existing account</small>
              </span>
              <span className="auth-cta-arrow" aria-hidden="true">→</span>
            </button>

            <button className="auth-entry-action auth-entry-action-secondary" disabled={busy}
              onClick={() => void run(signUp)}>
              <span className="auth-entry-action-copy">
                <strong>Create account</strong>
                <small>New here? Start with a fresh account</small>
              </span>
              <span className="auth-cta-arrow" aria-hidden="true">＋</span>
            </button>
          </div>

          <div className="auth-security-note">
            <span className="auth-security-dot" aria-hidden="true" />
            <span>Secure sign-in with email verification and MFA</span>
          </div>

          {error && <div className="auth-login-signout">{logout}</div>}
        </div>
      </section>
    </div>
  </main>

  return <main className="auth-page"><section className="auth-card">
    <h1>{config.environment === 'staging' ? 'Quiz From Notes staging' : 'Quiz From Notes'}</h1>
    {error && <p role="alert">{error}</p>}
    <p>Signed in as {account.email}</p>
    <h2>{config.environment === 'staging' ? 'Set up your staging account' : 'Set up your account'}</h2>
    {confirmation ? <>
      <p>{confirmation.mode === 'link' ? 'Link this Cognito account to the existing account you just verified?'
        : 'Create a separate account with empty history? You cannot attach existing history to it later.'}</p>
      <button className="auth-submit" disabled={busy} onClick={() => void run(async () => {
        await identityRequest('/identity/confirm', { mode: confirmation.mode, nonce: confirmation.nonce }, confirmation.token)
        setConfirmation(null); await load()
      })}>Confirm account setup</button>
      <button disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button>
    </> : legacy ? <form className="auth-form" aria-busy={busy} onSubmit={verifyMfa}>
      <label>Existing-account authenticator code<input autoComplete="one-time-code" inputMode="numeric" required
        pattern="[0-9]{6}" value={code} onChange={e => setCode(e.target.value)} /></label>
      <button className="auth-submit" disabled={busy}>Verify authenticator</button>
    </form> : <form className="auth-form" aria-busy={busy} onSubmit={begin}>
      <label htmlFor="account-setup">Account setup</label>
      <select id="account-setup" value={mode} disabled={busy} onChange={e => {
        setMode(e.target.value as 'enroll' | 'link'); setPassword(''); setError('')
      }}>
        <option value="link">Link my existing account</option><option value="enroll">Create an empty account</option>
      </select>
      {mode === 'link' ? <>
        <p>Sign in to your existing Quiz From Notes account to prove ownership. Email addresses alone cannot link accounts.</p>
        {!linkingAvailable && <p>Existing-account linking is currently unavailable.</p>}
        <label>Existing account email<input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label>Existing account password<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
      </> : <p>Your new account will start with empty history. Choose linking if you have existing quizzes.</p>}
      <button className="auth-submit" disabled={busy || (mode === 'link' && !linkingAvailable)}>Continue account setup</button>
    </form>}
    {logout}
  </section></main>
}
