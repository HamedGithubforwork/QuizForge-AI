export type AdSurface =
  | 'home'
  | 'deck_library'
  | 'results_summary'
  | 'progress'
  | 'active_quiz'
  | 'review_session'
  | 'answer_reveal'
  | 'timed_exam'
  | 'settings'

export type AdRuntime =
  | 'browser'
  | 'desktop'
  | 'mobile'

export type AdPresentationReason =
  | 'eligible'
  | 'ad_free'
  | 'entitlement_unknown'
  | 'focus_critical'
  | 'surface_not_eligible'
  | 'provider_unavailable'

export type AdPresentationDecision = Readonly<{
  requestProvider: boolean
  reason: AdPresentationReason
}>

// Surfaces are semantic interaction states, not URL/path aliases.
// A quiz route that is currently revealing answers must therefore use
// 'answer_reveal', never 'home' or 'results_summary'.
const FOCUS_CRITICAL_SURFACES =
  new Set<AdSurface>([
    'active_quiz',
    'review_session',
    'answer_reveal',
    'timed_exam',
  ])

const ELIGIBLE_SURFACES =
  new Set<AdSurface>([
    'home',
    'deck_library',
    'results_summary',
    'progress',
  ])

export function adPresentationDecision({
  surface,
  runtime,
  lifetimeAdFree,
  approvedProviderRuntime,
}: {
  surface: AdSurface
  runtime: AdRuntime
  lifetimeAdFree: boolean | null
  approvedProviderRuntime: AdRuntime | null
}): AdPresentationDecision {
  if (lifetimeAdFree === null) {
    return {
      requestProvider: false,
      reason: 'entitlement_unknown',
    }
  }

  if (lifetimeAdFree) {
    return {
      requestProvider: false,
      reason: 'ad_free',
    }
  }

  if (FOCUS_CRITICAL_SURFACES.has(surface)) {
    return {
      requestProvider: false,
      reason: 'focus_critical',
    }
  }

  if (!ELIGIBLE_SURFACES.has(surface)) {
    return {
      requestProvider: false,
      reason: 'surface_not_eligible',
    }
  }

  if (approvedProviderRuntime !== runtime) {
    return {
      requestProvider: false,
      reason: 'provider_unavailable',
    }
  }

  return {
    requestProvider: true,
    reason: 'eligible',
  }
}

export function shouldRequestAdProvider(
  input: Parameters<
    typeof adPresentationDecision
  >[0],
) {
  return adPresentationDecision(
    input,
  ).requestProvider
}
