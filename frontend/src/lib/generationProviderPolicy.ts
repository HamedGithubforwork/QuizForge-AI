import type {
  QuizGenerationMode,
} from './localQuizGeneration.ts'

export function resolveQuizGenerationMode({
  explicitMode,
  localAvailable,
}: {
  explicitMode: QuizGenerationMode | null
  localAvailable: boolean
}): QuizGenerationMode {
  if (explicitMode) return explicitMode
  return localAvailable ? 'local' : 'cloud'
}
