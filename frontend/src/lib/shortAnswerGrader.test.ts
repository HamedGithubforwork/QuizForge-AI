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


function singleConceptQuestion(
  alias: string,
): ShortAnswerQuestion {
  return {
    correct_answer: alias,
    accepted_answers: [alias],
    grading: {
      grading_version: 2,
      grading_mode: 'concepts',
      answer_groups: [[alias]],
      required_group_count: 1,
      numeric_value: 0,
      numeric_tolerance: 0,
      numeric_unit: '',
    },
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

// Fuzzy concept matching has deliberate length boundaries: short
// words are not typo-corrected, six-to-eight-character tokens allow
// one edit, and tokens of nine or more characters allow two edits.
assertEqual(
  gradeShortAnswer(
    singleConceptQuestion('brain'),
    'braim',
  ).correct,
  false,
)

assertEqual(
  gradeShortAnswer(
    singleConceptQuestion('memory'),
    'memoru',
  ).correct,
  true,
)

assertEqual(
  gradeShortAnswer(
    singleConceptQuestion('learning'),
    'lxarninx',
  ).correct,
  false,
)

assertEqual(
  gradeShortAnswer(
    singleConceptQuestion('knowledge'),
    'kzowledxe',
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

assertEqual(
  gradeShortAnswer(
    numericQuestion,
    'not a number',
  ).feedback,
  'No numeric value was detected in the answer.',
)

assertEqual(
  gradeShortAnswer(
    numericQuestion,
    '84.2',
  ).feedback,
  'Include the expected unit (%).',
)

assertEqual(
  gradeShortAnswer(
    numericQuestion,
    '84.2 kg',
  ).feedback,
  'The supplied unit is not compatible with the expected unit (%).',
)

assertEqual(
  gradeShortAnswer(
    numericQuestion,
    '90%',
  ).feedback,
  'Numeric answer is outside the accepted value or tolerance.',
)

const unitlessNumericQuestion: ShortAnswerQuestion = {
  ...numericQuestion,
  correct_answer: '84.2',
  accepted_answers: ['84.2'],
  grading: {
    ...numericQuestion.grading!,
    numeric_unit: '',
  },
}

assertEqual(
  gradeShortAnswer(
    unitlessNumericQuestion,
    '84.2 kg',
  ).feedback,
  'This answer is expected to be unitless.',
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

assertEqual(
  gradeShortAnswer(
    exactQuestion,
    'status 404 not found',
  ).correct,
  false,
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

assertEqual(
  gradeShortAnswer(
    {
      correct_answer: 'models',
      accepted_answers: [],
    },
    'model',
  ).correct,
  true,
)

assertEqual(
  gradeShortAnswer(
    {
      correct_answer: 'code',
      accepted_answers: [],
    },
    'I used code here',
  ).correct,
  true,
)

assertEqual(
  gradeShortAnswer(
    {
      correct_answer: 'cat',
      accepted_answers: [],
    },
    'the cat appears here',
  ).correct,
  false,
)

assertEqual(
  gradeShortAnswer(
    {
      correct_answer: '42',
      accepted_answers: [],
    },
    'the answer is 42 exactly',
  ).correct,
  true,
)

// Explicit legacy modes must continue to route through the legacy
// matcher rather than concept/exact grading.
const legacyModeQuestion: ShortAnswerQuestion = {
  correct_answer: 'Playwright',
  accepted_answers: ['playwright'],
  grading: {
    grading_version: 2,
    grading_mode: 'none',
    answer_groups: [],
    required_group_count: 0,
    numeric_value: 0,
    numeric_tolerance: 0,
    numeric_unit: '',
  },
}

assertEqual(
  gradeShortAnswer(
    legacyModeQuestion,
    'I used Playwright',
  ).correct,
  true,
)

assertEqual(
  gradeShortAnswer(
    {
      ...exactQuestion,
      grading: {
        ...exactQuestion.grading!,
        grading_version: 1,
      },
    },
    'the result was HTTP 404',
  ).correct,
  true,
)

console.log(
  'Short-answer grader tests passed.',
)
