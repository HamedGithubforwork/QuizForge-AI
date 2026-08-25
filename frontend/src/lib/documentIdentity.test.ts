// @ts-nocheck
import assert from 'node:assert/strict'

import {
  clearCurrentDocumentIdentity,
  getCurrentDocumentSha256,
  getHistoryDocumentSha256,
  matchesHistoryDocument,
  rememberCurrentDocumentIdentity,
  withDocumentIdentityInQuizData,
} from './documentIdentity.ts'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

clearCurrentDocumentIdentity()

rememberCurrentDocumentIdentity({
  filename: 'Lecture Notes.pdf',
  pdf_sha256: HASH_A.toUpperCase(),
})

assert.equal(
  getCurrentDocumentSha256(
    'lecture%20notes.pdf',
  ),
  HASH_A,
)

assert.equal(
  getCurrentDocumentSha256(
    'different.pdf',
  ),
  null,
)

const renamedHistoryRow = {
  source_filename: 'old-name.pdf',
  document_sha256: HASH_A,
  quiz_data: null,
}

assert.equal(
  matchesHistoryDocument(
    renamedHistoryRow,
    'new-name.pdf',
    HASH_A,
  ),
  true,
)

assert.equal(
  matchesHistoryDocument(
    {
      ...renamedHistoryRow,
      source_filename: 'new-name.pdf',
      document_sha256: HASH_B,
    },
    'new-name.pdf',
    HASH_A,
  ),
  false,
)

const legacyHistoryRow = {
  source_filename: 'Legacy Notes.pdf',
  document_sha256: null,
  quiz_data: null,
}

assert.equal(
  matchesHistoryDocument(
    legacyHistoryRow,
    'legacy%20notes.pdf',
    HASH_A,
  ),
  true,
)

const quizDataWithIdentity =
  withDocumentIdentityInQuizData(
    {
      title: 'Quiz',
      questions: [],
    },
    HASH_A,
  ) as {
    document_sha256: string
  }

assert.equal(
  quizDataWithIdentity.document_sha256,
  HASH_A,
)

assert.equal(
  getHistoryDocumentSha256({
    source_filename: 'renamed.pdf',
    quiz_data: quizDataWithIdentity,
  }),
  HASH_A,
)

assert.equal(
  matchesHistoryDocument(
    {
      source_filename: 'old-name.pdf',
      quiz_data: quizDataWithIdentity,
    },
    'renamed.pdf',
    HASH_A,
  ),
  true,
)

rememberCurrentDocumentIdentity({
  filename: 'Lecture Notes.pdf',
  pdf_sha256: 'not-a-hash',
})

assert.equal(
  getCurrentDocumentSha256(
    'Lecture Notes.pdf',
  ),
  null,
)

console.log(
  'documentIdentity tests passed',
)
