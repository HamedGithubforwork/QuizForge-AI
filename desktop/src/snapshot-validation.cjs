'use strict'

// Snapshot schema 1 stores complete DeckDetail/CardRow responses, not drafts.
// Keep these fields aligned with backend/decks.py. Scheduling remains server-owned.
const DECK_FIELDS = 'id name description exam_date study_intensity card_count due_count next_due_at created_at updated_at cards'.split(' ')
const CARD_FIELDS = 'id deck_id question_type question answer choices explanation source_filename document_sha256 source_pages tags fsrs_state fsrs_step stability difficulty due_at last_reviewed_at review_count lapse_count suspended progress_reset_at created_at updated_at'.split(' ')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const text = (value, limit, required = false) => typeof value === 'string' && [...value].length <= limit && (!required || value.trim().length > 0)
const nullable = (value, check) => value === null || check(value)
const fields = (value, names) => record(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
const uuid = value => typeof value === 'string' && UUID.test(value)

function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value
}

function timestamp(value) {
  if (typeof value !== 'string') return false
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  return Boolean(match && date(match[1]) && +match[2] < 24 && +match[3] < 60 && +match[4] < 60 && Number.isFinite(Date.parse(value)))
}

function answer(card) {
  const value = card.answer
  if (!record(value) || !text(value.correct_answer, 100_000, true)) return false
  if (value.accepted_answers !== undefined && value.accepted_answers !== null &&
      (!Array.isArray(value.accepted_answers) || !value.accepted_answers.every(item => text(item, 100_000, true)))) return false
  if (card.question_type === 'short_answer') return card.choices === null && (value.correct_index === undefined || value.correct_index === null)
  return Array.isArray(card.choices) && card.choices.length >= 2 && card.choices.length <= 8 &&
    card.choices.every(choice => text(choice, 2000, true)) && integer(value.correct_index) && value.correct_index < card.choices.length &&
    (card.question_type !== 'true_false' || card.choices.length === 2)
}

function cardValid(card, deckId, ids) {
  if (!fields(card, CARD_FIELDS) || !uuid(card.id) || !uuid(card.deck_id) || card.deck_id.toLowerCase() !== deckId.toLowerCase() || ids.has(card.id.toLowerCase())) return false
  ids.add(card.id.toLowerCase())
  return ['multiple_choice', 'true_false', 'short_answer'].includes(card.question_type) && text(card.question, 10_000, true) && answer(card) &&
    nullable(card.explanation, value => text(value, 20_000)) && nullable(card.source_filename, value => text(value, 1000)) &&
    nullable(card.document_sha256, value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) &&
    Array.isArray(card.source_pages) && card.source_pages.length <= 50 && card.source_pages.every(page => integer(page) && page > 0) &&
    new Set(card.source_pages).size === card.source_pages.length &&
    Array.isArray(card.tags) && card.tags.length <= 20 && card.tags.every(tag => text(tag, 50, true)) && new Set(card.tags).size === card.tags.length &&
    [1, 2, 3].includes(card.fsrs_state) && nullable(card.fsrs_step, integer) &&
    nullable(card.stability, value => Number.isFinite(value) && value >= 0) &&
    nullable(card.difficulty, value => Number.isFinite(value) && value >= 1 && value <= 10) &&
    integer(card.review_count) && integer(card.lapse_count) && card.lapse_count <= card.review_count && typeof card.suspended === 'boolean' &&
    timestamp(card.due_at) && nullable(card.last_reviewed_at, timestamp) && nullable(card.progress_reset_at, timestamp) &&
    timestamp(card.created_at) && timestamp(card.updated_at) && Buffer.byteLength(JSON.stringify(card)) <= 100_000
}

function validateEnvelope(value, ownerId) {
  const reject = () => { throw new Error('Invalid or incompatible study snapshot.') }
  if (!fields(value, ['schema', 'ownerId', 'savedAt', 'decks']) || value.schema !== 1 || value.ownerId !== ownerId ||
      !timestamp(value.savedAt) || !Array.isArray(value.decks) || value.decks.length > 1000) reject()
  const deckIds = new Set()
  const cardIds = new Set()
  for (const deck of value.decks) {
    if (!fields(deck, DECK_FIELDS) || !uuid(deck.id) || deckIds.has(deck.id.toLowerCase()) || !text(deck.name, 200, true) ||
        !nullable(deck.description, item => text(item, 2000)) || !nullable(deck.exam_date, date) ||
        !['relaxed', 'balanced', 'intensive'].includes(deck.study_intensity) || !Array.isArray(deck.cards) ||
        !integer(deck.card_count) || deck.card_count !== deck.cards.length || !integer(deck.due_count) || deck.due_count > deck.card_count ||
        !nullable(deck.next_due_at, timestamp) || !timestamp(deck.created_at) || !timestamp(deck.updated_at) ||
        !deck.cards.every(card => cardValid(card, deck.id, cardIds))) reject()
    deckIds.add(deck.id.toLowerCase())
  }
  return value
}

module.exports = { validateEnvelope }
