import {
  useEffect,
  useMemo,
  useRef,
} from 'react'

import './WebAdSlot.css'

import {
  apiFetch,
} from '../../lib/api.ts'
import {
  requestEligibleAd,
  type AdProviderAdapter,
} from '../../lib/adProviderGate.ts'
import {
  type AdSurface,
} from '../../lib/adPresentationPolicy.ts'
import {
  resolveAdSenseConfig,
} from '../../lib/adSenseConfig.ts'
import {
  requestAdSenseUnit,
} from '../../lib/adSenseProvider.ts'
import {
  desktopBridge,
} from '../../lib/desktop.ts'

export default function WebAdSlot({
  surface,
}: {
  surface: AdSurface
}) {
  const containerRef =
    useRef<HTMLElement | null>(
      null,
    )
  const elementRef =
    useRef<HTMLModElement | null>(
      null,
    )
  const desktop =
    Boolean(desktopBridge())

  const config = useMemo(
    () =>
      resolveAdSenseConfig(
        import.meta.env
          .VITE_ADSENSE_CLIENT,
        import.meta.env
          .VITE_ADSENSE_HOME_SLOT,
      ),
    [],
  )

  useEffect(() => {
    if (
      desktop
      || !config
      || !containerRef.current
      || !elementRef.current
    ) {
      return
    }

    let active = true
    const container =
      containerRef.current
    const element =
      elementRef.current

    container.hidden = true

    const provider:
      AdProviderAdapter = {
        runtime: 'browser',
        async request() {
          if (!active) {
            return
          }

          container.hidden = false

          await requestAdSenseUnit({
            client: config.client,
            slot:
              config.homeSlot,
            element,
          })
        },
      }

    void requestEligibleAd({
      surface,
      runtime: 'browser',
      requestEntitlements:
        apiFetch,
      provider,
    }).then((outcome) => {
      if (
        active
        && (
          !outcome.providerRequested
          || !outcome.providerSucceeded
        )
      ) {
        container.hidden = true
      }
    })

    return () => {
      active = false
      container.hidden = true
    }
  }, [
    config,
    desktop,
    surface,
  ])

  if (
    desktop
    || !config
  ) {
    return null
  }

  return (
    <aside
      ref={containerRef}
      className="web-ad-slot"
      aria-label="Advertisement"
      hidden
    >
      <span
        className="web-ad-label"
      >
        Advertisement
      </span>
      <ins
        ref={elementRef}
        className="adsbygoogle"
        style={{
          display: 'block',
        }}
        data-ad-client={
          config.client
        }
        data-ad-slot={
          config.homeSlot
        }
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </aside>
  )
}
