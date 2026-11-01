import {
  formatGenerationDuration,
  type GenerationTimeEstimate,
} from '../../lib/generationTiming.ts'

type GenerationTimingPanelProps = {
  elapsedMs: number
  estimate: GenerationTimeEstimate | null
  label?: string
}

export default function GenerationTimingPanel({
  elapsedMs,
  estimate,
  label,
}: GenerationTimingPanelProps) {
  return (
    <div className="generation-timing" aria-live="off" data-testid="quiz-generation-timing">
      {label && <p><strong>{label}</strong></p>}
      <p><strong>Elapsed:</strong> {formatGenerationDuration(elapsedMs)}</p>
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
