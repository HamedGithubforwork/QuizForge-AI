import {
  useEffect,
  useState,
} from 'react'

import {
  loadSourcePageText,
} from '../../lib/sourcePageCache'

type SourcePageTextProps = {
  documentSha256: string
  pageNumber: number
}

function SourcePageText({
  documentSha256,
  pageNumber,
}: SourcePageTextProps) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] =
    useState(true)

  useEffect(() => {
    let cancelled = false

    async function loadSourcePage() {
      setText('')
      setError('')
      setIsLoading(true)

      try {
        const sourceText =
          await loadSourcePageText(
            documentSha256,
            pageNumber,
          )

        if (!cancelled) {
          setText(sourceText)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'Source text is unavailable.',
          )
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    void loadSourcePage()

    return () => {
      cancelled = true
    }
  }, [
    documentSha256,
    pageNumber,
  ])

  if (text) {
    return (
      <p className="source-page-text">
        {text}
      </p>
    )
  }

  if (isLoading) {
    return (
      <p className="source-page-text">
        Loading source text...
      </p>
    )
  }

  return (
    <p className="source-page-text">
      {error || 'Source text unavailable.'}
    </p>
  )
}

export default SourcePageText
