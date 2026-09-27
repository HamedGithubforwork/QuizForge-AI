import {
  useEffect,
  useState,
  type FormEvent,
} from 'react'

import type { Session } from '@supabase/supabase-js'

import App from './App'
import {
  AuthLoadingView,
  PasswordResetView,
  SignedInAccountBar,
  SignedOutAuthView,
  type AuthMode,
} from './components/auth/LegacyAuthViews.tsx'
import './AuthGate.css'
import { supabase } from './lib/supabase'

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
    return <AuthLoadingView />
  }

  if (resettingPassword) {
    return (
      <PasswordResetView
        newPassword={newPassword}
        confirmPassword={
          confirmPassword
        }
        submitting={submitting}
        error={error}
        onNewPasswordChange={
          setNewPassword
        }
        onConfirmPasswordChange={
          setConfirmPassword
        }
        onSubmit={
          handlePasswordReset
        }
      />
    )
  }

  if (!session) {
    return (
      <SignedOutAuthView
        mode={mode}
        email={email}
        password={password}
        submitting={submitting}
        error={error}
        message={message}
        onModeChange={changeMode}
        onEmailChange={setEmail}
        onPasswordChange={setPassword}
        onSubmit={handleSubmit}
      />
    )
  }

  return (
    <>
      <SignedInAccountBar
        email={session.user.email}
        onSignOut={() => {
          void handleSignOut()
        }}
      />
      <App />
    </>
  )
}

export default AuthGate
