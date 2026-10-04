export type AdSenseConfig = Readonly<{
  client: string
  homeSlot: string
}>

const CLIENT_PATTERN =
  /^ca-pub-[0-9]+$/
const SLOT_PATTERN =
  /^[0-9]+$/

export function resolveAdSenseConfig(
  clientValue:
    | string
    | undefined,
  homeSlotValue:
    | string
    | undefined,
): AdSenseConfig | null {
  const client =
    clientValue?.trim() ?? ''
  const homeSlot =
    homeSlotValue?.trim() ?? ''

  if (
    !CLIENT_PATTERN.test(client)
    || !SLOT_PATTERN.test(homeSlot)
  ) {
    return null
  }

  return {
    client,
    homeSlot,
  }
}
