import type {
  ChangeEventHandler,
  RefObject,
} from 'react'

import {
  getDisplayFilename,
} from '../../lib/quizPresentation'
import type { PdfJobResponse } from '../../types/api.generated'
import { pdfJobMessage } from '../../lib/pdfJobs'

type UploadPanelProps = {
  fileInputRef:
    RefObject<HTMLInputElement | null>
  selectedFile: File | null
  isProcessing: boolean
  onFileChange:
    ChangeEventHandler<HTMLInputElement>
  onProcessPdf: () => void
  job: PdfJobResponse | null
  recentJob: PdfJobResponse | null
  onResume: (job: PdfJobResponse) => void
  onCancel: () => void
}

function UploadPanel({
  fileInputRef,
  selectedFile,
  isProcessing,
  onFileChange,
  onProcessPdf,
  job,
  recentJob,
  onResume,
  onCancel,
}: UploadPanelProps) {
  return (
    <section className="panel upload-panel">
      <div className="section-heading">
        <span className="step-number">
          1
        </span>

        <div>
          <h2>
            Upload your study material
          </h2>

          <p>
            Select a PDF containing your
            notes.
          </p>
        </div>
      </div>

      <input
        ref={fileInputRef}
        className="file-input"
        type="file"
        accept="application/pdf"
        aria-label="Study material PDF"
        onChange={onFileChange}
        disabled={isProcessing}
      />

      {selectedFile && (
        <div className="selected-file">
          <span className="file-icon">
            PDF
          </span>

          <div>
            <strong>
              {getDisplayFilename(
                selectedFile.name,
              )}
            </strong>

            <span>
              {(
                selectedFile.size /
                1024 /
                1024
              ).toFixed(2)}{' '}
              MB
            </span>
          </div>
        </div>
      )}

      <button
        className="button primary-button"
        type="button"
        onClick={onProcessPdf}
        disabled={
          !selectedFile ||
          isProcessing
        }
      >
        {isProcessing
          ? 'Processing PDF...'
          : 'Process PDF'}
      </button>
      {job && (
        <div className="pdf-job-status">
          <p role="status">{pdfJobMessage(job)}</p>
          {isProcessing && job.status === 'processing' && job.total_pages ? (
            <progress aria-label="PDF pages processed" value={job.completed_pages} max={job.total_pages} />
          ) : null}
          {isProcessing && (
            <p>You can close this page and resume your PDF here within one hour of uploading.</p>
          )}
        </div>
      )}
      {!isProcessing && recentJob && (
        <div className="pdf-job-status">
          <button className="button secondary-button" type="button" onClick={() => onResume(recentJob)}>
            Resume {getDisplayFilename(recentJob.filename)}
          </button>
          <p>Recent PDFs are available for up to one hour after upload.</p>
        </div>
      )}
      {((isProcessing && job) || (!isProcessing && recentJob)) && (
        <button className="button secondary-button" type="button" onClick={onCancel}>
          Cancel and discard PDF
        </button>
      )}
    </section>
  )
}

export default UploadPanel
