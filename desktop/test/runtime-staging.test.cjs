'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { stageLocalRuntime } = require('../scripts/stage-local-runtime.cjs')

const sha = value => createHash('sha256').update(value).digest('hex')

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qfn-stage-'))
  const source = path.join(root, 'source')
  const destination = path.join(root, 'destination')
  const notices = path.join(root, 'notices')
  await Promise.all([fs.mkdir(source), fs.mkdir(destination), fs.mkdir(notices)])
  const files = {
    'llama-server.exe': Buffer.from('server'),
    'ggml.dll': Buffer.from('ggml'),
  }
  const noticeFiles = {
    'LICENSE-LLAMA-CPP': Buffer.from('llama license\n'),
    'LICENSE-JSONHPP': Buffer.from('json license\n'),
  }
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(source, name), bytes)
  for (const [name, bytes] of Object.entries(noticeFiles)) await fs.writeFile(path.join(notices, name), bytes)
  const manifest = {
    files: Object.fromEntries([...Object.entries(noticeFiles), ...Object.entries(files)]
      .map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }])),
  }
  return {
    root, source, destination, manifest,
    noticeSources: {
      'LICENSE-LLAMA-CPP': path.join(notices, 'LICENSE-LLAMA-CPP'),
      'LICENSE-JSONHPP': path.join(notices, 'LICENSE-JSONHPP'),
    },
  }
}

test('stages exactly the verified runtime and notice files', async t => {
  const f = await fixture()
  t.after(() => fs.rm(f.root, { recursive: true, force: true }))
  const result = await stageLocalRuntime({
    sourceDirectory: f.source,
    destinationDirectory: f.destination,
    manifest: f.manifest,
    noticeSources: f.noticeSources,
  })
  assert.deepEqual(result.files, [
    'LICENSE-JSONHPP',
    'LICENSE-LLAMA-CPP',
    'ggml.dll',
    'llama-server.exe',
  ])
  assert.deepEqual((await fs.readdir(f.destination)).sort(), result.files)
})

test('rejects corrupt source and leaves no partial payload', async t => {
  const f = await fixture()
  t.after(() => fs.rm(f.root, { recursive: true, force: true }))
  await fs.writeFile(path.join(f.source, 'ggml.dll'), 'changed')
  await assert.rejects(stageLocalRuntime({
    sourceDirectory: f.source,
    destinationDirectory: f.destination,
    manifest: f.manifest,
    noticeSources: f.noticeSources,
  }), { code: 'invalid_source' })
  assert.deepEqual(await fs.readdir(f.destination), [])
})

test('rejects a non-empty destination instead of replacing runtime files', async t => {
  const f = await fixture()
  t.after(() => fs.rm(f.root, { recursive: true, force: true }))
  await fs.writeFile(path.join(f.destination, 'existing'), 'keep')
  await assert.rejects(stageLocalRuntime({
    sourceDirectory: f.source,
    destinationDirectory: f.destination,
    manifest: f.manifest,
    noticeSources: f.noticeSources,
  }), { code: 'destination_not_empty' })
  assert.equal(await fs.readFile(path.join(f.destination, 'existing'), 'utf8'), 'keep')
})
