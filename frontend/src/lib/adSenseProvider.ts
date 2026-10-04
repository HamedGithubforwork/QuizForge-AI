const SCRIPT_ID =
  'quizforge-adsense-script'

declare global {
  interface Window {
    adsbygoogle?:
      Array<Record<string, never>>
  }
}

export type AdSenseRequest = Readonly<{
  client: string
  slot: string
  element: HTMLElement
}>

function ensureAdSenseScript(
  client: string,
) {
  const existing =
    document.getElementById(
      SCRIPT_ID,
    ) as HTMLScriptElement | null

  if (existing) {
    if (
      existing.dataset.quizforgeClient
      !== client
    ) {
      throw new Error(
        'AdSense publisher mismatch.',
      )
    }
    return
  }

  const script =
    document.createElement('script')
  script.id = SCRIPT_ID
  script.async = true
  script.crossOrigin =
    'anonymous'
  script.dataset.quizforgeClient =
    client
  script.src =
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'
    + '?client='
    + encodeURIComponent(client)

  document.head.appendChild(
    script,
  )
}

export async function requestAdSenseUnit({
  client,
  slot,
  element,
}: AdSenseRequest) {
  if (
    element.dataset
      .quizforgeAdRequested
    === 'true'
  ) {
    return
  }

  if (
    element.dataset.adClient
    !== client
    || element.dataset.adSlot
    !== slot
  ) {
    throw new Error(
      'AdSense element configuration mismatch.',
    )
  }

  ensureAdSenseScript(client)

  element.dataset
    .quizforgeAdRequested =
    'true'

  window.adsbygoogle =
    window.adsbygoogle ?? []
  window.adsbygoogle.push({})
}
