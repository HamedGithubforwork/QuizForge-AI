'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {
  CONTENT_SECURITY_POLICY,
  LOCAL_RENDERER_URL,
  createLocalRendererHandler,
  registerLocalRenderer,
} = require('../src/local-renderer.cjs')

test('serves only the bundled single-page renderer with a restrictive CSP', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-local-ui-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.mkdir(path.join(directory, 'assets'))
  await fs.writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Local preview</title>')
  await fs.writeFile(path.join(directory, 'assets', 'main.js'), 'window.localRenderer = true')
  const handle = createLocalRendererHandler({ directory })

  const page = await handle(new Request(LOCAL_RENDERER_URL))
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(page.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY)
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.match(await page.text(), /Local preview/)

  const route = await handle(new Request('qfn://app/settings/local-ai'))
  assert.equal(route.status, 200)
  assert.match(await route.text(), /Local preview/)

  const script = await handle(new Request('qfn://app/assets/main.js'))
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal(script.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(await script.text(), 'window.localRenderer = true')
})

test('rejects unknown hosts, traversal, unsupported methods, and non-asset extensions', async () => {
  const handle = createLocalRendererHandler({ directory: path.resolve(__dirname, '../src') })
  for (const request of [
    new Request('qfn://elsewhere/index.html'),
    new Request('qfn://app/%2e%2e/package.json'),
    new Request('qfn://app/renderer.exe'),
    new Request('qfn://app/index.html', { method: 'POST' }),
  ]) assert.ok([400, 404].includes((await handle(request)).status))
})

test('registers exactly the private qfn renderer scheme', () => {
  const calls = []
  const protocol = { handle: (...args) => calls.push(args) }
  const url = registerLocalRenderer(protocol, { directory: path.resolve(__dirname, '../src') })
  assert.equal(url, LOCAL_RENDERER_URL)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'qfn')
  assert.equal(typeof calls[0][1], 'function')
})
