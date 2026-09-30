'use strict'

function reminderSlot(preferences, now) {
  if (!preferences || preferences.enabled !== true || !Number.isInteger(preferences.minimum_due_cards)
      || preferences.minimum_due_cards < 1 || preferences.minimum_due_cards > 1000
      || typeof preferences.timezone !== 'string' || preferences.timezone.length > 100
      || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$/.test(preferences.reminder_time)) return null
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: preferences.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map(p => [p.type, p.value]))
    const time = preferences.reminder_time.split(':').map(Number)
    const elapsed = Number(parts.hour) * 60 + Number(parts.minute) - time[0] * 60 - time[1]
    // Catch a brief sleep/network interruption, without surprising late reminders.
    if (elapsed < 0 || elapsed >= 15) return null
    return `${parts.year}-${parts.month}-${parts.day}`
  } catch { return null }
}

function createNativeReminders({ account, show, supported, now = () => new Date() }) {
  let enabledGeneration = -1, busy = false, disposed = false
  const delivered = new Map()
  let visible = null
  function clear() { enabledGeneration = -1; visible?.close(); visible = null }
  return {
    clear,
    status: () => ({ supported: supported(), enabled: !disposed && !!account.current()
      && enabledGeneration === account.generation() }),
    enable() {
      if (disposed || !supported() || !account.current()?.enrolled) throw new Error('Desktop reminders are unavailable. Sign in first.')
      enabledGeneration = account.generation()
    },
    disable: clear,
    dispose() { disposed = true; clear(); delivered.clear() },
    async tick() {
      const user = account.current(), g = account.generation()
      if (disposed || busy || !user?.enrolled || enabledGeneration !== g || !supported()) return
      busy = true
      const valid = () => !disposed && account.generation() === g && enabledGeneration === g && account.current()?.userId === user.userId
      try {
        const response = await account.request({ path: '/api/study-notifications/preferences', method: 'GET' })
        if (response.status !== 200 || !valid()) return
        const prefs = JSON.parse(response.body)
        const slot = reminderSlot(prefs, now())
        if (!slot || delivered.get(user.userId) === slot) return
        const decksResponse = await account.request({ path: '/api/decks', method: 'GET' })
        if (decksResponse.status !== 200 || !valid() || reminderSlot(prefs, now()) !== slot) return
        const decks = JSON.parse(decksResponse.body)
        if (!Array.isArray(decks) || decks.some(d => !d || !Number.isSafeInteger(d.due_count) || d.due_count < 0)) return
        const due = decks.reduce((total, deck) => total + deck.due_count, 0)
        if (!Number.isSafeInteger(due) || due < prefs.minimum_due_cards) return
        visible?.close()
        // Generic lock-screen copy deliberately omits email, deck titles and counts.
        visible = show({ title: 'Quiz From Notes', body: 'Your study cards are ready to review.' })
        delivered.set(user.userId, slot)
        // Bound memory without writing account activity to disk.
        if (delivered.size > 100) delivered.delete(delivered.keys().next().value)
      } catch { /* Offline/error: retry on the next bounded poll, with no cached due data. */ }
      finally { busy = false }
    },
  }
}
module.exports = { createNativeReminders, reminderSlot }
