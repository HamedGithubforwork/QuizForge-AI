import type {
  FormEvent,
} from 'react'

export type AuthMode =
  | 'login'
  | 'signup'
  | 'forgot'

function AuthBrand() {
  return (
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
  )
}

export function AuthLoadingView() {
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

type PasswordResetViewProps = {
  newPassword: string
  confirmPassword: string
  submitting: boolean
  error: string
  onNewPasswordChange: (
    value: string,
  ) => void
  onConfirmPasswordChange: (
    value: string,
  ) => void
  onSubmit: (
    event: FormEvent<HTMLFormElement>,
  ) => void
}

export function PasswordResetView({
  newPassword,
  confirmPassword,
  submitting,
  error,
  onNewPasswordChange,
  onConfirmPasswordChange,
  onSubmit,
}: PasswordResetViewProps) {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <AuthBrand />

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
          onSubmit={onSubmit}
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
                onNewPasswordChange(
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
                onConfirmPasswordChange(
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

type SignedOutAuthViewProps = {
  mode: AuthMode
  email: string
  password: string
  submitting: boolean
  error: string
  message: string
  onModeChange: (
    mode: AuthMode,
  ) => void
  onEmailChange: (
    value: string,
  ) => void
  onPasswordChange: (
    value: string,
  ) => void
  onSubmit: (
    event: FormEvent<HTMLFormElement>,
  ) => void
}

function getSubmitLabel(
  mode: AuthMode,
  submitting: boolean,
) {
  if (submitting) {
    if (mode === 'login') {
      return 'Logging in...'
    }

    if (mode === 'signup') {
      return 'Creating account...'
    }

    return 'Sending reset link...'
  }

  if (mode === 'login') {
    return 'Log In'
  }

  if (mode === 'signup') {
    return 'Create Account'
  }

  return 'Send Reset Link'
}

export function SignedOutAuthView({
  mode,
  email,
  password,
  submitting,
  error,
  message,
  onModeChange,
  onEmailChange,
  onPasswordChange,
  onSubmit,
}: SignedOutAuthViewProps) {
  const isForgotMode =
    mode === 'forgot'

  return (
    <main className="auth-page">
      <section className="auth-card">
        <AuthBrand />

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
                onModeChange('login')
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
                onModeChange('signup')
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
          onSubmit={onSubmit}
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
                onEmailChange(
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
                  onPasswordChange(
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
                  onModeChange('forgot')
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
            {getSubmitLabel(
              mode,
              submitting,
            )}
          </button>
        </form>

        {isForgotMode ? (
          <p className="auth-switch">
            Remember your password?

            {' '}

            <button
              type="button"
              onClick={() =>
                onModeChange('login')
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
                onModeChange(
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

type SignedInAccountBarProps = {
  email: string | undefined
  onSignOut: () => void
}

export function SignedInAccountBar({
  email,
  onSignOut,
}: SignedInAccountBarProps) {
  return (
    <div className="account-bar">
      <div className="account-bar-inner">
        <div className="account-info">
          <span className="account-dot" />

          <span>
            Signed in as
          </span>

          <strong>
            {email}
          </strong>
        </div>

        <button
          className="sign-out-button"
          type="button"
          onClick={onSignOut}
        >
          Sign Out
        </button>
      </div>
    </div>
  )
}
