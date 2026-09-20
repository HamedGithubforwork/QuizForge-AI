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
  pageSelection: string
  onPageSelectionChange: (value: string) => void
  supportsPageSelection: boolean
  selectionDisabled: boolean
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
  pageSelection,
  onPageSelectionChange,
  supportsPageSelection,
  selectionDisabled,
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

      {supportsPageSelection && (
        <div className="page-selection">
          <label htmlFor="pdf-page-selection">Pages to process (optional)</label>
          <input
            id="pdf-page-selection"
            type="text"
            value={pageSelection}
            onChange={event => onPageSelectionChange(event.target.value)}
            placeholder="All pages, or e.g. 1, 3-5"
            maxLength={400}
            aria-describedby="pdf-page-selection-help"
            disabled={isProcessing || selectionDisabled || !selectedFile}
          />
          <p id="pdf-page-selection-help">Leave blank for all pages. Selected pages keep their original page numbers.</p>
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
          <p>Completed text can be reused for up to 24 hours, while cache space is available. Processing jobs expire after one hour.</p>
          {!!recentJob.selected_pages?.length && <p>Selected pages: {recentJob.selected_pages.join(', ')}.</p>}
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
