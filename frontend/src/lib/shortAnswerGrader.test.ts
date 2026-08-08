import {
  gradeShortAnswer,
  type ShortAnswerGradingSpec,
  type ShortAnswerQuestion,
} from './shortAnswerGrader.ts'


function assertEqual(
  actual: unknown,
  expected: unknown,
) {
  if (actual !== expected) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    )
  }
}


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

assertEqual(
  gradeShortAnswer(
    treatmentQuestion,
    'CBT IPT behavioural activation',
  ).correct,
  true,
)

assertEqual(
  gradeShortAnswer(
    treatmentQuestion,
    'behavioural activation, CBT and IPT',
  ).correct,
  true,
)

assertEqual(
  gradeShortAnswer(
    treatmentQuestion,
    'cognitive behavioral therapy interpersonal therapy BA',
  ).correct,
  true,
)

assertEqual(
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

assertEqual(
  incompleteGrade.correct,
  false,
)
assertEqual(
  incompleteGrade.matchedGroups,
  2,
)
assertEqual(
  incompleteGrade.requiredGroups,
  3,
)

const negatedGrade =
  gradeShortAnswer(
    treatmentQuestion,
    'CBT IPT and BA are not the treatments',
  )

assertEqual(
  negatedGrade.correct,
  false,
)
assertEqual(
  negatedGrade.borderline,
  true,
)

assertEqual(
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

assertEqual(
  gradeShortAnswer(
    numericQuestion,
    '84.3%',
  ).correct,
  true,
)

assertEqual(
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

assertEqual(
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

assertEqual(
  gradeShortAnswer(
    legacyQuestion,
    'I used Playwright',
  ).correct,
  true,
)

console.log(
  'Short-answer grader tests passed.',
)
