import type {
  SourcePageResponse,
} from '../types/api.generated.ts'
import {
  apiFetch,
} from './api'
import {
  supabase,
} from './supabase'


type SourcePageCacheEntry = {
  text: string
  bytes: number
}

const SOURCE_PAGE_CACHE_MAX_ENTRIES = 32
const SOURCE_PAGE_CACHE_MAX_BYTES = 2_000_000

const sourcePageCache = new Map<
  string,
  SourcePageCacheEntry
>()

const pendingSourcePageRequests = new Map<
  string,
  Promise<string>
>()

let sourcePageCacheBytes = 0


function buildSourcePageCacheKey(
  userId: string,
  documentSha256: string,
  pageNumber: number,
) {
  return [
    userId,
    documentSha256.trim().toLowerCase(),
    pageNumber,
  ].join(':')
}


function getCachedSourcePage(
  cacheKey: string,
) {
  const entry = sourcePageCache.get(
    cacheKey,
  )

  if (!entry) {
    return null
  }

  sourcePageCache.delete(cacheKey)
  sourcePageCache.set(
    cacheKey,
    entry,
  )

  return entry.text
}


function removeOldestSourcePage() {
  const oldestKey =
    sourcePageCache.keys().next().value

  if (typeof oldestKey !== 'string') {
    return false
  }

  const entry = sourcePageCache.get(
    oldestKey,
  )

  if (entry) {
    sourcePageCacheBytes -= entry.bytes
  }

  sourcePageCache.delete(oldestKey)
  return true
}


function rememberSourcePage(
  cacheKey: string,
  text: string,
) {
  const bytes = new TextEncoder()
    .encode(text).byteLength

  if (bytes > SOURCE_PAGE_CACHE_MAX_BYTES) {
    return
  }

  const existing = sourcePageCache.get(
    cacheKey,
  )

  if (existing) {
    sourcePageCacheBytes -= existing.bytes
    sourcePageCache.delete(cacheKey)
  }

  while (
    sourcePageCache.size > 0 &&
    (
      sourcePageCache.size
        >= SOURCE_PAGE_CACHE_MAX_ENTRIES ||
      sourcePageCacheBytes + bytes
        > SOURCE_PAGE_CACHE_MAX_BYTES
    )
  ) {
    if (!removeOldestSourcePage()) {
      break
    }
  }

  if (
    sourcePageCache.size
      >= SOURCE_PAGE_CACHE_MAX_ENTRIES ||
    sourcePageCacheBytes + bytes
      > SOURCE_PAGE_CACHE_MAX_BYTES
  ) {
    return
  }

  sourcePageCache.set(
    cacheKey,
    {
      text,
      bytes,
    },
  )
  sourcePageCacheBytes += bytes
}


async function getCurrentUserId() {
  const {
    data,
    error,
  } = await supabase.auth.getSession()

  if (error) {
    throw error
  }

  const userId = data.session?.user.id

  if (!userId) {
    throw new Error(
      'Your session has expired. Please sign in again.',
    )
  }

  return userId
}


async function fetchSourcePageText(
  documentSha256: string,
  pageNumber: number,
) {
  const response = await apiFetch(
    `/api/documents/${encodeURIComponent(
      documentSha256,
    )}/pages/${pageNumber}`,
  )

  const data =
    await response.json() as Partial<
      SourcePageResponse
    > & {
      detail?: string
    }

  if (!response.ok) {
    throw new Error(
      data.detail ||
        'Source text is unavailable.',
    )
  }

  if (typeof data.text !== 'string') {
    throw new Error(
      'Source text is unavailable.',
    )
  }

  return data.text
}


export async function loadSourcePageText(
  documentSha256: string,
  pageNumber: number,
) {
  const userId = await getCurrentUserId()
  const cacheKey = buildSourcePageCacheKey(
    userId,
    documentSha256,
    pageNumber,
  )

  const cachedText = getCachedSourcePage(
    cacheKey,
  )

  if (cachedText !== null) {
    return cachedText
  }

  const pendingRequest =
    pendingSourcePageRequests.get(
      cacheKey,
    )

  if (pendingRequest) {
    return pendingRequest
  }

  const request = fetchSourcePageText(
    documentSha256,
    pageNumber,
  )

  pendingSourcePageRequests.set(
    cacheKey,
    request,
  )

  try {
    const text = await request
    rememberSourcePage(
      cacheKey,
      text,
    )
    return text
  } finally {
    pendingSourcePageRequests.delete(
      cacheKey,
    )
  }
}


export function clearSourcePageTextCache() {
  sourcePageCache.clear()
  pendingSourcePageRequests.clear()
  sourcePageCacheBytes = 0
}
