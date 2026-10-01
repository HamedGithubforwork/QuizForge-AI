'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { createHash } = require('node:crypto')
const { verifyRuntime, runtimeEnvironment, request } = require('../src/local-runtime.cjs')

test('runtime verification rejects changed, missing and unexpected library files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-runtime-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const bytes = Buffer.from('synthetic runtime')
  const manifest = { files: Object.fromEntries(['llama-server.exe', 'llama.dll'].map(name => [name,
    { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }])) }
  for (const name of Object.keys(manifest.files)) await fs.writeFile(path.join(directory, name), bytes)
  assert.equal(await verifyRuntime(directory, manifest), path.join(directory, 'llama-server.exe'))
  await fs.writeFile(path.join(directory, 'llama.dll'), 'tampered runtime!')
  await assert.rejects(verifyRuntime(directory, manifest), { code: 'invalid_runtime' })
  await fs.writeFile(path.join(directory, 'llama.dll'), bytes)
  await fs.writeFile(path.join(directory, 'injected.dll'), bytes)
  await assert.rejects(verifyRuntime(directory, manifest), { code: 'unexpected_files' })
  await fs.unlink(path.join(directory, 'injected.dll'))
  await fs.unlink(path.join(directory, 'llama.dll'))
  await assert.rejects(verifyRuntime(directory, manifest), { code: 'unexpected_files' })
})

test('child receives only explicit runtime environment', () => {
  const env = runtimeEnvironment('ephemeral', { SystemRoot: 'C:\\Windows', TEMP: 'temporary',
    OPENAI_API_KEY: 'private', LLAMA_ARG_HOST: '0.0.0.0', LLAMA_ARG_API_KEY: 'old',
    HTTP_PROXY: 'remote', NODE_OPTIONS: '--require unwanted', PATH: 'untrusted' })
  assert.deepEqual(Object.keys(env).sort(), ['LLAMA_API_KEY', 'PATH', 'SystemRoot', 'TEMP'])
  assert.equal(env.LLAMA_API_KEY, 'ephemeral')
  assert.equal(env.PATH, path.join('C:\\Windows', 'System32'))
})

async function server(t, handler) {
  const instance = http.createServer(handler)
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => instance.close(resolve)))
  return instance.address().port
}

test('loopback client authenticates and does not follow redirects', async t => {
  let calls = 0
  const port = await server(t, (req, res) => {
    calls++
    assert.equal(req.headers.authorization, 'Bearer ephemeral')
    res.writeHead(302, { Location: 'https://example.invalid/' }); res.end()
  })
  await assert.rejects(request(port, 'ephemeral', '/v1/models', undefined, AbortSignal.timeout(1000)), { code: 'request_failed' })
  assert.equal(calls, 1)
  await assert.rejects(request(port, '', '/other'), { code: 'invalid_route' })
})

test('loopback client bounds response bytes, request bytes and cancellation', async t => {
  const port = await server(t, (req, res) => res.end('x'.repeat(262145)))
  await assert.rejects(request(port, '', '/v1/models', undefined, AbortSignal.timeout(1000)), { code: 'response_too_large' })
  await assert.rejects(request(port, '', '/v1/chat/completions', { content: 'x'.repeat(65536) }), { code: 'request_too_large' })
  await assert.rejects(request(port, '', '/v1/models', undefined, AbortSignal.abort()))
})
