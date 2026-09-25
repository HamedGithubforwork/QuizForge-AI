import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../lib/api'
import { rememberCurrentDocumentIdentity } from '../lib/documentIdentity'
import { waitForPdfJob } from '../lib/pdfJobs'
import { normalizePageSelection } from '../lib/pageSelection'
import type { PdfJobResponse, UploadResponse } from '../types/api.generated'

async function readJob(id: string, signal: AbortSignal): Promise<PdfJobResponse> {
  const response = await apiFetch(`/api/documents/jobs/${id}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.detail || 'Could not check your PDF. You can resume it below.')
  return data
}

export function usePdfUpload() {
  const [isProcessing, setIsProcessing] = useState(false)
  const [job, setJob] = useState<PdfJobResponse | null>(null)
  const [recentJob, setRecentJob] = useState<PdfJobResponse | null>(null)
  const [supportsPageSelection, setSupportsPageSelection] = useState(false)
  const [supportsPageReuse, setSupportsPageReuse] = useState(false)
  const [supportsCachedSelection, setSupportsCachedSelection] = useState(false)
  const [sourceSha256, setSourceSha256] = useState<string | null>(null)
  const operation = useRef<AbortController | null>(null)
  const revision = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    const initialRevision = revision.current
    void apiFetch('/api/documents/jobs', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) return
        const data = await response.json()
        if (!controller.signal.aborted) {
          setSupportsPageSelection(data.supports_page_selection === true)
          setSupportsPageReuse(data.supports_page_reuse === true)
          setSupportsCachedSelection(data.supports_cached_selection === true)
        }
        if (!controller.signal.aborted && initialRevision === revision.current) {
          setRecentJob(data.jobs?.find((item: PdfJobResponse) => ['queued', 'processing', 'succeeded'].includes(item.status)) ?? null)
        }
      }).catch(() => { /* Optional resume discovery; regular uploads remain available. */ })
    return () => {
      controller.abort()
      operation.current?.abort()
    }
  }, [])

  async function run(file?: File, resume?: PdfJobResponse, pageSelection = '', reuseSource?: string) {
    operation.current?.abort()
    const controller = new AbortController()
    operation.current = controller
    revision.current += 1
    setIsProcessing(true)
    setJob(null)
    try {
      let data: UploadResponse | PdfJobResponse | null = null
      if (resume) {
        data = await readJob(resume.job_id, controller.signal)
      } else if (reuseSource && supportsCachedSelection) {
        const response = await apiFetch('/api/documents/jobs/reuse', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_sha256: reuseSource, page_selection: normalizePageSelection(pageSelection) }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        })
        const cached = await response.json()
        if (!response.ok) throw new Error(cached.detail || 'Could not check cached pages. Please try again.')
        data = cached
      }
      if (!data) {
        const formData = new FormData()
        if (!file) throw new Error(reuseSource
          ? 'Some selected pages are not cached. Select the original PDF to process them.'
          : 'Please choose a PDF first.')
        const selection = normalizePageSelection(pageSelection)
        formData.append('file', file)
        if (selection) formData.append('page_selection', selection)
        const response = await apiFetch('/api/documents/upload', {
          method: 'POST', body: formData,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
        })
        data = await response.json()
        if (!response.ok) throw new Error((data as { detail?: string }).detail || 'PDF processing failed.')
      }
      controller.signal.throwIfAborted()
      if (!data) throw new Error('The processed PDF response was invalid. Please try again.')
      let completedSource: string | null = null
      const result = 'job_id' in data
        ? await waitForPdfJob(data, readJob, next => {
          if (next.status === 'succeeded') completedSource = next.source_sha256 ?? null
          setJob(next)
          setRecentJob(['queued', 'processing', 'succeeded'].includes(next.status) ? next : null)
        }, controller.signal)
        : data
      controller.signal.throwIfAborted()
      setSourceSha256(completedSource)
      rememberCurrentDocumentIdentity(result)
      setRecentJob(null)
      return result
    } catch (error) {
      if (controller.signal.aborted) throw new DOMException('Polling stopped.', 'AbortError')
      // Terminal failures are rendered by the caller. Keeping the failed job
      // here would show the same message twice (job status + page error).
      setJob(null)
      throw error
    } finally {
      if (operation.current === controller) {
        operation.current = null
        setIsProcessing(false)
      }
    }
  }

  async function cancel() {
    const target = job ?? recentJob
    if (!target) return
    const response = await apiFetch(`/api/documents/jobs/${target.job_id}`, { method: 'DELETE', signal: AbortSignal.timeout(15000) })
    if (!response.ok && response.status !== 404) throw new Error('Could not cancel processing. Please try again.')
    operation.current?.abort()
    setJob({ ...target, status: 'cancelled', result: null })
    setRecentJob(null)
  }

  function clear() {
    revision.current += 1
    setJob(null)
    setSourceSha256(null)
  }

  return { isProcessing, job, recentJob, supportsPageSelection, supportsPageReuse, supportsCachedSelection, sourceSha256, run, cancel, clear }
}
