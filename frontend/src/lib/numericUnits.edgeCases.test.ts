// @ts-nocheck
import assert from 'node:assert/strict'

import { compareNumericMeasurement } from './numericUnits.ts'

function assertConverted(
  answer: string,
  expectedUnit: string,
  expectedValue: number,
) {
  const result = compareNumericMeasurement(answer, expectedUnit)

  assert.equal(result.status, 'ok')
  assert.equal(result.converted, true)
  assert.ok(result.valueInExpectedUnit !== null)
  assert.ok(
    Math.abs(result.valueInExpectedUnit - expectedValue) < 1e-9,
    `${answer} should equal ${expectedValue} ${expectedUnit}`,
  )
}

for (const [answer, expectedUnit, expectedValue] of [
  ['1 kg', 'g', 1000],
  ['1000 g', 'kg', 1],
  ['1 g', 'mg', 1000],
  ['1000 mg', 'g', 1],
  ['1 mg', 'ug', 1000],
  ['1000 ug', 'mg', 1],
  ['1 km', 'm', 1000],
  ['100 cm', 'm', 1],
  ['1000 mm', 'm', 1],
  ['1 m', 'um', 1_000_000],
  ['1 L', 'mL', 1000],
  ['1000 mL', 'L', 1],
  ['1 mL', 'uL', 1000],
  ['1 h', 'min', 60],
  ['1 min', 's', 60],
  ['1000 ms', 's', 1],
  ['1 day', 'h', 24],
  ['1 week', 'day', 7],
  ['32 °F', '°C', 0],
  ['100 °C', '°F', 212],
] as const) {
  assertConverted(answer, expectedUnit, expectedValue)
}

for (const [answer, expectedUnit, expectedValue] of [
  ['1 kilogram', 'g', 1000],
  ['1 microgram', 'ug', 1],
  ['1 µg', 'ug', 1],
  ['1 mcg', 'ug', 1],
  ['1 kilometre', 'm', 1000],
  ['1 meter', 'cm', 100],
  ['1 millilitre', 'uL', 1000],
  ['1 hr', 'min', 60],
  ['1 secs', 'ms', 1000],
  ['10 percentage', '%', 10],
  ['32 degrees Fahrenheit', '°C', 0],
] as const) {
  const result = compareNumericMeasurement(answer, expectedUnit)

  assert.equal(result.status, 'ok')
  assert.ok(result.valueInExpectedUnit !== null)
  assert.ok(
    Math.abs(result.valueInExpectedUnit - expectedValue) < 1e-9,
    `${answer} should normalize to ${expectedValue} ${expectedUnit}`,
  )
}

assert.deepEqual(
  compareNumericMeasurement('not a number', 'g'),
  {
    status: 'no_number',
    valueInExpectedUnit: null,
    providedUnit: null,
    expectedUnit: 'g',
    converted: false,
  },
)

assert.deepEqual(
  compareNumericMeasurement('1', 'g'),
  {
    status: 'missing_unit',
    valueInExpectedUnit: null,
    providedUnit: null,
    expectedUnit: 'g',
    converted: false,
  },
)

assert.deepEqual(
  compareNumericMeasurement('1 kg', ''),
  {
    status: 'unexpected_unit',
    valueInExpectedUnit: null,
    providedUnit: 'kg',
    expectedUnit: '',
    converted: false,
  },
)

assert.equal(
  compareNumericMeasurement('1 kg', 's').status,
  'incompatible_unit',
)
assert.equal(
  compareNumericMeasurement('72 rpm', 'bpm').status,
  'incompatible_unit',
)

assert.deepEqual(
  compareNumericMeasurement('72 bpm.', 'BPM'),
  {
    status: 'ok',
    valueInExpectedUnit: 72,
    providedUnit: 'bpm.',
    expectedUnit: 'BPM',
    converted: false,
  },
)

assert.deepEqual(
  compareNumericMeasurement('1 kilogram', 'kg'),
  {
    status: 'ok',
    valueInExpectedUnit: 1,
    providedUnit: 'kilogram',
    expectedUnit: 'kg',
    converted: false,
  },
)

assert.equal(
  compareNumericMeasurement('1,000 mg', 'g').valueInExpectedUnit,
  1,
)
assert.equal(
  compareNumericMeasurement('1e3 mg', 'g').valueInExpectedUnit,
  1,
)

console.log('Numeric unit edge-case tests passed.')
