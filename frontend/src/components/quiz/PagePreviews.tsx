import type {
  UploadResult,
} from '../../types/quiz'

type PagePreviewsProps = {
  documentResult: UploadResult
}

function PagePreviews({
  documentResult,
}: PagePreviewsProps) {
  return (
    <section className="panel previews-panel">
      <h2>Page previews</h2>

      <div className="preview-grid">
        {documentResult.pages.map(
          (page) => (
            <article
              className="preview-card"
              key={page.page_number}
            >
              <div className="preview-header">
                <strong>
                  Page {page.page_number}
                </strong>

                <span>
                  {page.character_count
                    .toLocaleString()}{' '}
                  characters
                </span>
              </div>

              <p>{page.preview}</p>
            </article>
          ),
        )}
      </div>
    </section>
  )
}

export default PagePreviews
