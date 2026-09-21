import { useState, type FormEvent } from 'react'
import { normalizePageSelection } from '../../lib/pageSelection'
import { verifySamePdf } from '../../lib/pageChange'
import { getDisplayFilename } from '../../lib/quizPresentation'

type Props = {
  currentFile: File | null
  filename: string | null
  sourceSha256: string
  selection: string
  disabled: boolean
  onApply: (file: File, selection: string) => Promise<void>
  onCancel: () => void
}

export default function ChangePagesPanel({ currentFile, filename, sourceSha256, selection, disabled, onApply, onCancel }: Props) {
  const [nextSelection, setNextSelection] = useState(selection)
  const [reselectedFile, setReselectedFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [isApplying, setIsApplying] = useState(false)
  const busy = disabled || isApplying

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setError('')
    setIsApplying(true)
    try {
      const normalized = normalizePageSelection(nextSelection)
      const file = currentFile ?? reselectedFile
      if (!file) throw new Error('Select the original PDF to continue.')
      await verifySamePdf(file, sourceSha256)
      await onApply(file, normalized)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change pages. Please try again.')
    } finally {
      setIsApplying(false)
    }
  }

  return (
    <section className="panel" id="change-pages-panel" aria-labelledby="change-pages-title">
      <h2 id="change-pages-title">Change pages</h2>
      <p>Reuse cached pages while available and process any additional pages. Applying a new selection resets the current quiz.</p>
      <form onSubmit={handleSubmit}>
        {!currentFile && (
          <div className="page-selection">
            <label htmlFor="change-pages-file">Select the same PDF again</label>
            <p id="change-pages-file-help">Choose {getDisplayFilename(filename)}. The original file is only kept in this browser while the page is open.</p>
            <input id="change-pages-file" className="file-input" type="file" accept="application/pdf"
              aria-describedby="change-pages-file-help" disabled={busy}
              onChange={event => { setReselectedFile(event.target.files?.[0] ?? null); setError('') }} />
          </div>
        )}
        <div className="page-selection">
          <label htmlFor="change-pages-selection">New pages to process (optional)</label>
          <input id="change-pages-selection" type="text" autoFocus maxLength={400} value={nextSelection}
            aria-describedby="change-pages-help" disabled={busy}
            placeholder="All pages, or e.g. 5-15" onChange={event => setNextSelection(event.target.value)} />
          <p id="change-pages-help">Leave blank for all pages. Use original PDF page numbers.</p>
        </div>
        {error && <p role="alert" className="error-message">{error}</p>}
        <div className="change-pages-actions">
          <button className="button primary-button" type="submit" disabled={busy}>{busy ? 'Applying pages…' : 'Apply pages'}</button>
          <button className="button secondary-button" type="button" disabled={busy} onClick={onCancel}>Keep current pages</button>
        </div>
      </form>
    </section>
  )
}
