type UploadIdentityPayload = {
  filename?: unknown
  pdf_sha256?: unknown
}

export type HistoryDocumentIdentitySource = {
  source_filename: string
  document_sha256?: string | null
  quiz_data?: unknown
}

type CurrentDocumentIdentity = {
  filename: string
  sha256: string
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/i

let currentDocumentIdentity:
  CurrentDocumentIdentity | null = null

function getDisplayFilename(name: string) {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function normalizeFilename(name: string) {
  return getDisplayFilename(name)
    .trim()
    .toLowerCase()
}

export function normalizeDocumentSha256(
  value: unknown,
) {
  if (
    typeof value !== 'string' ||
    !SHA256_PATTERN.test(value.trim())
  ) {
    return null
  }

  return value.trim().toLowerCase()
}

export function rememberCurrentDocumentIdentity(
  payload: unknown,
) {
  if (
    typeof payload !== 'object' ||
    payload === null
  ) {
    return
  }

  const candidate =
    payload as UploadIdentityPayload

  if (
    typeof candidate.filename !== 'string'
  ) {
    return
  }

  const sha256 =
    normalizeDocumentSha256(
      candidate.pdf_sha256,
    )

  currentDocumentIdentity =
    sha256
      ? {
          filename: candidate.filename,
          sha256,
        }
      : null
}

export function clearCurrentDocumentIdentity() {
  currentDocumentIdentity = null
}

export function getCurrentDocumentSha256(
  filename?: string | null,
) {
  if (
    !filename ||
    !currentDocumentIdentity ||
    normalizeFilename(
      currentDocumentIdentity.filename,
    ) !== normalizeFilename(filename)
  ) {
    return null
  }

  return currentDocumentIdentity.sha256
}

export function getHistoryDocumentSha256(
  item: HistoryDocumentIdentitySource,
) {
  const directHash =
    normalizeDocumentSha256(
      item.document_sha256,
    )

  if (directHash) {
    return directHash
  }

  if (
    typeof item.quiz_data !== 'object' ||
    item.quiz_data === null ||
    Array.isArray(item.quiz_data)
  ) {
    return null
  }

  return normalizeDocumentSha256(
    (
      item.quiz_data as {
        document_sha256?: unknown
      }
    ).document_sha256,
  )
}

export function withDocumentIdentityInQuizData(
  quizData: unknown,
  documentSha256: string | null,
) {
  const normalizedHash =
    normalizeDocumentSha256(
      documentSha256,
    )

  if (
    !normalizedHash ||
    typeof quizData !== 'object' ||
    quizData === null ||
    Array.isArray(quizData)
  ) {
    return quizData
  }

  return {
    ...quizData,
    document_sha256: normalizedHash,
  }
}

export function matchesHistoryDocument(
  item: HistoryDocumentIdentitySource,
  currentFilename: string,
  currentDocumentSha256?: string | null,
) {
  const currentHash =
    normalizeDocumentSha256(
      currentDocumentSha256,
    )
  const historyHash =
    getHistoryDocumentSha256(item)

  if (currentHash && historyHash) {
    return currentHash === historyHash
  }

  return (
    normalizeFilename(
      item.source_filename,
    ) === normalizeFilename(currentFilename)
  )
}
