import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildWeakDeckAiFocus,
  generateWeakDeckPracticeQuiz,
  practiceCardsFromQuiz,
} from './deckAiPractice.ts'
import type {
  CardRow,
  DeckDetail,
} from '../types/api.generated.ts'
import type {
  QuizResult,
} from '../types/quiz.ts'

const DECK_ID =
  '11111111-1111-4111-8111-111111111111'

function card(
  id: string,
  documentSha256:
    string | null,
  changes:
    Partial<CardRow> = {},
): CardRow {
  return {
    question_type:
      'multiple_choice',
    question:
      'Question ' + id,
    answer: {
      correct_answer:
        'Answer ' + id,
      correct_index: 1,
    },
    choices: [
      'Wrong',
      'Answer ' + id,
    ],
    explanation: null,
    source_filename:
      'notes.pdf',
    document_sha256:
      documentSha256,
    source_pages: [3],
    tags: [],
    id,
    deck_id: DECK_ID,
    fsrs_state: 2,
    fsrs_step: null,
    stability: 5,
    difficulty: 6.5,
    due_at:
      '2026-09-28T12:00:00Z',
    last_reviewed_at:
      '2026-09-27T12:00:00Z',
    review_count: 4,
    lapse_count: 1,
    suspended: false,
    progress_reset_at: null,
    created_at:
      '2026-09-20T12:00:00Z',
    updated_at:
      '2026-09-28T12:00:00Z',
    ...changes,
  }
}

function deck(
  cards: CardRow[],
): DeckDetail {
  return {
    id: DECK_ID,
    name: 'Biology',
    description: null,
    card_count:
      cards.length,
    due_count: 0,
    next_due_at: null,
    created_at:
      '2026-09-20T12:00:00Z',
    updated_at:
      '2026-09-28T12:00:00Z',
    cards,
  }
}

test(
  'buildWeakDeckAiFocus selects the dominant weak source and its evidence',
  () => {
    const a =
      'a'.repeat(64)
    const b =
      'b'.repeat(64)

    const focus =
      buildWeakDeckAiFocus(
        deck([
          card(
            'a-1',
            a,
            {
              question:
                'Cell question',
              source_pages:
                [4, 2],
              lapse_count: 2,
              review_count: 4,
              difficulty: 7.5,
            },
          ),
          card(
            'a-2',
            a,
            {
              question:
                'ATP question',
              source_pages:
                [4, 6],
              question_type:
                'short_answer',
              lapse_count: 1,
              review_count: 3,
            },
          ),
          card(
            'b-1',
            b,
            {
              lapse_count: 4,
              review_count: 5,
            },
          ),
        ]),
      )

    assert.ok(focus)
    assert.equal(
      focus.documentSha256,
      a,
    )
    assert.equal(
      focus.weakCardCount,
      2,
    )
    assert.deepEqual(
      focus.sourcePages,
      [2, 4, 6],
    )
    assert.deepEqual(
      focus.weakQuestions,
      [
        'Cell question',
        'ATP question',
      ],
    )
    assert.equal(
      focus.questionMode,
      'mixed',
    )
    assert.deepEqual(
      focus.focusQuestionTypes,
      [
        'multiple_choice',
        'short_answer',
      ],
    )
    assert.equal(
      focus.difficulty,
      'easy',
    )
  },
)

test(
  'buildWeakDeckAiFocus ignores weak cards without a saved source hash',
  () => {
    const focus =
      buildWeakDeckAiFocus(
        deck([
          card(
            'manual',
            null,
            {
              lapse_count: 3,
            },
          ),
        ]),
      )

    assert.equal(
      focus,
      null,
    )
  },
)

test(
  'moderately difficult cards generate medium practice',
  () => {
    const focus =
      buildWeakDeckAiFocus(
        deck([
          card(
            'hard',
            'c'.repeat(64),
            {
              review_count: 4,
              lapse_count: 0,
              difficulty: 6.4,
            },
          ),
        ]),
      )

    assert.ok(focus)
    assert.equal(
      focus.difficulty,
      'medium',
    )
    assert.equal(
      focus.questionMode,
      'multiple_choice',
    )
  },
)

test(
  'generateWeakDeckPracticeQuiz sends saved document identity and focus evidence',
  async () => {
    const focus =
      buildWeakDeckAiFocus(
        deck([
          card(
            'weak',
            'd'.repeat(64),
          ),
        ]),
      )
    assert.ok(focus)

    let path = ''
    const bodies:
      FormData[] = []

    const quiz =
      await generateWeakDeckPracticeQuiz(
        focus,
        async (
          requestPath,
          init,
        ) => {
          path = requestPath
          bodies.push(
            init?.body as FormData,
          )

          return new Response(
            JSON.stringify({
              title:
                'Practice',
              questions: [],
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
      '/api/quizzes/generate',
    )
    const body = bodies[0]
    assert.ok(body)
    assert.equal(
      body.get(
        'document_sha256',
      ),
      'd'.repeat(64),
    )
    assert.equal(
      body.get(
        'question_count',
      ),
      '5',
    )
    assert.equal(
      body.get(
        'focus_pages',
      ),
      '3',
    )
    assert.deepEqual(
      JSON.parse(
        String(
          body.get(
            'avoid_questions',
          ),
        ),
      ),
      ['Question weak'],
    )
    assert.equal(
      quiz.title,
      'Practice',
    )
  },
)

test(
  'practiceCardsFromQuiz creates new FSRS-ready cards with source provenance',
  () => {
    const focus =
      buildWeakDeckAiFocus(
        deck([
          card(
            'weak',
            'e'.repeat(64),
          ),
        ]),
      )
    assert.ok(focus)

    const quiz: QuizResult = {
      title: 'Practice',
      questions: [
        {
          question_type:
            'short_answer',
          question:
            'New question',
          choices: [],
          correct_index: -1,
          correct_answer:
            'New answer',
          accepted_answers: [
            'New answer',
          ],
          grading: {
            grading_version: 2,
            grading_mode:
              'exact',
            answer_groups: [],
            required_group_count: 0,
            numeric_value: 0,
            numeric_tolerance: 0,
            numeric_unit: '',
          },
          explanation:
            'Explanation',
          source_pages: [3],
        },
      ],
    }

    const cards =
      practiceCardsFromQuiz(
        quiz,
        focus,
      )

    assert.equal(
      cards.length,
      1,
    )
    assert.equal(
      cards[0].document_sha256,
      'e'.repeat(64),
    )
    assert.equal(
      cards[0].source_filename,
      'notes.pdf',
    )
    assert.deepEqual(
      cards[0].tags,
      ['ai-practice'],
    )
    assert.deepEqual(
      cards[0].source_pages,
      [3],
    )
  },
)
