import { useEffect, useRef, useState, type FormEvent } from 'react'
import { config } from '../../lib/cognitoBrowser'
import { confirmSignupCode, normalizedVerificationEmail, resendSignupCode, signUpWithEmail } from '../../lib/cognitoSignupRecovery'

type Props = { onBack: () => void; onSignIn: (email: string) => void }
type Stage = 'create' | 'confirm' | 'complete'

/** Registration and verification use Cognito's public browser client, without a hosted-page dead end. */
export default function CognitoEmailSignUp({ onBack, onSignIn }: Props) {
  const [email, setEmail] = useState('')
  const [registeredEmail, setRegisteredEmail] = useState('')
  const [password, setPassword] = useState('')
  const [repeatPassword, setRepeatPassword] = useState('')
  const [code, setCode] = useState('')
  const [stage, setStage] = useState<Stage>('create')
  const [busy, setBusy] = useState(false)
  const [cooling, setCooling] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const pending = useRef(false)
  const active = useRef(true)

  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  useEffect(() => {
    if (!cooling) return
    const timeout = setTimeout(() => setCooling(false), 60_000)
    return () => clearTimeout(timeout)
  }, [cooling])

  async function run(action: () => Promise<void>) {
    if (pending.current) return
    pending.current = true
    setBusy(true); setError(''); setNotice('')
    try { await action() }
    catch (caught) {
      if (active.current) setError(caught instanceof Error ? caught.message : 'Please try again.')
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      if (stage === 'confirm') {
        await confirmSignupCode(config.client, registeredEmail, code)
        if (!active.current) return
        setCode('')
        setStage('complete')
        return
      }
      if (stage !== 'create') return
      const chosenPassword = password
      setPassword(''); setRepeatPassword('')
      if (chosenPassword !== repeatPassword) throw new Error('Passwords do not match. Please try again.')
      const result = await signUpWithEmail(config.client, email, chosenPassword)
      if (!active.current) return
      setRegisteredEmail(result.email)
      setStage(result.confirmed ? 'complete' : 'confirm')
    })
  }

  const confirming = stage === 'confirm'
  const complete = stage === 'complete'
  const signInEmail = registeredEmail || normalizedEmailOrEmpty(email)
  return <main className="auth-page"><section className="auth-card">
    <div className="auth-brand"><div className="auth-logo">QF</div><h1>Quiz From Notes</h1></div>
    <div className="auth-heading">
      <h2>{complete ? 'Email verified' : confirming ? 'Verify your email' : 'Create your account'}</h2>
      {confirming && <p>Enter the code sent to <strong>{registeredEmail}</strong>. If you leave, sign in with this email and password to finish verification.</p>}
      {complete && <p>Your account is ready. Sign in with your password to continue.</p>}
      {stage === 'create' && <p>You'll verify your email before signing in. Already started registration? Use Sign in to resume verification.</p>}
    </div>
    {error && <div className="auth-error" role="alert">{error}</div>}
    {notice && <p role="status">{notice}</p>}
    {!complete && <form className="auth-form" aria-busy={busy} onSubmit={submit}>
      {confirming ? <label><span>Email confirmation code</span>
        <input autoComplete="one-time-code" inputMode="numeric" required minLength={6} maxLength={8}
          pattern="[0-9]{6,8}" disabled={busy} value={code} onChange={e => setCode(e.target.value)} />
      </label> : <>
        <label><span>Email</span><input type="email" autoComplete="email" placeholder="you@example.com"
          required maxLength={254} disabled={busy} value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label><span>Password</span><input type="password" autoComplete="new-password" required minLength={8}
          maxLength={256} disabled={busy} value={password} onChange={e => setPassword(e.target.value)} /></label>
        <label><span>Confirm password</span><input type="password" autoComplete="new-password" required minLength={8}
          maxLength={256} disabled={busy} value={repeatPassword} onChange={e => setRepeatPassword(e.target.value)} /></label>
        <p>Use at least 8 characters with uppercase, lowercase, a number, and a special character or space.</p>
      </>}
      <button className="auth-submit" disabled={busy}>{busy ? 'Please wait…' : confirming ? 'Confirm my email' : 'Create account'}</button>
    </form>}
    {confirming && <div className="auth-verification-resend">
      <p>Didn't receive a code, or has it expired?</p>
      <button type="button" className="auth-secondary-button" disabled={busy || cooling}
        onClick={() => void run(async () => {
          setCooling(true)
          await resendSignupCode(config.client, registeredEmail)
          if (active.current) setNotice('A new code has been requested. Check your inbox and spam folder.')
        })}>{cooling ? 'Please wait before resending' : 'Resend confirmation code'}</button>
    </div>}
    <p className="auth-switch">
      {complete ? <button type="button" className="auth-secondary-button" onClick={() => onSignIn(registeredEmail)}>
        Continue to sign in
      </button> : <button type="button" disabled={busy} onClick={() => onSignIn(signInEmail)}>
        {confirming ? 'Already have your password? Sign in to finish verification' : 'Already registered? Sign in'}
      </button>}
    </p>
    <p className="auth-switch"><button type="button" disabled={busy} onClick={onBack}>Back to sign in options</button></p>
  </section></main>
}

function normalizedEmailOrEmpty(value: string) {
  try { return normalizedVerificationEmail(value) } catch { return '' }
}
