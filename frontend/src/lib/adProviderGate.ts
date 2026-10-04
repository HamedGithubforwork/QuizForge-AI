import {
  adPresentationDecision,
  type AdPresentationDecision,
  type AdRuntime,
  type AdSurface,
} from './adPresentationPolicy.ts'
import {
  loadAccountEntitlements,
  type EntitlementRequest,
} from './accountEntitlements.ts'

export type AdProviderAdapter = Readonly<{
  runtime: AdRuntime
  request: (
    input: Readonly<{
      surface: AdSurface
    }>,
  ) => Promise<void>
}>

export type AdProviderOutcome = Readonly<{
  decision: AdPresentationDecision
  providerRequested: boolean
  providerSucceeded: boolean
}>

export async function requestEligibleAd({
  surface,
  runtime,
  requestEntitlements,
  provider,
}: {
  surface: AdSurface
  runtime: AdRuntime
  requestEntitlements: EntitlementRequest
  provider: AdProviderAdapter
}): Promise<AdProviderOutcome> {
  const entitlement =
    await loadAccountEntitlements(
      requestEntitlements,
    )

  const decision =
    adPresentationDecision({
      surface,
      runtime,
      lifetimeAdFree:
        entitlement.lifetimeAdFree,
      approvedProviderRuntime:
        provider.runtime,
    })

  if (!decision.requestProvider) {
    return {
      decision,
      providerRequested: false,
      providerSucceeded: false,
    }
  }

  try {
    await provider.request({
      surface,
    })
  } catch {
    return {
      decision,
      providerRequested: true,
      providerSucceeded: false,
    }
  }

  return {
    decision,
    providerRequested: true,
    providerSucceeded: true,
  }
}
