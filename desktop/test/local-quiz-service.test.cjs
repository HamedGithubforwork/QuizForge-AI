'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  MAX_SOURCE_BYTES,
  QUIZ_SCHEMA,
  createLocalQuizService,
  normalizeRequest,
  parseGeneratedQuiz,
} = require('../src/local-quiz-service.cjs')

const RETRY_FACTS = Object.freeze([
  Object.freeze({
    page: 2,
    answer: 'ATP',
    text: 'Mitochondria generate ATP through cellular respiration.',
  }),
  Object.freeze({
    page: 5,
    answer: 'proteins',
    text: 'Ribosomes synthesize proteins from messenger RNA.',
  }),
  Object.freeze({
    page: 2,
    answer: 'inner membrane',
    text: 'Mitochondria have an inner membrane.',
  }),
  Object.freeze({
    page: 5,
    answer: 'ribosomal RNA',
    text: 'Ribosomes contain ribosomal RNA.',
  }),
  Object.freeze({
    page: 2,
    answer: 'glucose',
    text: 'Cells use glucose during respiration.',
  }),
  Object.freeze({
    page: 5,
    answer: 'coding information',
    text: 'Messenger RNA carries coding information.',
  }),
  Object.freeze({
    page: 5,
    answer: 'amino acids',
    text: 'Proteins are chains of amino acids.',
  }),
])

const pages = () => [
  {
    pageNumber: 2,
    text: RETRY_FACTS
      .filter(fact => fact.page === 2)
      .map(fact => fact.text)
      .join(' '),
  },
  {
    pageNumber: 5,
    text: RETRY_FACTS
      .filter(fact => fact.page === 5)
      .map(fact => fact.text)
      .join(' '),
  },
]

const withRetrySourceFacts = quiz => ({
  ...quiz,
  questions: quiz.questions.map(
    (question, index) => {
      const fact =
        RETRY_FACTS[
          index % RETRY_FACTS.length
        ]
      return {
        ...question,
        choices: question.choices.map((choice, choiceIndex) =>
          choiceIndex === question.correct_index
            ? fact.answer
            : choice),
        source_pages: [fact.page],
        source_fact: fact.text,
      }
    },
  ),
})

const rawQuiz = () => ({
  title: 'Cell Biology',
  questions: Array.from({ length: 5 }, (_, index) => ({
    question: `Question ${index + 1}?`,
    choices: ['A', 'B', 'C', 'D'].map(choice => choice + index),
    correct_index: index % 4,
    explanation: 'Supported by the study material.',
    source_pages: [index % 2 ? 5 : 2],
  })),
})

test('request accepts only the benchmarked five-question multiple-choice envelope', () => {
  const value = normalizeRequest({
    pages: pages(),
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  })
  assert.equal(value.questionCount, 5)
  for (const bad of [
    { pages: pages(), questionCount: 10, difficulty: 'medium', questionType: 'multiple_choice' },
    { pages: pages(), questionCount: 5, difficulty: 'medium', questionType: 'mixed' },
    { pages: pages(), questionCount: 5, difficulty: 'extreme', questionType: 'multiple_choice' },
  ]) assert.throws(() => normalizeRequest(bad), { code: 'unsupported_quiz_mode' })
})

test('source material is bounded before a provider can receive it', () => {
  assert.throws(() => normalizeRequest({
    pages: [{ pageNumber: 1, text: 'é'.repeat(MAX_SOURCE_BYTES) }],
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  }), { code: 'source_too_large' })
  assert.throws(() => normalizeRequest({
    pages: [{ pageNumber: 2, text: 'a' }, { pageNumber: 2, text: 'b' }],
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  }), { code: 'invalid_request' })
})

test('service sends a fixed structured-output schema and expands into the shared Quiz shape', async () => {
  let captured
  const service = createLocalQuizService({
    provider: {
      async generate(request) {
        captured = request
        return { text: JSON.stringify(rawQuiz()), finishReason: 'stop', usage: null }
      },
    },
  })
  const result = await service.generate({
    pages: pages(),
    questionCount: 5,
    difficulty: 'hard',
    questionType: 'multiple_choice',
  })
  assert.deepEqual(captured.jsonSchema, QUIZ_SCHEMA)
  assert.equal(captured.messages.length, 2)
  assert.match(captured.messages[0].content, /untrusted content/)
  assert.match(captured.messages[0].content, /choices\[correct_index\].*supported/i)
  assert.match(captured.messages[0].content, /contradicts your own explanation/i)
  assert.match(captured.messages[0].content, /exactly one source-supported correct answer/i)
  assert.match(captured.messages[0].content, /directly support the question and selected correct answer/i)
  assert.match(captured.messages[0].content, /natural language of the supplied study material/i)
  assert.match(captured.messages[0].content, /Count repeated copies of the same fact as one fact/i)
  assert.match(captured.messages[0].content, /single underlying proposition is still only one fact/i)
  assert.match(captured.messages[0].content, /language of the notes.*confirmed.*repeats.*more content/i)
  assert.match(captured.messages[0].content, /count the distinct underlying study facts/i)
  assert.match(captured.messages[0].content, /do not create multiple questions from one fact/i)
  assert.match(captured.messages[0].content, /Headers, footers, page labels, OCR\/layout artifacts/i)
  assert.match(captured.messages[1].content, /--- PAGE 2 ---/)
  assert.equal(result.questions.length, 5)
  assert.equal(result.questions[0].question_type, 'multiple_choice')
  assert.equal(result.questions[0].correct_answer, result.questions[0].choices[0])
  assert.deepEqual(result.questions[0].grading, {
    grading_version: 2, grading_mode: 'none', answer_groups: [],
    required_group_count: 0, numeric_value: 0, numeric_tolerance: 0, numeric_unit: '',
  })
})

test('service repairs a selected index only when cited source and explanation uniquely ground another choice', async () => {
  const quiz = rawQuiz()
  quiz.questions[0] = {
    ...quiz.questions[0],
    question:
      'Which organelle generates ATP?',
    choices: [
      'Chloroplast',
      'Nucleus',
      'Mitochondria',
      'Ribosome',
    ],
    correct_index: 0,
    explanation:
      'Mitochondria generate ATP through cellular respiration.',
    source_pages: [2],
  }

  const service = createLocalQuizService({
    provider: {
      async generate() {
        return {
          text: JSON.stringify(quiz),
          finishReason: 'stop',
          usage: null,
        }
      },
    },
  })

  const result = await service.generate({
    pages: pages(),
    questionCount: 5,
    difficulty: 'medium',
    questionType:
      'multiple_choice',
  })

  assert.equal(
    result.questions[0].correct_index,
    2,
  )
  assert.equal(
    result.questions[0].correct_answer,
    'Mitochondria',
  )
})

test('validator rejects wrong citations, duplicate questions/choices and truncated generation', async () => {
  const invalidPage = rawQuiz()
  invalidPage.questions[0].source_pages = [99]
  assert.throws(() => parseGeneratedQuiz(JSON.stringify(invalidPage), new Set([2, 5])),
    { code: 'quiz_validation_failed' })

  const duplicateQuestion = rawQuiz()
  duplicateQuestion.questions[1].question = duplicateQuestion.questions[0].question
  assert.throws(() => parseGeneratedQuiz(JSON.stringify(duplicateQuestion), new Set([2, 5])),
    { code: 'quiz_validation_failed' })

  const duplicateChoice = rawQuiz()
  duplicateChoice.questions[0].choices[1] = duplicateChoice.questions[0].choices[0]
  assert.throws(() => parseGeneratedQuiz(JSON.stringify(duplicateChoice), new Set([2, 5])),
    { code: 'quiz_validation_failed' })

  const service = createLocalQuizService({
    provider: { generate: async () => ({ text: JSON.stringify(rawQuiz()), finishReason: 'length', usage: null }) },
  })
  await assert.rejects(service.generate({
    pages: pages(), questionCount: 5, difficulty: 'medium', questionType: 'multiple_choice',
  }), { code: 'quiz_validation_failed' })
})

test('model output cannot inject extra top-level or question fields', () => {
  const top = { ...rawQuiz(), secret: 'nope' }
  assert.throws(() => parseGeneratedQuiz(JSON.stringify(top), new Set([2, 5])),
    { code: 'quiz_validation_failed' })
  const item = rawQuiz()
  item.questions[0].runtime_path = 'private'
  assert.throws(() => parseGeneratedQuiz(JSON.stringify(item), new Set([2, 5])),
    { code: 'quiz_validation_failed' })
})


test('insufficient source abstention is preserved as a bounded product error', async () => {
  const service = createLocalQuizService({
    provider: {
      async generate() {
        return {
          text: JSON.stringify({
            title: 'Insufficient source material',
            questions: [],
          }),
          finishReason: 'stop',
          usage: null,
        }
      },
    },
  })

  await assert.rejects(
    service.generate({
      pages: [{ pageNumber: 1, text: 'Only one isolated fact is available.' }],
      questionCount: 5,
      difficulty: 'medium',
      questionType: 'multiple_choice',
    }),
    { code: 'insufficient_source' },
  )

  assert.throws(
    () => parseGeneratedQuiz(
      JSON.stringify({
        title: 'Looks valid',
        questions: [],
      }),
      new Set([1]),
    ),
    { code: 'quiz_validation_failed' },
  )
})


test('targeted practice keeps prior questions bounded, separate from source, and non-repeatable', async () => {
  let captured
  const service = createLocalQuizService({
    provider: {
      async generate(request) {
        captured = request
        const quiz = withRetrySourceFacts(rawQuiz())
        quiz.questions[0].question = 'A different follow-up question?'
        quiz.questions[1].question = 'Another distinct follow-up question?'
        assert.equal(request.jsonSchema.oneOf.length, 2)
        assert.equal(
          request.jsonSchema.oneOf[0].properties.title.const,
          'Insufficient source material',
        )
        assert.equal(
          request.jsonSchema.oneOf[0].properties.questions.maxItems,
          0,
        )
        const quizPoolSchema = request.jsonSchema.oneOf[1]
        assert.equal(
          quizPoolSchema.properties.questions.minItems,
          7,
        )
        assert.equal(
          quizPoolSchema.properties.questions.maxItems,
          7,
        )
        assert.equal(
          quizPoolSchema.properties.questions.items.required.includes(
            'source_fact',
          ),
          true,
        )
        assert.match(
          request.messages.at(-1).content,
          /exactly seven candidate questions/i,
        )
        assert.match(
          request.messages.at(-1).content,
          /compare every candidate against every PRIOR QUESTION TO AVOID/i,
        )
        assert.match(
          request.messages.at(-1).content,
          /selected correct choice must be a concise phrase copied verbatim from that source_fact/i,
        )
        return {
          text: JSON.stringify(quiz),
          finishReason: 'stop',
          usage: null,
        }
      },
    },
  })

  const result = await service.generate({
    pages: pages(),
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
    practice: {
      avoidQuestions: ['Question 1?', 'Question 2?'],
    },
  })

  assert.equal(result.questions.length, 5)
  assert.equal(captured.messages.length, 4)
  assert.match(captured.messages[0].content, /targeted follow-up/)
  assert.match(captured.messages[2].content, /PRIOR QUESTIONS TO AVOID/)
  assert.match(captured.messages[0].content, /each question must test a different underlying source fact/i)
  assert.match(captured.messages[2].content, /Question 1\?/)
  assert.equal(captured.messages[1].content.includes('Question 1?'), false)

  assert.throws(
    () => parseGeneratedQuiz(
      JSON.stringify(rawQuiz()),
      new Set([2, 5]),
      ['Question 1?'],
    ),
    { code: 'quiz_validation_failed' },
  )
})

test('targeted-practice input rejects duplicate, oversized and malformed prior-question lists', () => {
  const base = {
    pages: pages(),
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  }

  assert.doesNotThrow(
    () => normalizeRequest({
      ...base,
      practice: { avoidQuestions: [] },
    }),
  )

  for (const practice of [
    { avoidQuestions: ['Same?', 'Same?'] },
    { avoidQuestions: ['x'.repeat(501)] },
    { avoidQuestions: ['valid'], extra: true },
  ]) {
    assert.throws(
      () => normalizeRequest({ ...base, practice }),
      { code: 'invalid_request' },
    )
  }
})


test('targeted practice accumulates valid candidates across the bounded retry', async () => {
  const first = withRetrySourceFacts(rawQuiz())
  first.questions[0].question = 'Question to avoid?'
  first.questions[1].choices[first.questions[1].correct_index] =
    'Not stated in the notes'
  const second = rawQuiz()
  second.questions.forEach((item, index) => {
    item.question = 'Replacement question ' + (index + 1) + '?'
  })
  second.questions = second.questions.slice(0, 3)
  let calls = 0
  const service = createLocalQuizService({
    provider: {
      async generate(request) {
        calls++
        if (calls === 1) {
          assert.equal(
            request.generationProfile,
            'quiz-mcq-v1',
          )
        }
        if (calls === 2) {
          assert.equal(
            request.generationProfile,
            'quiz-mcq-targeted-retry-v1',
          )
          assert.match(
            request.messages.at(-1).content,
            /failed strict quiz validation/i,
          )
          assert.match(
            request.messages.at(-1).content,
            /RETAINED CANDIDATES/i,
          )
          assert.match(
            request.messages.at(-1).content,
            /Question 2\?/,
          )
          assert.match(
            request.messages.at(-1).content,
            /Question: Question 3\?[\s\S]*Covered source fact: Mitochondria have an inner membrane\./,
          )
          assert.match(
            request.messages.at(-1).content,
            /REJECTED CANDIDATES AND FILTER REASONS/i,
          )
          assert.match(
            request.messages.at(-1).content,
            /Rejection reason: avoided_question[\s\S]*Question: Question to avoid\?/,
          )
          assert.match(
            request.messages.at(-1).content,
            /Rejection reason: unsupported_answer[\s\S]*Source fact: Ribosomes synthesize proteins from messenger RNA\./,
          )
        }
        return {
          text: JSON.stringify(
            calls === 1
              ? first
              : withRetrySourceFacts(second),
          ),
          finishReason: 'stop',
          usage: null,
        }
      },
    },
  })
  const result = await service.generate({
    pages: pages(),
    practice: { avoidQuestions: ['Question to avoid?'] },
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  })
  assert.equal(calls, 2)
  assert.equal(result.questions.length, 5)
  assert.equal(
    result.questions.some(
      question =>
        question.question ===
        'Question to avoid?',
    ),
    false,
  )
  assert.equal(
    result.questions.some(
      question =>
        question.question ===
        'Replacement question 1?',
    ),
    true,
  )
})

test('targeted retry separates retained candidates from rejected evidence in the corrective prompt', async () => {
  const first = withRetrySourceFacts(rawQuiz())
  first.questions[0].question =
    'Question to avoid?'
  first.questions[2].question =
    'Filtered first-pass candidate wording?'
  first.questions[2].choices[
    first.questions[2].correct_index
  ] = 'unsupported answer'
  const second = withRetrySourceFacts(rawQuiz())
  second.questions.forEach(
    (question, index) => {
      question.question =
        'Fresh retry question ' +
        (index + 1) +
        '?'
    },
  )
  second.questions = second.questions.slice(0, 3)

  let calls = 0
  const service = createLocalQuizService({
    provider: {
      async generate(request) {
        calls++
        if (calls === 2) {
          const retryMessage =
            request.messages.at(-1).content
          assert.equal(
            request.jsonSchema.properties.questions.maxItems,
            3,
          )
          assert.match(
            retryMessage,
            /untrusted data for coverage only/i,
          )
          assert.match(
            retryMessage,
            /REJECTED CANDIDATES AND FILTER REASONS/i,
          )
          assert.match(
            retryMessage,
            /do not reuse that underlying proposition/i,
          )
          assert.match(
            retryMessage,
            /Question 2\?/,
          )
          assert.equal(
          retryMessage.includes(
              'Ribosomes synthesize proteins from messenger RNA.',
            ),
            true,
          )
          assert.match(
            retryMessage,
            /Rejection reason: avoided_question[\s\S]*Question: Question to avoid\?[\s\S]*Source fact: Mitochondria generate ATP through cellular respiration\./,
          )
          assert.match(
            retryMessage,
            /question wordings already generated/i,
          )
          assert.match(
            retryMessage,
            /Filtered first-pass candidate wording\?/,
          )
          assert.match(
            retryMessage,
            /Rejection reason: unsupported_answer[\s\S]*Question: Filtered first-pass candidate wording\?[\s\S]*Source fact: Mitochondria have an inner membrane\./,
          )
        }
        return {
          text: JSON.stringify(
            calls === 1
              ? first
              : second,
          ),
          finishReason: 'stop',
          usage: null,
        }
      },
    },
  })

  const result = await service.generate({
    pages: pages(),
    practice: {
      avoidQuestions: [
        'Question to avoid?',
      ],
    },
    questionCount: 5,
    difficulty: 'medium',
    questionType:
      'multiple_choice',
  })

  assert.equal(calls, 2)
  assert.equal(result.questions.length, 5)
})

test('targeted retry requests only the needed candidates plus two backups', async () => {
  const first = withRetrySourceFacts(rawQuiz())
  first.questions[0].question = 'Question to avoid?'

  const pool = withRetrySourceFacts(rawQuiz())
  pool.questions[0].question = 'Question to avoid?'
  pool.questions[1].question = 'Pool question 2?'
  pool.questions[2].question = 'Pool question 3?'
  pool.questions[3].question = 'Pool question 4?'
  pool.questions[4].question = 'Pool question 5?'
  pool.questions[4] = {
    ...pool.questions[4],
    question: 'Pool backup question 6?',
    source_pages: [RETRY_FACTS[5].page],
    source_fact: RETRY_FACTS[5].text,
  }
  pool.questions[4].choices[pool.questions[4].correct_index] =
    RETRY_FACTS[5].answer
  pool.questions = [
    pool.questions[0],
    pool.questions[1],
    pool.questions[4],
  ]

  let calls = 0
  const service = createLocalQuizService({
    provider: {
      async generate(request) {
        calls++
        if (calls === 2) {
          assert.equal(
            request.generationProfile,
            'quiz-mcq-targeted-retry-v1',
          )
          assert.equal(
            request.jsonSchema.properties.questions.minItems,
            3,
          )
          assert.equal(
            request.jsonSchema.properties.questions.maxItems,
            3,
          )
          assert.equal(
            request.jsonSchema.properties.questions.items.required.includes(
              'source_fact',
            ),
            true,
          )
          assert.equal(request.maxTokens, 1300)
          assert.match(
            request.messages.at(-1).content,
            /exactly 3 additional candidate questions/i,
          )
          assert.match(
            request.messages.at(-1).content,
            /final quiz needs 1 more valid candidate/i,
          )
          assert.match(
            request.messages.at(-1).content,
            /verbatim as source_fact/i,
          )
        }
        return {
          text: JSON.stringify(
            calls === 1
              ? first
              : pool,
          ),
          finishReason: 'stop',
          usage: null,
        }
      },
    },
  })

  const result = await service.generate({
    pages: pages(),
    practice: {
      avoidQuestions: [
        'Question to avoid?',
      ],
    },
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  })

  assert.equal(calls, 2)
  assert.equal(
    result.questions.length,
    5,
  )
  assert.equal(
    result.questions.some(
      question =>
        question.question ===
        'Question to avoid?',
    ),
    false,
  )
  assert.equal(
    result.questions.at(-1).question,
    'Pool backup question 6?',
  )
})

test('targeted retry filters duplicate underlying source facts using verbatim source_fact', async () => {
  const first = withRetrySourceFacts(rawQuiz())
  first.questions.slice(0, 3).forEach(question => {
    question.question = 'Question to avoid?'
  })

  const pool = withRetrySourceFacts(rawQuiz())
  pool.questions[0].question = 'Question to avoid?'
  pool.questions[1].question = 'Candidate on fact six?'
  pool.questions[1].source_pages = [RETRY_FACTS[5].page]
  pool.questions[1].source_fact = RETRY_FACTS[5].text
  pool.questions[1].choices[pool.questions[1].correct_index] =
    RETRY_FACTS[5].answer
  pool.questions[2] = {
    ...pool.questions[1],
    choices: [...pool.questions[1].choices],
    question: 'Duplicate candidate on fact six?',
  }
  pool.questions[3].question = 'Candidate on fact seven?'
  pool.questions[3].source_pages = [RETRY_FACTS[6].page]
  pool.questions[3].source_fact = RETRY_FACTS[6].text
  pool.questions[3].choices[pool.questions[3].correct_index] =
    RETRY_FACTS[6].answer
  pool.questions[4].question = 'Candidate on fact one?'
  pool.questions[4].source_pages = [RETRY_FACTS[0].page]
  pool.questions[4].source_fact = RETRY_FACTS[0].text
  pool.questions[4].choices[pool.questions[4].correct_index] =
    RETRY_FACTS[0].answer

  let calls = 0
  const service = createLocalQuizService({
    provider: {
      async generate() {
        calls++
        return {
          text: JSON.stringify(
            calls === 1 ? first : pool,
          ),
          finishReason: 'stop',
          usage: null,
        }
      },
    },
  })

  const result = await service.generate({
    pages: pages(),
    practice: {
      avoidQuestions: [
        'Question to avoid?',
      ],
    },
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  })

  assert.equal(calls, 2)
  assert.equal(result.questions.length, 5)
  assert.equal(
    result.questions.some(
      question =>
        question.question ===
        'Question to avoid?',
    ),
    false,
  )
  assert.equal(
    result.questions.some(
      question =>
        question.question ===
        'Question 3?',
    ),
    false,
  )
})

test('targeted practice retries one strict validation failure and then succeeds', async () => {
  let calls = 0
  const validationIssues = []
  const invalid = rawQuiz()
  invalid.questions[0].source_pages = [99]
  const recovered = rawQuiz()
  recovered.questions.forEach((item, index) => {
    item.question = 'Recovered targeted question ' + (index + 1) + '?'
  })
  const service = createLocalQuizService({
    onValidationIssue(issue) {
      validationIssues.push(issue)
    },
    provider: {
      async generate(request) {
        calls++
        if (calls === 2) {
          assert.match(
            request.messages.at(-1).content,
            /failed strict quiz validation/i,
          )
          assert.match(
            request.messages.at(-1).content,
            /choices\[correct_index\].*concise answer copied/i,
          )
          assert.match(
            request.messages.at(-1).content,
            /Do not invent facts/i,
          )
          assert.match(
            request.messages.at(-1).content,
            /five different underlying source facts/i,
          )
          assert.match(
            request.messages.at(-1).content,
            /exactly 5 additional candidate questions/i,
          )
          assert.equal(
            request.jsonSchema.properties.questions.minItems,
            5,
          )
          assert.equal(
            request.jsonSchema.properties.questions.maxItems,
            5,
          )
          assert.equal(
            request.jsonSchema.properties.questions.items.required.includes(
              'source_fact',
            ),
            true,
          )
          assert.equal(request.maxTokens, 1800)
        }
        return {
          text: JSON.stringify(
            calls === 1
              ? invalid
              : withRetrySourceFacts(recovered),
          ),
          finishReason: 'stop',
          usage: null,
        }
      },
    },
  })
  const result = await service.generate({
    pages: pages(),
    practice: { avoidQuestions: ['Old question?'] },
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  })
  assert.equal(calls, 2)
  assert.equal(result.questions[0].question, 'Recovered targeted question 1?')
  assert.deepEqual(validationIssues, [
    { attempt: 'primary', reason: 'question_shape' },
  ])
})

test('targeted practice retries one false insufficient-source abstention without forcing the candidate-pool schema', async () => {
  let calls = 0
  const recovered = rawQuiz()
  recovered.questions.forEach((item, index) => {
    item.question = 'Abstention recovery question ' + (index + 1) + '?'
  })
  const service = createLocalQuizService({
    provider: {
      async generate(request) {
        calls++
        if (calls === 2) {
          assert.equal(
            request.generationProfile,
            'quiz-mcq-retry-v1',
          )
          assert.equal(
            request.jsonSchema.properties.questions.minItems,
            0,
          )
          assert.equal(
            request.jsonSchema.properties.questions.maxItems,
            5,
          )
          assert.equal(
            request.jsonSchema.properties.questions.items.required.includes(
              'source_fact',
            ),
            false,
          )
          assert.match(
            request.messages.at(-1).content,
            /preserve the Insufficient source material abstention/i,
          )
        }
        return {
          text: JSON.stringify(
            calls === 1
              ? {
                  title: 'Insufficient source material',
                  questions: [],
                }
              : recovered,
          ),
          finishReason: 'stop',
          usage: null,
        }
      },
    },
  })
  const result = await service.generate({
    pages: pages(),
    practice: { avoidQuestions: ['Old question?'] },
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  })
  assert.equal(calls, 2)
  assert.equal(result.questions[0].question, 'Abstention recovery question 1?')
})

test('candidate-pool exhaustion reports counts without source text', async () => {
  const first = withRetrySourceFacts(rawQuiz())
  const repeatedFact =
    RETRY_FACTS[0]
  first.questions.forEach((question, index) => {
    question.question =
      index === 0
        ? 'Question to avoid?'
        : 'Primary repeated fact ' +
          (index + 1) +
          '?'
    question.source_pages = [
      repeatedFact.page,
    ]
    question.source_fact =
      repeatedFact.text
    question.choices[
      question.correct_index
    ] = repeatedFact.answer
  })

  const pool = rawQuiz()
  while (pool.questions.length < 7) {
    pool.questions.push({
      ...pool.questions[0],
      question:
        'Extra pool question ' +
        (pool.questions.length + 1) +
        '?',
    })
  }
  for (const [index, question] of
    pool.questions.entries()) {
    question.question =
      index === 0
        ? 'Question to avoid?'
        : 'Distinct wording ' +
          (index + 1) +
          '?'
    question.source_pages = [
      repeatedFact.page,
    ]
    question.source_fact =
      repeatedFact.text
    question.choices[
      question.correct_index
    ] = repeatedFact.answer
  }

  const validationIssues = []
  let calls = 0
  const service = createLocalQuizService({
    onValidationIssue(issue) {
      validationIssues.push(issue)
    },
    provider: {
      async generate(request) {
        calls++
        if (calls > 1) {
          assert.equal(
            request.generationProfile,
            'quiz-mcq-targeted-retry-v' + (calls - 1),
          )
        }
        const retryPool = {
          ...pool,
          questions: pool.questions.slice(
            calls === 1
              ? 0
              : calls - 2,
            calls === 1
              ? (request.jsonSchema?.properties?.questions?.maxItems ?? 7)
              : calls - 2 +
                (request.jsonSchema?.properties?.questions?.maxItems ?? 7),
          ),
        }
        return {
          text: JSON.stringify(
            calls === 1
              ? first
              : retryPool,
          ),
          finishReason: 'stop',
          usage: null,
        }
      },
    },
  })

  await assert.rejects(
    service.generate({
      pages: pages(),
      practice: {
        avoidQuestions: [
          'Question to avoid?',
        ],
      },
      questionCount: 5,
      difficulty: 'medium',
      questionType:
        'multiple_choice',
    }),
    { code: 'quiz_validation_failed' },
  )

  assert.equal(calls, 3)
  assert.equal(
    validationIssues.at(-1).reason,
    'candidate_pool_exhausted',
  )
  assert.deepEqual(
    validationIssues.at(-1).details,
    {
      inputCandidates: 10,
      avoidedQuestions: 1,
      duplicateQuestions: 3,
      unsupportedSourceFacts: 0,
      unsupportedAnswers: 0,
      duplicateSourceFacts: 5,
      survivors: 1,
    },
  )
  assert.equal(
    JSON.stringify(
      validationIssues.at(-1),
    ).includes(repeatedFact.text),
    false,
  )
})

test('targeted candidate filtering rejects answers absent from their cited source fact', async () => {
  const first = withRetrySourceFacts(rawQuiz())
  first.questions[0].choices[
    first.questions[0].correct_index
  ] = 'To capture light'

  const retry = withRetrySourceFacts(rawQuiz())
  retry.questions.forEach((question, index) => {
    question.question = 'Retry candidate ' + (index + 1) + '?'
  })

  const issues = []
  let calls = 0
  const service = createLocalQuizService({
    onValidationIssue(issue) { issues.push(issue) },
    provider: {
      async generate() {
        calls++
        return {
          text: JSON.stringify(calls === 1 ? first : retry),
          finishReason: 'stop',
          usage: null,
        }
      },
    },
  })

  const result = await service.generate({
    pages: pages(),
    practice: { avoidQuestions: ['Previously asked?'] },
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  })

  assert.equal(calls, 2)
  assert.equal(result.questions.length, 5)
  assert.equal(issues[0].reason, 'candidate_pool_exhausted')
  assert.equal(issues[0].details.unsupportedAnswers, 1)
  assert.equal(issues[0].details.survivors, 4)
})

test('targeted practice retries validation at most once', async () => {
  let calls = 0
  const invalid = rawQuiz()
  invalid.questions[0].source_pages = [99]
  const service = createLocalQuizService({
    provider: {
      async generate() {
        calls++
        return {
          text: JSON.stringify(invalid),
          finishReason: 'stop',
          usage: null,
        }
      },
    },
  })
  await assert.rejects(service.generate({
    pages: pages(),
    practice: { avoidQuestions: ['Old question?'] },
    questionCount: 5,
    difficulty: 'medium',
    questionType: 'multiple_choice',
  }), { code: 'quiz_validation_failed' })
  assert.equal(calls, 2)
})

test('structured schema requires four unique choices before post-validation', () => {
  assert.equal(QUIZ_SCHEMA.properties.questions.items.properties.choices.uniqueItems, true)
})
