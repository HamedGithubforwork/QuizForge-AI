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
    text: 'Mitochondria generate ATP through cellular respiration.',
  }),
  Object.freeze({
    page: 5,
    text: 'Ribosomes synthesize proteins from messenger RNA.',
  }),
  Object.freeze({
    page: 2,
    text: 'Mitochondria have an inner membrane.',
  }),
  Object.freeze({
    page: 5,
    text: 'Ribosomes contain ribosomal RNA.',
  }),
  Object.freeze({
    page: 2,
    text: 'Cells use glucose during respiration.',
  }),
  Object.freeze({
    page: 5,
    text: 'Messenger RNA carries coding information.',
  }),
  Object.freeze({
    page: 5,
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
        assert.equal(
          request.jsonSchema.properties.questions.minItems,
          0,
        )
        assert.equal(
          request.jsonSchema.properties.questions.maxItems,
          8,
        )
        assert.equal(
          request.jsonSchema.properties.questions.items.required.includes(
            'source_fact',
          ),
          true,
        )
        assert.match(
          request.messages.at(-1).content,
          /exactly eight candidate questions/i,
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
  const second = rawQuiz()
  second.questions.forEach((item, index) => {
    item.question = 'Replacement question ' + (index + 1) + '?'
  })
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
            'quiz-mcq-retry-v1',
          )
          assert.match(
            request.messages.at(-1).content,
            /failed strict quiz validation/i,
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

test('targeted retry filters exact prior questions from an eight-question candidate pool', async () => {
  const first = withRetrySourceFacts(rawQuiz())
  first.questions[0].question = 'Question to avoid?'

  const pool = rawQuiz()
  pool.questions[0].question = 'Question to avoid?'
  pool.questions[1].question = 'Pool question 2?'
  pool.questions[2].question = 'Pool question 3?'
  pool.questions[3].question = 'Pool question 4?'
  pool.questions[4].question = 'Pool question 5?'
  pool.questions.push({
    ...pool.questions[0],
    question: 'Pool backup question 6?',
  })
  pool.questions.push({
    ...pool.questions[1],
    question: 'Pool backup question 7?',
  })
  pool.questions.push({
    ...pool.questions[2],
    question: 'Pool backup question 8?',
  })

  let calls = 0
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
            8,
          )
          assert.equal(
            request.jsonSchema.properties.questions.items.required.includes(
              'source_fact',
            ),
            true,
          )
          assert.equal(request.maxTokens, 1800)
          assert.match(
            request.messages.at(-1).content,
            /candidate pool of exactly eight/i,
          )
          assert.match(
            request.messages.at(-1).content,
            /source_fact.*verbatim/i,
          )
        }
        return {
          text: JSON.stringify(
            calls === 1
              ? first
              : withRetrySourceFacts(pool),
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
  first.questions.slice(0, 4).forEach(question => {
    question.question =
      'Question to avoid?'
  })

  const pool = withRetrySourceFacts(
    rawQuiz(),
  )
  pool.questions[0].question =
    'Question to avoid?'
  pool.questions.push({
    ...pool.questions[0],
    question: 'Backup fact six?',
    source_pages: [
      RETRY_FACTS[5].page,
    ],
    source_fact:
      RETRY_FACTS[5].text,
  })
  pool.questions.push({
    ...pool.questions[1],
    question: 'Backup fact seven?',
    source_pages: [
      RETRY_FACTS[6].page,
    ],
    source_fact:
      RETRY_FACTS[6].text,
  })
  pool.questions.push({
    ...pool.questions[1],
    question: 'Backup fact eight?',
    source_pages: [
      RETRY_FACTS[6].page,
    ],
    source_fact:
      RETRY_FACTS[6].text,
  })

  // Candidate 2 and candidate 3 intentionally
  // point to the same underlying source fact.
  pool.questions[1].source_pages = [
    RETRY_FACTS[2].page,
  ]
  pool.questions[1].source_fact =
    RETRY_FACTS[2].text
  pool.questions[2].source_pages = [
    RETRY_FACTS[2].page,
  ]
  pool.questions[2].source_fact =
    RETRY_FACTS[2].text

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
            /choices\[correct_index\].*source-supported/i,
          )
          assert.match(
            request.messages.at(-1).content,
            /instead of inventing facts/i,
          )
          assert.match(
            request.messages.at(-1).content,
            /five different underlying source facts/i,
          )
          assert.match(
            request.messages.at(-1).content,
            /candidate pool of exactly eight/i,
          )
          assert.equal(
            request.jsonSchema.properties.questions.maxItems,
            8,
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
  })

  const pool = rawQuiz()
  while (pool.questions.length < 8) {
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
  }

  const validationIssues = []
  let calls = 0
  const service = createLocalQuizService({
    onValidationIssue(issue) {
      validationIssues.push(issue)
    },
    provider: {
      async generate() {
        calls++
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

  assert.equal(calls, 2)
  assert.equal(
    validationIssues.at(-1).reason,
    'candidate_pool_exhausted',
  )
  assert.deepEqual(
    validationIssues.at(-1).details,
    {
      inputCandidates: 13,
      avoidedQuestions: 1,
      duplicateQuestions: 1,
      unsupportedSourceFacts: 0,
      duplicateSourceFacts: 10,
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
