'use strict'

const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const MANIFEST = require('../src/local-runtime-manifest.json')

const NOTICE_SOURCES = Object.freeze({
  'LICENSE-LLAMA-CPP': path.resolve(__dirname, '..', 'third_party', 'local-ai', 'LICENSE-LLAMA-CPP'),
  'LICENSE-JSONHPP': path.resolve(__dirname, '..', 'third_party', 'local-ai', 'LICENSE-JSONHPP'),
})

const failure = code => Object.assign(new Error('Local runtime staging failed: ' + code), { code })

async function hashFile(filename) {
  const hash = createHash('sha256')
  const handle = await fs.open(filename, 'r')
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

async function validateFile(filename, spec) {
  const info = await fs.lstat(filename)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== spec.bytes) throw failure('invalid_source')
  if (await hashFile(filename) !== spec.sha256) throw failure('invalid_source')
}

async function stageLocalRuntime({
  sourceDirectory,
  destinationDirectory,
  manifest = MANIFEST,
  noticeSources = NOTICE_SOURCES,
} = {}) {
  if (!path.isAbsolute(sourceDirectory) || !path.isAbsolute(destinationDirectory) ||
      sourceDirectory === destinationDirectory) throw failure('invalid_directory')

  const sourceInfo = await fs.lstat(sourceDirectory)
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw failure('unsafe_source')

  await fs.mkdir(destinationDirectory, { recursive: true, mode: 0o700 })
  const destinationInfo = await fs.lstat(destinationDirectory)
  if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) throw failure('unsafe_destination')
  const existing = await fs.readdir(destinationDirectory)
  if (existing.length) throw failure('destination_not_empty')

  const copied = []
  try {
    for (const [name, spec] of Object.entries(manifest.files)) {
      if (path.basename(name) !== name || name.includes('\\')) throw failure('invalid_manifest')
      const source = noticeSources[name] ?? path.join(sourceDirectory, name)
      const destination = path.join(destinationDirectory, name)
      await validateFile(source, spec)
      await fs.copyFile(source, destination, constants.COPYFILE_EXCL)
      copied.push(destination)
      await validateFile(destination, spec)
    }

    const names = (await fs.readdir(destinationDirectory)).sort()
    const expected = Object.keys(manifest.files).sort()
    if (names.join('\n') !== expected.join('\n')) throw failure('unexpected_output')
    return Object.freeze({
      files: Object.freeze(names),
      bytes: Object.values(manifest.files).reduce((sum, spec) => sum + spec.bytes, 0),
    })
  } catch (error) {
    await Promise.allSettled(copied.map(filename => fs.rm(filename, { force: true })))
    throw error
  }
}

async function main() {
  if (!process.argv[2] || !process.argv[3]) throw failure('invalid_directory')
  const sourceDirectory = path.resolve(process.argv[2])
  const destinationDirectory = path.resolve(process.argv[3])
  const result = await stageLocalRuntime({ sourceDirectory, destinationDirectory })
  console.log('PASS: staged verified server-only Local AI runtime', result.files.length, result.bytes)
}

if (require.main === module) {
  main().catch(error => {
    console.error('Local runtime staging failed:', error?.code || error?.name || 'unknown')
    process.exitCode = 1
  })
}

module.exports = { NOTICE_SOURCES, stageLocalRuntime }
