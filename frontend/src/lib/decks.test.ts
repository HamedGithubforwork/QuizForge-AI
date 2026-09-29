import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addCardsToStudyDeck,
  deleteStudyCard,
  deleteStudyDeck,
  duplicateStudyDeck,
  buildDeckCreatePayload,
  buildSelectedDeckCards,
  createStudyDeck,
  getReviewQueue,
  getStudyDeck,
  listStudyDecks,
  moveStudyCard,
  resetStudyCardProgress,
  resumeStudyCard,
  suspendStudyCard,
  submitReview,
  updateStudyCard,
  updateStudyDeck,
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
    {
      question_type:
        'true_false',
      question:
        'Ribosomes synthesize proteins.',
      choices: [
        'True',
        'False',
      ],
      correct_index: 0,
      correct_answer:
        'True',
      accepted_answers: [
        'True',
      ],
      grading: {
        grading_version: 2,
        grading_mode: 'exact',
        answer_groups: [
          ['True'],
        ],
        required_group_count: 1,
        numeric_value: 0,
        numeric_tolerance: 0,
        numeric_unit: '',
      },
      explanation:
        'Ribosomes are responsible for protein synthesis.',
      source_pages: [7],
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
      2,
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
      study_intensity: 'balanced',
      card_count: 1,
      due_count: 1,
      next_due_at: null,
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

test(
  'listStudyDecks loads deck summaries',
  async () => {
    let path = ''

    const decks =
      await listStudyDecks(
        async (requestPath) => {
          path = requestPath
          return new Response(
            JSON.stringify([
              {
                id: '11111111-1111-4111-8111-111111111111',
                name: 'Biology Midterm',
                description: null,
                study_intensity: 'balanced',
                card_count: 12,
                due_count: 4,
                next_due_at: null,
                created_at:
                  '2026-09-27T15:00:00Z',
                updated_at:
                  '2026-09-27T15:30:00Z',
              },
            ]),
            {
              status: 200,
              headers: {
                'Content-Type':
                  'application/json',
              },
            },
          )
        },
      )

    assert.equal(path, '/api/decks')
    assert.equal(decks.length, 1)
    assert.equal(
      decks[0].card_count,
      12,
    )
    assert.equal(
      decks[0].due_count,
      4,
    )
  },
)

test(
  'getStudyDeck encodes the deck id and loads cards',
  async () => {
    let path = ''

    const deck =
      await getStudyDeck(
        'deck/id',
        async (requestPath) => {
          path = requestPath
          return new Response(
            JSON.stringify({
              id: '11111111-1111-4111-8111-111111111111',
              name: 'Biology Midterm',
              description: null,
              card_count: 1,
              created_at:
                '2026-09-27T15:00:00Z',
              updated_at:
                '2026-09-27T15:30:00Z',
              cards: [
                {
                  question_type:
                    'short_answer',
                  question:
                    'What is ATP?',
                  answer: {
                    correct_answer:
                      'Adenosine triphosphate',
                  },
                  choices: null,
                  explanation: null,
                  source_filename:
                    'biology.pdf',
                  document_sha256:
                    'a'.repeat(64),
                  source_pages: [3, 5],
                  id: '22222222-2222-4222-8222-222222222222',
                  deck_id:
                    '11111111-1111-4111-8111-111111111111',
                  created_at:
                    '2026-09-27T15:00:00Z',
                  updated_at:
                    '2026-09-27T15:00:00Z',
                },
              ],
            }),
            {
              status: 200,
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
      '/api/decks/deck%2Fid',
    )
    assert.equal(
      deck.cards[0]
        .source_pages?.join(','),
      '3,5',
    )
  },
)

test(
  'deck reads use safe fallback errors for empty failures',
  async () => {
    await assert.rejects(
      () =>
        listStudyDecks(
          async () =>
            new Response(null, {
              status: 503,
            }),
        ),
      /Could not load your study decks/,
    )

    await assert.rejects(
      () =>
        getStudyDeck(
          'missing',
          async () =>
            new Response(null, {
              status: 404,
            }),
        ),
      /Could not load this study deck/,
    )
  },
)

test(
  'getReviewQueue requests bounded due cards',
  async () => {
    let path = ''

    const queue =
      await getReviewQueue(
        'deck/id',
        async (requestPath) => {
          path = requestPath
          return new Response(
            JSON.stringify({
              deck_id:
                '11111111-1111-4111-8111-111111111111',
              deck_name:
                'Biology Midterm',
              study_intensity:
                'intensive',
              due_count: 1,
              next_due_at: null,
              cards: [],
            }),
            {
              status: 200,
              headers: {
                'Content-Type':
                  'application/json',
              },
            },
          )
        },
        12,
      )

    assert.equal(
      path,
      '/api/decks/deck%2Fid/review?limit=12',
    )
    assert.equal(
      queue.due_count,
      1,
    )
    assert.equal(
      queue.study_intensity,
      'intensive',
    )
  },
)

test(
  'submitReview posts the FSRS rating and duration',
  async () => {
    let path = ''
    let init: RequestInit = {}

    const result =
      await submitReview(
        'deck/id',
        {
          card_id:
            '22222222-2222-4222-8222-222222222222',
          rating: 3,
          review_duration_ms: 1400,
        },
        async (
          requestPath,
          requestInit,
        ) => {
          path = requestPath
          init = requestInit ?? {}

          return new Response(
            JSON.stringify({
              card: {
                question_type:
                  'short_answer',
                question:
                  'What is ATP?',
                answer: {
                  correct_answer:
                    'Adenosine triphosphate',
                },
                choices: null,
                explanation: null,
                source_filename:
                  'biology.pdf',
                document_sha256:
                  'a'.repeat(64),
                source_pages: [3],
                id:
                  '22222222-2222-4222-8222-222222222222',
                deck_id:
                  '11111111-1111-4111-8111-111111111111',
                fsrs_state: 1,
                fsrs_step: 1,
                stability: 2,
                difficulty: 5,
                due_at:
                  '2026-09-27T18:00:00Z',
                last_reviewed_at:
                  '2026-09-27T17:50:00Z',
                review_count: 1,
                lapse_count: 0,
                created_at:
                  '2026-09-27T17:00:00Z',
                updated_at:
                  '2026-09-27T17:50:00Z',
              },
              remaining_due_count: 0,
              next_due_at:
                '2026-09-27T18:00:00Z',
            }),
            {
              status: 200,
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
      '/api/decks/deck%2Fid/review',
    )
    assert.equal(
      init.method,
      'POST',
    )
    assert.deepEqual(
      JSON.parse(
        String(init.body),
      ),
      {
        card_id:
          '22222222-2222-4222-8222-222222222222',
        rating: 3,
        review_duration_ms: 1400,
      },
    )
    assert.equal(
      result.card.review_count,
      1,
    )
  },
)

test(
  'buildSelectedDeckCards keeps only unique selected questions in quiz order',
  () => {
    const cards =
      buildSelectedDeckCards(
        quiz,
        documentResult,
        [1, 0, 1],
      )

    assert.equal(
      cards.length,
      2,
    )
    assert.equal(
      cards[0].question,
      'What organelle produces ATP?',
    )
    assert.equal(
      cards[1].question,
      'Ribosomes synthesize proteins.',
    )
  },
)

test(
  'buildSelectedDeckCards rejects empty or invalid selections',
  () => {
    assert.throws(
      () =>
        buildSelectedDeckCards(
          quiz,
          documentResult,
          [],
        ),
      /Choose at least one valid quiz question/,
    )

    assert.throws(
      () =>
        buildSelectedDeckCards(
          quiz,
          documentResult,
          [99],
        ),
      /Choose at least one valid quiz question/,
    )
  },
)

test(
  'addCardsToStudyDeck posts selected cards to an existing deck',
  async () => {
    let path = ''
    let init: RequestInit = {}

    const responseBody = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Biology Midterm',
      description: null,
      study_intensity: 'balanced',
      card_count: 2,
      due_count: 2,
      next_due_at: null,
      created_at:
        '2026-09-27T15:00:00Z',
      updated_at:
        '2026-09-28T08:00:00Z',
      cards: [],
    }

    const cards =
      buildSelectedDeckCards(
        quiz,
        documentResult,
        [1],
      )

    const result =
      await addCardsToStudyDeck(
        responseBody.id,
        cards,
        async (
          requestPath,
          requestInit,
        ) => {
          path = requestPath
          init =
            requestInit ?? {}

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
      '/api/decks/11111111-1111-4111-8111-111111111111/cards',
    )
    assert.equal(
      init.method,
      'POST',
    )
    assert.deepEqual(
      JSON.parse(
        String(init.body),
      ),
      {
        cards,
      },
    )
    assert.equal(
      result.card_count,
      2,
    )
  },
)

test(
  'addCardsToStudyDeck rejects an empty card list before the request',
  async () => {
    let called = false

    await assert.rejects(
      () =>
        addCardsToStudyDeck(
          'deck-id',
          [],
          async () => {
            called = true
            return new Response()
          },
        ),
      /Choose at least one question/,
    )

    assert.equal(
      called,
      false,
    )
  },
)

test(
  'updateStudyDeck sends a PATCH with only the requested fields',
  async () => {
    let path = ''
    let init: RequestInit = {}

    const result =
      await updateStudyDeck(
        'deck/id',
        {
          name:
            'Renamed Biology',
        },
        async (
          requestPath,
          requestInit,
        ) => {
          path = requestPath
          init =
            requestInit ?? {}

          return new Response(
            JSON.stringify({
              id:
                '11111111-1111-4111-8111-111111111111',
              name:
                'Renamed Biology',
              description: null,
              card_count: 2,
              due_count: 1,
              next_due_at: null,
              created_at:
                '2026-09-27T15:00:00Z',
              updated_at:
                '2026-09-28T12:00:00Z',
              cards: [],
            }),
            {
              status: 200,
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
      '/api/decks/deck%2Fid',
    )
    assert.equal(
      init.method,
      'PATCH',
    )
    assert.deepEqual(
      JSON.parse(
        String(init.body),
      ),
      {
        name:
          'Renamed Biology',
      },
    )
    assert.equal(
      result.name,
      'Renamed Biology',
    )
  },
)

test(
  'updateStudyDeck can set and clear an exam date',
  async () => {
    const bodies: unknown[] = []

    const fetcher = async (
      _path: string,
      init?: RequestInit,
    ) => {
      bodies.push(
        JSON.parse(
          String(init?.body),
        ),
      )

      const payload =
        bodies.at(-1) as {
          exam_date:
            string | null
        }

      return new Response(
        JSON.stringify({
          id:
            '11111111-1111-4111-8111-111111111111',
          name:
            'Biology Midterm',
          description: null,
          exam_date:
            payload.exam_date,
          study_intensity:
            'balanced',
          card_count: 0,
          due_count: 0,
          next_due_at: null,
          created_at:
            '2026-09-27T15:00:00Z',
          updated_at:
            '2026-09-28T12:00:00Z',
          cards: [],
        }),
        {
          status: 200,
          headers: {
            'Content-Type':
              'application/json',
          },
        },
      )
    }

    const saved =
      await updateStudyDeck(
        'deck',
        {
          exam_date:
            '2026-12-15',
        },
        fetcher,
      )
    const cleared =
      await updateStudyDeck(
        'deck',
        {
          exam_date: null,
        },
        fetcher,
      )

    assert.deepEqual(
      bodies,
      [
        {
          exam_date:
            '2026-12-15',
        },
        {
          exam_date: null,
        },
      ],
    )
    assert.equal(
      saved.exam_date,
      '2026-12-15',
    )
    assert.equal(
      cleared.exam_date,
      null,
    )
  },
)

test(
  'deleteStudyDeck sends DELETE and accepts an empty 204 response',
  async () => {
    let path = ''
    let init: RequestInit = {}

    await deleteStudyDeck(
      'deck/id',
      async (
        requestPath,
        requestInit,
      ) => {
        path = requestPath
        init =
          requestInit ?? {}
        return new Response(
          null,
          {
            status: 204,
          },
        )
      },
    )

    assert.equal(
      path,
      '/api/decks/deck%2Fid',
    )
    assert.equal(
      init.method,
      'DELETE',
    )
  },
)

test(
  'updateStudyDeck sends only the requested study intensity',
  async () => {
    let body: unknown = null

    const updated =
      await updateStudyDeck(
        'deck',
        {
          study_intensity:
            'intensive',
        },
        async (
          _path,
          init,
        ) => {
          body = JSON.parse(
            String(init?.body),
          )

          return new Response(
            JSON.stringify({
              id:
                '11111111-1111-4111-8111-111111111111',
              name:
                'Biology Midterm',
              description: null,
              exam_date: null,
              study_intensity:
                'intensive',
              card_count: 0,
              due_count: 0,
              next_due_at: null,
              created_at:
                '2026-09-27T15:00:00Z',
              updated_at:
                '2026-09-29T03:00:00Z',
              cards: [],
            }),
            {
              status: 200,
              headers: {
                'Content-Type':
                  'application/json',
              },
            },
          )
        },
      )

    assert.deepEqual(
      body,
      {
        study_intensity:
          'intensive',
      },
    )
    assert.equal(
      updated.study_intensity,
      'intensive',
    )
  },
)

test(
  'deck mutation clients surface bounded fallback errors',
  async () => {
    await assert.rejects(
      () =>
        updateStudyDeck(
          'deck',
          {
            name: 'New name',
          },
          async () =>
            new Response(null, {
              status: 503,
            }),
        ),
      /Could not update this study deck/,
    )

    await assert.rejects(
      () =>
        deleteStudyDeck(
          'deck',
          async () =>
            new Response(null, {
              status: 503,
            }),
        ),
      /Could not delete this study deck/,
    )
  },
)

test(
  'duplicateStudyDeck posts to the duplicate endpoint and returns the new deck',
  async () => {
    let path = ''
    let init: RequestInit = {}

    const result =
      await duplicateStudyDeck(
        'deck/id',
        {},
        async (
          requestPath,
          requestInit,
        ) => {
          path = requestPath
          init =
            requestInit ?? {}

          return new Response(
            JSON.stringify({
              id:
                '33333333-3333-4333-8333-333333333333',
              name:
                'Copy of Biology Midterm',
              description:
                'Cell biology',
              card_count: 2,
              due_count: 2,
              next_due_at: null,
              created_at:
                '2026-09-28T12:00:00Z',
              updated_at:
                '2026-09-28T12:00:00Z',
              cards: [],
            }),
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
      '/api/decks/deck%2Fid/duplicate',
    )
    assert.equal(
      init.method,
      'POST',
    )
    assert.deepEqual(
      JSON.parse(
        String(init.body),
      ),
      {},
    )
    assert.equal(
      result.name,
      'Copy of Biology Midterm',
    )
  },
)

test(
  'duplicateStudyDeck surfaces a bounded fallback error',
  async () => {
    await assert.rejects(
      () =>
        duplicateStudyDeck(
          'deck',
          {},
          async () =>
            new Response(null, {
              status: 503,
            }),
        ),
      /Could not duplicate this study deck/,
    )
  },
)

test(
  'updateStudyCard patches an owned card',
  async () => {
    let path = ''
    let init: RequestInit = {}

    const result =
      await updateStudyCard(
        'deck/id',
        'card/id',
        {
          question:
            'Updated question?',
          explanation: null,
        },
        async (
          requestPath,
          requestInit,
        ) => {
          path = requestPath
          init =
            requestInit ?? {}

          return new Response(
            JSON.stringify({
              id:
                '11111111-1111-4111-8111-111111111111',
              name:
                'Biology Midterm',
              description: null,
              card_count: 1,
              due_count: 1,
              next_due_at: null,
              created_at:
                '2026-09-27T15:00:00Z',
              updated_at:
                '2026-09-28T12:00:00Z',
              cards: [],
            }),
            {
              status: 200,
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
      '/api/decks/deck%2Fid/cards/card%2Fid',
    )
    assert.equal(
      init.method,
      'PATCH',
    )
    assert.deepEqual(
      JSON.parse(
        String(init.body),
      ),
      {
        question:
          'Updated question?',
        explanation: null,
      },
    )
    assert.equal(
      result.card_count,
      1,
    )
  },
)

test(
  'deleteStudyCard sends DELETE and accepts an empty response',
  async () => {
    let path = ''
    let init: RequestInit = {}

    await deleteStudyCard(
      'deck/id',
      'card/id',
      async (
        requestPath,
        requestInit,
      ) => {
        path = requestPath
        init =
          requestInit ?? {}

        return new Response(
          null,
          {
            status: 204,
          },
        )
      },
    )

    assert.equal(
      path,
      '/api/decks/deck%2Fid/cards/card%2Fid',
    )
    assert.equal(
      init.method,
      'DELETE',
    )
  },
)

test(
  'card mutation clients use bounded fallback errors',
  async () => {
    await assert.rejects(
      () =>
        updateStudyCard(
          'deck',
          'card',
          {
            question:
              'Updated',
          },
          async () =>
            new Response(null, {
              status: 503,
            }),
        ),
      /Could not update this study card/,
    )

    await assert.rejects(
      () =>
        deleteStudyCard(
          'deck',
          'card',
          async () =>
            new Response(null, {
              status: 503,
            }),
        ),
      /Could not delete this study card/,
    )
  },
)

test(
  'moveStudyCard posts the target deck and returns the refreshed source deck',
  async () => {
    let path = ''
    let init: RequestInit = {}

    const result =
      await moveStudyCard(
        'source/deck',
        'card/id',
        {
          target_deck_id:
            '33333333-3333-4333-8333-333333333333',
        },
        async (
          requestPath,
          requestInit,
        ) => {
          path = requestPath
          init =
            requestInit ?? {}

          return new Response(
            JSON.stringify({
              id:
                '11111111-1111-4111-8111-111111111111',
              name:
                'Source',
              description: null,
              card_count: 0,
              due_count: 0,
              next_due_at: null,
              created_at:
                '2026-09-28T10:00:00Z',
              updated_at:
                '2026-09-28T11:00:00Z',
              cards: [],
            }),
            {
              status: 200,
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
      '/api/decks/source%2Fdeck/cards/card%2Fid/move',
    )
    assert.equal(
      init.method,
      'POST',
    )
    assert.deepEqual(
      JSON.parse(
        String(init.body),
      ),
      {
        target_deck_id:
          '33333333-3333-4333-8333-333333333333',
      },
    )
    assert.equal(
      result.card_count,
      0,
    )
  },
)

test(
  'moveStudyCard surfaces a bounded fallback error',
  async () => {
    await assert.rejects(
      () =>
        moveStudyCard(
          'source',
          'card',
          {
            target_deck_id:
              'target',
          },
          async () =>
            new Response(
              null,
              {
                status: 503,
              },
            ),
        ),
      /Could not move this study card/,
    )
  },
)

test(
  'card study-state actions POST to owned card routes',
  async () => {
    const calls: string[] = []

    const fetcher = async (
      path: string,
      init?: RequestInit,
    ) => {
      calls.push(
        `${init?.method ?? 'GET'} ${path}`,
      )
      return new Response(
        JSON.stringify({
          id:
            '11111111-1111-4111-8111-111111111111',
          name: 'Deck',
          description: null,
          card_count: 1,
          due_count: 0,
          next_due_at: null,
          created_at:
            '2026-09-28T10:00:00Z',
          updated_at:
            '2026-09-28T12:00:00Z',
          cards: [],
        }),
        {
          status: 200,
          headers: {
            'Content-Type':
              'application/json',
          },
        },
      )
    }

    await suspendStudyCard(
      'deck/id',
      'card/id',
      fetcher,
    )
    await resumeStudyCard(
      'deck/id',
      'card/id',
      fetcher,
    )
    await resetStudyCardProgress(
      'deck/id',
      'card/id',
      fetcher,
    )

    assert.deepEqual(
      calls,
      [
        'POST /api/decks/deck%2Fid/cards/card%2Fid/suspend',
        'POST /api/decks/deck%2Fid/cards/card%2Fid/resume',
        'POST /api/decks/deck%2Fid/cards/card%2Fid/reset-progress',
      ],
    )
  },
)

test(
  'card study-state actions use bounded fallback errors',
  async () => {
    const fail = async () =>
      new Response(null, {
        status: 503,
      })

    await assert.rejects(
      () =>
        suspendStudyCard(
          'deck',
          'card',
          fail,
        ),
      /Could not suspend this study card/,
    )
    await assert.rejects(
      () =>
        resumeStudyCard(
          'deck',
          'card',
          fail,
        ),
      /Could not resume this study card/,
    )
    await assert.rejects(
      () =>
        resetStudyCardProgress(
          'deck',
          'card',
          fail,
        ),
      /Could not reset this study card progress/,
    )
  },
)

