import {
  useEffect,
  useState,
  type FormEvent,
} from 'react'

import {
  apiFetch,
} from '../../lib/api'
import {
  browserPushSupported,
  currentBrowserPushSubscription,
  detectedTimezone,
  disableBrowserPush,
  enableBrowserPush,
  getStudyNotificationPreferences,
  saveStudyNotificationPreferences,
} from '../../lib/studyNotifications'

const availableTimezones = Intl.supportedValuesOf('timeZone')

function cleanTime(
  value: string | undefined,
) {
  if (!value) {
    return '19:00'
  }

  return value.slice(0, 5)
}

export default function StudyNotificationsSettings() {
  const [loading, setLoading] =
    useState(true)
  const [saving, setSaving] =
    useState(false)
  const [enabled, setEnabled] =
    useState(false)
  const [
    reminderTime,
    setReminderTime,
  ] = useState('19:00')
  const [timezone, setTimezone] =
    useState(detectedTimezone())
  const [
    minimumDueCards,
    setMinimumDueCards,
  ] = useState(1)
  const [
    browserConnected,
    setBrowserConnected,
  ] = useState(false)
  const [message, setMessage] =
    useState('')
  const [error, setError] =
    useState('')

  const deviceTimezone = detectedTimezone()
  const timezoneOptions = Array.from(new Set([
    'UTC', timezone, deviceTimezone, ...availableTimezones,
  ])).sort((a, b) => a.localeCompare(b))

  const supported =
    browserPushSupported()

  useEffect(() => {
    let active = true

    async function load() {
      setLoading(true)
      setError('')

      try {
        const [preferences, subscription] =
          await Promise.all([
            getStudyNotificationPreferences(
              apiFetch,
            ),
            currentBrowserPushSubscription(),
          ])

        if (!active) {
          return
        }

        setEnabled(
          Boolean(
            preferences.enabled,
          ),
        )
        setReminderTime(
          cleanTime(
            preferences.reminder_time,
          ),
        )
        setTimezone(
          preferences.timezone ||
            detectedTimezone(),
        )
        setMinimumDueCards(
          preferences.minimum_due_cards ??
            1,
        )
        setBrowserConnected(
          Boolean(subscription),
        )
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

  async function save(
    event: FormEvent,
  ) {
    event.preventDefault()
    setSaving(true)
    setError('')
    setMessage('')

    try {
      let connected =
        browserConnected

      if (
        enabled &&
        supported &&
        !connected
      ) {
        await enableBrowserPush(
          apiFetch,
        )
        connected = true
        setBrowserConnected(true)
      }

      if (
        enabled &&
        !supported
      ) {
        throw new Error(
          'This browser does not support Web Push notifications.',
        )
      }

      const saved =
        await saveStudyNotificationPreferences(
          {
            enabled,
            reminder_time:
              reminderTime,
            timezone:
              timezone.trim(),
            minimum_due_cards:
              minimumDueCards,
          },
          apiFetch,
        )

      setEnabled(
        Boolean(saved.enabled),
      )
      setReminderTime(
        cleanTime(
          saved.reminder_time,
        ),
      )
      setTimezone(
        saved.timezone ||
          timezone,
      )
      setMinimumDueCards(
        saved.minimum_due_cards ??
          minimumDueCards,
      )
      setMessage(
        saved.enabled
          ? connected
            ? 'Study reminders are enabled.'
            : 'Reminder preferences are saved.'
          : 'Study reminders are disabled.',
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

  async function connectBrowser() {
    setSaving(true)
    setError('')
    setMessage('')

    try {
      await enableBrowserPush(
        apiFetch,
      )
      setBrowserConnected(true)
      setMessage(
        'This browser is connected for study reminders.',
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not connect this browser.',
      )
    } finally {
      setSaving(false)
    }
  }

  async function disconnectBrowser() {
    setSaving(true)
    setError('')
    setMessage('')

    try {
      await disableBrowserPush(
        apiFetch,
      )
      setBrowserConnected(false)
      setMessage(
        'This browser was removed from study reminders.',
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not remove this browser.',
      )
    } finally {
      setSaving(false)
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
          Get a browser notification
          when your spaced-repetition
          cards are ready to review.
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
          className="settings-success"
          role="status"
        >
          {message}
        </div>
      )}

      <form
        className="settings-card settings-reminder-form"
        onSubmit={save}
      >
        <div className="settings-card-heading">
          <div>
            <h2>
              Review reminders
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
                  event.target
                    .checked,
                )
              }
            />

            <span
              aria-hidden="true"
            />

            <strong>
              {enabled
                ? 'On'
                : 'Off'}
            </strong>
          </label>
        </div>

        <div className="settings-reminder-grid">
          <label>
            <span>
              Reminder time
            </span>

            <input
              type="time"
              value={reminderTime}
              disabled={saving}
              required
              onChange={(event) =>
                setReminderTime(
                  event.target
                    .value,
                )
              }
            />
          </label>

          <div className="settings-timezone-field">
            <label>
              <span>Time zone</span>
              <select
                value={timezone}
                disabled={saving}
                required
                aria-describedby="reminder-timezone-help"
                onChange={(event) => setTimezone(event.target.value)}
              >
                {timezoneOptions.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </label>

            <button
              className="settings-inline-action"
              type="button"
              disabled={saving}
              onClick={() => setTimezone(deviceTimezone)}
            >
              Use my computer’s time zone ({deviceTimezone.replaceAll('_', ' ')})
            </button>
            <small id="reminder-timezone-help">
              Sets the time zone for your reminder time. This does not enable
              notifications. Click Save reminder settings to apply changes.
            </small>
          </div>

          <label>
            <span>
              Minimum cards due
            </span>

            <input
              type="number"
              min={1}
              max={1000}
              value={
                minimumDueCards
              }
              disabled={saving}
              required
              onChange={(event) =>
                setMinimumDueCards(
                  Number(
                    event.target
                      .value,
                  ),
                )
              }
            />

            <small>
              Skip the reminder
              until at least this
              many cards are due.
            </small>
          </label>
        </div>

        <div className="settings-form-actions">
          <button
            className="settings-primary-button"
            disabled={saving}
          >
            {saving
              ? 'Saving…'
              : 'Save reminder settings'}
          </button>
        </div>
      </form>

      <section className="settings-card">
        <div className="settings-card-heading">
          <div>
            <h2>
              This browser
            </h2>

            <p>
              Connect this device to
              receive review reminders
              even when Quiz From Notes
              is not open.
            </p>
          </div>

          <span
            className={
              browserConnected
                ? 'settings-status settings-status-on'
                : 'settings-status settings-status-off'
            }
          >
            {browserConnected
              ? 'Connected'
              : 'Not connected'}
          </span>
        </div>

        {!supported ? (
          <div className="settings-coming-soon">
            Web Push is not supported
            by this browser.
          </div>
        ) : browserConnected ? (
          <button
            className="settings-secondary-button"
            type="button"
            disabled={saving}
            onClick={() =>
              void disconnectBrowser()
            }
          >
            Remove this browser
          </button>
        ) : (
          <button
            className="settings-primary-button"
            type="button"
            disabled={saving}
            onClick={() =>
              void connectBrowser()
            }
          >
            Enable browser notifications
          </button>
        )}

        <p className="settings-method-note">
          Browser permission is controlled
          by your browser or operating
          system. You can connect multiple
          devices to the same account.
        </p>
      </section>
    </>
  )
}
