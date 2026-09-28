import {
  useEffect,
  useState,
  type FormEvent,
} from 'react'

import {
  apiFetch,
} from '../../lib/api'
import {
  browserTimezone,
  currentDeviceSubscription,
  disablePushOnCurrentDevice,
  enablePushOnCurrentDevice,
  getStudyNotificationPreferences,
  saveStudyNotificationPreferences,
  supportsWebPush,
} from '../../lib/studyNotifications'

type DeviceState = {
  supported: boolean
  permission: string
  subscribed: boolean
  linked: boolean
}

const DEFAULT_DEVICE: DeviceState = {
  supported: false,
  permission: 'unsupported',
  subscribed: false,
  linked: false,
}

function trimTime(
  value: string | undefined,
) {
  if (!value) {
    return '19:00'
  }
  return value.slice(0, 5)
}

export default function StudyNotificationsSettings() {
  const [enabled, setEnabled] =
    useState(false)
  const [reminderTime, setReminderTime] =
    useState('19:00')
  const [timezone, setTimezone] =
    useState(browserTimezone())
  const [minimumDue, setMinimumDue] =
    useState(1)
  const [loading, setLoading] =
    useState(true)
  const [saving, setSaving] =
    useState(false)
  const [deviceBusy, setDeviceBusy] =
    useState(false)
  const [device, setDevice] =
    useState<DeviceState>(
      DEFAULT_DEVICE,
    )
  const [message, setMessage] =
    useState('')
  const [error, setError] =
    useState('')

  async function refreshDevice() {
    if (!supportsWebPush()) {
      setDevice(
        DEFAULT_DEVICE,
      )
      return
    }

    try {
      const status =
        await currentDeviceSubscription(
          apiFetch,
        )
      setDevice({
        supported:
          status.supported,
        permission:
          status.permission,
        subscribed:
          Boolean(
            status.subscription,
          ),
        linked:
          Boolean(
            status.serverSubscription,
          ),
      })
    } catch {
      setDevice({
        supported: true,
        permission:
          Notification.permission,
        subscribed: false,
        linked: false,
      })
    }
  }

  useEffect(() => {
    let active = true

    async function load() {
      setLoading(true)
      setError('')

      try {
        const preferences =
          await getStudyNotificationPreferences(
            apiFetch,
          )

        if (!active) {
          return
        }

        setEnabled(
          Boolean(
            preferences.enabled,
          ),
        )
        setReminderTime(
          trimTime(
            preferences.reminder_time,
          ),
        )
        setTimezone(
          preferences.timezone ||
            browserTimezone(),
        )
        setMinimumDue(
          preferences.minimum_due_cards ??
            1,
        )
        await refreshDevice()
      } catch (caught) {
        if (active) {
          setError(
            caught instanceof Error
              ? caught.message
              : 'Could not load study reminder settings.',
          )
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      active = false
    }
  }, [])

  async function handleSave(
    event: FormEvent,
  ) {
    event.preventDefault()
    setSaving(true)
    setError('')
    setMessage('')

    try {
      const saved =
        await saveStudyNotificationPreferences(
          {
            enabled,
            reminder_time:
              reminderTime,
            timezone:
              timezone.trim(),
            minimum_due_cards:
              minimumDue,
          },
          apiFetch,
        )
      setEnabled(
        Boolean(saved.enabled),
      )
      setReminderTime(
        trimTime(
          saved.reminder_time,
        ),
      )
      setTimezone(
        saved.timezone ||
          timezone,
      )
      setMinimumDue(
        saved.minimum_due_cards ??
          minimumDue,
      )
      setMessage(
        'Study reminder schedule saved.',
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not save study reminder settings.',
      )
    } finally {
      setSaving(false)
    }
  }

  async function enableDevice() {
    setDeviceBusy(true)
    setError('')
    setMessage('')

    try {
      await enablePushOnCurrentDevice(
        apiFetch,
      )
      await refreshDevice()
      setMessage(
        'Browser notifications are enabled on this device.',
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not enable browser notifications.',
      )
    } finally {
      setDeviceBusy(false)
    }
  }

  async function removeDevice() {
    setDeviceBusy(true)
    setError('')
    setMessage('')

    try {
      await disablePushOnCurrentDevice(
        apiFetch,
      )
      await refreshDevice()
      setMessage(
        'This browser was removed from study notifications.',
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not remove browser notifications.',
      )
    } finally {
      setDeviceBusy(false)
    }
  }

  if (loading) {
    return (
      <div
        className="settings-loading"
        role="status"
      >
        Loading study reminder settings…
      </div>
    )
  }

  return (
    <>
      <div className="settings-heading">
        <span className="settings-eyebrow">
          NOTIFICATIONS
        </span>
        <h1>
          Study reminders
        </h1>
        <p>
          Choose when Quiz From Notes
          should remind you that spaced
          repetition cards are ready.
        </p>
      </div>

      {error && (
        <div
          className="settings-alert"
          role="alert"
        >
          {error}
        </div>
      )}

      {message && (
        <div
          className="settings-notice"
          role="status"
        >
          {message}
        </div>
      )}

      <form
        className="settings-card settings-form"
        onSubmit={handleSave}
      >
        <div className="settings-card-heading">
          <div>
            <h2>
              Reminder schedule
            </h2>
            <p>
              Reminders are sent only
              when enough cards are due.
            </p>
          </div>

          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={enabled}
              disabled={saving}
              onChange={(event) =>
                setEnabled(
                  event.target.checked,
                )
              }
            />
            <span>
              {enabled
                ? 'Enabled'
                : 'Disabled'}
            </span>
          </label>
        </div>

        <div className="settings-notification-grid">
          <label>
            <span>
              Reminder time
            </span>
            <input
              type="time"
              required
              value={reminderTime}
              disabled={saving}
              onChange={(event) =>
                setReminderTime(
                  event.target.value,
                )
              }
            />
          </label>

          <label>
            <span>
              Minimum cards due
            </span>
            <input
              type="number"
              min={1}
              max={1000}
              required
              value={minimumDue}
              disabled={saving}
              onChange={(event) =>
                setMinimumDue(
                  Number(
                    event.target.value,
                  ),
                )
              }
            />
          </label>
        </div>

        <label>
          <span>Timezone</span>
          <div className="settings-timezone-row">
            <input
              type="text"
              required
              maxLength={100}
              value={timezone}
              disabled={saving}
              onChange={(event) =>
                setTimezone(
                  event.target.value,
                )
              }
            />
            <button
              className="settings-secondary-button"
              type="button"
              disabled={saving}
              onClick={() =>
                setTimezone(
                  browserTimezone(),
                )
              }
            >
              Use this device
            </button>
          </div>
        </label>

        <p className="settings-method-note">
          Your reminder follows this
          timezone even if another device
          is in a different location.
        </p>

        <div className="settings-form-actions">
          <button
            className="settings-primary-button"
            disabled={saving}
          >
            {saving
              ? 'Saving…'
              : 'Save reminder schedule'}
          </button>
        </div>
      </form>

      <section className="settings-card">
        <div className="settings-card-heading">
          <div>
            <h2>
              Browser notifications
            </h2>
            <p>
              Register this browser as
              one device that can receive
              your study reminders.
            </p>
          </div>

          <span
            className={
              device.linked
                ? 'settings-status settings-status-on'
                : 'settings-status settings-status-off'
            }
          >
            {device.linked
              ? 'This device enabled'
              : 'Not enabled'}
          </span>
        </div>

        {!device.supported ? (
          <div className="settings-coming-soon">
            This browser does not support
            Web Push in the current
            context. Use a supported
            browser over HTTPS.
          </div>
        ) : device.permission ===
          'denied' ? (
          <div className="settings-coming-soon">
            Notifications are blocked in
            this browser. Allow
            notifications for this site
            in browser settings, then
            return here.
          </div>
        ) : (
          <>
            <div className="settings-device-summary">
              <div>
                <span>
                  Permission
                </span>
                <strong>
                  {device.permission}
                </strong>
              </div>
              <div>
                <span>
                  Browser subscription
                </span>
                <strong>
                  {device.subscribed
                    ? 'Present'
                    : 'None'}
                </strong>
              </div>
              <div>
                <span>
                  Linked to account
                </span>
                <strong>
                  {device.linked
                    ? 'Yes'
                    : 'No'}
                </strong>
              </div>
            </div>

            <div className="settings-form-actions settings-device-actions">
              {device.linked ? (
                <button
                  className="settings-secondary-button"
                  type="button"
                  disabled={deviceBusy}
                  onClick={() =>
                    void removeDevice()
                  }
                >
                  {deviceBusy
                    ? 'Removing…'
                    : 'Remove this device'}
                </button>
              ) : (
                <button
                  className="settings-primary-button"
                  type="button"
                  disabled={deviceBusy}
                  onClick={() =>
                    void enableDevice()
                  }
                >
                  {deviceBusy
                    ? 'Enabling…'
                    : 'Enable on this device'}
                </button>
              )}
            </div>
          </>
        )}

        <p className="settings-method-note">
          You can register more than one
          browser. Turning off the
          reminder schedule above pauses
          delivery without removing your
          registered devices.
        </p>
      </section>
    </>
  )
}
