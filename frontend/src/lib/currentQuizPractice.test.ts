import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCurrentQuizPracticeFocus,
} from './currentQuizPractice.ts'
import type {
  AnswerValue,
  QuizQuestion,
  QuizResult,
} from '../types/quiz.ts'

function question(
  type: QuizQuestion['question_type'],
  text: string,
  pages: number[],
): QuizQuestion {
  return {
    question_type: type,
    question: text,
    choices:
      type === 'short_answer'
        ? []
        : type === 'true_false'
          ? ['True', 'False']
          : ['A', 'B', 'C', 'D'],
    correct_index:
      type === 'short_answer'
        ? -1
        : 0,
    correct_answer:
      type === 'short_answer'
        ? 'answer'
        : type === 'true_false'
          ? 'True'
          : 'A',
    accepted_answers:
      type === 'short_answer'
        ? ['answer']
        : type === 'true_false'
          ? ['True']
          : ['A'],
    explanation: 'Supported by source.',
    source_pages: pages,
  }
}

function quiz(
  questions: QuizQuestion[],
): QuizResult {
  return {
    title: 'Practice',
    questions,
  }
}

function isCorrect(
  _question: QuizQuestion,
  answer: AnswerValue | undefined,
) {
  return answer === 1
}

test(
  'returns null when the current quiz has no misses',
  () => {
    const value =
      buildCurrentQuizPracticeFocus(
        quiz([
          question(
            'multiple_choice',
            'Question one',
            [1],
          ),
          question(
            'true_false',
            'Question two',
            [2],
          ),
        ]),
        {
          0: 1,
          1: 1,
        },
        isCorrect,
      )

    assert.equal(value, null)
  },
)

test(
  'preserves current-quiz weak type, pages, avoided questions, and baseline',
  () => {
    const value =
      buildCurrentQuizPracticeFocus(
        quiz([
          question(
            'multiple_choice',
            'MC correct',
            [1],
          ),
          question(
            'multiple_choice',
            'MC missed',
            [4, 2],
          ),
          question(
            'short_answer',
            'SA missed one',
            [3],
          ),
          question(
            'short_answer',
            'SA missed two',
            [2, 5],
          ),
          question(
            'short_answer',
            'SA correct',
            [6],
          ),
        ]),
        {
          0: 1,
          1: 0,
          2: 0,
          3: 0,
          4: 1,
        },
        isCorrect,
      )

    assert.deepEqual(value, {
      pages: [2, 3, 4, 5],
      questionType: 'short_answer',
      avoidQuestions: [
        'MC missed',
        'SA missed one',
        'SA missed two',
      ],
      baselinePercent: 33,
      baselineQuestionCount: 3,
    })
  },
)

test(
  'keeps the existing question-type order as the tie breaker',
  () => {
    const value =
      buildCurrentQuizPracticeFocus(
        quiz([
          question(
            'multiple_choice',
            'MC missed',
            [1],
          ),
          question(
            'true_false',
            'TF missed',
            [2],
          ),
        ]),
        {
          0: 0,
          1: 0,
        },
        isCorrect,
      )

    assert.equal(
      value?.questionType,
      'multiple_choice',
    )
  },
)
