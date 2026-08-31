import assert from 'node:assert/strict'

import {
  gradeShortAnswer,
  normalizeShortAnswer,
  type ShortAnswerQuestion,
} from './shortAnswerGrader.ts'

for (const [input, expected] of [
  ['behavioural', 'behavioral'],
  ['behaviour', 'behavior'],
  ['behaviours', 'behaviors'],
  ['colour', 'color'],
  ['colours', 'colors'],
  ['organisation', 'organization'],
  ['organisations', 'organizations'],
  ['organised', 'organized'],
  ['organising', 'organizing'],
  ['analyse', 'analyze'],
  ['analysed', 'analyzed'],
  ['analysing', 'analyzing'],
] as const) {
  assert.equal(normalizeShortAnswer(input), expected)
}

assert.equal(
  normalizeShortAnswer('  Café—based / THÉRAPY  '),
  'cafe based therapy',
)
assert.equal(
  normalizeShortAnswer('alpha...beta   gamma'),
  'alpha beta gamma',
)

function oneConceptQuestion(): ShortAnswerQuestion {
  return {
    correct_answer: 'effective treatment',
    accepted_answers: ['effective treatment'],
    grading: {
      grading_version: 2,
      grading_mode: 'concepts',
      answer_groups: [['effective treatment']],
      required_group_count: 1,
      numeric_value: 0,
      numeric_tolerance: 0,
      numeric_unit: '',
    },
  }
}

for (const negation of [
  'not',
  'no',
  'never',
  'isnt',
  'arent',
  'wasnt',
  'werent',
  'doesnt',
  'dont',
  'didnt',
  'cannot',
  'cant',
]) {
  const grade = gradeShortAnswer(
    oneConceptQuestion(),
    `${negation} effective treatment`,
  )

  assert.equal(grade.correct, false, `${negation} must negate correctness`)
  assert.equal(grade.borderline, true, `${negation} must trigger borderline review`)
}

const expectedNegationQuestion = oneConceptQuestion()
expectedNegationQuestion.correct_answer = 'not effective treatment'
expectedNegationQuestion.accepted_answers = ['not effective treatment']
expectedNegationQuestion.grading!.answer_groups = [['not effective treatment']]

const expectedNegationGrade = gradeShortAnswer(
  expectedNegationQuestion,
  'not effective treatment',
)
assert.equal(expectedNegationGrade.correct, true)
assert.equal(expectedNegationGrade.borderline, false)

const pluralQuestion: ShortAnswerQuestion = {
  correct_answer: 'model',
  accepted_answers: [],
}
assert.equal(gradeShortAnswer(pluralQuestion, 'models').correct, true)

const doubleSQuestion: ShortAnswerQuestion = {
  correct_answer: 'glass',
  accepted_answers: [],
}
assert.equal(gradeShortAnswer(doubleSQuestion, 'glas').correct, false)

const numericLegacyQuestion: ShortAnswerQuestion = {
  correct_answer: '404',
  accepted_answers: [],
}
assert.equal(
  gradeShortAnswer(numericLegacyQuestion, 'the result was 404').correct,
  true,
)

const shortLegacyQuestion: ShortAnswerQuestion = {
  correct_answer: 'cat',
  accepted_answers: [],
}
assert.equal(
  gradeShortAnswer(shortLegacyQuestion, 'the cat sat').correct,
  false,
)

const clampedLowQuestion = oneConceptQuestion()
clampedLowQuestion.grading!.required_group_count = 0
assert.equal(
  gradeShortAnswer(clampedLowQuestion, 'effective treatment').requiredGroups,
  1,
)

const clampedHighQuestion: ShortAnswerQuestion = {
  correct_answer: 'alpha beta',
  accepted_answers: [],
  grading: {
    grading_version: 2,
    grading_mode: 'concepts',
    answer_groups: [['alpha'], ['beta']],
    required_group_count: 99,
    numeric_value: 0,
    numeric_tolerance: 0,
    numeric_unit: '',
  },
}
const clampedHighGrade = gradeShortAnswer(clampedHighQuestion, 'alpha beta')
assert.equal(clampedHighGrade.requiredGroups, 2)
assert.equal(clampedHighGrade.totalGroups, 2)
assert.equal(clampedHighGrade.matchedGroups, 2)
assert.equal(clampedHighGrade.correct, true)

const emptyGroupsQuestion: ShortAnswerQuestion = {
  correct_answer: 'Playwright',
  accepted_answers: ['playwright'],
  grading: {
    grading_version: 2,
    grading_mode: 'concepts',
    answer_groups: [[], ['   ']],
    required_group_count: 1,
    numeric_value: 0,
    numeric_tolerance: 0,
    numeric_unit: '',
  },
}
assert.equal(
  gradeShortAnswer(emptyGroupsQuestion, 'I used Playwright').correct,
  true,
)

const exactQuestion: ShortAnswerQuestion = {
  correct_answer: 'HTTP 404',
  accepted_answers: [],
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
assert.equal(gradeShortAnswer(exactQuestion, 'http-404').correct, true)
assert.equal(gradeShortAnswer(exactQuestion, 'HTTP 405').correct, false)

const oldVersionQuestion: ShortAnswerQuestion = {
  correct_answer: 'Playwright',
  accepted_answers: [],
  grading: {
    grading_version: 1,
    grading_mode: 'exact',
    answer_groups: [],
    required_group_count: 0,
    numeric_value: 0,
    numeric_tolerance: 0,
    numeric_unit: '',
  },
}
assert.equal(
  gradeShortAnswer(oldVersionQuestion, 'I used Playwright').correct,
  true,
)

console.log('Short-answer grader edge-case tests passed.')
