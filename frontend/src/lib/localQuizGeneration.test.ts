import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildLocalQuizRequest,
  localQuizErrorMessage,
} from './localQuizGeneration.ts'
import type {
  DesktopLocalAiQuizStatus,
} from './desktop'

const status: DesktopLocalAiQuizStatus = {
  available: true,
  reason: null,
  busy: false,
  modelId: 'qwen3-4b-q4-k-m',
  execution: 'local',
  constraints: {
    questionCount: 5,
    questionType: 'multiple_choice',
    maxSourceBytes: 8000,
  },
}

const document = {
  filename: 'notes.pdf',
  pdf_sha256:
    'a'.repeat(64),
  page_count: 2,
  character_count: 12,
  extractable_page_count: 2,
  scanned_likely: false,
  warning: null,
  pages: [
    {
      page_number: 2,
      character_count: 6,
      preview: 'first',
    },
    {
      page_number: 7,
      character_count: 6,
      preview: 'second',
    },
  ],
}

test(
  'builds a five-question MCQ request from authenticated source pages',
  async () => {
    const calls: number[] = []
    const request =
      await buildLocalQuizRequest(
        document,
        'hard',
        status,
        async (
          _sha,
          pageNumber,
        ) => {
          calls.push(pageNumber)
          return 'text ' + pageNumber
        },
      )

    assert.deepEqual(
      calls,
      [2, 7],
    )
    assert.equal(
      request.questionCount,
      5,
    )
    assert.equal(
      request.questionType,
      'multiple_choice',
    )
    assert.deepEqual(
      request.pages.map(
        page => page.pageNumber,
      ),
      [2, 7],
    )
  },
)

test(
  'rejects unavailable capability and oversized selections before generation',
  async () => {
    await assert.rejects(
      buildLocalQuizRequest(
        document,
        'medium',
        {
          ...status,
          available: false,
          reason:
            'runtime_unavailable',
        },
        async () => 'text',
      ),
      /not ready/,
    )

    await assert.rejects(
      buildLocalQuizRequest(
        {
          ...document,
          character_count: 9000,
        },
        'medium',
        status,
        async () => {
          throw new Error(
            'must not load',
          )
        },
      ),
      /too large/,
    )

    await assert.rejects(
      buildLocalQuizRequest(
        document,
        'medium',
        {
          ...status,
          constraints: {
            ...status.constraints!,
            maxSourceBytes: 4,
          },
        },
        async () => 'ééé',
      ),
      /too large/,
    )
  },
)

test(
  'maps bounded native failure codes to actionable copy',
  () => {
    assert.match(
      localQuizErrorMessage({
        ok: false,
        error:
          'quiz_validation_failed',
      }),
      /invalid quiz/,
    )
    assert.match(
      localQuizErrorMessage({
        ok: false,
        error:
          'runtime_unavailable',
      }),
      /not available/,
    )
  },
)
