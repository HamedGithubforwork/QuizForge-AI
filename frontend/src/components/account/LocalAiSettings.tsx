import {
  useEffect,
  useState,
} from 'react'

import {
  desktopLocalAiBridge,
  type DesktopLocalAiStatus,
} from '../../lib/desktop'

function bytes(value: number | null | undefined) {
  if (!value) return '—'
  const gib = value / 1024 ** 3
  return gib >= 1
    ? `${gib.toFixed(gib >= 10 ? 0 : 1)} GB`
    : `${Math.round(value / 1024 ** 2)} MB`
}

function reason(value: string) {
  const messages: Record<string, string> = {
    unsupported_platform:
      'This Local AI preview currently supports Windows x64 only.',
    insufficient_memory:
      'This computer does not meet the current preview memory threshold.',
    insufficient_disk:
      'There is not enough free storage for the current model and safety reserve.',
    runtime_acceleration_unavailable:
      'The available runtime does not support the required acceleration mode.',
    no_eligible_local_profile:
      'No validated local model profile matches this computer yet.',
  }
  return messages[value] ?? 'Local AI is not ready on this computer yet.'
}

function errorMessage(value: string | null) {
  const messages: Record<string, string> = {
    cancelled: 'The model download was cancelled.',
    timed_out: 'The model download timed out. You can try again.',
    insufficient_disk: 'There is not enough free storage to download this model.',
    invalid_model: 'The saved model failed its integrity check. Remove it before retrying.',
    invalid_download: 'The downloaded model did not pass verification.',
    unapproved_download: 'The model download destination was not approved.',
    model_store_failed: 'The local model could not be updated.',
    busy: 'Another Local AI operation is already running.',
  }
  return value ? (messages[value] ?? 'The Local AI operation did not finish.') : ''
}

export default function LocalAiSettings() {
  const bridge = desktopLocalAiBridge()
  const [status, setStatus] =
    useState<DesktopLocalAiStatus | null>(null)
  const [error, setError] = useState('')
  const [confirmRemove, setConfirmRemove] =
    useState(false)

  async function refresh() {
    if (!bridge) return
    try {
      setStatus(await bridge.localAiStatus())
      setError('')
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not read Local AI status.',
      )
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (!bridge || status?.phase !== 'downloading') return
    const timer = window.setInterval(() => {
      void bridge.localAiStatus()
        .then(next => {
          setStatus(next)
          if (next.error) setError(errorMessage(next.error))
        })
        .catch(caught => setError(
          caught instanceof Error
            ? caught.message
            : 'Could not refresh the model download.',
        ))
    }, 750)
    return () => window.clearInterval(timer)
  }, [bridge, status?.phase])

  async function action(
    operation: () => Promise<DesktopLocalAiStatus>,
  ) {
    setError('')
    setConfirmRemove(false)
    try {
      const next = await operation()
      setStatus(next)
      if (next.error) setError(errorMessage(next.error))
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The Local AI operation did not finish.',
      )
    }
  }

  if (!bridge) {
    return (
      <div className="settings-alert" role="alert">
        Update the desktop app to a Local AI preview build to manage local models.
      </div>
    )
  }

  if (!status) {
    return (
      <div className="settings-loading" role="status">
        Checking Local AI compatibility…
      </div>
    )
  }

  const capability = status.capability
  const progress = status.progress
  const percent = progress
    ? Math.min(
        100,
        Math.round(
          progress.receivedBytes /
            progress.totalBytes *
            100,
        ),
      )
    : 0
  const busy = status.phase !== 'idle'

  return (
    <>
      <div className="settings-heading">
        <span className="settings-eyebrow">
          LOCAL AI
        </span>
        <h1>Local AI preview</h1>
        <p>
          Check this computer and manage the optional on-device model.
          Local quiz generation is still disabled until runtime and
          quality acceptance are complete.
        </p>
      </div>

      {error && (
        <div className="settings-alert" role="alert">
          {error}
        </div>
      )}

      <section className="settings-card">
        <div className="settings-card-heading">
          <div>
            <h2>Computer compatibility</h2>
            <p>
              The current policy is a development screen, not a
              published system requirement.
            </p>
          </div>
          <span className={
            capability?.localEligible
              ? 'settings-status settings-status-on'
              : 'settings-status settings-status-off'
          }>
            {capability?.localEligible
              ? 'Preview eligible'
              : 'Not eligible'}
          </span>
        </div>

        {capability?.localEligible ? (
          <>
            <p>
              Recommended preview: <strong>
                {capability.recommendation === 'enhanced-local-preview'
                  ? 'Enhanced local model'
                  : 'Lightweight local model'}
              </strong>.
            </p>
            <p>
              Available acceleration: <strong>
                {capability.acceleration === 'gpu' ? 'GPU (Vulkan)' : 'CPU'}
              </strong>
            </p>
            <p>
              Last successful inference: <strong>
                {status.lastAccelerationMode === 'gpu'
                  ? 'GPU (Vulkan)'
                  : status.lastAccelerationMode === 'cpu'
                    ? 'CPU'
                    : status.lastAccelerationMode === null
                      ? 'Not used yet'
                      : 'Not reported by this build'}
              </strong>
              {capability.acceleration === 'gpu' &&
                status.lastAccelerationMode === 'cpu' &&
                ' (GPU startup fell back to CPU)'}
            </p>
            {capability.hardware.gpuDetected &&
              !capability.hardware.gpuAccelerationUsable && (
                <p className="settings-method-note">
                  A GPU was detected, but the currently validated runtime
                  remains CPU-only.
                </p>
              )}
          </>
        ) : (
          <ul>
            {(capability?.reasons ?? ['no_eligible_local_profile'])
              .map(item => <li key={item}>{reason(item)}</li>)}
          </ul>
        )}
      </section>

      <section className="settings-card">
        <div className="settings-card-heading">
          <div>
            <h2>Local model</h2>
            <p>
              Models are downloaded separately from app updates and
              only after you explicitly choose Download.
            </p>
          </div>
          <span className={
            status.model.ready
              ? 'settings-status settings-status-on'
              : 'settings-status settings-status-off'
          }>
            {status.model.state === 'invalid'
              ? 'Needs removal'
              : status.model.ready ? 'Installed' : 'Not installed'}
          </span>
        </div>

        {status.model.metadata && (
          <div className="settings-method-note">
            <p>
              <strong>
                {status.model.metadata.displayName}
              </strong>
            </p>
            <p>
              Source: {status.model.metadata.repository}
              {' · '}License: {status.model.metadata.license}
            </p>
          </div>
        )}

        <p>
          Model size: {bytes(
            status.model.bytes ??
              capability?.requirements?.modelBytes,
          )}
        </p>

        {status.phase === 'downloading' && progress && (
          <div role="status">
            <progress value={percent} max={100} />
            <p>
              Downloading… {percent}% ({bytes(progress.receivedBytes)}
              {' '}of {bytes(progress.totalBytes)})
            </p>
          </div>
        )}

        {status.model.state === 'missing' && capability?.localEligible &&
          status.phase !== 'downloading' && (
            <button
              className="settings-primary-button"
              type="button"
              disabled={busy}
              onClick={() => void action(
                () => bridge.startLocalAiModelDownload(),
              )}
            >
              Download {status.model.metadata?.displayName ?? 'experimental model'}
            </button>
          )}

        {status.phase === 'downloading' && (
          <button
            className="settings-secondary-button"
            type="button"
            onClick={() => void action(
              () => bridge.cancelLocalAiModelDownload(),
            )}
          >
            Cancel download
          </button>
        )}

        {(status.model.ready || status.model.state === 'invalid') && !confirmRemove && (
          <button
            className="settings-secondary-button"
            type="button"
            disabled={busy}
            onClick={() => setConfirmRemove(true)}
          >
            Remove local model
          </button>
        )}

        {(status.model.ready || status.model.state === 'invalid') && confirmRemove && (
          <div>
            <p>
              Remove this model from this Windows profile?
              Study decks and offline reviews are not removed.
            </p>
            <button
              className="settings-secondary-button"
              type="button"
              disabled={busy}
              onClick={() => void action(
                () => bridge.removeLocalAiModel(),
              )}
            >
              Confirm remove model
            </button>
            <button
              className="settings-inline-action"
              type="button"
              disabled={busy}
              onClick={() => setConfirmRemove(false)}
            >
              Keep model
            </button>
          </div>
        )}

        <p className="settings-method-note">
          {status.model.metadata
            ? `The model download is distributed under ${status.model.metadata.license}. `
            : ''}
          Downloading the model does not by itself enable Local AI generation.
          This desktop build must also include the verified runtime and satisfy
          the current release gates.
        </p>
      </section>
    </>
  )
}
