import {
  useEffect,
  useState,
  type FormEvent,
} from 'react'

import type { Session } from '@supabase/supabase-js'

import App from './App'
import './AuthGate.css'
import { supabase } from './lib/supabase'

type AuthMode = 'login' | 'signup'

function AuthGate() {
  const [session, setSession] =
    useState<Session | null>(null)

  const [loading, setLoading] =
    useState(true)

  const [mode, setMode] =
    useState<AuthMode>('login')

  const [email, setEmail] =
    useState('')

  const [password, setPassword] =
    useState('')

  const [submitting, setSubmitting] =
    useState(false)

  const [error, setError] =
    useState('')

  const [message, setMessage] =
    useState('')

  useEffect(() => {
    async function loadSession() {
      const {
        data,
        error,
      } = await supabase.auth.getSession()

      if (error) {
        setError(error.message)
      }

      setSession(data.session)
      setLoading(false)
    }

    loadSession()

    const {
      data: { subscription },
    } =
      supabase.auth.onAuthStateChange(
        (_event, nextSession) => {
          setSession(nextSession)
          setLoading(false)
        },
      )

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  function changeMode(
    nextMode: AuthMode,
  ) {
    setMode(nextMode)
    setError('')
    setMessage('')
    setPassword('')
  }

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault()

    setError('')
    setMessage('')

    const cleanEmail =
      email.trim()

    if (!cleanEmail) {
      setError(
        'Enter your email address.',
      )
      return
    }

    if (!password) {
      setError(
        'Enter your password.',
      )
      return
    }

    if (
      mode === 'signup' &&
      password.length < 8
    ) {
      setError(
        'Password must contain at least 8 characters.',
      )
      return
    }

    setSubmitting(true)

    try {
      if (mode === 'signup') {
        const {
          data,
          error,
        } =
          await supabase.auth.signUp({
            email: cleanEmail,
            password,
            options: {
              emailRedirectTo:
                window.location.origin,
            },
          })

        if (error) {
          throw error
        }

        setPassword('')

        if (data.session) {
          setMessage(
            'Account created successfully.',
          )
        } else {
          setMessage(
            'Account created. Check your email to confirm your account.',
          )
        }

        return
      }

      const { error } =
        await supabase.auth
          .signInWithPassword({
            email: cleanEmail,
            password,
          })

      if (error) {
        throw error
      }

      setPassword('')
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Authentication failed.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSignOut() {
    setError('')
    setMessage('')

    const { error } =
      await supabase.auth.signOut()

    if (error) {
      setError(error.message)
    }
  }

  if (loading) {
    return (
      <main className="auth-page">
        <section className="auth-card loading-card">
          <div className="auth-logo">
            QF
          </div>

          <div className="auth-spinner" />

          <p>
            Loading QuizForge...
          </p>
        </section>
      </main>
    )
  }

  if (!session) {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <div className="auth-brand">
            <div className="auth-logo">
              QF
            </div>

            <div>
              <h1>
                QuizForge AI
              </h1>

              <p>
                AI-generated practice
                quizzes from your study
                material.
              </p>
            </div>
          </div>

          <div className="auth-tabs">
            <button
              type="button"
              className={
                mode === 'login'
                  ? 'auth-tab active'
                  : 'auth-tab'
              }
              onClick={() =>
                changeMode('login')
              }
            >
              Log In
            </button>

            <button
              type="button"
              className={
                mode === 'signup'
                  ? 'auth-tab active'
                  : 'auth-tab'
              }
              onClick={() =>
                changeMode('signup')
              }
            >
              Create Account
            </button>
          </div>

          <div className="auth-heading">
            <h2>
              {mode === 'login'
                ? 'Welcome back'
                : 'Create your account'}
            </h2>

            <p>
              {mode === 'login'
                ? 'Log in to continue to QuizForge.'
                : 'Create an account to start using QuizForge.'}
            </p>
          </div>

          <form
            className="auth-form"
            onSubmit={handleSubmit}
          >
            <label>
              <span>Email</span>

              <input
                type="email"
                value={email}
                autoComplete="email"
                placeholder="you@example.com"
                disabled={submitting}
                onChange={(event) =>
                  setEmail(
                    event.target.value,
                  )
                }
              />
            </label>

            <label>
              <span>Password</span>

              <input
                type="password"
                value={password}
                autoComplete={
                  mode === 'signup'
                    ? 'new-password'
                    : 'current-password'
                }
                placeholder={
                  mode === 'signup'
                    ? 'At least 8 characters'
                    : 'Enter your password'
                }
                disabled={submitting}
                onChange={(event) =>
                  setPassword(
                    event.target.value,
                  )
                }
              />
            </label>

            {error && (
              <div className="auth-error">
                {error}
              </div>
            )}

            {message && (
              <div className="auth-message">
                {message}
              </div>
            )}

            <button
              className="auth-submit"
              type="submit"
              disabled={submitting}
            >
              {submitting
                ? mode === 'login'
                  ? 'Logging in...'
                  : 'Creating account...'
                : mode === 'login'
                  ? 'Log In'
                  : 'Create Account'}
            </button>
          </form>

          <p className="auth-switch">
            {mode === 'login'
              ? "Don't have an account?"
              : 'Already have an account?'}

            {' '}

            <button
              type="button"
              onClick={() =>
                changeMode(
                  mode === 'login'
                    ? 'signup'
                    : 'login',
                )
              }
            >
              {mode === 'login'
                ? 'Create one'
                : 'Log in'}
            </button>
          </p>
        </section>
      </main>
    )
  }

  return (
    <>
      <div className="account-bar">
        <div className="account-bar-inner">
          <div className="account-info">
            <span className="account-dot" />

            <span>
              Signed in as
            </span>

            <strong>
              {session.user.email}
            </strong>
          </div>

          <button
            className="sign-out-button"
            type="button"
            onClick={handleSignOut}
          >
            Sign Out
          </button>
        </div>
      </div>

      <App />
    </>
  )
}

export default AuthGate