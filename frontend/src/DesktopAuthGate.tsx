import { useEffect, useState, useRef } from 'react'
import App from './App'
import DecksPage from './components/decks/DecksPage'
import ProgressPage from './components/progress/ProgressPage'
import StudyNotificationsSettings from './components/account/StudyNotificationsSettings'
import { desktopBridge, type DesktopAccount } from './lib/desktop'
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
  if (!account) return <main className="auth-page"><section className="auth-card">
    <h1>Quiz From Notes</h1>
    <h2>Sign in to the desktop app</h2>
    <p>Your browser will open for secure sign-in. Return here to use your saved decks and study progress.</p>
    {error && <p role="alert">{error}</p>}
    <button className="auth-submit" disabled={busy} onClick={() => void run(async () => {
      const revision = ++authRevision.current
      const next = await bridge.signIn()
      if (revision === authRevision.current) setAccount(next)
    })}>{busy ? 'Waiting for browser sign-in…' : 'Sign in with browser'}</button>
    {busy && <button onClick={() => void bridge.signOut().catch(() => {})}>Cancel sign-in</button>}
    <p>New account or first-time setup?</p>
    <button disabled={busy} onClick={() => void run(() => bridge.openAccountWebsite())}>Open account setup in browser</button>
  </section></main>
  if (!account.enrolled) return <main className="auth-page"><section className="auth-card">
    <h1>Finish account setup</h1><p>Signed in as {account.email}. Complete account setup in your browser, then sign in here again.</p>
    {error && <p role="alert">{error}</p>}
    <button onClick={() => void run(() => bridge.openAccountWebsite())}>Open account setup</button>
    <button onClick={() => void run(signOut)}>Sign out</button>
  </section></main>
  return <div key={account.userId}>
    <div className="account-bar"><div className="account-bar-inner">
      <span className="account-bar-email">Signed in as {account.email}</span>
      <nav className="account-bar-actions" aria-label="Account navigation">
        {([['/', 'Quiz'], ['/decks', 'Decks'], ['/progress', 'Progress'], ['/settings/notifications', 'Reminders']] as const).map(([path, label]) =>
          <button key={path} className="account-nav-button" aria-current={pathname === path ? 'page' : undefined}
            onClick={() => navigate(path)}>{label}</button>)}
        <button disabled={busy} onClick={() => void run(() => bridge.openAccountWebsite())}>Account security</button>
        <button disabled={busy} onClick={() => void run(signOut)}>Sign out</button>
      </nav>
    </div></div>
    {error && <p role="alert">{error}</p>}
    {pathname.startsWith('/decks') ? <DecksPage pathname={pathname} onNavigate={navigate} />
      : pathname === '/progress' ? <ProgressPage onNavigate={navigate} />
      : pathname.startsWith('/settings') ? <main className="settings-page"><StudyNotificationsSettings /></main> : <App />}
  </div>
}
