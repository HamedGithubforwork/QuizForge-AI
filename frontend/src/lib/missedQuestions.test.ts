import assert from 'node:assert/strict'
import test from 'node:test'

import {
  missedAnswerLabel,
  missedStudyQuestions,
} from './missedQuestions.ts'
import type {
  QuizHistoryRow,
} from './quizHistory.ts'

function question(
  text: string,
) {
  return {
    question_type:
      'multiple_choice' as const,
    question: text,
    choices: [
      'Wrong',
      'Correct',
    ],
    correct_index: 1,
    correct_answer: 'Correct',
    accepted_answers: [],
    explanation:
      'Because it is correct.',
    source_pages: [3],
  }
}

function row(
  id: string,
  createdAt: string,
  answer: number,
  text = 'Question?',
): QuizHistoryRow {
  return {
    id,
    user_id:
      '11111111-1111-4111-8111-111111111111',
    quiz_title:
      'Saved Quiz',
    source_filename:
      'notes.pdf',
    document_sha256:
      'a'.repeat(64),
    difficulty: 'medium',
    question_type:
      'multiple_choice',
    question_count: 1,
    score:
      answer === 1
        ? 1
        : 0,
    percentage:
      answer === 1
        ? 100
        : 0,
    quiz_data: {
      title: 'Saved Quiz',
      questions: [
        question(text),
      ],
    },
    selected_answers: {
      '0': answer,
    },
    created_at: createdAt,
  }
}

test(
  'missedStudyQuestions returns genuinely incorrect saved questions',
  () => {
    const result =
      missedStudyQuestions([
        row(
          'old-miss',
          '2026-09-20T12:00:00Z',
          0,
          'Older miss?',
        ),
        row(
          'new-miss',
          '2026-09-28T12:00:00Z',
          0,
          'Newest miss?',
        ),
        row(
          'correct',
          '2026-09-27T12:00:00Z',
          1,
          'Correct question?',
        ),
      ])

    assert.deepEqual(
      result.map(
        (item) =>
          item.question,
      ),
      [
        'Newest miss?',
        'Older miss?',
      ],
    )
  },
)

test(
  'newer correct evidence resolves an older miss for the same question',
  () => {
    const result =
      missedStudyQuestions([
        row(
          'older',
          '2026-09-20T12:00:00Z',
          0,
          'Repeated question?',
        ),
        row(
          'newer',
          '2026-09-28T12:00:00Z',
          1,
          'Repeated question?',
        ),
      ])

    assert.deepEqual(
      result,
      [],
    )
  },
)

test(
  'newer miss replaces older correct evidence and keeps source context',
  () => {
    const result =
      missedStudyQuestions([
        row(
          'older',
          '2026-09-20T12:00:00Z',
          1,
          'Repeated question?',
        ),
        row(
          'newer',
          '2026-09-28T12:00:00Z',
          0,
          'Repeated question?',
        ),
      ])

    assert.equal(
      result.length,
      1,
    )
    assert.equal(
      result[0].source_filename,
      'notes.pdf',
    )
    assert.deepEqual(
      result[0].source_pages,
      [3],
    )
    assert.equal(
      missedAnswerLabel(
        result[0],
      ),
      'Wrong',
    )
  },
)

test(
  'same question text in different documents remains separate evidence',
  () => {
    const first =
      row(
        'first',
        '2026-09-28T12:00:00Z',
        0,
        'Shared text?',
      )
    const second = {
      ...row(
        'second',
        '2026-09-28T11:00:00Z',
        0,
        'Shared text?',
      ),
      document_sha256:
        'b'.repeat(64),
      source_filename:
        'other.pdf',
    }

    assert.equal(
      missedStudyQuestions([
        first,
        second,
      ]).length,
      2,
    )
  },
)

test(
  'missed questions ignore malformed history and enforce the session limit',
  () => {
    const malformed = {
      ...row(
        'malformed',
        '2026-09-30T12:00:00Z',
        0,
      ),
      quiz_data: {
        questions: 'bad',
      },
    }

    const valid =
      Array.from(
        {
          length: 5,
        },
        (_, index) =>
          row(
            `id-${index}`,
            new Date(
              Date.UTC(
                2026,
                8,
                28,
                12,
                index,
              ),
            ).toISOString(),
            0,
            `Question ${index}?`,
          ),
      )

    const result =
      missedStudyQuestions(
        [
          malformed,
          ...valid,
        ],
        3,
      )

    assert.equal(
      result.length,
      3,
    )

    assert.throws(
      () =>
        missedStudyQuestions(
          valid,
          0,
        ),
      /between 1 and 50/,
    )
    assert.throws(
      () =>
        missedStudyQuestions(
          valid,
          51,
        ),
      /between 1 and 50/,
    )
  },
)
