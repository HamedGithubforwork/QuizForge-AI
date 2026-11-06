'use strict'

// Diagnostic only: NEVER changes the production quiz validator or awards credit.
// Reports fixed synthetic fact IDs, reason codes and counts, not generated text.
const { FIXTURES, validateSemanticQuiz } = require('./verify-local-product-acceptance.cjs')

const normalized = value => String(value ?? '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim()
const answerMatches = (answer, values) => {
  const value = normalized(answer)
  return Array.isArray(values) && values.some(candidate =>
    value === candidate || value.startsWith(candidate + ' ') || value.endsWith(' ' + candidate))
}
const pageNumbers = question => Array.isArray(question?.source_pages)
  ? question.source_pages.filter(n => Number.isSafeInteger(n)) : []

function inspectQuestion(question, fixture, priorFacts = new Set()) {
  const correctAnswer = typeof question?.correct_answer === 'string'
    ? question.correct_answer
    : Array.isArray(question?.choices) &&
        Number.isSafeInteger(question.correct_index) &&
        question.correct_index >= 0 && question.correct_index < question.choices.length &&
        typeof question.choices[question.correct_index] === 'string'
      ? question.choices[question.correct_index]
      : null
  if (!question || typeof question.question !== 'string' ||
      typeof correctAnswer !== 'string') {
    return { reason: 'question_shape', sourceFactId: null, oracleMatch: false, evidenceMatch: false }
  }
  const context = normalized(question.question + ' ' + (question.explanation ?? ''))
  const cited = pageNumbers(question)
  const related = fixture.facts.filter(fact =>
    fact.routes.some(route => answerMatches(correctAnswer, route.answers)))
  const withCitation = related.filter(fact =>
    (fact.pages ?? [fact.page]).every(number => cited.includes(number)))
  const matched = withCitation.filter(fact =>
    fact.routes.some(route =>
      answerMatches(correctAnswer, route.answers) &&
      route.tokens.every(token => context.includes(normalized(token)))))
  const candidate = matched.length === 1 ? matched[0] : null
  const citedText = fixture.selectedPages.filter(p => cited.includes(p.pageNumber))
    .map(p => normalized(p.text)).join(' ')
  const quote = normalized(question.source_fact)
  // A quote match is not by itself proof of answer correctness.
  const evidenceMatch = quote.length > 0 && citedText.includes(quote) &&
    quote.includes(normalized(correctAnswer))
  const duplicatesFact = candidate && priorFacts.has(candidate.id)
  const reason = matched.length > 1 ? 'oracle_ambiguous' :
    candidate && duplicatesFact ? 'duplicate_fact' :
    candidate ? 'matched' :
    withCitation.length > 0 ? 'oracle_wording_mismatch_candidate' :
    related.length > 0 ? 'citation_or_answer_context_mismatch' :
    'answer_not_in_fixture_aliases'
  return {
    reason, sourceFactId: candidate?.id ?? (withCitation.length === 1 ? withCitation[0].id : null),
    oracleMatch: reason === 'matched',
    evidenceMatch,
  }
}

function inspectQuiz(quiz, fixture) {
  const questions = Array.isArray(quiz?.questions) ? quiz.questions : []
  const facts = new Set()
  const questionsReport = questions.slice(0, 20).map((question, i) => {
    const result = inspectQuestion(question, fixture, facts)
    if (result.oracleMatch) facts.add(result.sourceFactId)
    const choices = Array.isArray(question?.choices) ? question.choices : []
    const cleanChoices = choices.map(normalized)
    return {
      index: i + 1, reason: result.reason, factId: result.sourceFactId,
      oracleMatched: result.oracleMatch,
      sourceQuoteMatched: result.evidenceMatch,
      duplicateChoices: cleanChoices.length > 0 &&
        new Set(cleanChoices).size !== cleanChoices.length,
    }
  })
  let strictPass = false
  try { validateSemanticQuiz(quiz, fixture); strictPass = true } catch {}
  return {
    questionCount: questions.length,
    oracleMatchedQuestions: questionsReport.filter(q => q.oracleMatched).length,
    distinctOracleFacts: facts.size,
    exactQuotedCandidates: questionsReport.filter(q => q.sourceQuoteMatched).length,
    strictPass,
    questions: questionsReport,
  }
}

function inspectModelResponse(text, fixture) {
  if (typeof text !== 'string' || text.length > 80000) return { status: 'invalid_text' }
  let parsed
  try { parsed = JSON.parse(text) } catch { return { status: 'invalid_json' } }
  if (!parsed || !Array.isArray(parsed.questions)) return { status: 'invalid_shape' }
  if (!parsed.questions.length) return { status: 'abstained', questionCount: 0 }
  return { status: 'has_questions', ...inspectQuiz(parsed, fixture) }
}

module.exports = { inspectQuestion, inspectQuiz, inspectModelResponse, FIXTURES }
