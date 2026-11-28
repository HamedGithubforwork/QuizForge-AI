const assert = require('node:assert/strict')
const test = require('node:test')

const SEMANTIC_LIMIT_BYTES = 512 * 1024
const ORIGINAL_PROXY_LIMIT_BYTES = 512 * 1024
const CORRECTED_PROXY_LIMIT_BYTES = 2 * 1024 * 1024
const USER_PREFIX = 'Review these borderline short answers:\n\n'

// Historical, synthetic review fixture: it models the original 512 KiB proxy
// cap and a hypothetical 2 MiB allowance to demonstrate envelope overhead.
// It is not a live configuration check and does not describe the current
// PR #686 Caddy limit (4 MiB); integration tests verify that configuration.

function pythonCompatibleJson(value) {
  const compact = JSON.stringify(value)
  let output = ''
  let insideString = false
  let escaped = false

  for (const character of compact) {
    if (insideString) {
      output += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') insideString = false
      continue
    }

    if (character === '"') insideString = true
    output += character
    if (character === ',' || character === ':') output += ' '
  }

  return output
}

function escapeNonAsciiForJson(value) {
  return JSON.stringify(value).replace(/[^\x00-\x7f]/gu, character => {
    const codePoint = character.codePointAt(0)
    if (codePoint <= 0xffff) {
      return `\\u${codePoint.toString(16).padStart(4, '0')}`
    }

    const adjusted = codePoint - 0x10000
    const high = 0xd800 + (adjusted >> 10)
    const low = 0xdc00 + (adjusted & 0x3ff)
    return `\\u${high.toString(16)}\\u${low.toString(16)}`
  })
}

function buildCasesAtSemanticLimit(targetBytes) {
  const aliasGroups = Array.from({ length: 9 }, () => Array(30).fill(''))
  const makeCases = () => aliasGroups.map((aliases, questionIndex) => ({
    question_index: questionIndex,
    question: 'What is a reliable transport protocol?',
    correct_answer: 'TCP provides reliable ordered delivery.',
    accepted_answers: ['TCP'],
    answer_groups: [aliases],
    required_group_count: 1,
    student_answer: 'a reliable transport protocol',
    explanation: 'TCP is reliable and ordered.',
  }))

  let cases = makeCases()
  const initialBytes = Buffer.byteLength(USER_PREFIX + pythonCompatibleJson(cases))
  let remaining = targetBytes - initialBytes
  assert.ok(remaining >= 0)

  for (const aliases of aliasGroups) {
    for (let index = 0; index < aliases.length && remaining > 0; index += 1) {
      const emojiCount = Math.min(2000, Math.floor(remaining / 4))
      aliases[index] = '😀'.repeat(emojiCount)
      remaining -= emojiCount * 4

      if (remaining > 0 && emojiCount < 2000) {
        aliases[index] += 'x'.repeat(Math.min(2000 - emojiCount, remaining))
        remaining -= Math.min(2000 - emojiCount, remaining)
      }
    }
  }

  assert.equal(remaining, 0, 'Fixture must fit supported case and alias bounds')
  cases = makeCases()
  assert.equal(
    Buffer.byteLength(USER_PREFIX + pythonCompatibleJson(cases)),
    targetBytes,
  )
  return cases
}

function reviewRequestBodyLimit(requestBodyBytes, proxyLimitBytes) {
  return requestBodyBytes > proxyLimitBytes
    ? [{ code: 'proxy_limit_below_valid_request', requestBodyBytes, proxyLimitBytes }]
    : []
}

test('flags PR 686 limits when a supported max semantic payload has escaped JSON overhead', () => {
  const cases = buildCasesAtSemanticLimit(SEMANTIC_LIMIT_BYTES)
  const semanticBytes = Buffer.byteLength(USER_PREFIX + pythonCompatibleJson(cases))
  const encodedHttpBody = escapeNonAsciiForJson({ cases })
  const requestBodyBytes = Buffer.byteLength(encodedHttpBody)

  assert.equal(semanticBytes, SEMANTIC_LIMIT_BYTES)
  assert.ok(requestBodyBytes > ORIGINAL_PROXY_LIMIT_BYTES)
  assert.deepEqual(
    reviewRequestBodyLimit(requestBodyBytes, ORIGINAL_PROXY_LIMIT_BYTES),
    [{
      code: 'proxy_limit_below_valid_request',
      requestBodyBytes,
      proxyLimitBytes: ORIGINAL_PROXY_LIMIT_BYTES,
    }],
  )
})

test('accepts a corrected proxy limit that accommodates the same valid request', () => {
  const cases = buildCasesAtSemanticLimit(SEMANTIC_LIMIT_BYTES)
  const encodedHttpBody = escapeNonAsciiForJson({ cases })
  const requestBodyBytes = Buffer.byteLength(encodedHttpBody)

  assert.ok(requestBodyBytes <= CORRECTED_PROXY_LIMIT_BYTES)
  assert.deepEqual(
    reviewRequestBodyLimit(requestBodyBytes, CORRECTED_PROXY_LIMIT_BYTES),
    [],
  )
})
