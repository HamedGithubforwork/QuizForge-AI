// @ts-nocheck
import assert from 'node:assert/strict'

import {
  gradeShortAnswer,
  type ShortAnswerQuestion,
} from './shortAnswerGrader.ts'
import {
  compareNumericMeasurement,
} from './numericUnits.ts'

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

function assertMeasurementValue(
  answer: string,
  expectedUnit: string,
  expectedValue: number,
  expectedConverted = true,
) {
  const measurement = compareNumericMeasurement(
    answer,
    expectedUnit,
  )

  assert.equal(measurement.status, 'ok')
  assert.notEqual(
    measurement.valueInExpectedUnit,
    null,
  )
  assert.ok(
    Math.abs(
      measurement.valueInExpectedUnit -
        expectedValue,
    ) < 1e-9,
    `${answer} should equal ${expectedValue} ${expectedUnit}`,
  )
  assert.equal(
    measurement.converted,
    expectedConverted,
  )
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

// Direct conversion contracts cover each supported measurement
// dimension so arithmetic/operator mutations cannot hide behind the
// higher-level short-answer grader.
assertMeasurementValue('1 kg', 'g', 1000)
assertMeasurementValue('1 g', 'mg', 1000)
assertMeasurementValue('1 mg', 'µg', 1000)
assertMeasurementValue('1 km', 'm', 1000)
assertMeasurementValue('1 m', 'cm', 100)
assertMeasurementValue('1 L', 'mL', 1000)
assertMeasurementValue('1 h', 'min', 60)
assertMeasurementValue('1 day', 'h', 24)
assertMeasurementValue('1 week', 'day', 7)
assertMeasurementValue('212 °F', '°C', 100)
assertMeasurementValue('0 °C', '°F', 32)

// Representative aliases exercise plural, British spelling,
// micro-symbol normalization, whitespace compaction, and degree names.
assertMeasurementValue('2 kilograms', 'g', 2000)
assertMeasurementValue('2 kilometres', 'm', 2000)
assertMeasurementValue('2 metres', 'cm', 200)
assertMeasurementValue('2 millilitres', 'L', 0.002)
assertMeasurementValue('2 micrograms', 'mg', 0.002)
assertMeasurementValue('2 μg', 'mg', 0.002)
assertMeasurementValue('2 hours', 'min', 120)
assertMeasurementValue('2 seconds', 'ms', 2000)
assertMeasurementValue('32 degrees Fahrenheit', '°C', 0)
assertMeasurementValue('100 degrees Celsius', '°F', 212)

// Number parsing boundaries: sign, thousands separators, leading
// decimal, exponent notation, and trailing punctuation on the unit.
assertMeasurementValue(
  '-1,234.5 kg',
  'g',
  -1234500,
)
assertMeasurementValue('.5 L', 'mL', 500)
assertMeasurementValue('5e-3 g', 'mg', 5)
assertMeasurementValue('5 kg.', 'g', 5000)

const noNumber = compareNumericMeasurement(
  'no numeric answer',
  'kg',
)
assert.deepEqual(noNumber, {
  status: 'no_number',
  valueInExpectedUnit: null,
  providedUnit: null,
  expectedUnit: 'kg',
  converted: false,
})

const missingUnit = compareNumericMeasurement(
  '5',
  'kg',
)
assert.deepEqual(missingUnit, {
  status: 'missing_unit',
  valueInExpectedUnit: null,
  providedUnit: null,
  expectedUnit: 'kg',
  converted: false,
})

const unexpectedUnit = compareNumericMeasurement(
  '5 kg',
  '',
)
assert.deepEqual(unexpectedUnit, {
  status: 'unexpected_unit',
  valueInExpectedUnit: null,
  providedUnit: 'kg',
  expectedUnit: '',
  converted: false,
})

const incompatibleKnown = compareNumericMeasurement(
  '5 kg',
  's',
)
assert.deepEqual(incompatibleKnown, {
  status: 'incompatible_unit',
  valueInExpectedUnit: null,
  providedUnit: 'kg',
  expectedUnit: 's',
  converted: false,
})

const incompatibleUnknown = compareNumericMeasurement(
  '72 rpm',
  'bpm',
)
assert.deepEqual(incompatibleUnknown, {
  status: 'incompatible_unit',
  valueInExpectedUnit: null,
  providedUnit: 'rpm',
  expectedUnit: 'bpm',
  converted: false,
})

const matchingUnknown = compareNumericMeasurement(
  '72 BPM',
  ' bpm ',
)
assert.deepEqual(matchingUnknown, {
  status: 'ok',
  valueInExpectedUnit: 72,
  providedUnit: 'BPM',
  expectedUnit: 'bpm',
  converted: false,
})

console.log(
  'Numeric unit grading tests passed.',
)
