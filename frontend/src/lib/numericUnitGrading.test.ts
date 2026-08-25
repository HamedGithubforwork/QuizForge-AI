// @ts-nocheck
import assert from 'node:assert/strict'

import {
  gradeShortAnswer,
  type ShortAnswerQuestion,
} from './shortAnswerGrader.ts'

function numericQuestion(
  value: number,
  unit: string,
  tolerance = 0,
): ShortAnswerQuestion {
  return {
    correct_answer: `${value}${unit ? ` ${unit}` : ''}`,
    accepted_answers: [
      `${value}${unit ? ` ${unit}` : ''}`,
    ],
    grading: {
      grading_version: 2,
      grading_mode: 'numeric',
      answer_groups: [],
      required_group_count: 0,
      numeric_value: value,
      numeric_tolerance: tolerance,
      numeric_unit: unit,
    },
  }
}

function isCorrect(
  question: ShortAnswerQuestion,
  answer: string,
) {
  return gradeShortAnswer(
    question,
    answer,
  ).correct
}

assert.equal(
  isCorrect(
    numericQuestion(1, 'g'),
    '1000 mg',
  ),
  true,
  '1000 mg should equal 1 g',
)

assert.equal(
  isCorrect(
    numericQuestion(2.5, 'L'),
    '2500 mL',
  ),
  true,
  '2500 mL should equal 2.5 L',
)

assert.equal(
  isCorrect(
    numericQuestion(60, 's'),
    '1 min',
  ),
  true,
  '1 min should equal 60 s',
)

assert.equal(
  isCorrect(
    numericQuestion(37, '°C'),
    '37 C',
  ),
  true,
  'C should be accepted as an alias for °C',
)

assert.equal(
  isCorrect(
    numericQuestion(0, '°C', 0.01),
    '32 °F',
  ),
  true,
  '32 °F should convert to 0 °C',
)

assert.equal(
  isCorrect(
    numericQuestion(10, '%'),
    '10%',
  ),
  true,
)

assert.equal(
  isCorrect(
    numericQuestion(10, '%'),
    '10 percent',
  ),
  true,
)

assert.equal(
  isCorrect(
    numericQuestion(10, '%'),
    '10',
  ),
  false,
  'a percentage should require a percentage unit',
)

assert.equal(
  isCorrect(
    numericQuestion(10, '%'),
    '0.1',
  ),
  false,
  '10% should not silently treat 0.1 as the same representation',
)

assert.equal(
  isCorrect(
    numericQuestion(5, ''),
    '5',
  ),
  true,
)

assert.equal(
  isCorrect(
    numericQuestion(5, ''),
    '5 kg',
  ),
  false,
  'unitless answers should reject supplied measurement units',
)

assert.equal(
  isCorrect(
    numericQuestion(5, 's'),
    '5 kg',
  ),
  false,
  'incompatible dimensions should be rejected',
)

assert.equal(
  isCorrect(
    numericQuestion(1, 'g'),
    '1e3 mg',
  ),
  true,
  'scientific notation should work with conversion',
)

assert.equal(
  isCorrect(
    numericQuestion(1, 'g', 0.01),
    '1009 mg',
  ),
  true,
  'tolerance should be applied after converting to the expected unit',
)

assert.equal(
  isCorrect(
    numericQuestion(1, 'g', 0.01),
    '1020 mg',
  ),
  false,
)

assert.equal(
  isCorrect(
    numericQuestion(72, 'bpm'),
    '72 bpm',
  ),
  true,
  'unknown units should still work when they match exactly',
)

assert.equal(
  isCorrect(
    numericQuestion(72, 'bpm'),
    '72 rpm',
  ),
  false,
  'unknown units should reject a different unit',
)

const missingUnitGrade = gradeShortAnswer(
  numericQuestion(1, 'g'),
  '1',
)

assert.equal(
  missingUnitGrade.correct,
  false,
)
assert.match(
  missingUnitGrade.feedback,
  /expected unit/i,
)

const convertedGrade = gradeShortAnswer(
  numericQuestion(1, 'g'),
  '1000 mg',
)

assert.match(
  convertedGrade.feedback,
  /unit conversion/i,
)

console.log(
  'Numeric unit grading tests passed.',
)
