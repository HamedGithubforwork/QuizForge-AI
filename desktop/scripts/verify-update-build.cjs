'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { load, JSON_SCHEMA } = require('js-yaml')
const { loadApprovedConfiguration } = require('../src/updates.cjs')
const packageJson = require('../package.json')
try {
  const root = path.resolve(process.argv[2])
  if (!loadApprovedConfiguration(path.join(root, 'win-unpacked/resources'))) throw Error()
  const raw = fs.readFileSync(path.join(root, 'latest.yml'), 'utf8')
  if (raw.length > 16384) throw Error()
  const info = load(raw, { schema: JSON_SCHEMA })
  if (info.version !== packageJson.version || !Array.isArray(info.files) || info.files.length !== 1) throw Error()
  const file = info.files[0]
  if (typeof file.url !== 'string' || path.basename(file.url) !== file.url || !file.url.endsWith('.exe')) throw Error()
  const installer = path.join(root, file.url)
  if (!fs.lstatSync(installer).isFile() || fs.lstatSync(installer).isSymbolicLink()) throw Error()
  const bytes = fs.readFileSync(installer)
  if (bytes.length !== file.size || createHash('sha512').update(bytes).digest('base64') !== file.sha512) throw Error()
  console.log('Exact update feed, publisher, version, installer size and checksum verified')
} catch {
  console.error('Update build metadata is missing or inconsistent; do not publish')
  process.exitCode = 1
}
