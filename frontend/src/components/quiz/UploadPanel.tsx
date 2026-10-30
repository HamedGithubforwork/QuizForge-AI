import { useState } from 'react'
import type {
  DragEvent,
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
  onFileSelected: (file: File | null) => void
  onProcessPdf: () => void
  job: PdfJobResponse | null
  recentJob: PdfJobResponse | null
  onResume: (job: PdfJobResponse) => void
  onCancel: () => void
  pageSelection: string
  onPageSelectionChange: (value: string) => void
  supportsPageSelection: boolean
  localProcessing: boolean
  localAiAvailable: boolean
  processedLocally: boolean
  selectionDisabled: boolean
  hidePageSelection: boolean
  isChangingPages: boolean
}

function UploadPanel({
  fileInputRef,
  selectedFile,
  isProcessing,
  onFileSelected,
  onProcessPdf,
  job,
  recentJob,
  onResume,
  onCancel,
  pageSelection,
  onPageSelectionChange,
  supportsPageSelection,
  localProcessing,
  localAiAvailable,
  processedLocally,
  selectionDisabled,
  hidePageSelection,
  isChangingPages,
}: UploadPanelProps) {
  const [dropError, setDropError] = useState('')

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (isProcessing || selectionDisabled) return
    const files = Array.from(event.dataTransfer.files)
    const pdf = files.find(file =>
      file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'),
    )
    if (!pdf) {
      setDropError(files.length ? 'Please choose a PDF file.' : 'Drop a PDF file to continue.')
      return
    }
    setDropError('')
    onFileSelected(pdf)
  }

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
          {processedLocally && (
            <p className="local-processing-note" role="status">Processed on this computer. The PDF has not been uploaded.</p>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        id="study-material-pdf"
        className="file-input-hidden"
        type="file"
        accept="application/pdf"
        aria-label="Study material PDF"
        onChange={event => {
          setDropError('')
          onFileSelected(event.currentTarget.files?.[0] ?? null)
          event.currentTarget.value = ''
        }}
        disabled={isProcessing || selectionDisabled}
      />

      <div
        className="upload-dropzone"
        role="group"
        aria-labelledby="upload-dropzone-title"
        aria-describedby="upload-dropzone-note"
        onDragOver={event => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={handleDrop}
        aria-label="PDF upload area. Drop a PDF here or use Browse files."
      >
        <svg className="upload-dropzone-icon" viewBox="0 0 48 48" aria-hidden="true">
          <path d="M13 5h15l9 9v27H13z" fill="currentColor" opacity=".12" />
          <path d="M28 5v10h9M13 5h15l9 9v27H13z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
          <path d="M18 27h14M18 33h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          <text x="16" y="23" fill="currentColor" fontSize="7" fontWeight="800">PDF</text>
        </svg>
        <p className="upload-dropzone-title" id="upload-dropzone-title">
          Drop a PDF here, or{' '}
          <button
            className="upload-inline-browse"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing || selectionDisabled}
          >
            browse files
          </button>
        </p>
        <span className="upload-dropzone-note" id="upload-dropzone-note">
          {localProcessing
            ? 'PDF files only · Processed locally on this computer'
            : localAiAvailable
              ? 'PDF files only · Choose Local AI to process on this computer'
              : 'PDF files only · Processing begins after you continue'}
        </span>
        {dropError && <p className="upload-dropzone-error" role="alert">{dropError}</p>}
        <button
          className="upload-browse-button"
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isProcessing || selectionDisabled}
        >
          Browse files
        </button>
      </div>

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

      {supportsPageSelection && !hidePageSelection && (
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
          isProcessing || selectionDisabled
        }
      >
        {isProcessing
          ? 'Processing PDF...'
          : localProcessing ? 'Process PDF on this computer' : 'Process PDF'}
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
          <button className="button secondary-button" type="button" disabled={selectionDisabled} onClick={() => onResume(recentJob)}>
            Resume {getDisplayFilename(recentJob.filename)}
          </button>
          <p>Completed text can be reused for up to 24 hours, while cache space is available. Processing jobs expire after one hour.</p>
          {!!recentJob.selected_pages?.length && <p>Selected pages: {recentJob.selected_pages.join(', ')}.</p>}
        </div>
      )}
      {((isProcessing && (job || localProcessing)) || (!isProcessing && recentJob)) && (
        <button className="button secondary-button" type="button" onClick={onCancel}>
          {isChangingPages ? 'Cancel page change' : 'Cancel and discard PDF'}
        </button>
      )}
    </section>
  )
}

export default UploadPanel
