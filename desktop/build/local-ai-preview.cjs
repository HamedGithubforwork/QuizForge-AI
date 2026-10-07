'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { build } = require('../package.json')
const manifest = require('../src/local-runtime-manifest.json')

const runtime = process.env.QFN_LOCAL_AI_RUNTIME_DIR
if (!runtime || !path.isAbsolute(runtime)) {
  throw new Error('Set QFN_LOCAL_AI_RUNTIME_DIR to the verified staged runtime directory.')
}
const info = fs.lstatSync(runtime)
if (!info.isDirectory() || info.isSymbolicLink()) {
  throw new Error('QFN_LOCAL_AI_RUNTIME_DIR must be a real directory.')
}
const actual = fs.readdirSync(runtime).sort()
const expected = Object.keys(manifest.files).sort()
if (actual.join('\n') !== expected.join('\n')) {
  throw new Error('Local AI preview runtime directory does not match the pinned manifest.')
}

module.exports = {
  ...build,
  // Share the regular preview identity so NSIS upgrades that install in place
  // and keeps the user's existing app data and settings.
  appId: build.appId,
  productName: build.productName,
  artifactName: 'Quiz-From-Notes-Local-AI-Preview-${version}-${arch}.${ext}',
  directories: {
    ...build.directories,
    output: 'dist/local-ai-preview',
  },
  nsis: {
    ...build.nsis,
    allowToChangeInstallationDirectory: false,
    include: path.join(__dirname, 'local-ai-preview-installer.nsh'),
  },
  extraResources: [
    {
      from: runtime,
      to: 'local-ai-runtime',
      filter: ['**/*'],
    },
  ],
  publish: null,
}
