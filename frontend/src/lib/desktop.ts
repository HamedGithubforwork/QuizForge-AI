import type { Quiz } from '../types/api.generated.ts'
export type DesktopLocalAiQuizStatus = {
  available: boolean
  reason:
    | 'unsupported_platform'
    | 'insufficient_memory'
    | 'insufficient_disk'
    | 'runtime_acceleration_unavailable'
    | 'no_eligible_local_profile'
    | 'model_missing'
    | 'invalid_model'
    | 'runtime_invalid'
    | 'runtime_unavailable'
    | null
  busy: boolean
  modelId?: string
  execution?: 'local'
  constraints?: {
    questionCount: 5
    questionType: 'multiple_choice'
    maxSourceBytes: number
  }
}

export type DesktopLocalQuizRequest = {
  pages: Array<{ pageNumber: number; text: string }>
  questionCount: 5
  difficulty: 'easy' | 'medium' | 'hard'
  questionType: 'multiple_choice'
  practice?: {
    avoidQuestions: string[]
  }
}

export type DesktopLocalQuizResult =
  | { ok: true; quiz: Quiz }
  | {
      ok: false
      error:
        | 'cancelled'
        | 'timed_out'
        | 'busy'
        | 'model_missing'
        | 'invalid_model'
        | 'runtime_invalid'
        | 'runtime_unavailable'
        | 'source_too_large'
        | 'unsupported_quiz_mode'
        | 'quiz_validation_failed'
        | 'insufficient_source'
        | 'invalid_request'
        | 'invalid_response'
        | 'generation_failed'
    }

export type DesktopLocalAiStatus = {
  lastAccelerationMode?: 'cpu' | 'gpu' | null
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
  model: {
    state: 'missing' | 'ready' | 'invalid'
    ready: boolean
    bytes: number | null
    metadata?: {
      id: string
      displayName: string
      repository: string
      license: string
    } | null
  }
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
  loadSourcePageText?(request: { documentSha256: string; pageNumber: number }): Promise<string>
  reminderStatus(): Promise<{ supported: boolean; enabled: boolean }>
  enableReminders(): Promise<void>
  disableReminders(): Promise<void>
  localAiStatus?(): Promise<DesktopLocalAiStatus>
  startLocalAiModelDownload?(): Promise<DesktopLocalAiStatus>
  cancelLocalAiModelDownload?(): Promise<DesktopLocalAiStatus>
  removeLocalAiModel?(): Promise<DesktopLocalAiStatus>
  localAiQuizStatus?(): Promise<DesktopLocalAiQuizStatus>
  generateLocalAiQuiz?(request: DesktopLocalQuizRequest): Promise<DesktopLocalQuizResult>
  cancelLocalAiQuiz?(): Promise<void>
  openAccountWebsite(): Promise<void>
}
declare global { interface Window { quizFromNotesDesktop?: DesktopBridge } }
export function desktopBridge() {
  return typeof window !== 'undefined' && window.quizFromNotesDesktop?.version === 1
    ? window.quizFromNotesDesktop : undefined
}

export type DesktopSourceTextBridge = DesktopBridge & {
  loadSourcePageText(request: {
    documentSha256: string
    pageNumber: number
  }): Promise<string>
}

export function desktopSourceTextBridge(
  bridge = desktopBridge(),
): DesktopSourceTextBridge | undefined {
  if (!bridge) return undefined
  const candidate = bridge as DesktopSourceTextBridge
  return typeof candidate.loadSourcePageText === 'function'
    ? candidate
    : undefined
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
export type DesktopLocalQuizBridge = DesktopLocalAiBridge & {
  localAiQuizStatus(): Promise<DesktopLocalAiQuizStatus>
  generateLocalAiQuiz(request: DesktopLocalQuizRequest): Promise<DesktopLocalQuizResult>
  cancelLocalAiQuiz(): Promise<void>
}

export function desktopLocalQuizBridge(
  bridge = desktopLocalAiBridge(),
): DesktopLocalQuizBridge | undefined {
  if (!bridge) return undefined
  const candidate = bridge as DesktopLocalQuizBridge
  return [
    candidate.localAiQuizStatus,
    candidate.generateLocalAiQuiz,
    candidate.cancelLocalAiQuiz,
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
