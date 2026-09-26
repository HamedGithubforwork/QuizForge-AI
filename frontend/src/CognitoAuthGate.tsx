import { useEffect, useState, type FormEvent } from 'react'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import App from './App'
import SettingsPage, { type SettingsSection } from './components/account/SettingsPage'
import './AuthGate.css'
import { config, identityRequest, initialize, manager, session, signIn, signOut, signUp } from './lib/cognitoBrowser'
import { authenticatorSetupUri, beginMigratedActivation, finishMigratedActivation, type MigratedActivationSetup } from './lib/cognitoActivation'
import { beginPhoneVerification, beginTotpEnrollment, disableMfa, getMfaSecurityStatus, setMfaPreference, totpSetupUri, updateMfaMethods, verifyPhoneNumber, verifyTotpEnrollment, type MfaSecurityStatus } from './lib/cognitoMfa'
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
  const [activationMode, setActivationMode] = useState(false)
  const [activationSetup, setActivationSetup] = useState<MigratedActivationSetup | null>(null)
  const [activationComplete, setActivationComplete] = useState(false)
  const [pathname, setPathname] = useState(() => window.location.pathname)
  const [securityStatus, setSecurityStatus] = useState<MfaSecurityStatus | null>(null)
  const [phone, setPhone] = useState('')
  const [phoneCode, setPhoneCode] = useState('')
  const [phonePending, setPhonePending] = useState(false)
  const [totpSecret, setTotpSecret] = useState('')
  const [totpCode, setTotpCode] = useState('')
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
    const unloaded = () => {
      setAccount(null)
      setConfirmation(null)
      setLegacy(null)
      setActivationMode(false)
      setActivationSetup(null)
      setActivationComplete(false)
      setSecurityStatus(null)
      setPhone('')
      setPhoneCode('')
      setPhonePending(false)
      setTotpSecret('')
      setTotpCode('')
      setPassword('')
      setCode('')
      if (window.location.pathname.startsWith('/settings')) {
        window.history.replaceState({}, '', '/')
        setPathname('/')
      }
    }
    manager.events.addUserUnloaded(unloaded)
    return () => { active = false; manager.events.removeUserUnloaded(unloaded) }
  }, [])

  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (!account?.enrolled || pathname !== '/settings/security') return
    let active = true
    void session().then(async (current) => {
      if (!current) throw new Error('Sign in again to manage security settings.')
      const status = await getMfaSecurityStatus(current.accessToken)
      if (!active) return
      setSecurityStatus(status)
      setPhone(status.phoneNumber)
    }).catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : 'Could not load security settings.')
    })
    return () => { active = false }
  }, [account?.enrolled, pathname])

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

  async function beginActivation(event: FormEvent) {
    event.preventDefault()
    await run(async () => {
      const result = await beginMigratedActivation(config.client, email, password)
      setPassword('')
      if (result.kind === 'already_ready') {
        setActivationSetup(null)
        setActivationComplete(true)
        return
      }
      setActivationSetup(result)
      setCode('')
    })
  }

  async function finishActivation(event: FormEvent) {
    event.preventDefault()
    await run(async () => {
      if (!activationSetup) return
      await finishMigratedActivation(config.client, activationSetup, code)
      setCode('')
      setActivationSetup(null)
      setActivationComplete(true)
    })
  }

  function leaveActivation() {
    setActivationMode(false)
    setActivationSetup(null)
    setActivationComplete(false)
    setPassword('')
    setCode('')
    setError('')
  }

  async function loadSecurityStatus() {
    const current = await session()
    if (!current) throw new Error('Sign in again to manage security settings.')
    const status = await getMfaSecurityStatus(current.accessToken)
    setSecurityStatus(status)
    setPhone(status.phoneNumber)
    return { current, status }
  }

  function navigate(path: string) {
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path)
    }
    setPathname(path)
    window.scrollTo({ top: 0, behavior: 'auto' })
  }

  function openSettings(section: SettingsSection) {
    setPhonePending(false)
    setPhoneCode('')
    setTotpSecret('')
    setTotpCode('')
    setError('')
    navigate(`/settings/${section}`)
  }

  function leaveSettings() {
    setPhonePending(false)
    setPhoneCode('')
    setTotpSecret('')
    setTotpCode('')
    setError('')
    navigate('/')
  }

  async function startTotpEnrollment() {
    await run(async () => {
      const current = await session()
      if (!current) throw new Error('Sign in again to manage security settings.')
      const secret = await beginTotpEnrollment(current.accessToken)
      setTotpSecret(secret)
      setTotpCode('')
    })
  }

  async function finishTotpEnrollment(event: FormEvent) {
    event.preventDefault()
    await run(async () => {
      const current = await session()
      if (!current) throw new Error('Sign in again to manage security settings.')
      await verifyTotpEnrollment(current.accessToken, totpCode)
      const status = await getMfaSecurityStatus(current.accessToken)
      await updateMfaMethods(current.accessToken, {
        smsEnabled: status.smsEnabled,
        totpEnabled: true,
        preferred: 'totp',
      })
      setTotpSecret('')
      setTotpCode('')
      await loadSecurityStatus()
    })
  }

  async function disableTwoFactor() {
    await run(async () => {
      const current = await session()
      if (!current) throw new Error('Sign in again to manage security settings.')
      await disableMfa(current.accessToken)
      setPhonePending(false)
      setPhoneCode('')
      setTotpSecret('')
      setTotpCode('')
      await loadSecurityStatus()
    })
  }

  async function startPhoneVerification(event: FormEvent) {
    event.preventDefault()
    await run(async () => {
      const current = await session()
      if (!current) throw new Error('Sign in again to manage security settings.')
      const normalized = await beginPhoneVerification(current.accessToken, phone)
      setPhone(normalized)
      setPhoneCode('')
      setPhonePending(true)
    })
  }

  async function finishPhoneVerification(event: FormEvent) {
    event.preventDefault()
    await run(async () => {
      const current = await session()
      if (!current) throw new Error('Sign in again to manage security settings.')
      await verifyPhoneNumber(current.accessToken, phoneCode)
      const status = await getMfaSecurityStatus(current.accessToken)
      await updateMfaMethods(current.accessToken, {
        smsEnabled: true,
        totpEnabled: status.totpEnabled,
        preferred: 'sms',
      })
      setPhoneCode('')
      setPhonePending(false)
      await loadSecurityStatus()
    })
  }

  async function preferMfa(method: 'sms' | 'totp') {
    await run(async () => {
      const { current, status } = await loadSecurityStatus()
      if (method === 'sms' && (!status.phoneVerified || !status.phoneNumber)) {
        throw new Error('Verify a phone number before choosing text-message MFA.')
      }
      if (method === 'totp' && !status.totpEnabled) {
        throw new Error('Authenticator MFA is not configured for this account.')
      }
      await setMfaPreference(current.accessToken, method, status)
      await loadSecurityStatus()
    })
  }
  if (loading) return <p role="status">Checking account…</p>
  const logout = <button className="sign-out-button" type="button" disabled={busy} onClick={() => void run(signOut)}>Sign out</button>
  const settingsSection: SettingsSection = pathname === '/settings/security' ? 'security' : 'account'
  const inSettings = pathname === '/settings' || pathname.startsWith('/settings/')

  if (account?.enrolled && inSettings) return <SettingsPage
    email={account.email}
    section={settingsSection}
    busy={busy}
    error={error}
    smsMfaEnabled={config.smsMfaEnabled}
    securityStatus={securityStatus}
    phone={phone}
    phoneCode={phoneCode}
    phonePending={phonePending}
    totpSecret={totpSecret}
    totpCode={totpCode}
    onSectionChange={openSettings}
    onBack={leaveSettings}
    onSignOut={() => void run(async () => { await signOut(); leaveSettings() })}
    onPhoneChange={setPhone}
    onPhoneCodeChange={setPhoneCode}
    onTotpCodeChange={setTotpCode}
    onStartTotp={() => void startTotpEnrollment()}
    onFinishTotp={finishTotpEnrollment}
    onCancelTotp={() => { setTotpSecret(''); setTotpCode('') }}
    onStartPhone={startPhoneVerification}
    onFinishPhone={finishPhoneVerification}
    onCancelPhone={() => { setPhonePending(false); setPhoneCode('') }}
    onPreferMfa={(method) => void preferMfa(method)}
    onDisableMfa={() => void disableTwoFactor()}
    totpUri={totpSecret ? totpSetupUri(totpSecret, account.email) : ''}
  />

  if (account?.enrolled) return <>
    <div className="account-bar"><div className="account-bar-inner">
      <span>Signed in as {account.email}</span>
      <div className="account-bar-actions">
        <button className="account-security-button" type="button" disabled={busy}
          onClick={() => openSettings('security')}>Settings</button>
        {logout}
      </div>
    </div></div>
    {error && <p role="alert">{error}</p>}
    <App />
  </>
  if (!account && activationMode) return <main className="auth-page">
    <section className="auth-card">
      <div className="auth-brand">
        <div className="auth-logo">QF</div>
        <div>
          <h1>Quiz From Notes</h1>
          <p>Finish the one-time security setup for your migrated account.</p>
        </div>
      </div>

      {error && <div className="auth-error" role="alert">{error}</div>}

      {activationComplete ? <>
        <div className="auth-heading">
          <h2>Security setup complete</h2>
          <p>Your existing password is ready in Cognito. Sign in normally and use your new authenticator code when prompted.</p>
        </div>
        <button className="auth-submit" disabled={busy} onClick={() => void run(signIn)}>Continue to Sign in</button>
      </> : activationSetup ? <>
        <div className="auth-heading">
          <h2>Set up your authenticator</h2>
          <p>Add this account to Google Authenticator, Microsoft Authenticator, 1Password, or another TOTP app, then enter the 6-digit code.</p>
        </div>

        <div className="auth-message">
          <strong>Setup key</strong>
          <code style={{ display: 'block', marginTop: '0.5rem', overflowWrap: 'anywhere' }}>{activationSetup.secret}</code>
        </div>

        <p className="auth-switch">
          <a href={authenticatorSetupUri(activationSetup)}>Open in an authenticator app</a>
        </p>

        <form className="auth-form" aria-busy={busy} onSubmit={finishActivation}>
          <label>
            <span>6-digit authenticator code</span>
            <input autoComplete="one-time-code" inputMode="numeric" required pattern="[0-9]{6}"
              value={code} disabled={busy} onChange={e => setCode(e.target.value)} />
          </label>
          <button className="auth-submit" disabled={busy}>
            {busy ? 'Verifying…' : 'Finish Security Setup'}
          </button>
        </form>
      </> : <>
        <div className="auth-heading">
          <h2>Activate your migrated account</h2>
          <p>Use the same email and password you used before the move to Cognito. Your password is sent directly to Amazon Cognito and is not stored by Quiz From Notes.</p>
        </div>

        <form className="auth-form" aria-busy={busy} onSubmit={beginActivation}>
          <label>
            <span>Existing account email</span>
            <input type="email" autoComplete="username" required value={email} disabled={busy}
              onChange={e => setEmail(e.target.value)} />
          </label>
          <label>
            <span>Existing password</span>
            <input type="password" autoComplete="current-password" required value={password} disabled={busy}
              onChange={e => setPassword(e.target.value)} />
          </label>
          <button className="auth-submit" disabled={busy}>
            {busy ? 'Checking account…' : 'Continue Security Setup'}
          </button>
        </form>
      </>}

      <p className="auth-switch">
        <button type="button" disabled={busy} onClick={leaveActivation}>Back to sign in</button>
      </p>
    </section>
  </main>

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
            for secure email verification, with optional two-factor authentication.
          </p>

          {error && <div className="auth-error auth-login-error" role="alert">{error}</div>}

          <div className="auth-entry-actions">
            <button className="auth-entry-action auth-entry-action-primary" aria-label="Sign in" disabled={busy}
              onClick={() => void run(signIn)}>
              <span className="auth-entry-action-copy">
                <strong>Sign in</strong>
                <small>Continue to your existing account</small>
              </span>
              <span className="auth-cta-arrow" aria-hidden="true">→</span>
            </button>

            <button className="auth-entry-action auth-entry-action-secondary" aria-label="Create account" disabled={busy}
              onClick={() => void run(signUp)}>
              <span className="auth-entry-action-copy">
                <strong>Create account</strong>
                <small>New here? Start with a fresh account</small>
              </span>
              <span className="auth-cta-arrow" aria-hidden="true">＋</span>
            </button>
          </div>

          <p className="auth-switch">
            Migrated from the old Quiz From Notes login?
            {' '}
            <button type="button" disabled={busy} onClick={() => {
              setActivationMode(true)
              setActivationSetup(null)
              setActivationComplete(false)
              setError('')
            }}>
              Finish first-time setup
            </button>
          </p>

          <div className="auth-security-note">
            <span className="auth-security-dot" aria-hidden="true" />
            <span>Email verification is required; two-factor authentication is optional</span>
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
