import {
  useEffect,
  useState,
} from 'react'

import {
  apiFetch,
} from '../../lib/api'
import {
  addCardsToStudyDeck,
  getStudyDeck,
} from '../../lib/decks'
import {
  buildWeakDeckAiFocus,
  generateWeakDeckPracticeQuiz,
  practiceCardsFromQuiz,
  type WeakDeckAiFocus,
} from '../../lib/deckAiPractice'
import {
  weakCardLabel,
  weakStudyCards,
} from '../../lib/studyModes'
import type {
  DeckDetail,
} from '../../types/api.generated'
import type {
  QuizResult,
} from '../../types/quiz'

type DeckAiPracticePageProps = {
  deckId: string
  onNavigate: (path: string) => void
}

function questionTypeLabel(
  value: string,
) {
  if (
    value ===
    'multiple_choice'
  ) {
    return 'Multiple Choice'
  }

  if (
    value ===
    'true_false'
  ) {
    return 'True / False'
  }

  if (
    value ===
    'short_answer'
  ) {
    return 'Short Answer'
  }

  return 'Mixed'
}

export default function DeckAiPracticePage({
  deckId,
  onNavigate,
}: DeckAiPracticePageProps) {
  const [deck, setDeck] =
    useState<DeckDetail | null>(
      null,
    )
  const [focus, setFocus] =
    useState<
      WeakDeckAiFocus | null
    >(null)
  const [generated, setGenerated] =
    useState<QuizResult | null>(
      null,
    )
  const [savedCount, setSavedCount] =
    useState(0)
  const [loading, setLoading] =
    useState(true)
  const [
    generating,
    setGenerating,
  ] = useState(false)
  const [saving, setSaving] =
    useState(false)
  const [error, setError] =
    useState('')

  useEffect(() => {
    let active = true

    async function load() {
      setLoading(true)
      setError('')

      try {
        const next =
          await getStudyDeck(
            deckId,
            apiFetch,
          )

        if (!active) {
          return
        }

        setDeck(next)
        setFocus(
          buildWeakDeckAiFocus(
            next,
          ),
        )
      } catch (caught) {
        if (active) {
          setError(
            caught instanceof Error
              ? caught.message
              : 'Could not prepare AI practice.',
          )
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void load()

    return () => {
      active = false
    }
  }, [deckId])

  async function saveGenerated(
    quiz: QuizResult,
    resolvedFocus:
      WeakDeckAiFocus,
  ) {
    setSaving(true)

    try {
      const cards =
        practiceCardsFromQuiz(
          quiz,
          resolvedFocus,
        )

      const updated =
        await addCardsToStudyDeck(
          deckId,
          cards,
          apiFetch,
        )

      setDeck(updated)
      setSavedCount(
        cards.length,
      )
      setError('')
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The AI questions were generated, but they could not be added to the deck.',
      )
    } finally {
      setSaving(false)
    }
  }

  async function generate() {
    if (!focus) {
      return
    }

    setGenerating(true)
    setError('')
    setGenerated(null)
    setSavedCount(0)

    try {
      const quiz =
        await generateWeakDeckPracticeQuiz(
          focus,
          apiFetch,
        )

      setGenerated(quiz)
      await saveGenerated(
        quiz,
        focus,
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not generate AI practice cards.',
      )
    } finally {
      setGenerating(false)
    }
  }

  if (loading) {
    return (
      <section
        className="review-session-status"
        role="status"
      >
        <div
          className="decks-spinner"
          aria-hidden="true"
        />

        <span>
          Analyzing weak-card evidence…
        </span>
      </section>
    )
  }

  if (error && !deck) {
    return (
      <section className="review-session-status">
        <h1>
          Could not prepare AI practice
        </h1>

        <p role="alert">
          {error}
        </p>

        <button
          className="decks-secondary-button"
          type="button"
          onClick={() =>
            onNavigate(
              `/decks/${deckId}`,
            )
          }
        >
          Back to Deck
        </button>
      </section>
    )
  }

  if (!deck) {
    return null
  }

  const weakCards =
    weakStudyCards(
      deck.cards,
    )

  if (!focus) {
    const missingSource =
      weakCards.length > 0

    return (
      <>
        <button
          className="decks-back"
          type="button"
          onClick={() =>
            onNavigate(
              `/decks/${deckId}`,
            )
          }
        >
          ← {deck.name}
        </button>

        <section className="review-complete">
          <span className="decks-eyebrow">
            AI PRACTICE
          </span>

          <h1>
            {missingSource
              ? 'Source PDF is unavailable for these weak cards'
              : 'No weak cards to target yet'}
          </h1>

          <p>
            {missingSource
              ? 'AI practice needs weak cards that still have a saved source-document identifier. Manual cards without source provenance cannot be regenerated from the PDF.'
              : 'Review this deck normally first. Once cards show lapses or high FSRS difficulty, Quiz From Notes can generate new targeted practice.'}
          </p>

          <button
            className="decks-secondary-button"
            type="button"
            onClick={() =>
              onNavigate(
                `/decks/${deckId}`,
              )
            }
          >
            Back to Deck
          </button>
        </section>
      </>
    )
  }

  return (
    <>
      <button
        className="decks-back"
        type="button"
        disabled={
          generating ||
          saving
        }
        onClick={() =>
          onNavigate(
            `/decks/${deckId}`,
          )
        }
      >
        ← {deck.name}
      </button>

      <section className="deck-ai-practice">
        <div className="deck-ai-practice-heading">
          <div>
            <span className="decks-eyebrow">
              AI + SPACED REPETITION
            </span>

            <h1>
              Generate targeted practice cards
            </h1>

            <p>
              Quiz From Notes will use your
              weakest reviewed cards as
              evidence, return to their
              source PDF pages, and create
              new questions instead of
              repeating the old ones.
            </p>
          </div>

          <span className="deck-ai-practice-count">
            {focus.weakCardCount}{' '}
            {focus.weakCardCount ===
            1
              ? 'weak card'
              : 'weak cards'}
          </span>
        </div>

        <div className="deck-ai-focus-grid">
          <article>
            <span>
              Source
            </span>

            <strong>
              {focus.sourceFilename}
            </strong>
          </article>

          <article>
            <span>
              Focus pages
            </span>

            <strong>
              {focus.sourcePages.length >
              0
                ? focus.sourcePages.join(
                    ', ',
                  )
                : 'Whole document'}
            </strong>
          </article>

          <article>
            <span>
              Practice type
            </span>

            <strong>
              {questionTypeLabel(
                focus.questionMode,
              )}
            </strong>
          </article>

          <article>
            <span>
              Difficulty
            </span>

            <strong>
              {focus.difficulty ===
              'easy'
                ? 'Foundational'
                : 'Medium'}
            </strong>
          </article>
        </div>

        <div className="deck-ai-evidence">
          <h2>
            Weak-card evidence
          </h2>

          <div className="deck-ai-evidence-list">
            {weakCards
              .filter(
                (card) =>
                  card.document_sha256 ===
                  focus.documentSha256,
              )
              .slice(0, 5)
              .map(
                (card) => (
                  <div
                    key={card.id}
                  >
                    <span>
                      {
                        card.question
                      }
                    </span>

                    <strong>
                      {weakCardLabel(
                        card,
                      )}
                    </strong>
                  </div>
                ),
              )}
          </div>
        </div>

        {!generated && (
          <div className="deck-ai-action">
            <button
              className="decks-primary-button"
              type="button"
              disabled={generating}
              onClick={() =>
                void generate()
              }
            >
              {generating
                ? 'Generating 5 Practice Cards…'
                : 'Generate 5 AI Practice Cards'}
            </button>

            <span>
              New cards are added as fresh
              FSRS cards tagged
              {' '}
              <strong>
                #ai-practice
              </strong>
              .
            </span>
          </div>
        )}

        {generated && (
          <section className="deck-ai-result">
            <div>
              <span className="decks-eyebrow">
                GENERATED PRACTICE
              </span>

              <h2>
                {generated.title}
              </h2>

              <p>
                {savedCount > 0
                  ? `${savedCount} new ${savedCount === 1 ? 'card was' : 'cards were'} added to this deck.`
                  : 'The questions were generated but are not saved yet.'}
              </p>
            </div>

            <ol>
              {generated.questions.map(
                (
                  question,
                  index,
                ) => (
                  <li key={index}>
                    {
                      question.question
                    }
                  </li>
                ),
              )}
            </ol>

            {savedCount === 0 && (
              <button
                className="decks-primary-button"
                type="button"
                disabled={saving}
                onClick={() =>
                  void saveGenerated(
                    generated,
                    focus,
                  )
                }
              >
                {saving
                  ? 'Saving Practice Cards…'
                  : 'Retry Saving Practice Cards'}
              </button>
            )}

            {savedCount > 0 && (
              <div className="deck-ai-result-actions">
                <button
                  className="decks-primary-button"
                  type="button"
                  onClick={() =>
                    onNavigate(
                      `/decks/${deckId}/review`,
                    )
                  }
                >
                  Review New Cards
                </button>

                <button
                  className="decks-secondary-button"
                  type="button"
                  onClick={() =>
                    onNavigate(
                      `/decks/${deckId}`,
                    )
                  }
                >
                  Back to Deck
                </button>
              </div>
            )}
          </section>
        )}

        {error && (
          <div
            className="deck-management-error"
            role="alert"
          >
            {error}
            {error
              .toLowerCase()
              .includes(
                'expired',
              ) && (
              <span>
                {' '}Reprocess the source
                PDF from the Quiz page,
                then try again while its
                processed text is
                available.
              </span>
            )}
          </div>
        )}
      </section>
    </>
  )
}
