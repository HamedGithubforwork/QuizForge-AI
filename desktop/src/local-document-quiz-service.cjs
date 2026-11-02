'use strict'

const { createHash } = require('node:crypto')
const { MAX_SOURCE_BYTES } = require('./local-quiz-service.cjs')
const { LocalAiError } = require('./local-ai-provider.cjs')
const { LocalDocumentProcessingError } = require('./local-document-processing.cjs')

const MAX_SELECTED_PAGES = 20
const encoder = new TextEncoder()
const REQUEST_KEYS = new Set([
  'bytes', 'filename', 'selectedPages', 'difficulty', 'questionCount', 'questionType',
])
const ERROR_MESSAGES = Object.freeze({
  cancelled: 'Local document quiz generation was cancelled.',
  invalid_request: 'The local PDF quiz request is invalid.',
  insufficient_source: 'Not enough selectable text was found on these PDF pages. Scanned images and diagrams are not yet readable by Local AI. Try a text-based PDF or run OCR first.',
  source_too_large: 'Select fewer PDF pages for local quiz generation.',
  too_many_pages: 'This PDF has too many pages for local processing.',
  document_too_large: 'This PDF is too large for local processing.',
  processing_failed: 'The PDF could not be processed on this computer.',
  generation_failed: 'Local quiz generation failed.',
})

class LocalDocumentQuizError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.processing_failed)
    this.name = 'LocalDocumentQuizError'
    this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'processing_failed'
  }
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new LocalDocumentQuizError('cancelled')
}

function normalizeRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !REQUEST_KEYS.has(key)) ||
      !(value.bytes instanceof Uint8Array) ||
      (value.selectedPages != null && (!Array.isArray(value.selectedPages) ||
        value.selectedPages.length < 1 || value.selectedPages.length > MAX_SELECTED_PAGES ||
        value.selectedPages.some(page => !Number.isSafeInteger(page) || page < 1) ||
        new Set(value.selectedPages).size !== value.selectedPages.length)) ||
      !['easy', 'medium', 'hard'].includes(value.difficulty) ||
      ![5, 10, 15].includes(value.questionCount) ||
      !['multiple_choice', 'true_false', 'short_answer', 'mixed'].includes(value.questionType)) {
    throw new LocalDocumentQuizError('invalid_request')
  }
  return value
}

function validateProcessedDocument(document) {
  if (!document || document.processing !== 'local' ||
      !/^[a-f0-9]{64}$/.test(document.pdfSha256) ||
      !Number.isSafeInteger(document.pageCount) || document.pageCount < 1 ||
      !Array.isArray(document.pages) || document.pages.length < 1 ||
      document.scannedLikely === true) {
    throw new LocalDocumentQuizError('insufficient_source')
  }
  if (document.pages.length > MAX_SELECTED_PAGES) throw new LocalDocumentQuizError('source_too_large')

  const pageNumbers = new Set()
  let sourceBytes = 0
  for (const page of document.pages) {
    if (!page || !Number.isSafeInteger(page.pageNumber) || page.pageNumber < 1 ||
        page.pageNumber > document.pageCount || pageNumbers.has(page.pageNumber) ||
        typeof page.text !== 'string' || !page.text.trim()) {
      throw new LocalDocumentQuizError('processing_failed')
    }
    pageNumbers.add(page.pageNumber)
    sourceBytes += encoder.encode(page.text).byteLength
    if (sourceBytes > MAX_SOURCE_BYTES) throw new LocalDocumentQuizError('source_too_large')
  }
  return document.pages.map(page => Object.freeze({ pageNumber: page.pageNumber, text: page.text }))
}

function createLocalDocumentQuizService({ documentProcessor, quizService } = {}) {
  if (!documentProcessor || typeof documentProcessor.processPdf !== 'function' ||
      !quizService || typeof quizService.generate !== 'function') {
    throw new TypeError('Local document processing and quiz services are required.')
  }

  // One validated source selection only, kept in memory. Never persist PDF
  // text, model output or quiz answers; a different selection misses the cache.
  // Call clearCache on account changes and sign-out.
  let lastSource = null
  function clearCache() { lastSource = null }
  return Object.freeze({
    clearCache,
    async generate(value, { signal, onProgress } = {}) {
      abortIfNeeded(signal)
      const request = normalizeRequest(value)
      const selection = [...(request.selectedPages ?? [])].sort((a, b) => a - b)
      const digest = createHash('sha256').update(request.bytes).digest('hex') + ':' + selection.join(',')
      let document
      let pages
      if (lastSource?.key === digest) {
        document = lastSource.document
        pages = lastSource.pages
      } else try {
        document = await documentProcessor.processPdf({
          bytes: request.bytes,
          filename: request.filename ?? null,
          selectedPages: request.selectedPages ?? null,
        }, { signal, onProgress })
      } catch (error) {
        abortIfNeeded(signal)
        if (error instanceof LocalDocumentQuizError) throw error
        if (error instanceof LocalDocumentProcessingError && error.code === 'invalid_selection') {
          throw new LocalDocumentQuizError('invalid_request')
        }
        if (error?.code === 'input_too_large') throw new LocalDocumentQuizError('document_too_large')
        if (error?.code === 'too_many_pages') throw new LocalDocumentQuizError('too_many_pages')
        if (error?.code === 'text_too_large') throw new LocalDocumentQuizError('source_too_large')
        throw new LocalDocumentQuizError('processing_failed')
      }
      abortIfNeeded(signal)

      if (!pages) {
        pages = validateProcessedDocument(document)
        // Only bounded source excerpts stay resident, never a PDF byte buffer.
        lastSource = { key: digest, document: {
          pdfSha256: document.pdfSha256, pageCount: document.pageCount,
        }, pages }
      }
      let quiz
      try {
        quiz = await quizService.generate({
          pages,
          questionCount: request.questionCount,
          difficulty: request.difficulty,
          questionType: request.questionType,
        }, { signal })
      } catch (error) {
        abortIfNeeded(signal)
        if (error instanceof LocalAiError) throw error
        throw new LocalDocumentQuizError('generation_failed')
      }
      abortIfNeeded(signal)

      return Object.freeze({
        processing: 'local',
        documentSha256: document.pdfSha256,
        pageCount: document.pageCount,
        selectedPages: Object.freeze(pages.map(page => page.pageNumber)),
        quiz,
      })
    },
  })
}

module.exports = Object.freeze({
  MAX_SELECTED_PAGES,
  LocalDocumentQuizError,
  createLocalDocumentQuizService,
})
