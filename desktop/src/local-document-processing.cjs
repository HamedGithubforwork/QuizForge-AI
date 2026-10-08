'use strict'

const { createHash } = require('node:crypto')

const MAX_LOCAL_PDF_BYTES = 15 * 1024 * 1024
const DEFAULT_LIMITS = Object.freeze({
  maxPdfBytes: MAX_LOCAL_PDF_BYTES,
  maxPages: 100,
  maxCharacters: 3_000_000,
  minExtractableCharacters: 100,
  scanCharactersPerPage: 50,
  minExtractablePageCharacters: 20,
})

const ERROR_MESSAGES = Object.freeze({
  cancelled: 'Local PDF processing was cancelled.',
  invalid_input: 'Choose a valid PDF file.',
  invalid_selection: 'Choose valid PDF pages to process.',
  input_too_large: 'This PDF is too large for local processing.',
  too_many_pages: 'This PDF has too many pages for local processing.',
  text_too_large: 'This PDF contains too much readable text to process at once.',
  invalid_result: 'The local PDF processor returned invalid page data.',
  processing_failed: 'The PDF could not be processed on this computer.',
})

class LocalDocumentProcessingError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.processing_failed)
    this.name = 'LocalDocumentProcessingError'
    this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'processing_failed'
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new LocalDocumentProcessingError('cancelled')
}

function validateLimits(limits) {
  const result = { ...DEFAULT_LIMITS, ...limits }
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`Invalid local PDF limit: ${name}`)
    }
  }
  return Object.freeze(result)
}

function normalizePages(pages, maximum) {
  if (pages == null) return null
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > maximum) {
    throw new LocalDocumentProcessingError('invalid_selection')
  }
  const normalized = [...pages]
  if (normalized.some(page => !Number.isSafeInteger(page) || page < 1) || new Set(normalized).size !== normalized.length) {
    throw new LocalDocumentProcessingError('invalid_selection')
  }
  return Object.freeze(normalized.sort((a, b) => a - b))
}

function safeFilename(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new LocalDocumentProcessingError('invalid_input')
  }
  return value.replaceAll('\\', '/').split('/').at(-1) || null
}

function isPdf(bytes) {
  const header = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 1024))).toString('latin1')
  return header.includes('%PDF-')
}

function normalizedProgress(onProgress) {
  if (typeof onProgress !== 'function') return () => {}
  return value => {
    if (!value || !['opening', 'extracting', 'ocr', 'complete'].includes(value.phase) ||
      !Number.isSafeInteger(value.totalPages) || value.totalPages < 1 ||
      !Number.isSafeInteger(value.completedPages) || value.completedPages < 0 ||
      value.completedPages > value.totalPages) return
    try {
      onProgress(Object.freeze({
        phase: value.phase,
        completedPages: value.completedPages,
        totalPages: value.totalPages,
      }))
    } catch {
      // A view closing or a progress callback failing must not fail processing.
    }
  }
}

function validateEngineResult(result, selectedPages, limits) {
  if (!result || !Number.isSafeInteger(result.pageCount) || result.pageCount < 1 ||
    result.pageCount > limits.maxPages || !Array.isArray(result.pages)) {
    throw new LocalDocumentProcessingError('invalid_result')
  }
  const expected = selectedPages ?? Array.from({ length: result.pageCount }, (_, index) => index + 1)
  if (selectedPages?.some(page => page > result.pageCount) || result.pages.length !== expected.length) {
    throw new LocalDocumentProcessingError('invalid_result')
  }
  const pages = result.pages.map((page, index) => {
    if (!page || page.pageNumber !== expected[index] || typeof page.text !== 'string' ||
      !Number.isSafeInteger(page.text.length)) {
      throw new LocalDocumentProcessingError('invalid_result')
    }
    return Object.freeze({ pageNumber: page.pageNumber, text: page.text })
  })
  const characterCount = pages.reduce((total, page) => total + page.text.length, 0)
  if (characterCount > limits.maxCharacters) throw new LocalDocumentProcessingError('invalid_result')
  return { pageCount: result.pageCount, pages, characterCount }
}

function createLocalDocumentProcessor({ engine, limits: inputLimits } = {}) {
  if (!engine || typeof engine.processPdf !== 'function') {
    throw new TypeError('A local PDF engine is required.')
  }
  const limits = validateLimits(inputLimits)

  async function processPdf({ bytes, filename = null, selectedPages = null } = {}, { signal, onProgress } = {}) {
    throwIfAborted(signal)
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8) {
      throw new LocalDocumentProcessingError('invalid_input')
    }
    if (bytes.byteLength > limits.maxPdfBytes) {
      throw new LocalDocumentProcessingError('input_too_large')
    }
    if (!isPdf(bytes)) throw new LocalDocumentProcessingError('invalid_input')

    const pages = normalizePages(selectedPages, limits.maxPages)
    if (pages?.some(page => page > limits.maxPages)) {
      throw new LocalDocumentProcessingError('invalid_selection')
    }
    const displayName = safeFilename(filename)
    const pdfSha256 = createHash('sha256').update(bytes).digest('hex')
    const progress = normalizedProgress(onProgress)
    let result
    try {
      result = await engine.processPdf({
        bytes: new Uint8Array(bytes),
        selectedPages: pages,
        limits,
        signal,
        onProgress: value => {
          if (value && Number.isSafeInteger(value.totalPages) && value.totalPages >= 1 && value.totalPages <= limits.maxPages) {
            progress(value)
          }
        },
      })
    } catch (error) {
      throwIfAborted(signal)
      if (error instanceof LocalDocumentProcessingError) throw error
      throw new LocalDocumentProcessingError('processing_failed')
    }
    throwIfAborted(signal)

    const processed = validateEngineResult(result, pages, limits)
    const extractablePageCount = processed.pages.filter(page => page.text.trim().length >= limits.minExtractablePageCharacters).length
    const scannedLikely = processed.characterCount < Math.max(
      limits.minExtractableCharacters,
      processed.pages.length * limits.scanCharactersPerPage,
    )
    return Object.freeze({
      filename: displayName,
      pdfSha256,
      pageCount: processed.pageCount,
      selectedPageCount: processed.pages.length,
      characterCount: processed.characterCount,
      extractablePageCount,
      scannedLikely,
      warning: scannedLikely
        ? 'Very little readable text was detected after local processing. This PDF may need clearer scans or local OCR support.'
        : null,
      pages: Object.freeze(processed.pages),
      processing: 'local',
    })
  }

  return Object.freeze({ processPdf })
}

module.exports = Object.freeze({
  MAX_LOCAL_PDF_BYTES,
  LocalDocumentProcessingError,
  createLocalDocumentProcessor,
})
