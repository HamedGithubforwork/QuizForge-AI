'use strict'
const at = '2026-09-30T04:00:00.000000+00:00'
function snapshotDeck() {
  const id = '11111111-1111-4111-8111-111111111111'
  return {
    id, name: 'Private study notes', description: null, exam_date: null,
    study_intensity: 'balanced', card_count: 1, due_count: 1, next_due_at: null,
    created_at: at, updated_at: at,
    cards: [{
      id: '22222222-2222-4222-8222-222222222222', deck_id: id,
      question_type: 'short_answer', question: 'Private question',
      answer: { correct_answer: 'Private answer', accepted_answers: ['Private answer'] }, choices: null,
      explanation: null, source_filename: null, document_sha256: null, source_pages: [], tags: [],
      fsrs_state: 1, fsrs_step: 0, stability: null, difficulty: null,
      due_at: at, last_reviewed_at: null, review_count: 0, lapse_count: 0,
      suspended: false, progress_reset_at: null, created_at: at, updated_at: at,
    }],
  }
}
module.exports = { snapshotDeck }
