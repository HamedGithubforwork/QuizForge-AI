self.addEventListener(
  'push',
  (event) => {
    let payload = {}

    try {
      payload =
        event.data
          ? event.data.json()
          : {}
    } catch {
      payload = {}
    }

    const title =
      typeof payload.title === 'string'
        ? payload.title
        : 'Study review ready'
    const body =
      typeof payload.body === 'string'
        ? payload.body
        : 'You have study cards ready to review.'

    let url = '/decks'
    if (
      typeof payload.url === 'string'
    ) {
      try {
        const candidate =
          new URL(
            payload.url,
            self.location.origin,
          )
        if (
          candidate.origin ===
          self.location.origin
        ) {
          url =
            candidate.pathname +
            candidate.search
        }
      } catch {
        // Keep the safe same-origin fallback.
      }
    }

    event.waitUntil(
      self.registration.showNotification(
        title,
        {
          body,
          icon: '/favicon.svg',
          tag:
            'quizforge-study-review',
          renotify: false,
          data: {
            url,
          },
        },
      ),
    )
  },
)

self.addEventListener(
  'notificationclick',
  (event) => {
    event.notification.close()

    const path =
      event.notification.data &&
      typeof event.notification
        .data.url === 'string'
        ? event.notification
            .data.url
        : '/decks'
    const target =
      new URL(
        path,
        self.location.origin,
      ).href

    event.waitUntil(
      self.clients
        .matchAll({
          type: 'window',
          includeUncontrolled:
            true,
        })
        .then(async (windows) => {
          for (
            const client
            of windows
          ) {
            if (
              'navigate' in client
            ) {
              await client.navigate(
                target,
              )
            }
            return client.focus()
          }

          return self.clients
            .openWindow(target)
        }),
    )
  },
)
