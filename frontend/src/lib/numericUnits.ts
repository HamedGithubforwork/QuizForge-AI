export type NumericMeasurementStatus =
  | 'ok'
  | 'no_number'
  | 'missing_unit'
  | 'unexpected_unit'
  | 'incompatible_unit'

export type NumericMeasurement = {
  status: NumericMeasurementStatus
  valueInExpectedUnit: number | null
  providedUnit: string | null
  expectedUnit: string
  converted: boolean
}

type UnitDefinition = {
  dimension: string
  toBase: (value: number) => number
  fromBase: (value: number) => number
}

const linearUnit = (
  dimension: string,
  factor: number,
): UnitDefinition => ({
  dimension,
  toBase: (value) => value * factor,
  fromBase: (value) => value / factor,
})

const UNIT_DEFINITIONS: Record<
  string,
  UnitDefinition
> = {
  kg: linearUnit('mass', 1000),
  g: linearUnit('mass', 1),
  mg: linearUnit('mass', 0.001),
  ug: linearUnit('mass', 0.000001),

  km: linearUnit('length', 1000),
  m: linearUnit('length', 1),
  cm: linearUnit('length', 0.01),
  mm: linearUnit('length', 0.001),
  um: linearUnit('length', 0.000001),

  l: linearUnit('volume', 1),
  ml: linearUnit('volume', 0.001),
  ul: linearUnit('volume', 0.000001),

  h: linearUnit('time', 3600),
  min: linearUnit('time', 60),
  s: linearUnit('time', 1),
  ms: linearUnit('time', 0.001),
  day: linearUnit('time', 86400),
  week: linearUnit('time', 604800),

  percent: linearUnit('percentage', 1),

  celsius: {
    dimension: 'temperature',
    toBase: (value) => value,
    fromBase: (value) => value,
  },
  fahrenheit: {
    dimension: 'temperature',
    toBase: (value) =>
      ((value - 32) * 5) / 9,
    fromBase: (value) =>
      (value * 9) / 5 + 32,
  },
}

const UNIT_ALIASES: Record<string, string> = {
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',

  g: 'g',
  gram: 'g',
  grams: 'g',

  mg: 'mg',
  milligram: 'mg',
  milligrams: 'mg',

  ug: 'ug',
  mcg: 'ug',
  microgram: 'ug',
  micrograms: 'ug',

  km: 'km',
  kilometer: 'km',
  kilometers: 'km',
  kilometre: 'km',
  kilometres: 'km',

  m: 'm',
  meter: 'm',
  meters: 'm',
  metre: 'm',
  metres: 'm',

  cm: 'cm',
  centimeter: 'cm',
  centimeters: 'cm',
  centimetre: 'cm',
  centimetres: 'cm',

  mm: 'mm',
  millimeter: 'mm',
  millimeters: 'mm',
  millimetre: 'mm',
  millimetres: 'mm',

  um: 'um',
  micrometer: 'um',
  micrometers: 'um',
  micrometre: 'um',
  micrometres: 'um',

  l: 'l',
  liter: 'l',
  liters: 'l',
  litre: 'l',
  litres: 'l',

  ml: 'ml',
  milliliter: 'ml',
  milliliters: 'ml',
  millilitre: 'ml',
  millilitres: 'ml',

  ul: 'ul',
  microliter: 'ul',
  microliters: 'ul',
  microlitre: 'ul',
  microlitres: 'ul',

  h: 'h',
  hr: 'h',
  hrs: 'h',
  hour: 'h',
  hours: 'h',

  min: 'min',
  mins: 'min',
  minute: 'min',
  minutes: 'min',

  s: 's',
  sec: 's',
  secs: 's',
  second: 's',
  seconds: 's',

  ms: 'ms',
  millisecond: 'ms',
  milliseconds: 'ms',

  day: 'day',
  days: 'day',

  week: 'week',
  weeks: 'week',

  '%': 'percent',
  percent: 'percent',
  percentage: 'percent',

  c: 'celsius',
  '°c': 'celsius',
  celsius: 'celsius',
  degreecelsius: 'celsius',
  degreescelsius: 'celsius',

  f: 'fahrenheit',
  '°f': 'fahrenheit',
  fahrenheit: 'fahrenheit',
  degreefahrenheit: 'fahrenheit',
  degreesfahrenheit: 'fahrenheit',
}

function normalizeUnitText(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[μµ]/g, 'u')
    .replace(/[º]/g, '°')
    .replace(/[.,;:!?()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactUnitText(value: string) {
  return normalizeUnitText(value)
    .replace(/\s+/g, '')
}

function resolveKnownUnit(value: string) {
  const compact = compactUnitText(value)
  const canonical = UNIT_ALIASES[compact]

  return canonical ?? null
}

function normalizeGenericUnit(value: string) {
  return compactUnitText(value)
}

function parseNumberAndUnit(answer: string) {
  const numericMatch = answer.match(
    /[-+]?(?:\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?/i,
  )

  if (!numericMatch || numericMatch.index === undefined) {
    return null
  }

  const value = Number(
    numericMatch[0].replace(/,/g, ''),
  )

  if (!Number.isFinite(value)) {
    return null
  }

  const unitText = answer
    .slice(
      numericMatch.index +
        numericMatch[0].length,
    )
    .trim()

  return {
    value,
    unitText,
  }
}

export function compareNumericMeasurement(
  answer: string,
  expectedUnitRaw: string,
): NumericMeasurement {
  const parsed = parseNumberAndUnit(answer)
  const expectedUnit =
    expectedUnitRaw.trim()

  if (!parsed) {
    return {
      status: 'no_number',
      valueInExpectedUnit: null,
      providedUnit: null,
      expectedUnit,
      converted: false,
    }
  }

  const providedUnitText =
    parsed.unitText
  const expectedKnownUnit =
    resolveKnownUnit(expectedUnit)

  if (!expectedUnit) {
    if (providedUnitText) {
      return {
        status: 'unexpected_unit',
        valueInExpectedUnit: null,
        providedUnit: providedUnitText,
        expectedUnit,
        converted: false,
      }
    }

    return {
      status: 'ok',
      valueInExpectedUnit: parsed.value,
      providedUnit: null,
      expectedUnit,
      converted: false,
    }
  }

  if (!providedUnitText) {
    return {
      status: 'missing_unit',
      valueInExpectedUnit: null,
      providedUnit: null,
      expectedUnit,
      converted: false,
    }
  }

  const providedKnownUnit =
    resolveKnownUnit(providedUnitText)

  if (expectedKnownUnit) {
    if (!providedKnownUnit) {
      return {
        status: 'incompatible_unit',
        valueInExpectedUnit: null,
        providedUnit: providedUnitText,
        expectedUnit,
        converted: false,
      }
    }

    const expectedDefinition =
      UNIT_DEFINITIONS[expectedKnownUnit]
    const providedDefinition =
      UNIT_DEFINITIONS[providedKnownUnit]

    if (
      expectedDefinition.dimension !==
      providedDefinition.dimension
    ) {
      return {
        status: 'incompatible_unit',
        valueInExpectedUnit: null,
        providedUnit: providedUnitText,
        expectedUnit,
        converted: false,
      }
    }

    const baseValue =
      providedDefinition.toBase(
        parsed.value,
      )
    const convertedValue =
      expectedDefinition.fromBase(
        baseValue,
      )

    return {
      status: 'ok',
      valueInExpectedUnit:
        convertedValue,
      providedUnit: providedUnitText,
      expectedUnit,
      converted:
        providedKnownUnit !==
        expectedKnownUnit,
    }
  }

  if (
    normalizeGenericUnit(providedUnitText) !==
    normalizeGenericUnit(expectedUnit)
  ) {
    return {
      status: 'incompatible_unit',
      valueInExpectedUnit: null,
      providedUnit: providedUnitText,
      expectedUnit,
      converted: false,
    }
  }

  return {
    status: 'ok',
    valueInExpectedUnit: parsed.value,
    providedUnit: providedUnitText,
    expectedUnit,
    converted: false,
  }
}
