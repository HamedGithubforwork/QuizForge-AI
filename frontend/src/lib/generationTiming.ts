// Only successful generation durations and non-content settings are stored.
// Never persist PDF pages, questions, source text, user identity, or model output.
export type GenerationTimingProfile = {
  engine: 'local' | 'cloud'
  // Missing on legacy samples; treat it as an ordinary quiz.
  kind?: 'quiz' | 'practice'
  questionCount: number
  difficulty: string
  questionType: string
}

export type GenerationTimingSample = GenerationTimingProfile & {
  elapsedMs: number
}

export type GenerationTimeEstimate = {
  sampleCount: number
  lowerTotalMs: number
  upperTotalMs: number
  lowerRemainingMs: number
  upperRemainingMs: number
  overdue: boolean
}

const STORAGE_KEY = 'qfn-generation-timing-v1'
const SAMPLE_LIMIT = 24
const MAX_SAMPLE_MS = 30 * 60 * 1000

function validProfile(value: unknown): value is GenerationTimingProfile {
  if (!value || typeof value !== 'object') return false
  const profile = value as Record<string, unknown>
  return (profile.engine === 'local' || profile.engine === 'cloud') &&
    (profile.kind === undefined || profile.kind === 'quiz' || profile.kind === 'practice') &&
    [5, 10, 15].includes(profile.questionCount as number) &&
    ['easy', 'medium', 'hard'].includes(profile.difficulty as string) &&
    ['multiple_choice', 'short_answer', 'true_false', 'mixed'].includes(profile.questionType as string)
}

function validSample(value: unknown): value is GenerationTimingSample {
  return validProfile(value) &&
    Number.isFinite((value as GenerationTimingSample).elapsedMs) &&
    (value as GenerationTimingSample).elapsedMs >= 100 &&
    (value as GenerationTimingSample).elapsedMs <= MAX_SAMPLE_MS
}

export function appendGenerationTiming(
  samples: GenerationTimingSample[],
  profile: GenerationTimingProfile,
  elapsedMs: number,
): GenerationTimingSample[] {
  if (!validProfile(profile) || !Number.isFinite(elapsedMs) || elapsedMs < 100 ||
    elapsedMs > MAX_SAMPLE_MS) return samples.slice(-SAMPLE_LIMIT)
  return [...samples.filter(validSample), { ...profile, elapsedMs: Math.round(elapsedMs) }]
    .slice(-SAMPLE_LIMIT)
}

export function readGenerationTimings(
  storage: Pick<Storage, 'getItem'> | null,
): GenerationTimingSample[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.slice(-SAMPLE_LIMIT).filter(validSample).map(sample => ({
        engine: sample.engine,
        ...(sample.kind === 'practice' ? { kind: 'practice' as const } : {}),
        questionCount: sample.questionCount,
        difficulty: sample.difficulty,
        questionType: sample.questionType,
        elapsedMs: Math.round(sample.elapsedMs),
      }))
      : []
  } catch {
    return []
  }
}

export function storeGenerationTimings(
  storage: Pick<Storage, 'setItem'> | null,
  samples: GenerationTimingSample[],
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(samples.filter(validSample).slice(-SAMPLE_LIMIT)))
  } catch {
    // Storage permissions and quotas cannot interfere with generation.
  }
}

export function estimateGenerationTime(
  samples: GenerationTimingSample[],
  profile: GenerationTimingProfile,
  elapsedMs: number,
): GenerationTimeEstimate | null {
  if (!validProfile(profile) || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null
  const matches = samples.filter(s => validSample(s) &&
    s.engine === profile.engine &&
    (s.kind ?? 'quiz') === (profile.kind ?? 'quiz') &&
    s.questionCount === profile.questionCount &&
    s.difficulty === profile.difficulty &&
    s.questionType === profile.questionType).slice(-5)
  // An estimate based on a single run is too misleading, especially for
  // Local AI, where validation retries can add several minutes.
  if (matches.length < 2) return null
  const values = matches.map(s => s.elapsedMs)
  const lowerTotalMs = Math.max(1000, Math.floor(Math.min(...values) * 0.75))
  const upperTotalMs = Math.ceil(Math.max(...values) * 1.5)
  return {
    sampleCount: matches.length,
    lowerTotalMs,
    upperTotalMs,
    lowerRemainingMs: Math.max(0, lowerTotalMs - elapsedMs),
    upperRemainingMs: Math.max(0, upperTotalMs - elapsedMs),
    overdue: elapsedMs > upperTotalMs,
  }
}

export function formatGenerationDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
