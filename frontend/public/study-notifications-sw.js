self.addEventListener(
  'push',
  (event) => {
    let payload = {}

    try {
      payload =
        event.data?.json() ?? {}
    } catch {
      payload = {}
    }

    const title =
      typeof payload.title ===
        'string'
        ? payload.title
        : 'Quiz From Notes'

    const body =
      typeof payload.body ===
        'string'
        ? payload.body
        : 'You have study cards ready to review.'

    const url =
      typeof payload.url ===
        'string' &&
      payload.url.startsWith('/')
        ? payload.url
        : '/decks'

    event.waitUntil(
      self.registration
        .showNotification(
          title,
          {
            body,
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

    const url =
      event.notification
        .data?.url ?? '/decks'

    event.waitUntil(
      self.clients
        .matchAll({
          type: 'window',
          includeUncontrolled:
            true,
        })
        .then(
          async (clients) => {
            for (
              const client
              of clients
            ) {
              if (
                'focus' in client
              ) {
                await client.focus()
                if (
                  'navigate' in
                  client
                ) {
                  await client.navigate(
                    url,
                  )
                }
                return
              }
            }

            return self.clients
              .openWindow(url)
          },
        ),
    )
  },
)
