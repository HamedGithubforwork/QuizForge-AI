import assert from 'node:assert/strict'

import {
  gradeShortAnswer,
  type ShortAnswerGradingSpec,
  type ShortAnswerQuestion,
} from './shortAnswerGrader.ts'


function conceptQuestion(
  requiredGroupCount = 3,
): ShortAnswerQuestion {
  const grading: ShortAnswerGradingSpec = {
    grading_version: 2,
    grading_mode: 'concepts',
    answer_groups: [
      [
        'cognitive behavioural therapy',
        'cognitive behavioral therapy',
        'CBT',
      ],
      [
        'interpersonal therapy',
        'IPT',
      ],
      [
        'behavioural activation',
        'behavioral activation',
        'BA',
      ],
    ],
    required_group_count:
      requiredGroupCount,
    numeric_value: 0,
    numeric_tolerance: 0,
    numeric_unit: '',
  }

  return {
    correct_answer:
      'Cognitive-behavioural therapy, interpersonal therapy, and behavioural activation',
    accepted_answers: [
      'CBT, IPT, and BA',
    ],
    grading,
  }
}


const treatmentQuestion =
  conceptQuestion()

assert.equal(
  gradeShortAnswer(
    treatmentQuestion,
    'CBT IPT behavioural activation',
  ).correct,
  true,
)

assert.equal(
  gradeShortAnswer(
    treatmentQuestion,
    'behavioural activation, CBT and IPT',
  ).correct,
  true,
)

assert.equal(
  gradeShortAnswer(
    treatmentQuestion,
    'cognitive behavioral therapy interpersonal therapy BA',
  ).correct,
  true,
)

assert.equal(
  gradeShortAnswer(
    treatmentQuestion,
    'CBT interpesonal therapy behavioural activation',
  ).correct,
  true,
)

const incompleteGrade =
  gradeShortAnswer(
    treatmentQuestion,
    'CBT IPT',
  )

assert.equal(
  incompleteGrade.correct,
  false,
)
assert.equal(
  incompleteGrade.matchedGroups,
  2,
)
assert.equal(
  incompleteGrade.requiredGroups,
  3,
)

const negatedGrade =
  gradeShortAnswer(
    treatmentQuestion,
    'CBT IPT and BA are not the treatments',
  )

assert.equal(
  negatedGrade.correct,
  false,
)
assert.equal(
  negatedGrade.borderline,
  true,
)

assert.equal(
  gradeShortAnswer(
    conceptQuestion(2),
    'IPT and BA',
  ).correct,
  true,
)

const numericQuestion: ShortAnswerQuestion = {
  correct_answer: '84.2%',
  accepted_answers: [
    '84.2',
    '84.2%',
  ],
  grading: {
    grading_version: 2,
    grading_mode: 'numeric',
    answer_groups: [],
    required_group_count: 0,
    numeric_value: 84.2,
    numeric_tolerance: 0.2,
    numeric_unit: '%',
  },
}

assert.equal(
  gradeShortAnswer(
    numericQuestion,
    '84.3%',
  ).correct,
  true,
)

assert.equal(
  gradeShortAnswer(
    numericQuestion,
    '85%',
  ).correct,
  false,
)

const exactQuestion: ShortAnswerQuestion = {
  correct_answer: 'HTTP 404',
  accepted_answers: [
    '404 Not Found',
  ],
  grading: {
    grading_version: 2,
    grading_mode: 'exact',
    answer_groups: [],
    required_group_count: 0,
    numeric_value: 0,
    numeric_tolerance: 0,
    numeric_unit: '',
  },
}

assert.equal(
  gradeShortAnswer(
    exactQuestion,
    '404 not found',
  ).correct,
  true,
)

const legacyQuestion: ShortAnswerQuestion = {
  correct_answer: 'Playwright',
  accepted_answers: [
    'playwright',
  ],
}

assert.equal(
  gradeShortAnswer(
    legacyQuestion,
    'I used Playwright',
  ).correct,
  true,
)

console.log(
  'Short-answer grader tests passed.',
)
