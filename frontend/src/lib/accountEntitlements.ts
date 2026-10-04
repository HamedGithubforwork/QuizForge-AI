import type {
  AccountEntitlements,
} from '../types/api.generated.ts'
export type AccountEntitlementState =
  | Readonly<{
      status: 'ready'
      lifetimeAdFree: boolean
    }>
  | Readonly<{
      status: 'unknown'
      lifetimeAdFree: null
    }>

const UNKNOWN_ENTITLEMENT:
  AccountEntitlementState = {
    status: 'unknown',
    lifetimeAdFree: null,
  }

export type EntitlementRequest = (
  path: string,
  init?: RequestInit,
) => Promise<Response>

export async function loadAccountEntitlements(
  send: EntitlementRequest,
): Promise<AccountEntitlementState> {
  try {
    const response = await send(
      '/api/account/entitlements',
    )

    if (!response.ok) {
      return UNKNOWN_ENTITLEMENT
    }

    const payload =
      await response.json() as Partial<
        AccountEntitlements
      >

    if (
      typeof payload?.lifetime_ad_free
      !== 'boolean'
    ) {
      return UNKNOWN_ENTITLEMENT
    }

    return {
      status: 'ready',
      lifetimeAdFree:
        payload.lifetime_ad_free,
    }
  } catch {
    return UNKNOWN_ENTITLEMENT
  }
}
