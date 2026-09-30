import { expect, test } from '@playwright/test'
import {
  frontendUrl,
  readCanaryFixture,
  signInAndEnrollCanary,
} from './canary-fixture'

const apiOrigin = 'https://api.quizfromnotes.com'

test('production manual deck creation, first card, and FSRS review without model calls', async ({ page }) => {
  let blockedWrites = 0
  let deckId: string | undefined
  let createAllowed = true
  // Allow one manual deck creation, then card/review writes to that deck only.
  // Any accidental AI/upload/generation
  // request from the browser is blocked before it reaches production.
  await page.route(`${apiOrigin}/api/**`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const creatingDeck = request.method() === 'POST' && path === '/api/decks' && createAllowed
    if (creatingDeck) createAllowed = false
    const writingCreatedDeck = request.method() === 'POST' && deckId &&
      [`/api/decks/${deckId}/cards`, `/api/decks/${deckId}/review`].includes(path)
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || creatingDeck || writingCreatedDeck) {
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
  try {
    await page.getByRole('button', { name: '+ Create Deck', exact: true }).click()
    const form = page.getByRole('form', { name: 'Create a study deck' })
    await form.getByLabel('Deck name', { exact: true }).fill('Production Study Canary')
    await form.getByLabel('Description (optional)', { exact: true }).fill('Synthetic smoke test; no model generation.')
    const createdPromise = page.waitForResponse((response) =>
      response.url() === `${apiOrigin}/api/decks` && response.request().method() === 'POST')
    await form.getByRole('button', { name: 'Create Deck', exact: true }).click()
    const created = await createdPromise
    expect(created.status()).toBe(201)
    const deck = await created.json()
    expect(typeof deck.id === 'string' && /^[a-f0-9-]{36}$/.test(deck.id)).toBe(true)
    deckId = deck.id
    expect(deck.card_count).toBe(0)
    expect(deck.study_intensity).toBe('balanced')
    await expect(page.getByRole('heading', { name: 'Production Study Canary' })).toBeVisible()
    await page.getByRole('button', { name: '+ Add Card', exact: true }).first().click()
    await page.getByLabel('Question', { exact: true }).fill('Which protocol protects HTTP traffic?')
    await page.getByLabel('Correct answer', { exact: true }).fill('TLS')
    const addedPromise = page.waitForResponse((response) =>
      response.url() === `${apiOrigin}/api/decks/${deckId}/cards` && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Add Card', exact: true }).click()
    const added = await addedPromise
    expect(added.status()).toBe(201)
    expect((await added.json()).card_count).toBe(1)
    await expect(page.getByText('Which protocol protects HTTP traffic?', { exact: true })).toBeVisible()

    // Tokens intentionally live only in memory. Use the application's router
    // so this test does not log itself out with a full document navigation.
    await page.getByRole('button', { name: 'Quiz', exact: true }).click()
    await page.getByRole('button', { name: 'Decks', exact: true }).click()
    await page.getByRole('button', { name: /Production Study Canary/ }).click()
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
    await expect(page.getByRole('heading', { name: 'You’re caught up' })).toBeVisible()
    const refreshedListPromise = page.waitForResponse((response) =>
      response.url() === `${apiOrigin}/api/decks` && response.request().method() === 'GET')
    await page.getByRole('button', { name: 'Decks', exact: true }).click()
    const refreshedList = await refreshedListPromise
    expect(refreshedList.status()).toBe(200)
    const refreshedDecks = await refreshedList.json()
    expect(refreshedDecks.find((item: { id: string }) => item.id === deckId)?.due_count).toBe(0)
    await expect(page.getByRole('button', { name: /Production Study Canary/ })).toContainText('Caught up')
    await page.getByRole('button', { name: /Production Study Canary/ }).click()
    await page.getByRole('button', { name: 'Review Status', exact: true }).click()
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
