import { expect, test } from '@playwright/test'
import {
  frontendUrl,
  readCanaryFixture,
  signInAndEnrollCanary,
} from './canary-fixture'

const apiOrigin = 'https://api.quizfromnotes.com'

test('production Cognito, persistent deck, and FSRS review without model calls', async ({ page }) => {
  let blockedWrites = 0
  // Allow the study review write only. Any accidental AI/upload/generation
  // request from the browser is blocked before it reaches production.
  await page.route(`${apiOrigin}/api/**`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) ||
        (request.method() === 'POST' && /^\/api\/decks\/[a-f0-9-]{36}\/review$/.test(path))) {
      await route.continue()
    } else {
      blockedWrites += 1
      await route.abort('blockedbyclient')
    }
  })

  await signInAndEnrollCanary(page, readCanaryFixture())
  const listPromise = page.waitForResponse((response) =>
    response.url() === `${apiOrigin}/api/decks` && response.request().method() === 'GET')
  await page.getByRole('button', { name: 'Decks', exact: true }).click()
  const list = await listPromise
  expect(list.status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'My Decks' })).toBeVisible()

  // Reuse only this synthetic user's bearer token, already sent to the exact
  // production API by the real frontend. Never persist or print the token.
  const authorization = await list.request().headerValue('authorization')
  expect(Boolean(authorization?.startsWith('Bearer '))).toBe(true)
  const headers = { Authorization: authorization!, Origin: new URL(frontendUrl).origin }
  let deckId: string | undefined
  try {
    const created = await page.request.post(`${apiOrigin}/api/decks`, {
      headers,
      data: {
        name: 'Production Study Canary',
        cards: [{
          question_type: 'multiple_choice',
          question: 'Which protocol protects HTTP traffic?',
          choices: ['TLS', 'UDP'],
          answer: { correct_index: 0 },
          explanation: 'Synthetic smoke-test card; no model generation.',
        }],
      },
    }).catch(() => { throw new Error('Synthetic deck creation transport failed') })
    expect(created.status()).toBe(201)
    const deck = await created.json()
    expect(typeof deck.id === 'string' && /^[a-f0-9-]{36}$/.test(deck.id)).toBe(true)
    deckId = deck.id
    expect(deck.card_count).toBe(1)
    expect(deck.study_intensity).toBe('balanced')

    await page.goto(`${new URL(frontendUrl).origin}/decks/${deckId}`)
    await expect(page.getByRole('heading', { name: 'Production Study Canary' })).toBeVisible()
    await page.getByRole('button', { name: 'Review 1 Due', exact: true }).click()
    await page.getByRole('button', { name: 'Show Answer', exact: true }).click()
    const reviewPromise = page.waitForResponse((response) =>
      response.url() === `${apiOrigin}/api/decks/${deckId}/review` &&
      response.request().method() === 'POST')
    await page.getByRole('button', { name: /Good/ }).click()
    const review = await reviewPromise
    expect(review.status()).toBe(200)
    expect((await review.json()).remaining_due_count).toBe(0)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'You’re caught up' })).toBeVisible()

    for (const path of ['/api/study-notifications/preferences', '/api/study-analytics/summary']) {
      const response = await page.request.get(`${apiOrigin}${path}`, { headers })
        .catch(() => { throw new Error('Study read smoke-test transport failed') })
      expect(response.status()).toBe(200)
    }
    expect(blockedWrites).toBe(0)
  } finally {
    // Delete only the deck returned by this run's synthetic-user create call.
    if (deckId) {
      const removed = await page.request.delete(`${apiOrigin}/api/decks/${deckId}`, { headers })
        .catch(() => { throw new Error('Synthetic deck cleanup transport failed') })
      expect(removed.status()).toBe(204)
    }
  }
})
