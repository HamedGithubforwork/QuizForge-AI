import {
  useEffect,
  useState,
  type FormEvent,
} from 'react'

import type { Session } from '@supabase/supabase-js'

import App from './App'
import './AuthGate.css'
import { supabase } from './lib/supabase'

type AuthMode =
  | 'login'
  | 'signup'
  | 'forgot'

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

  const [newPassword, setNewPassword] =
    useState('')

  const [confirmPassword, setConfirmPassword] =
    useState('')

  const [resettingPassword, setResettingPassword] =
    useState(false)

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
        (event, nextSession) => {
          setSession(nextSession)

          if (event === 'PASSWORD_RECOVERY') {
            setResettingPassword(true)
            setMode('login')
            setError('')
            setMessage('')
          }

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

    if (mode === 'forgot') {
      setSubmitting(true)

      try {
        const { error } =
          await supabase.auth
            .resetPasswordForEmail(
              cleanEmail,
              {
                redirectTo:
                  window.location.origin,
              },
            )

        if (error) {
          throw error
        }

        setMessage(
          'If an account exists for this email, a password reset link has been sent.',
        )
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Unable to send the password reset email.',
        )
      } finally {
        setSubmitting(false)
      }

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
            'If this email is new, check your inbox to confirm your account. If you already have an account, log in instead.',
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

  async function handlePasswordReset(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault()

    setError('')
    setMessage('')

    if (newPassword.length < 8) {
      setError(
        'Password must contain at least 8 characters.',
      )
      return
    }

    if (newPassword !== confirmPassword) {
      setError(
        'The passwords do not match.',
      )
      return
    }

    setSubmitting(true)

    try {
      const { error } =
        await supabase.auth.updateUser({
          password: newPassword,
        })

      if (error) {
        throw error
      }

      setNewPassword('')
      setConfirmPassword('')
      setResettingPassword(false)
      setMode('login')

      await supabase.auth.signOut()

      setMessage(
        'Password updated successfully. Log in with your new password.',
      )
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Unable to update your password.',
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
        <section
          className="auth-card loading-card"
          aria-busy="true"
        >
          <div className="auth-logo">
            QF
          </div>

          <div
            className="auth-spinner"
            aria-hidden="true"
          />

          <p>
            Loading QuizForge...
          </p>
        </section>
      </main>
    )
  }

  if (resettingPassword) {
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

          <div className="auth-heading">
            <h2>
              Set a new password
            </h2>

            <p>
              Choose a new password for your account.
            </p>
          </div>

          <form
            className="auth-form"
            onSubmit={handlePasswordReset}
          >
            <label>
              <span>New password</span>

              <input
                type="password"
                value={newPassword}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                disabled={submitting}
                onChange={(event) =>
                  setNewPassword(
                    event.target.value,
                  )
                }
              />
            </label>

            <label>
              <span>Confirm new password</span>

              <input
                type="password"
                value={confirmPassword}
                autoComplete="new-password"
                placeholder="Enter it again"
                disabled={submitting}
                onChange={(event) =>
                  setConfirmPassword(
                    event.target.value,
                  )
                }
              />
            </label>

            {error && (
              <div
                className="auth-error"
                role="alert"
              >
                {error}
              </div>
            )}

            <button
              className="auth-submit"
              type="submit"
              disabled={submitting}
            >
              {submitting
                ? 'Updating password...'
                : 'Update Password'}
            </button>
          </form>
        </section>
      </main>
    )
  }

  if (!session) {
    const isForgotMode =
      mode === 'forgot'

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

          {!isForgotMode && (
            <div className="auth-tabs">
              <button
                type="button"
                className={
                  mode === 'login'
                    ? 'auth-tab active'
                    : 'auth-tab'
                }
                aria-pressed={
                  mode === 'login'
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
                aria-pressed={
                  mode === 'signup'
                }
                onClick={() =>
                  changeMode('signup')
                }
              >
                Create Account
              </button>
            </div>
          )}

          <div className="auth-heading">
            <h2>
              {mode === 'login'
                ? 'Welcome back'
                : mode === 'signup'
                  ? 'Create your account'
                  : 'Reset your password'}
            </h2>

            <p>
              {mode === 'login'
                ? 'Log in to continue to QuizForge.'
                : mode === 'signup'
                  ? 'Create an account to start using QuizForge.'
                  : 'Enter your email and we will send you a password reset link.'}
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

            {!isForgotMode && (
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
            )}

            {mode === 'login' && (
              <div className="auth-forgot">
                <button
                  type="button"
                  onClick={() =>
                    changeMode('forgot')
                  }
                >
                  Forgot password?
                </button>
              </div>
            )}

            {error && (
              <div
                className="auth-error"
                role="alert"
              >
                {error}
              </div>
            )}

            {message && (
              <div
                className="auth-message"
                role="status"
                aria-live="polite"
              >
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
                  : mode === 'signup'
                    ? 'Creating account...'
                    : 'Sending reset link...'
                : mode === 'login'
                  ? 'Log In'
                  : mode === 'signup'
                    ? 'Create Account'
                    : 'Send Reset Link'}
            </button>
          </form>

          {isForgotMode ? (
            <p className="auth-switch">
              Remember your password?

              {' '}

              <button
                type="button"
                onClick={() =>
                  changeMode('login')
                }
              >
                Back to log in
              </button>
            </p>
          ) : (
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
          )}
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
