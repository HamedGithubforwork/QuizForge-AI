export type ShortAnswerGradingMode =
  | 'none'
  | 'concepts'
  | 'exact'
  | 'numeric'

export type ShortAnswerGradingSpec = {
  grading_version: number
  grading_mode: ShortAnswerGradingMode
  answer_groups: string[][]
  required_group_count: number
  numeric_value: number
  numeric_tolerance: number
  numeric_unit: string
}

export type ShortAnswerQuestion = {
  correct_answer: string
  accepted_answers: string[]
  grading?: ShortAnswerGradingSpec
}

export type ShortAnswerGrade = {
  correct: boolean
  matchedGroups: number
  requiredGroups: number
  totalGroups: number
  borderline: boolean
  feedback: string
}

const NEGATION_WORDS = new Set([
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
])

const SPELLING_EQUIVALENTS: Record<
  string,
  string
> = {
  behavioural: 'behavioral',
  behaviour: 'behavior',
  behaviours: 'behaviors',
  colour: 'color',
  colours: 'colors',
  organisation: 'organization',
  organisations: 'organizations',
  organised: 'organized',
  organising: 'organizing',
  analyse: 'analyze',
  analysed: 'analyzed',
  analysing: 'analyzing',
}

export function normalizeShortAnswer(
  value: string,
) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[-–—/]/g, ' ')
    .replace(/[^a-z0-9.%+\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(
      (word) =>
        SPELLING_EQUIVALENTS[word] ??
        word,
    )
    .join(' ')
}

function tokenize(value: string) {
  const normalized =
    normalizeShortAnswer(value)

  return normalized
    ? normalized.split(' ')
    : []
}

function removeSimplePlural(
  value: string,
) {
  const words = value.split(' ')

  if (words.length === 0) {
    return value
  }

  const lastIndex = words.length - 1
  const lastWord = words[lastIndex]

  if (
    lastWord.length > 3 &&
    lastWord.endsWith('s') &&
    !lastWord.endsWith('ss')
  ) {
    words[lastIndex] =
      lastWord.slice(0, -1)
  }

  return words.join(' ')
}

function levenshteinDistance(
  first: string,
  second: string,
) {
  if (first === second) {
    return 0
  }

  if (!first.length) {
    return second.length
  }

  if (!second.length) {
    return first.length
  }

  const previous = Array.from(
    { length: second.length + 1 },
    (_, index) => index,
  )

  const current = new Array<number>(
    second.length + 1,
  )

  for (
    let firstIndex = 1;
    firstIndex <= first.length;
    firstIndex += 1
  ) {
    current[0] = firstIndex

    for (
      let secondIndex = 1;
      secondIndex <= second.length;
      secondIndex += 1
    ) {
      const substitutionCost =
        first[firstIndex - 1] ===
        second[secondIndex - 1]
          ? 0
          : 1

      current[secondIndex] = Math.min(
        current[secondIndex - 1] + 1,
        previous[secondIndex] + 1,
        previous[secondIndex - 1] +
          substitutionCost,
      )
    }

    for (
      let index = 0;
      index <= second.length;
      index += 1
    ) {
      previous[index] = current[index]
    }
  }

  return previous[second.length]
}

function tokenMatches(
  userToken: string,
  expectedToken: string,
) {
  if (userToken === expectedToken) {
    return true
  }

  const minimumLength = Math.min(
    userToken.length,
    expectedToken.length,
  )

  if (minimumLength < 6) {
    return false
  }

  const allowedDistance =
    minimumLength >= 9 ? 2 : 1

  return (
    levenshteinDistance(
      userToken,
      expectedToken,
    ) <= allowedDistance
  )
}

function sequenceMatches(
  userTokens: string[],
  aliasTokens: string[],
) {
  if (
    aliasTokens.length === 0 ||
    userTokens.length < aliasTokens.length
  ) {
    return false
  }

  for (
    let start = 0;
    start <=
    userTokens.length - aliasTokens.length;
    start += 1
  ) {
    const matches =
      aliasTokens.every(
        (expectedToken, offset) =>
          tokenMatches(
            userTokens[start + offset],
            expectedToken,
          ),
      )

    if (matches) {
      return true
    }
  }

  return false
}

function aliasMatches(
  userAnswer: string,
  alias: string,
) {
  return sequenceMatches(
    tokenize(userAnswer),
    tokenize(alias),
  )
}

function hasUnexpectedNegation(
  answer: string,
  expectedAnswer: string,
) {
  const answerTokens = tokenize(answer)
  const expectedTokens = new Set(
    tokenize(expectedAnswer),
  )

  return answerTokens.some(
    (token) =>
      NEGATION_WORDS.has(token) &&
      !expectedTokens.has(token),
  )
}

function legacyAnswerMatches(
  userAnswer: string,
  acceptedAnswer: string,
) {
  if (userAnswer === acceptedAnswer) {
    return true
  }

  if (
    removeSimplePlural(userAnswer) ===
    removeSimplePlural(acceptedAnswer)
  ) {
    return true
  }

  const acceptedTokens =
    acceptedAnswer.split(' ')

  if (acceptedTokens.length !== 1) {
    return false
  }

  const token = acceptedTokens[0]
  const usefulToken =
    token.length >= 4 ||
    /^\d+$/.test(token)

  return (
    usefulToken &&
    userAnswer.split(' ').includes(token)
  )
}

function gradeLegacyAnswer(
  question: ShortAnswerQuestion,
  answer: string,
): ShortAnswerGrade {
  const acceptedAnswers = [
    question.correct_answer,
    ...question.accepted_answers,
  ]
    .map(normalizeShortAnswer)
    .filter(
      (value, index, array) =>
        value.length > 0 &&
        array.indexOf(value) === index,
    )

  const normalizedUser =
    normalizeShortAnswer(answer)

  const correct = acceptedAnswers.some(
    (acceptedAnswer) =>
      legacyAnswerMatches(
        normalizedUser,
        acceptedAnswer,
      ),
  )

  return {
    correct,
    matchedGroups: correct ? 1 : 0,
    requiredGroups: 1,
    totalGroups: 1,
    borderline: false,
    feedback: correct
      ? 'Answer matched the expected response.'
      : 'Answer did not match an accepted response.',
  }
}

function gradeConceptAnswer(
  question: ShortAnswerQuestion,
  answer: string,
  grading: ShortAnswerGradingSpec,
): ShortAnswerGrade {
  const groups = grading.answer_groups
    .map(
      (group) =>
        group
          .map((value) => value.trim())
          .filter(Boolean),
    )
    .filter((group) => group.length > 0)

  if (groups.length === 0) {
    return gradeLegacyAnswer(
      question,
      answer,
    )
  }

  const requiredGroups = Math.min(
    Math.max(
      1,
      grading.required_group_count,
    ),
    groups.length,
  )

  const matchedGroups = groups.filter(
    (group) =>
      group.some((alias) =>
        aliasMatches(answer, alias),
      ),
  ).length

  const borderline =
    hasUnexpectedNegation(
      answer,
      question.correct_answer,
    )

  const correct =
    matchedGroups >= requiredGroups &&
    !borderline

  const feedback = borderline
    ? 'The answer contains negation, so its meaning is ambiguous for automatic grading.'
    : `Matched ${matchedGroups} of ${requiredGroups} required concepts.`

  return {
    correct,
    matchedGroups,
    requiredGroups,
    totalGroups: groups.length,
    borderline,
    feedback,
  }
}

function parseNumericAnswer(answer: string) {
  const normalized = answer
    .replace(/,/g, '')
    .trim()

  const match = normalized.match(
    /[-+]?\d*\.?\d+(?:e[-+]?\d+)?/i,
  )

  if (!match) {
    return null
  }

  const value = Number(match[0])

  return Number.isFinite(value)
    ? value
    : null
}

function gradeNumericAnswer(
  answer: string,
  grading: ShortAnswerGradingSpec,
): ShortAnswerGrade {
  const value = parseNumericAnswer(answer)
  const tolerance = Math.max(
    0,
    grading.numeric_tolerance,
  )

  const correct =
    value !== null &&
    Math.abs(
      value - grading.numeric_value,
    ) <= tolerance

  return {
    correct,
    matchedGroups: correct ? 1 : 0,
    requiredGroups: 1,
    totalGroups: 1,
    borderline: false,
    feedback: correct
      ? 'Numeric answer is within the accepted tolerance.'
      : 'Numeric answer is outside the accepted value or tolerance.',
  }
}

function gradeExactAnswer(
  question: ShortAnswerQuestion,
  answer: string,
): ShortAnswerGrade {
  const normalizedUser =
    normalizeShortAnswer(answer)

  const acceptedAnswers = [
    question.correct_answer,
    ...question.accepted_answers,
  ]
    .map(normalizeShortAnswer)
    .filter(Boolean)

  const correct = acceptedAnswers.includes(
    normalizedUser,
  )

  return {
    correct,
    matchedGroups: correct ? 1 : 0,
    requiredGroups: 1,
    totalGroups: 1,
    borderline: false,
    feedback: correct
      ? 'Answer matched an accepted exact response.'
      : 'Answer did not match an accepted exact response.',
  }
}

export function gradeShortAnswer(
  question: ShortAnswerQuestion,
  answer: string,
): ShortAnswerGrade {
  const grading = question.grading

  if (
    !grading ||
    grading.grading_version < 2 ||
    grading.grading_mode === 'none'
  ) {
    return gradeLegacyAnswer(
      question,
      answer,
    )
  }

  if (grading.grading_mode === 'numeric') {
    return gradeNumericAnswer(
      answer,
      grading,
    )
  }

  if (grading.grading_mode === 'exact') {
    return gradeExactAnswer(
      question,
      answer,
    )
  }

  return gradeConceptAnswer(
    question,
    answer,
    grading,
  )
}
