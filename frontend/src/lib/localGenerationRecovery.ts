// Desktop IPC can stall after a local runtime crash or a lost renderer
// response. Bound the *entire* local operation (including page-text loading),
// not just llama.cpp inference, and free the interface on user cancellation.
// This never sends notes to the cloud and never retries generation silently.
export const LOCAL_GENERATION_WATCHDOG_MS = 13 * 60 * 1000

export class LocalGenerationUnresponsiveError extends Error {
  readonly code = 'local_generation_unresponsive'
  constructor() {
    super('Local AI stopped responding. The desktop was asked to cancel the task. Try again after it finishes stopping, or restart the desktop app if Local AI remains busy.')
    this.name = 'LocalGenerationUnresponsiveError'
  }
}

type RecoveryOptions = {
  signal?: AbortSignal
  cancelNative: () => Promise<unknown>
  timeoutMs?: number
}

export async function runRecoverableLocalGeneration<T>(
  task: () => Promise<T>,
  { signal, cancelNative, timeoutMs = LOCAL_GENERATION_WATCHDOG_MS }: RecoveryOptions,
): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException('Local generation cancelled.', 'AbortError')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Invalid local generation watchdog duration.')
  }

  let timeout: ReturnType<typeof setTimeout> | undefined
  let cancelRequested = false
  // The native cancellation IPC may itself never resolve. Do not await it:
  // the UI must recover even when the Electron process is unresponsive.
  const requestCancellation = () => {
    if (cancelRequested) return
    cancelRequested = true
    void Promise.resolve().then(cancelNative).catch(() => {})
  }
  let onAbort: (() => void) | undefined

  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => {
      requestCancellation()
      reject(new DOMException('Local generation cancelled.', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => {
      requestCancellation()
      reject(new LocalGenerationUnresponsiveError())
    }, timeoutMs)
  })

  try {
    // Attach both branches to Promise.race so a late IPC rejection cannot
    // become an unhandled rejection or publish a stale quiz after cancellation.
    return await Promise.race([Promise.resolve().then(task), interrupted])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}
