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
          {progress.phase === 'extracting_pdf'
            ? `Reading PDF pages — ${progress.completedPages ?? 0} of ${progress.totalPages || '?'}`
            : progress.phase === 'selecting_source'
              ? `Selecting source evidence — ${progress.selectedSourceBytes ?? 0} of ${progress.originalSourceBytes ?? 0} bytes retained`
              : progress.phase === 'extracting_facts'
                ? `Identified ${progress.candidateCount ?? 0} source-backed facts across ${progress.topicCount ?? 0} topics`
                : progress.phase === 'checking_duplicates'
                  ? `Checking repeated facts — ${progress.validQuestions} validated questions`
                  : progress.phase === 'finalizing_quiz'
                    ? `Finalizing quiz — ${progress.validQuestions} verified questions`
                    : progress.candidateCount !== undefined
                      ? `Validating source questions — ${progress.validQuestions} accepted of ${progress.requestedQuestions} requested · ${progress.repairedCount ?? 0} source repairs`
                      : `Batch ${Math.min((progress.completedBatches ?? 0) + 1, progress.totalBatches ?? 1)} of ${progress.totalBatches ?? 1} · ${progress.validQuestions} validated questions so far`}
        </p>
      )}
      {progress?.phase === 'generating' && Boolean(progress.previewQuestions?.length) && (
        <div className="generation-timing-note" aria-label="Provisional validated questions">
          <p>Questions ready from completed batches (final duplicate check still pending):</p>
          <ol>{progress.previewQuestions?.map((question, index) => (
            <li key={index}>{question}</li>
          ))}</ol>
        </div>
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
