import type { FormEvent } from 'react'

import type { MfaSecurityStatus } from '../../lib/cognitoMfa'
import './SettingsPage.css'

const SETTINGS_LAYOUT_FALLBACK = `
.settings-page{min-height:100vh;background:#f6f7fb;color:#1d2335}
.settings-topbar{display:flex;min-height:70px;align-items:center;justify-content:space-between;gap:20px;padding:0 28px;border-bottom:1px solid #e3e6ef;background:#fff}
.settings-shell{display:grid;width:min(1180px,calc(100% - 48px));grid-template-columns:250px minmax(0,820px);justify-content:center;gap:38px;margin:0 auto;padding:44px 0 84px}
.settings-sidebar{align-self:start;padding:18px;border:1px solid #e1e4ed;border-radius:20px;background:#fff}
.settings-sidebar nav{display:grid;gap:7px}
.settings-sidebar nav button{display:flex;width:100%;min-height:44px;align-items:center;gap:11px;padding:0 12px;border:0;border-radius:11px;background:transparent;text-align:left}
.settings-sidebar nav button.active{background:#eceaff;color:#5549d5}
.settings-content{min-width:0}
.settings-card{margin-bottom:18px;padding:24px;border:1px solid #e1e4ed;border-radius:20px;background:#fff}
.settings-card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}
.settings-method-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:20px}
.settings-method-grid>div{display:grid;gap:8px;padding:15px;border:1px solid #eceef4;border-radius:14px;background:#fafbfe}
@media(max-width:920px){.settings-shell{width:min(100% - 36px,820px);grid-template-columns:1fr;gap:22px;padding-top:28px}.settings-sidebar{position:static}.settings-sidebar nav{grid-template-columns:1fr 1fr}}
@media(max-width:680px){.settings-topbar{align-items:stretch;flex-direction:column;padding:14px 16px}.settings-shell{width:min(100% - 24px,620px);padding:22px 0 54px}.settings-card-heading{flex-direction:column}.settings-method-grid{grid-template-columns:1fr}}
`


export type SettingsSection = 'account' | 'security'

type SettingsPageProps = {
  email: string
  section: SettingsSection
  busy: boolean
  error: string
  smsMfaEnabled: boolean
  securityStatus: MfaSecurityStatus | null
  phone: string
  phoneCode: string
  phonePending: boolean
  totpSecret: string
  totpCode: string
  onSectionChange: (section: SettingsSection) => void
  onBack: () => void
  onSignOut: () => void
  onPhoneChange: (value: string) => void
  onPhoneCodeChange: (value: string) => void
  onTotpCodeChange: (value: string) => void
  onStartTotp: () => void
  onFinishTotp: (event: FormEvent) => void
  onCancelTotp: () => void
  onStartPhone: (event: FormEvent) => void
  onFinishPhone: (event: FormEvent) => void
  onCancelPhone: () => void
  onPreferMfa: (method: 'sms' | 'totp') => void
  onDisableMfa: () => void
  totpUri: string
}

function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span className={enabled ? 'settings-status settings-status-on' : 'settings-status settings-status-off'}>
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  )
}

export default function SettingsPage({
  email,
  section,
  busy,
  error,
  smsMfaEnabled,
  securityStatus,
  phone,
  phoneCode,
  phonePending,
  totpSecret,
  totpCode,
  onSectionChange,
  onBack,
  onSignOut,
  onPhoneChange,
  onPhoneCodeChange,
  onTotpCodeChange,
  onStartTotp,
  onFinishTotp,
  onCancelTotp,
  onStartPhone,
  onFinishPhone,
  onCancelPhone,
  onPreferMfa,
  onDisableMfa,
  totpUri,
}: SettingsPageProps) {
  const twoFactorEnabled = Boolean(
    securityStatus?.totpEnabled ||
    securityStatus?.smsEnabled,
  )

  return (
    <main className="settings-page">
      <style>{SETTINGS_LAYOUT_FALLBACK}</style>
      <header className="settings-topbar">
        <button
          className="settings-back"
          type="button"
          onClick={onBack}
        >
          <span aria-hidden="true">←</span>
          Back to quizzes
        </button>
        <div className="settings-topbar-account">
          <span>{email}</span>
          <button type="button" disabled={busy} onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <div className="settings-shell">
        <aside className="settings-sidebar">
          <div className="settings-brand">
            <span className="settings-brand-mark">QF</span>
            <div>
              <strong>Quiz From Notes</strong>
              <span>Settings</span>
            </div>
          </div>

          <nav aria-label="Settings">
            <button
              type="button"
              className={section === 'account' ? 'active' : ''}
              aria-current={section === 'account' ? 'page' : undefined}
              onClick={() => onSectionChange('account')}
            >
              <span aria-hidden="true">◉</span>
              Account
            </button>
            <button
              type="button"
              className={section === 'security' ? 'active' : ''}
              aria-current={section === 'security' ? 'page' : undefined}
              onClick={() => onSectionChange('security')}
            >
              <span aria-hidden="true">◆</span>
              Security
            </button>
          </nav>
        </aside>

        <section className="settings-content">
          {error && (
            <div className="settings-alert" role="alert">
              {error}
            </div>
          )}

          {section === 'account' ? (
            <>
              <div className="settings-heading">
                <span className="settings-eyebrow">ACCOUNT</span>
                <h1>Account settings</h1>
                <p>Manage the basics for your Quiz From Notes account.</p>
              </div>

              <section className="settings-card">
                <div className="settings-card-heading">
                  <div>
                    <h2>Email address</h2>
                    <p>This is the email used to sign in to your account.</p>
                  </div>
                </div>
                <div className="settings-account-row">
                  <div>
                    <span className="settings-field-label">Email</span>
                    <strong>{email}</strong>
                  </div>
                  <span className="settings-verified">Verified</span>
                </div>
              </section>

              <section className="settings-card settings-card-compact">
                <div className="settings-card-heading">
                  <div>
                    <h2>Sign out</h2>
                    <p>End your current Quiz From Notes session on this device.</p>
                  </div>
                  <button
                    className="settings-secondary-button"
                    type="button"
                    disabled={busy}
                    onClick={onSignOut}
                  >
                    Sign out
                  </button>
                </div>
              </section>
            </>
          ) : (
            <>
              <div className="settings-heading">
                <span className="settings-eyebrow">SECURITY</span>
                <h1>Sign-in security</h1>
                <p>
                  Two-factor authentication is optional. You can enable it for extra protection
                  and turn it off again whenever you want.
                </p>
              </div>

              <section className="settings-card settings-security-summary">
                <div className="settings-card-heading">
                  <div>
                    <h2>Two-factor authentication</h2>
                    <p>Add a second step after your password when signing in.</p>
                  </div>
                  <StatusPill enabled={twoFactorEnabled} />
                </div>

                {!securityStatus ? (
                  <div className="settings-loading" role="status">
                    Loading security settings…
                  </div>
                ) : (
                  <div className="settings-method-grid">
                    <div>
                      <span>Authenticator app</span>
                      <StatusPill enabled={securityStatus.totpEnabled} />
                    </div>
                    <div>
                      <span>Text messages</span>
                      {smsMfaEnabled ? (
                        <StatusPill enabled={securityStatus.smsEnabled} />
                      ) : (
                        <span className="settings-status settings-status-pending">Coming soon</span>
                      )}
                    </div>
                    <div>
                      <span>Preferred method</span>
                      <strong>
                        {securityStatus.preferred === 'sms'
                          ? 'Text message'
                          : securityStatus.preferred === 'totp'
                            ? 'Authenticator app'
                            : 'None'}
                      </strong>
                    </div>
                  </div>
                )}
              </section>

              {securityStatus && (
                <>
                  <section className="settings-card">
                    <div className="settings-card-heading">
                      <div>
                        <h2>Authenticator app</h2>
                        <p>Use Google Authenticator, Microsoft Authenticator, 1Password, or another TOTP app.</p>
                      </div>
                      {securityStatus.totpEnabled && <StatusPill enabled />}
                    </div>

                    {totpSecret ? (
                      <form className="settings-form" aria-busy={busy} onSubmit={onFinishTotp}>
                        <div className="settings-setup-key">
                          <span>Setup key</span>
                          <code>{totpSecret}</code>
                        </div>
                        <a className="settings-inline-link" href={totpUri}>
                          Open in an authenticator app
                        </a>
                        <label>
                          <span>6-digit authenticator code</span>
                          <input
                            autoComplete="one-time-code"
                            inputMode="numeric"
                            required
                            pattern="[0-9]{6}"
                            value={totpCode}
                            disabled={busy}
                            onChange={(event) => onTotpCodeChange(event.target.value)}
                          />
                        </label>
                        <div className="settings-form-actions">
                          <button className="settings-primary-button" disabled={busy}>
                            {busy ? 'Verifying…' : 'Enable authenticator 2FA'}
                          </button>
                          <button
                            className="settings-secondary-button"
                            type="button"
                            disabled={busy}
                            onClick={onCancelTotp}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : securityStatus.totpEnabled ? (
                      <p className="settings-method-note">
                        Authenticator 2FA is active on your account.
                      </p>
                    ) : (
                      <button
                        className="settings-primary-button"
                        type="button"
                        disabled={busy}
                        onClick={onStartTotp}
                      >
                        Enable authenticator 2FA
                      </button>
                    )}
                  </section>

                  <section className="settings-card">
                    <div className="settings-card-heading">
                      <div>
                        <h2>Text-message 2FA</h2>
                        <p>Receive a six-digit security code at a verified phone number.</p>
                      </div>
                      {smsMfaEnabled && securityStatus.smsEnabled && <StatusPill enabled />}
                    </div>

                    {!smsMfaEnabled ? (
                      <div className="settings-coming-soon">
                        SMS will become available here after AWS approves production messaging access.
                      </div>
                    ) : phonePending ? (
                      <form className="settings-form" aria-busy={busy} onSubmit={onFinishPhone}>
                        <label>
                          <span>6-digit text-message code</span>
                          <input
                            autoComplete="one-time-code"
                            inputMode="numeric"
                            required
                            pattern="[0-9]{6}"
                            value={phoneCode}
                            disabled={busy}
                            onChange={(event) => onPhoneCodeChange(event.target.value)}
                          />
                        </label>
                        <div className="settings-form-actions">
                          <button className="settings-primary-button" disabled={busy}>
                            {busy ? 'Verifying…' : 'Verify and enable text messages'}
                          </button>
                          <button
                            className="settings-secondary-button"
                            type="button"
                            disabled={busy}
                            onClick={onCancelPhone}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <form className="settings-form" aria-busy={busy} onSubmit={onStartPhone}>
                        <label>
                          <span>Phone number</span>
                          <input
                            type="tel"
                            autoComplete="tel"
                            required
                            placeholder="+16135551234"
                            value={phone}
                            disabled={busy}
                            onChange={(event) => onPhoneChange(event.target.value)}
                          />
                        </label>
                        <p className="settings-method-note">
                          Use international format with country code.
                        </p>
                        <button className="settings-primary-button" disabled={busy}>
                          {busy
                            ? 'Sending…'
                            : securityStatus.phoneVerified
                              ? 'Change phone number'
                              : 'Add phone number'}
                        </button>
                      </form>
                    )}
                  </section>

                  {securityStatus.totpEnabled && securityStatus.smsEnabled && (
                    <section className="settings-card settings-card-compact">
                      <div className="settings-card-heading">
                        <div>
                          <h2>Preferred 2FA method</h2>
                          <p>Choose which method Cognito should request first at sign-in.</p>
                        </div>
                      </div>
                      <div className="settings-preference-actions">
                        <button
                          className="settings-secondary-button"
                          type="button"
                          disabled={busy || securityStatus.preferred === 'totp'}
                          onClick={() => onPreferMfa('totp')}
                        >
                          Prefer authenticator
                        </button>
                        <button
                          className="settings-secondary-button"
                          type="button"
                          disabled={busy || securityStatus.preferred === 'sms'}
                          onClick={() => onPreferMfa('sms')}
                        >
                          Prefer text messages
                        </button>
                      </div>
                    </section>
                  )}

                  {twoFactorEnabled && (
                    <section className="settings-card settings-danger-card">
                      <div className="settings-card-heading">
                        <div>
                          <h2>Disable two-factor authentication</h2>
                          <p>
                            Future sign-ins will use your password without a second-factor challenge.
                          </p>
                        </div>
                        <button
                          className="settings-danger-button"
                          type="button"
                          disabled={busy}
                          onClick={onDisableMfa}
                        >
                          Disable 2FA
                        </button>
                      </div>
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  )
}
