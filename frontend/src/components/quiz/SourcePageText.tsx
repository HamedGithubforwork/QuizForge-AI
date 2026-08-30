import {
  useEffect,
  useState,
} from 'react'

import {
  apiFetch,
} from '../../lib/api'

const sourcePageCache =
  new Map<string, string>()

type SourcePageTextProps = {
  documentSha256: string
  pageNumber: number
  fallbackText?: string
}

function buildCacheKey(
  documentSha256: string,
  pageNumber: number,
) {
  return `${documentSha256}:${pageNumber}`
}

function SourcePageText({
  documentSha256,
  pageNumber,
  fallbackText,
}: SourcePageTextProps) {
  const cacheKey = buildCacheKey(
    documentSha256,
    pageNumber,
  )

  const [text, setText] = useState(
    () =>
      fallbackText ||
      sourcePageCache.get(cacheKey) ||
      '',
  )
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] =
    useState(!text)

  useEffect(() => {
    if (text) {
      return
    }

    let cancelled = false

    async function loadSourcePage() {
      setIsLoading(true)
      setError('')

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

        sourcePageCache.set(
          cacheKey,
          data.text,
        )

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
    cacheKey,
    documentSha256,
    pageNumber,
    text,
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
