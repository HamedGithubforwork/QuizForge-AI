import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../lib/api'
import { rememberCurrentDocumentIdentity } from '../lib/documentIdentity'
import { waitForPdfJob } from '../lib/pdfJobs'
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
  const operation = useRef<AbortController | null>(null)
  const revision = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    const initialRevision = revision.current
    void apiFetch('/api/documents/jobs', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) return
        const data = await response.json()
        if (!controller.signal.aborted && initialRevision === revision.current) {
          setRecentJob(data.jobs?.find((item: PdfJobResponse) => ['queued', 'processing', 'succeeded'].includes(item.status)) ?? null)
        }
      }).catch(() => { /* Optional resume discovery; regular uploads remain available. */ })
    return () => {
      controller.abort()
      operation.current?.abort()
    }
  }, [])

  async function run(file?: File, resume?: PdfJobResponse) {
    operation.current?.abort()
    const controller = new AbortController()
    operation.current = controller
    revision.current += 1
    setIsProcessing(true)
    setJob(null)
    try {
      let data: UploadResponse | PdfJobResponse
      if (resume) {
        data = await readJob(resume.job_id, controller.signal)
      } else {
        const formData = new FormData()
        if (!file) throw new Error('Please choose a PDF first.')
        formData.append('file', file)
        const response = await apiFetch('/api/documents/upload', {
          method: 'POST', body: formData,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
        })
        data = await response.json()
        if (!response.ok) throw new Error((data as { detail?: string }).detail || 'PDF processing failed.')
      }
      controller.signal.throwIfAborted()
      const result = 'job_id' in data
        ? await waitForPdfJob(data, readJob, next => {
          setJob(next)
          setRecentJob(next)
        }, controller.signal)
        : data
      controller.signal.throwIfAborted()
      rememberCurrentDocumentIdentity(result)
      setRecentJob(null)
      return result
    } catch (error) {
      if (controller.signal.aborted) throw new DOMException('Polling stopped.', 'AbortError')
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
  }

  return { isProcessing, job, recentJob, run, cancel, clear }
}
