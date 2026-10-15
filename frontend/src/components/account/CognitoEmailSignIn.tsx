import { useEffect, useRef, useState, type FormEvent } from 'react'
import { config, passwordSession, resetPassword } from '../../lib/cognitoBrowser'
import { confirmSignupCode, resendSignupCode } from '../../lib/cognitoSignupRecovery'
import type { PasswordStep } from '../../lib/cognitoPasswordSession'

type Props = { initialEmail?: string; onComplete: () => Promise<void>; onBack: () => void; onActivation: () => void; onSignUp: () => void }

/** Email confirmation is a step of sign-in, never a separate recovery destination. */
export default function CognitoEmailSignIn({ initialEmail = '', onComplete, onBack, onActivation, onSignUp }: Props) {
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<PasswordStep | null>(null)
  const [method, setMethod] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [cooling, setCooling] = useState(false)
  const active = useRef(true)
  const pending = useRef(false)

  useEffect(() => {
    active.current = true
    return () => { active.current = false; passwordSession.cancel() }
  }, [])
  useEffect(() => {
    if (!cooling) return
    const timer = setTimeout(() => setCooling(false), 60_000)
    return () => clearTimeout(timer)
  }, [cooling])

  async function run(action: () => Promise<void>) {
    if (pending.current) return
    pending.current = true
    setBusy(true); setError('')
    try { await action() }
    catch (caught) {
      if (active.current) setError(caught instanceof Error ? caught.message : 'Sign-in could not be completed.')
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
    }
  }
  async function advance(next: PasswordStep) {
    if (!active.current) return
    setCode(''); setNotice('')
    if (next.kind === 'ready') {
      try { await onComplete() }
      catch (caught) { await passwordSession.signOut().catch(() => undefined); throw caught }
      return
    }
    if (next.kind === 'select-mfa') setMethod(next.methods[0])
    setStep(next)
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      if (step?.kind === 'confirm-email') {
        await confirmSignupCode(config.client, step.email, code)
        if (!active.current) return
        setStep(null); setCode(''); setPassword('')
        setNotice('Email confirmed. Enter your password to finish signing in.')
      } else if (step?.kind === 'mfa' || step?.kind === 'select-mfa') {
        const answer = step.kind === 'mfa' ? code : method
        setCode('')
        await advance(await passwordSession.respond(step, answer))
      } else {
        const enteredPassword = password
        setPassword('')
        await advance(await passwordSession.begin(email, enteredPassword))
      }
    })
  }
  function restart() {
    passwordSession.cancel()
    setStep(null); setPassword(''); setCode(''); setError(''); setNotice('')
  }
  const confirming = step?.kind === 'confirm-email'
  const mfa = step?.kind === 'mfa'
  const choosing = step?.kind === 'select-mfa'
  return <main className="auth-page"><section className="auth-card">
    <div className="auth-brand"><div className="auth-logo">QF</div><h1>Quiz From Notes</h1></div>
    <div className="auth-heading">
      <h2>{confirming ? 'Verify your email to continue' : mfa ? 'Verify your sign-in' : choosing ? 'Choose a verification method' : 'Sign in with email'}</h2>
      {confirming && <p>Enter the code sent to <strong>{step.email}</strong>. You can use your original signup code or request a new one.</p>}
      {mfa && <p>{step.challenge === 'SOFTWARE_TOKEN_MFA' ? 'Enter the code from your authenticator app.'
        : step.challenge === 'SMS_MFA' ? 'Enter the code sent to your phone.' : 'Enter the sign-in code sent to your email.'}</p>}
    </div>
    {error && <div className="auth-error" role="alert">{error}</div>}
    {notice && <p role="status">{notice}</p>}
    <form className="auth-form" aria-busy={busy} onSubmit={submit}>
      {confirming || mfa ? <label>
        <span>{confirming ? 'Email confirmation code' : 'Sign-in verification code'}</span>
        <input autoComplete="one-time-code" inputMode="numeric" required minLength={6} maxLength={8}
          pattern="[0-9]{6,8}" value={code} disabled={busy} onChange={e => setCode(e.target.value)} />
      </label> : choosing ? <label>
        <span>Verification method</span>
        <select value={method} disabled={busy} onChange={e => setMethod(e.target.value)}>
          {step.methods.map(value => <option key={value} value={value}>
            {value === 'SOFTWARE_TOKEN_MFA' ? 'Authenticator app' : 'Text message'}
          </option>)}
        </select>
      </label> : <>
        <label><span>Email</span><input type="email" autoComplete="username" required maxLength={254}
          placeholder="you@example.com" value={email} disabled={busy} onChange={e => setEmail(e.target.value)} /></label>
        <label><span>Password</span><input type="password" autoComplete="current-password" required maxLength={256}
          value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></label>
      </>}
      <button className="auth-submit" disabled={busy}>
        {busy ? 'Please wait…' : confirming ? 'Confirm my email' : mfa ? 'Verify and sign in' : choosing ? 'Continue to verification' : 'Sign in'}
      </button>
    </form>
    {confirming && <div className="auth-verification-resend">
      <p>Didn't receive a code, or has it expired?</p>
      <button type="button" className="auth-secondary-button" disabled={busy || cooling}
        onClick={() => void run(async () => {
          setCooling(true)
          await resendSignupCode(config.client, step.email)
          if (active.current) setNotice('A new code has been requested. Check your inbox and spam folder.')
        })}>{cooling ? 'Please wait before resending' : 'Resend confirmation code'}</button>
    </div>}
    <p className="auth-switch">
      {step ? <button type="button" disabled={busy} onClick={restart}>Back to email sign in</button>
        : <button type="button" disabled={busy} onClick={() => void run(resetPassword)}>Forgot your password?</button>}
    </p>
    {!step && <p className="auth-switch">New to Quiz From Notes?{' '}
      <button type="button" disabled={busy} onClick={onSignUp}>Create an account</button>
    </p>}
    {error.includes('first-time security setup') && <p className="auth-switch">
      <button type="button" disabled={busy} onClick={onActivation}>Finish first-time setup</button>
    </p>}
    <p className="auth-switch"><button type="button" disabled={busy} onClick={onBack}>Back to sign in options</button></p>
  </section></main>
}
