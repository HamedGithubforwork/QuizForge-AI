import {
  useEffect,
  useState,
} from 'react'

import {
  apiFetch,
} from '../../lib/api'

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
        const response = await apiFetch(
          `/api/documents/${encodeURIComponent(
            documentSha256,
          )}/pages/${pageNumber}`,
        )

        const data =
          await response.json() as {
            detail?: string
            text?: string
          }

        if (!response.ok) {
          throw new Error(
            data.detail ||
              'Source text is unavailable.',
          )
        }

        if (
          typeof data.text !== 'string'
        ) {
          throw new Error(
            'Source text is unavailable.',
          )
        }

        if (!cancelled) {
          setText(data.text)
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
