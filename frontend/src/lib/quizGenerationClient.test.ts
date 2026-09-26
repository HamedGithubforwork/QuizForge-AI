// @ts-nocheck
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildQuizGenerationFormData,
  requestQuizGeneration,
} from './quizGenerationClient.ts'

function makeFile() {
  return new File(
    ['pdf-bytes'],
    'notes.pdf',
    {
      type: 'application/pdf',
    },
  )
}

test(
  'builds the standard quiz-generation request fields',
  () => {
    const form =
      buildQuizGenerationFormData({
        file: makeFile(),
        questionCount: 10,
        difficulty: 'hard',
        questionType: 'mixed',
      })

    assert.equal(
      form.get('file')?.name,
      'notes.pdf',
    )
    assert.equal(
      form.get('question_count'),
      '10',
    )
    assert.equal(
      form.get('difficulty'),
      'hard',
    )
    assert.equal(
      form.get('question_type'),
      'mixed',
    )
    assert.equal(
      form.has('focus_pages'),
      false,
    )
    assert.equal(
      form.has('avoid_questions'),
      false,
    )
  },
)

test(
  'adds weak-area focus fields without changing the common request',
  () => {
    const form =
      buildQuizGenerationFormData({
        file: makeFile(),
        questionCount: 5,
        difficulty: 'medium',
        questionType: 'short_answer',
        focusPages: [2, 7],
        focusQuestionTypes: [
          'short_answer',
        ],
        avoidQuestions: [
          'Old question?',
        ],
      })

    assert.equal(
      form.get('focus_pages'),
      '2,7',
    )
    assert.equal(
      form.get(
        'focus_question_types',
      ),
      'short_answer',
    )
    assert.equal(
      form.get('avoid_questions'),
      JSON.stringify([
        'Old question?',
      ]),
    )
  },
)

test(
  'posts to the shared endpoint and returns parsed quiz data',
  async () => {
    const expected = {
      title: 'Generated Quiz',
      questions: [],
    }
    let observedPath = ''
    let observedInit

    const result =
      await requestQuizGeneration(
        async (path, init) => {
          observedPath = path
          observedInit = init
          return new Response(
            JSON.stringify(expected),
            {
              status: 200,
              headers: {
                'Content-Type':
                  'application/json',
              },
            },
          )
        },
        {
          file: makeFile(),
          questionCount: 5,
          difficulty: 'easy',
          questionType:
            'multiple_choice',
        },
        'Quiz generation failed.',
      )

    assert.deepEqual(
      result,
      expected,
    )
    assert.equal(
      observedPath,
      '/api/quizzes/generate',
    )
    assert.equal(
      observedInit?.method,
      'POST',
    )
    assert.ok(
      observedInit?.body
        instanceof FormData,
    )
  },
)

test(
  'prefers API detail and falls back to the caller error message',
  async () => {
    await assert.rejects(
      () =>
        requestQuizGeneration(
          async () =>
            new Response(
              JSON.stringify({
                detail:
                  'Specific API failure.',
              }),
              {
                status: 400,
                headers: {
                  'Content-Type':
                    'application/json',
                },
              },
            ),
          {
            file: makeFile(),
            questionCount: 5,
            difficulty: 'easy',
            questionType:
              'multiple_choice',
          },
          'Fallback failure.',
        ),
      /Specific API failure/,
    )

    await assert.rejects(
      () =>
        requestQuizGeneration(
          async () =>
            new Response(
              JSON.stringify({}),
              {
                status: 500,
                headers: {
                  'Content-Type':
                    'application/json',
                },
              },
            ),
          {
            file: makeFile(),
            questionCount: 5,
            difficulty: 'easy',
            questionType:
              'multiple_choice',
          },
          'Fallback failure.',
        ),
      /Fallback failure/,
    )
  },
)
