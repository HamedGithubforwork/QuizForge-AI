import { useEffect, useState, useRef } from 'react'
import App from './App'
import DecksPage from './components/decks'
import ProgressPage from './components/progress/ProgressPage'
import StudyNotificationsSettings from './components/account/StudyNotificationsSettings'
import LocalAiSettings from './components/account/LocalAiSettings'
import { desktopBridge, desktopLocalAiBridge, type DesktopAccount } from './lib/desktop'
import './AuthGate.css'

const bridge = desktopBridge()!
export default function DesktopAuthGate() {
  const authRevision = useRef(0)
  const [account, setAccount] = useState<DesktopAccount | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pathname, setPathname] = useState(window.location.pathname)
  useEffect(() => {
    let active = true
    const check = () => {
      const revision = authRevision.current
      void bridge.status().then(value => {
      if (active && revision === authRevision.current) { setAccount(value.account); setLoading(false) }
    }).catch(() => { if (active && revision === authRevision.current) { setAccount(null); setLoading(false); setError('Desktop account is unavailable.') } })
    }
    check()
    const timer = setInterval(check, 5000)
    const pop = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', pop)
    return () => { active = false; clearInterval(timer); window.removeEventListener('popstate', pop) }
  }, [])
  function navigate(path: string) {
    window.history.pushState({}, '', path); setPathname(path); window.scrollTo(0, 0)
  }
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : 'Please try again.') }
    finally { setBusy(false) }
  }
  async function signOut() {
    authRevision.current++
    setAccount(null)
    navigate('/')
    await bridge.signOut()
  }
  if (loading) return <p role="status">Checking desktop account…</p>
  if (!account) return <main className="auth-page auth-page-welcome auth-page-desktop-welcome"><section className="auth-login-shell">
    <div className="auth-hero-panel">
      <div className="auth-wordmark"><span className="auth-wordmark-mark" aria-hidden="true">QF</span>Quiz From Notes</div>
      <div className="auth-hero-copy">
        <span className="auth-eyebrow">YOUR STUDY WORKSPACE</span>
        <h1>Study smarter with your own notes.</h1>
        <p>Turn class materials into quizzes, save what you’ve learned, and pick up where you left off.</p>
      </div>
      <ul className="auth-benefit-list">
        <li><span aria-hidden="true">✓</span> Build quizzes from your notes</li>
        <li><span aria-hidden="true">✓</span> Keep decks and progress together</li>
      </ul>
    </div>
    <div className="auth-login-panel"><div className="auth-login-panel-inner">
      <span className="auth-login-kicker">WELCOME BACK</span>
      <h2>Sign in to the desktop app</h2>
      <p className="auth-login-copy">Sign in securely in your browser, then come back here.</p>
      {error && <p className="auth-error auth-login-error" role="alert">{error}</p>}
      <div className="auth-entry-actions">
        <button aria-label={busy ? 'Waiting for browser sign-in…' : 'Sign in with browser'} className="auth-entry-action auth-entry-action-primary" disabled={busy} onClick={() => void run(async () => {
          const revision = ++authRevision.current
          const next = await bridge.signIn()
          if (revision === authRevision.current) setAccount(next)
        })}>
          <span className="auth-entry-action-copy">
            <strong>{busy ? 'Waiting for browser sign-in…' : 'Sign in with browser'}</strong>
            <small>Securely connect your account</small>
          </span>
          {!busy && <span className="auth-cta-arrow" aria-hidden="true">→</span>}
        </button>
        <button aria-label="Open account setup in browser" className="auth-entry-action auth-entry-action-secondary" disabled={busy} onClick={() => void run(() => bridge.openAccountWebsite())}>
          <span className="auth-entry-action-copy">
            <strong>Open account setup in browser</strong>
            <small>Create an account or finish first-time setup</small>
          </span>
          <span className="auth-cta-arrow" aria-hidden="true">↗</span>
        </button>
      </div>
      {busy && <div className="auth-login-signout"><button className="sign-out-button" onClick={() => void bridge.signOut().catch(() => {})}>Cancel sign-in</button></div>}
      <div className="auth-security-note"><span className="auth-security-dot" aria-hidden="true" />Your saved decks and study progress stay with your account.</div>
    </div></div>
  </section></main>
  if (!account.enrolled) return <main className="auth-page"><section className="auth-card">
    <h1>Finish account setup</h1><p>Signed in as {account.email}. Complete account setup in your browser, then sign in here again.</p>
    {error && <p role="alert">{error}</p>}
    <button onClick={() => void run(() => bridge.openAccountWebsite())}>Open account setup</button>
    <button onClick={() => void run(signOut)}>Sign out</button>
  </section></main>
  const localAiAvailable = desktopLocalAiBridge(bridge) !== undefined
  return <div key={account.userId}>
    <div className="account-bar"><div className="account-bar-inner">
      <span className="account-bar-email">Signed in as {account.email}</span>
      <nav className="account-bar-actions" aria-label="Account navigation">
        {([
          ['/', 'Quiz'],
          ['/decks', 'Decks'],
          ['/progress', 'Progress'],
          ['/settings/notifications', 'Reminders'],
          ...(localAiAvailable ? [['/settings/local-ai', 'Local AI'] as const] : []),
        ] as const).map(([path, label]) =>
          <button key={path} className="account-nav-button" aria-current={pathname === path ? 'page' : undefined}
            onClick={() => navigate(path)}>{label}</button>)}
        <button disabled={busy} onClick={() => void run(() => bridge.openAccountWebsite())}>Account security</button>
        <button disabled={busy} onClick={() => void run(signOut)}>Sign out</button>
      </nav>
    </div></div>
    {error && <p role="alert">{error}</p>}
    {pathname.startsWith('/decks') ? <DecksPage pathname={pathname} onNavigate={navigate} />
      : pathname === '/progress' ? <ProgressPage onNavigate={navigate} />
      : pathname === '/settings/local-ai' ? <main className="settings-page"><LocalAiSettings /></main>
      : pathname.startsWith('/settings') ? <main className="settings-page"><StudyNotificationsSettings /></main> : <App />}
  </div>
}
