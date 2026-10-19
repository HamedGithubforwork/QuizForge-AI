import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'))
const headers = config.headers.find((entry) => entry.source === '/(.*)').headers
const policy = headers.find((header) => header.key === 'Content-Security-Policy')?.value

test('Vercel sends a restrictive CSP for the frontend', () => {
  assert.ok(policy)
  const directives = Object.fromEntries(policy.split(';').map((part) => {
    const [name, ...sources] = part.trim().split(/\s+/)
    return [name, sources]
  }))

  assert.deepEqual(directives['default-src'], ["'self'"])
  assert.deepEqual(directives['script-src'], ["'self'"])
  assert.ok(!directives['script-src'].some((source) => source.includes('unsafe-')))
  assert.deepEqual(directives['object-src'], ["'none'"])
  assert.deepEqual(directives['base-uri'], ["'none'"])
  assert.deepEqual(directives['frame-ancestors'], ["'none'"])
  assert.deepEqual(directives['form-action'], ["'none'"])
  assert.deepEqual(directives['frame-src'], ["'none'"])

  for (const origin of [
    'https://quizforge-ai-api.onrender.com',
    'https://api.quizfromnotes.com',
    'https://vfxmsvphgcaizqnbyjip.supabase.co',
    'https://cognito-idp.ca-central-1.amazonaws.com',
  ]) {
    assert.ok(directives['connect-src'].includes(origin), `CSP must allow ${origin}`)
  }
  assert.ok(directives['style-src'].includes("'unsafe-inline'"))
  assert.ok(directives['upgrade-insecure-requests'])
})
