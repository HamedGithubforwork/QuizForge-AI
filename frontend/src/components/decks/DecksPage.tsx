import {
  useEffect,
  useMemo,
  useState,
} from 'react'

import {
  apiFetch,
} from '../../lib/api'
import {
  resolveDeckRoute,
} from '../../lib/deckRoutes'
import {
  getStudyDeck,
  listStudyDecks,
} from '../../lib/decks'
import type {
  DeckDetail,
  DeckSummary,
} from '../../types/api.generated'
import CreateDeckForm from './CreateDeckForm'
import DeckDetailView from './DeckDetailView'
import CramDeckPage from './CramDeckPage'
import DeckAiPracticePage from './DeckAiPracticePage'
import ExamPlanPage from './ExamPlanPage'
import MissedQuestionsPage from './MissedQuestionsPage'
import RecentlyAddedDeckPage from './RecentlyAddedDeckPage'
import ReviewDeckPage from './ReviewDeckPage'
import WeakCardsPage from './WeakCardsPage'
import './DecksPage.css'

type DecksPageProps = {
  pathname: string
  onNavigate: (path: string) => void
}

function formatDeckDate(
  value: string,
) {
  const date = new Date(value)

  if (
    Number.isNaN(date.getTime())
  ) {
    return 'Recently'
  }

  return new Intl.DateTimeFormat(
    undefined,
    {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    },
  ).format(date)
}

function DeckList({
  decks,
  onNavigate,
}: {
  decks: DeckSummary[]
  onNavigate: (path: string) => void
}) {
  if (decks.length === 0) {
    return (
      <section className="decks-empty">
        <div
          className="decks-empty-icon"
          aria-hidden="true"
        >
          ◫
        </div>

        <h2>
          No study decks yet
        </h2>

        <p>
          Choose Create Deck to add your own cards, or generate a quiz
          and use Save as Study Deck to keep its questions.
        </p>

        <button
          className="decks-primary-button"
          type="button"
          onClick={() =>
            onNavigate('/')
          }
        >
          Generate a Quiz
        </button>
      </section>
    )
  }

  return (
    <div className="decks-grid">
      {decks.map((deck) => (
        <button
          className="deck-tile"
          type="button"
          key={deck.id}
          onClick={() =>
            onNavigate(
              `/decks/${deck.id}`,
            )
          }
        >
          <div className="deck-tile-top">
            <span className="deck-icon">
              ◫
            </span>

            <div className="deck-tile-badges">
              <span className="deck-count">
                {deck.card_count}{' '}
                {deck.card_count === 1
                  ? 'card'
                  : 'cards'}
              </span>

              <span
                className={
                  deck.due_count > 0
                    ? 'deck-due-badge deck-due-badge-active'
                    : 'deck-due-badge'
                }
              >
                {deck.due_count > 0
                  ? `${deck.due_count} due`
                  : 'Caught up'}
              </span>
            </div>
          </div>

          <h2>{deck.name}</h2>

          {deck.description && (
            <p>
              {deck.description}
            </p>
          )}

          <span className="deck-updated">
            Updated{' '}
            {formatDeckDate(
              deck.updated_at,
            )}
          </span>
        </button>
      ))}
    </div>
  )
}

export default function DecksPage({
  pathname,
  onNavigate,
}: DecksPageProps) {
  const [creatingDeck, setCreatingDeck] = useState(false)
  const [decks, setDecks] =
    useState<DeckSummary[]>([])
  const [deck, setDeck] =
    useState<DeckDetail | null>(null)
  const [loading, setLoading] =
    useState(true)
  const [error, setError] =
    useState('')

  const route = useMemo(
    () =>
      resolveDeckRoute(pathname),
    [pathname],
  )

  useEffect(() => {
    let active = true

    async function load() {
      setLoading(true)
      setError('')
      setDeck(null)

      try {
        if (
          route.kind !== 'list' &&
          route.kind !== 'detail' &&
          route.kind !== 'invalid'
        ) {
          return
        }

        if (
          route.kind === 'invalid'
        ) {
          throw new Error(
            'This study deck link is invalid.',
          )
        }

        if (
          route.kind === 'detail'
        ) {
          const [
            nextDeck,
            nextDecks,
          ] = await Promise.all([
            getStudyDeck(
              route.deckId,
              apiFetch,
            ),
            listStudyDecks(
              apiFetch,
            ),
          ])

          if (active) {
            setDeck(nextDeck)
            setDecks(nextDecks)
          }
          return
        }

        const next =
          await listStudyDecks(
            apiFetch,
          )

        if (active) {
          setDecks(next)
        }
      } catch (caught) {
        if (active) {
          setError(
            caught instanceof Error
              ? caught.message
              : 'Could not load your study decks.',
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
  }, [route])

  const totalDue =
    decks.reduce(
      (total, item) =>
        total + item.due_count,
      0,
    )
  const totalCards =
    decks.reduce(
      (total, item) =>
        total + item.card_count,
      0,
    )
  const dueDecks =
    decks.filter(
      (item) =>
        item.due_count > 0,
    ).length

  return (
    <main className="decks-page">
      <div className="decks-shell">
        {route.kind === 'missed' ? (
          <MissedQuestionsPage
            onNavigate={onNavigate}
          />
        ) : route.kind === 'review' ? (
          <ReviewDeckPage
            deckId={route.deckId}
            onNavigate={onNavigate}
          />
        ) : route.kind === 'cram' ? (
          <CramDeckPage
            deckId={route.deckId}
            onNavigate={onNavigate}
          />
        ) : route.kind === 'weak' ? (
          <WeakCardsPage
            deckId={route.deckId}
            onNavigate={onNavigate}
          />
        ) : route.kind === 'recent' ? (
          <RecentlyAddedDeckPage
            deckId={route.deckId}
            onNavigate={onNavigate}
          />
        ) : route.kind === 'ai-practice' ? (
          <DeckAiPracticePage
            deckId={route.deckId}
            onNavigate={onNavigate}
          />
        ) : route.kind === 'exam' ? (
          <ExamPlanPage
            deckId={route.deckId}
            onNavigate={onNavigate}
          />
        ) : loading ? (
          <section
            className="decks-status"
            role="status"
          >
            <div
              className="decks-spinner"
              aria-hidden="true"
            />

            <span>
              Loading study decks…
            </span>
          </section>
        ) : error ? (
          <section className="decks-status">
            <h1>
              Could not open study decks
            </h1>

            <p role="alert">
              {error}
            </p>

            <div className="decks-status-actions">
              <button
                className="decks-secondary-button"
                type="button"
                onClick={() =>
                  onNavigate('/decks')
                }
              >
                My Decks
              </button>

              <button
                className="decks-primary-button"
                type="button"
                onClick={() =>
                  onNavigate('/')
                }
              >
                Back to Quiz
              </button>
            </div>
          </section>
        ) : deck ? (
          <DeckDetailView
            deck={deck}
            availableDecks={decks}
            onNavigate={onNavigate}
            onDeckUpdated={
              setDeck
            }
          />
        ) : (
          <>
            <header className="decks-header">
              <div>
                <span className="decks-eyebrow">
                  STUDY LIBRARY
                </span>

                <h1>
                  My Decks
                </h1>

                <p>
                  Create your own cards or save generated questions
                  for review and spaced repetition.
                </p>
              </div>

              <div className="decks-header-actions">
                <button
                  className="decks-primary-button"
                  type="button"
                  disabled={creatingDeck}
                  onClick={() => setCreatingDeck(true)}
                >
                  + Create Deck
                </button>
                <button
                  className="decks-secondary-button"
                  type="button"
                  onClick={() =>
                    onNavigate(
                      '/decks/missed',
                    )
                  }
                >
                  Missed Questions
                </button>

                <button
                  className="decks-primary-button"
                  type="button"
                  onClick={() =>
                    onNavigate('/')
                  }
                >
                  + Generate Quiz
                </button>
              </div>
            </header>

            {creatingDeck && (
              <CreateDeckForm
                onCancel={() => setCreatingDeck(false)}
                onCreated={(created) => {
                  setCreatingDeck(false)
                  onNavigate(`/decks/${created.id}`)
                }}
              />
            )}

            {decks.length > 0 && (
              <section
                className="decks-overview"
                aria-label="Study review summary"
              >
                <div
                  className={
                    totalDue > 0
                      ? 'decks-overview-item decks-overview-due'
                      : 'decks-overview-item'
                  }
                >
                  <span>Due now</span>
                  <strong>
                    {totalDue}
                  </strong>
                  <small>
                    {totalDue > 0
                      ? `Across ${dueDecks} ${dueDecks === 1 ? 'deck' : 'decks'}`
                      : 'All caught up'}
                  </small>
                </div>

                <div className="decks-overview-item">
                  <span>Study decks</span>
                  <strong>
                    {decks.length}
                  </strong>
                  <small>
                    Saved collections
                  </small>
                </div>

                <div className="decks-overview-item">
                  <span>Saved cards</span>
                  <strong>
                    {totalCards}
                  </strong>
                  <small>
                    Ready for review
                  </small>
                </div>
              </section>
            )}

            <DeckList
              decks={decks}
              onNavigate={onNavigate}
            />
          </>
        )}
      </div>
    </main>
  )
}
