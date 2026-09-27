import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDeckCreatePayload,
  createStudyDeck,
} from './decks.ts'
import type {
  QuizResult,
  UploadResult,
} from '../types/quiz.ts'

const quiz: QuizResult = {
  title: 'Cell Biology',
  questions: [
    {
      question_type:
        'multiple_choice',
      question:
        'What organelle produces ATP?',
      choices: [
        'Nucleus',
        'Mitochondria',
        'Ribosome',
      ],
      correct_index: 1,
      correct_answer:
        'Mitochondria',
      accepted_answers: [
        'Mitochondria',
      ],
      grading: {
        grading_version: 2,
        grading_mode: 'exact',
        answer_groups: [
          ['Mitochondria'],
        ],
        required_group_count: 1,
        numeric_value: 0,
        numeric_tolerance: 0,
        numeric_unit: '',
      },
      explanation:
        'Mitochondria perform cellular respiration.',
      source_pages: [14, 12],
    },
  ],
}

const documentResult: UploadResult = {
  filename: 'biology.pdf',
  pdf_sha256: 'a'.repeat(64),
  page_count: 20,
  character_count: 5000,
  extractable_page_count: 20,
  scanned_likely: false,
  warning: null,
  pages: [],
}

test(
  'buildDeckCreatePayload preserves generated answer metadata and all source pages',
  () => {
    const payload =
      buildDeckCreatePayload(
        '  Biology Midterm  ',
        quiz,
        documentResult,
      )

    assert.equal(
      payload.name,
      'Biology Midterm',
    )
    assert.equal(
      payload.cards?.length,
      1,
    )

    const card = payload.cards?.[0]
    assert.deepEqual(
      card?.source_pages,
      [14, 12],
    )
    assert.equal(
      card?.source_filename,
      'biology.pdf',
    )
    assert.equal(
      card?.document_sha256,
      'a'.repeat(64),
    )
    assert.deepEqual(
      card?.answer,
      {
        correct_index: 1,
        correct_answer:
          'Mitochondria',
        accepted_answers: [
          'Mitochondria',
        ],
        grading:
          quiz.questions[0]
            .grading,
      },
    )
  },
)

test(
  'createStudyDeck posts the atomic deck payload',
  async () => {
    let path = ''
    let init: RequestInit = {}

    const responseBody = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Biology Midterm',
      description: null,
      card_count: 1,
      created_at:
        '2026-09-27T15:00:00Z',
      updated_at:
        '2026-09-27T15:00:00Z',
      cards: [],
    }

    const result =
      await createStudyDeck(
        {
          name: 'Biology Midterm',
          cards: [],
        },
        async (
          requestPath,
          requestInit,
        ) => {
          path = requestPath
          init = requestInit ?? {}
          return new Response(
            JSON.stringify(
              responseBody,
            ),
            {
              status: 201,
              headers: {
                'Content-Type':
                  'application/json',
              },
            },
          )
        },
      )

    assert.equal(
      path,
      '/api/decks',
    )
    assert.equal(
      init.method,
      'POST',
    )
    assert.equal(
      new Headers(
        init.headers,
      ).get('Content-Type'),
      'application/json',
    )
    assert.deepEqual(
      JSON.parse(
        String(init.body),
      ),
      {
        name: 'Biology Midterm',
        cards: [],
      },
    )
    assert.equal(
      result.id,
      responseBody.id,
    )
  },
)

test(
  'createStudyDeck surfaces the API detail without leaking response internals',
  async () => {
    await assert.rejects(
      () =>
        createStudyDeck(
          {
            name: 'Deck',
            cards: [],
          },
          async () =>
            new Response(
              JSON.stringify({
                detail:
                  'Study deck access is not provisioned.',
              }),
              {
                status: 403,
                headers: {
                  'Content-Type':
                    'application/json',
                },
              },
            ),
        ),
      /Study deck access is not provisioned/,
    )
  },
)
