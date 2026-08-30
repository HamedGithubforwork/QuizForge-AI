import {
  getDisplayFilename,
} from '../../lib/quizPresentation'
import type {
  UploadResult,
} from '../../types/quiz'

type DocumentPanelProps = {
  documentResult: UploadResult
}

function DocumentPanel({
  documentResult,
}: DocumentPanelProps) {
  return (
    <section className="panel document-panel">
      <div className="success-header">
        <span className="success-icon">
          ✓
        </span>

        <div>
          <h2>
            PDF processed successfully
          </h2>

          <p>
            Your document is ready for
            quiz generation.
          </p>
        </div>
      </div>

      <div className="document-stats">
        <div className="stat-card">
          <span className="stat-label">
            File
          </span>

          <strong>
            {getDisplayFilename(
              documentResult.filename,
            )}
          </strong>
        </div>

        <div className="stat-card">
          <span className="stat-label">
            Pages
          </span>

          <strong>
            {documentResult.page_count}
          </strong>
        </div>

        <div className="stat-card">
          <span className="stat-label">
            Characters
          </span>

          <strong>
            {documentResult.character_count
              .toLocaleString()}
          </strong>
        </div>
      </div>

      {documentResult.warning && (
        <div className="scan-warning">
          <strong>
            Possible scanned PDF
          </strong>

          <p>
            {documentResult.warning}
          </p>

          <span>
            Extractable pages:{' '}
            {
              documentResult
                .extractable_page_count
            }{' '}
            / {documentResult.page_count}
          </span>
        </div>
      )}
    </section>
  )
}

export default DocumentPanel
