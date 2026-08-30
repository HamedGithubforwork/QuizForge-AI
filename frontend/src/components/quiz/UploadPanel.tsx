import type {
  ChangeEventHandler,
  RefObject,
} from 'react'

import {
  getDisplayFilename,
} from '../../lib/quizPresentation'

type UploadPanelProps = {
  fileInputRef:
    RefObject<HTMLInputElement | null>
  selectedFile: File | null
  isProcessing: boolean
  onFileChange:
    ChangeEventHandler<HTMLInputElement>
  onProcessPdf: () => void
}

function UploadPanel({
  fileInputRef,
  selectedFile,
  isProcessing,
  onFileChange,
  onProcessPdf,
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
        onChange={onFileChange}
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
    </section>
  )
}

export default UploadPanel
