import type { PdfJobResponse, UploadResponse } from '../types/api.generated.ts'

export function pdfErrorMessage(message: string) {
  return message.replace(/\b1 pages\b/g, '1 page')
}

export function pdfJobMessage(job: PdfJobResponse) {
  if (job.status === 'queued') return 'Your PDF is queued and will start shortly.'
  if (job.status === 'processing') {
    return job.total_pages
      ? `Processed ${job.completed_pages} of ${job.total_pages} pages.`
      : 'Checking your PDF…'
  }
  if (job.status === 'succeeded') return job.reused_pages
    ? `Your PDF is ready. Reused ${job.reused_pages} cached ${job.reused_pages === 1 ? 'page' : 'pages'}.`
    : 'Your PDF is ready.'
  if (job.status === 'cancelled') return 'PDF processing cancelled.'
  return pdfErrorMessage(job.error || 'PDF processing failed. Please try again.')
}

export function pausePdfPolling(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    const aborted = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolve()
    }, 2000)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

export async function waitForPdfJob(
  initial: PdfJobResponse,
  read: (id: string, signal: AbortSignal) => Promise<PdfJobResponse>,
  progress: (job: PdfJobResponse) => void,
  signal: AbortSignal,
  pause = pausePdfPolling,
): Promise<UploadResponse> {
  let job = initial
  while (true) {
    signal.throwIfAborted()
    progress(job)
    if (job.status === 'succeeded') {
      if (!job.result) throw new Error('The processed PDF is unavailable. Please upload it again.')
      return job.result
    }
    if (job.status === 'failed' || job.status === 'cancelled') throw new Error(pdfJobMessage(job))
    if (!/^[0-9a-f-]{36}$/i.test(job.job_id) || !['queued', 'processing'].includes(job.status)) {
      throw new Error('The PDF job response was invalid.')
    }
    const expires = Date.parse(job.expires_at)
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      throw new Error('This PDF job has expired. Please upload it again.')
    }
    await pause(signal)
    job = await read(job.job_id, signal)
  }
}
