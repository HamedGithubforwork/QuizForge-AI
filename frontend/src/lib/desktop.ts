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
  openAccountWebsite(): Promise<void>
}
declare global { interface Window { quizFromNotesDesktop?: DesktopBridge } }
export function desktopBridge() {
  return typeof window !== 'undefined' && window.quizFromNotesDesktop?.version === 1
    ? window.quizFromNotesDesktop : undefined
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
