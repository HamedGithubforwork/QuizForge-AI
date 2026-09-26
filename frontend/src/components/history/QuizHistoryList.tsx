import {
  getDisplayFilename,
  getQuestionTypeLabel,
} from '../../lib/quizHistoryAnalytics.ts'
import type {
  QuizHistoryRow,
} from '../../lib/quizHistory.ts'
import {
  formatHistoryDate,
} from './formatHistoryDate.ts'

type QuizHistoryListProps = {
  history: QuizHistoryRow[]
  totalHistoryCount: number
  loadMoreError: string
  hasMoreHistory: boolean
  loadingMore: boolean
  onDelete: (
    id: string,
  ) => void | Promise<void>
  onLoadMore: () => void | Promise<void>
}

function QuizHistoryList({
  history,
  totalHistoryCount,
  loadMoreError,
  hasMoreHistory,
  loadingMore,
  onDelete,
  onLoadMore,
}: QuizHistoryListProps) {
  return (
    <>
      <div className="history-divider">
        <span>
          Saved quizzes · Showing{' '}
          {history.length} of{' '}
          {totalHistoryCount}
        </span>
      </div>

      <div className="history-list">
        {history.map((item) => (
          <article
            className="history-card"
            key={item.id}
          >
            <div className="history-card-main">
              <div className="history-card-details">
                <span className="history-date">
                  {formatHistoryDate(
                    item.created_at,
                  )}
                </span>
                <h3>{item.quiz_title}</h3>
                <p>
                  {getDisplayFilename(
                    item.source_filename,
                  )}
                </p>
                <div className="history-meta">
                  <span>
                    {item.difficulty}
                  </span>
                  <span>
                    {getQuestionTypeLabel(
                      item.question_type,
                    )}
                  </span>
                  <span>
                    {item.question_count}{' '}
                    questions
                  </span>
                </div>
              </div>

              <div className="history-score">
                <strong>
                  {item.percentage}%
                </strong>
                <span>
                  {item.score} /{' '}
                  {item.question_count}
                </span>
              </div>
            </div>

            <button
              className="history-delete"
              type="button"
              onClick={() =>
                void onDelete(
                  item.id,
                )
              }
            >
              Delete
            </button>
          </article>
        ))}
      </div>

      {loadMoreError && (
        <div className="history-error">
          {loadMoreError}
        </div>
      )}

      {hasMoreHistory && (
        <button
          className="history-practice-button"
          type="button"
          onClick={() =>
            void onLoadMore()
          }
          disabled={loadingMore}
        >
          {loadingMore
            ? 'Loading More...'
            : 'Load More Saved Quizzes'}
        </button>
      )}
    </>
  )
}

export default QuizHistoryList
