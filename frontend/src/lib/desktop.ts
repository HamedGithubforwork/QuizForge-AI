export type DesktopLocalAiStatus = {
  initialized: boolean
  phase: 'idle' | 'checking' | 'downloading' | 'removing'
  progress: { receivedBytes: number; totalBytes: number } | null
  error: string | null
  capability: {
    localEligible: boolean
    recommendation: 'enhanced-local-preview' | 'lightweight-local-preview' | 'cloud-only'
    modelId: string | null
    acceleration: 'cpu' | 'gpu' | null
    releaseReady: boolean
    reasons: string[]
    hardware: { gpuDetected: boolean; gpuAccelerationUsable: boolean }
    requirements: { modelBytes: number; diskRequiredBytes: number } | null
  } | null
  model: { state: 'missing' | 'ready' | 'invalid'; ready: boolean; bytes: number | null }
}
export type DesktopAccount = { userId: string; email: string; enrolled: boolean }
type DesktopRequest = { path: string; method: string; body?: string; form?: Array<
  { name: string; value: string } | { name: string; bytes: Uint8Array; filename: string }
> }
export type DesktopBridge = {
  version: 1
  status(): Promise<{ available: boolean; account: DesktopAccount | null }>
  signIn(): Promise<DesktopAccount>
  signOut(): Promise<void>
  request(request: DesktopRequest): Promise<{ status: number; body: string; contentType: string }>
  reminderStatus(): Promise<{ supported: boolean; enabled: boolean }>
  enableReminders(): Promise<void>
  disableReminders(): Promise<void>
  localAiStatus?(): Promise<DesktopLocalAiStatus>
  startLocalAiModelDownload?(): Promise<DesktopLocalAiStatus>
  cancelLocalAiModelDownload?(): Promise<DesktopLocalAiStatus>
  removeLocalAiModel?(): Promise<DesktopLocalAiStatus>
  openAccountWebsite(): Promise<void>
}
declare global { interface Window { quizFromNotesDesktop?: DesktopBridge } }
export function desktopBridge() {
  return typeof window !== 'undefined' && window.quizFromNotesDesktop?.version === 1
    ? window.quizFromNotesDesktop : undefined
}

export type DesktopLocalAiBridge = DesktopBridge & {
  localAiStatus(): Promise<DesktopLocalAiStatus>
  startLocalAiModelDownload(): Promise<DesktopLocalAiStatus>
  cancelLocalAiModelDownload(): Promise<DesktopLocalAiStatus>
  removeLocalAiModel(): Promise<DesktopLocalAiStatus>
}

export function desktopLocalAiBridge(
  bridge = desktopBridge(),
): DesktopLocalAiBridge | undefined {
  if (!bridge) return undefined
  const candidate = bridge as DesktopLocalAiBridge
  return [
    candidate.localAiStatus,
    candidate.startLocalAiModelDownload,
    candidate.cancelLocalAiModelDownload,
    candidate.removeLocalAiModel,
  ].every(method => typeof method === 'function')
    ? candidate
    : undefined
}
export async function desktopFetch(bridge: DesktopBridge, path: string, init: RequestInit): Promise<Response> {
  init.signal?.throwIfAborted()
  const request: DesktopRequest = { path, method: init.method || 'GET' }
  if (init.body instanceof FormData) {
    request.form = []
    let size = 0
    for (const [name, value] of init.body.entries()) {
      size += typeof value === 'string' ? new TextEncoder().encode(value).length : value.size
      if (size > 32 * 1024 * 1024) throw new Error('This desktop request is too large.')
      request.form.push(typeof value === 'string' ? { name, value }
        : { name, filename: value.name, bytes: new Uint8Array(await value.arrayBuffer()) })
    }
  } else if (typeof init.body === 'string') request.body = init.body
  else if (init.body != null) throw new Error('This desktop request format is not supported.')
  init.signal?.throwIfAborted()
  const result = await bridge.request(request)
  init.signal?.throwIfAborted()
  return new Response([204, 205, 304].includes(result.status) || !result.body ? null : result.body,
    { status: result.status, headers: { 'Content-Type': result.contentType } })
}
