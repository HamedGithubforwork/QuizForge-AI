import type { DesktopLocalQuizProgress } from '../../lib/desktop.ts'
import {
  formatGenerationDuration,
  type GenerationTimeEstimate,
} from '../../lib/generationTiming.ts'

type GenerationTimingPanelProps = {
  elapsedMs: number
  estimate: GenerationTimeEstimate | null
  label?: string
  progress?: DesktopLocalQuizProgress | null
}

export default function GenerationTimingPanel({
  elapsedMs,
  estimate,
  label,
  progress,
}: GenerationTimingPanelProps) {
  return (
    <div className="generation-timing" aria-live="off" data-testid="quiz-generation-timing">
      {label && <p><strong>{label}</strong></p>}
      <p><strong>Elapsed:</strong> {formatGenerationDuration(elapsedMs)}</p>
      {progress && (
        <p className="generation-timing-note" role="status">
          {progress.phase === 'checking_duplicates'
            ? `Checking repeated facts — ${progress.validQuestions} validated questions`
            : `Batch ${Math.min(progress.completedBatches + 1, progress.totalBatches)} of ${progress.totalBatches} · ${progress.validQuestions} validated questions so far`}
        </p>
      )}
      {estimate ? (
        estimate.overdue ? (
          <p>Taking longer than recent quizzes with these settings. Validation or retries may add time.</p>
        ) : (
          <p>
            <strong>Estimated remaining:</strong>{' '}
            {formatGenerationDuration(estimate.lowerRemainingMs)}–{formatGenerationDuration(estimate.upperRemainingMs)}{' '}
            <span className="generation-timing-note">
              (rough estimate from {estimate.sampleCount} completed quizzes; not a deadline)
            </span>
          </p>
        )
      ) : (
        <p className="generation-timing-note">
          An estimate becomes available after two successful quizzes with these settings.
        </p>
      )}
    </div>
  )
}
