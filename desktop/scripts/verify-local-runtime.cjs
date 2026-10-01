'use strict'
// Real Windows integration: synthetic content only, no report containing credentials.
const assert = require('node:assert/strict')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const { createLocalRuntime } = require('../src/local-runtime.cjs')
const { createLocalModelStore } = require('../src/local-model-store.cjs')

async function main() {
  const directory = path.resolve(process.argv[2])
  const modelStore = createLocalModelStore({ directory: path.resolve(process.argv[3]) })
  let child, options, args, spawned
  let started = new Promise(resolve => { spawned = resolve })
  const runtime = createLocalRuntime({ directory, modelStore, spawnProcess(exe, argv, config) {
    options = config; args = argv; child = spawn(exe, argv, config); spawned(); return child
  } })
  const payload = { messages: [{ role: 'user', content: 'Return a JSON object with ok set to true.' }],
    max_tokens: 16, temperature: 0.7, chat_template_kwargs: { enable_thinking: false },
    json_schema: { type: 'object', properties: { ok: { type: 'boolean', const: true } }, required: ['ok'], additionalProperties: false } }
  const result = runtime.complete(payload)
  // Attach rejection handling immediately while checking the live boundary.
  result.catch(() => {})
  await Promise.race([started, result.then(() => { throw Error('Expected child launch') })])
  assert.equal(options.shell, false)
  assert.equal(options.stdio, 'ignore')
  assert.match(options.env.LLAMA_API_KEY, /^[0-9a-f]{64}$/)
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1')
  await assert.rejects(runtime.complete(payload), { code: 'busy' })
  const port = Number(args[args.indexOf('--port') + 1])
  let denied = false
  const deadline = Date.now() + 60000
  while (Date.now() < deadline && !denied) {
    try {
      const status = await new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: '/v1/models', signal: AbortSignal.timeout(2000) }, res => {
          res.resume(); resolve(res.statusCode)
        }); req.on('error', reject)
      })
      denied = status === 401
    } catch {}
    if (!denied) await delay(100)
  }
  assert.equal(denied, true, 'Unauthenticated local requests must be rejected')
  const response = await result
  assert.deepEqual(JSON.parse(response.choices[0].message.content), { ok: true })
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'Successful generation must stop its child')
  const firstKey = options.env.LLAMA_API_KEY
  started = new Promise(resolve => { spawned = resolve })
  const cancel = new AbortController()
  const canceled = runtime.complete(payload, { signal: cancel.signal })
  canceled.catch(() => {})
  await Promise.race([started, canceled.then(() => { throw Error('Expected second child launch') })])
  cancel.abort()
  await assert.rejects(canceled)
  assert.notEqual(options.env.LLAMA_API_KEY, firstKey)
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'Cancellation must stop its child')
  console.log('PASS: verified runtime/model, authenticated generation, unauthorized rejection, exclusive session, fresh key, success/cancellation cleanup')
}
main().catch(() => { console.error('Local runtime integration failed'); process.exitCode = 1 })
