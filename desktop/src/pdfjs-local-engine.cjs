'use strict'

const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { LocalDocumentProcessingError } = require('./local-document-processing.cjs')

const PDFJS_DIRECTORY = path.dirname(require.resolve('pdfjs-dist/package.json'))
const localDirectoryUrl = name => pathToFileURL(path.join(PDFJS_DIRECTORY, name) + path.sep).href

async function loadGetDocument() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjs.getDocument
}

function checkCancelled(signal) {
  if (signal?.aborted) throw new LocalDocumentProcessingError('cancelled')
}

function createPdfJsLocalEngine({ getDocument = loadGetDocument } = {}) {
  if (typeof getDocument !== 'function') throw new TypeError('A PDF.js document loader is required.')

  return Object.freeze({
    async processPdf({ bytes, selectedPages = null, limits, signal, onProgress }) {
      checkCancelled(signal)
      if (!(bytes instanceof Uint8Array) || !limits || typeof limits !== 'object') {
        throw new LocalDocumentProcessingError('invalid_input')
      }

      let loadingTask
      let document
      let onAbort
      try {
        const createDocument = await getDocument()
        checkCancelled(signal)
        if (typeof createDocument !== 'function') throw new LocalDocumentProcessingError('processing_failed')
        loadingTask = createDocument({
          data: new Uint8Array(bytes),
          cMapUrl: localDirectoryUrl('cmaps'),
          standardFontDataUrl: localDirectoryUrl('standard_fonts'),
          wasmUrl: localDirectoryUrl('wasm'),
          useWorkerFetch: false,
          useSystemFonts: true,
          isEvalSupported: false,
          enableXfa: false,
          stopAtErrors: true,
        })
        onAbort = () => { void loadingTask.destroy().catch(() => {}) }
        signal?.addEventListener('abort', onAbort, { once: true })
        checkCancelled(signal)
        document = await loadingTask.promise
        checkCancelled(signal)

        if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) {
          throw new LocalDocumentProcessingError('invalid_result')
        }
        if (document.numPages > limits.maxPages) {
          throw new LocalDocumentProcessingError('too_many_pages')
        }

        const requested = selectedPages ?? Array.from({ length: document.numPages }, (_, index) => index + 1)
        if (requested.some(pageNumber => pageNumber > document.numPages)) {
          throw new LocalDocumentProcessingError('invalid_selection')
        }

        const pages = []
        let characterCount = 0
        for (let index = 0; index < requested.length; index++) {
          checkCancelled(signal)
          const pageNumber = requested[index]
          const page = await document.getPage(pageNumber)
          try {
            const content = await page.getTextContent()
            let text = ''
            for (const item of content.items) {
              if (typeof item.str !== 'string') continue
              text += item.str
              if (item.hasEOL) text += '\n'
              else text += ' '
              characterCount += item.str.length + 1
              if (characterCount > limits.maxCharacters) {
                throw new LocalDocumentProcessingError('text_too_large')
              }
            }
            pages.push({ pageNumber, text: text.trim() })
          } finally {
            page.cleanup?.()
          }
          onProgress?.({ phase: 'extracting', completedPages: index + 1, totalPages: requested.length })
        }
        checkCancelled(signal)
        return { pageCount: document.numPages, pages }
      } catch (error) {
        checkCancelled(signal)
        if (error instanceof LocalDocumentProcessingError) throw error
        throw new LocalDocumentProcessingError('processing_failed')
      } finally {
        signal?.removeEventListener('abort', onAbort)
        await Promise.resolve(document?.destroy?.()).catch(() => {})
        await Promise.resolve(loadingTask?.destroy?.()).catch(() => {})
      }
    },
  })
}

module.exports = Object.freeze({ createPdfJsLocalEngine })
