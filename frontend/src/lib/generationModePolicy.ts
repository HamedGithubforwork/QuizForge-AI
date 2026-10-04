import type {
  DesktopLocalAiQuizStatus,
} from './desktop.ts'
import type {
  QuizGenerationMode,
} from './localQuizGeneration.ts'

export function automaticGenerationMode(
  current: QuizGenerationMode,
  status: DesktopLocalAiQuizStatus | null,
  userSelected: boolean,
): QuizGenerationMode {
  if (userSelected) {
    return current
  }

  return status?.available === true
    ? 'local'
    : current
}

export function showGenerationModeSelector(
  mode: QuizGenerationMode,
  localAvailable: boolean,
) {
  return localAvailable || mode === 'local'
}
