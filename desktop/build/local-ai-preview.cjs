'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { CANDIDATE } = require('../src/local-model-store.cjs')
const { build } = require('../package.json')
const manifest = require('../src/local-runtime-manifest.json')

const runtime = process.env.QFN_LOCAL_AI_RUNTIME_DIR
const model = process.env.QFN_LOCAL_AI_MODEL_DIR
const localUi = path.resolve(__dirname, '../../frontend/dist')
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
if (!fs.existsSync(path.join(localUi, 'index.html'))) {
  throw new Error('Build the reviewed frontend first; the Local AI preview requires frontend/dist/index.html.')
}
if (model) {
  if (!path.isAbsolute(model)) throw new Error('QFN_LOCAL_AI_MODEL_DIR must be an absolute directory.')
  const modelPath = path.join(model, CANDIDATE.sha256 + '.gguf')
  const info = fs.lstatSync(modelPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== CANDIDATE.bytes) {
    throw new Error('The optional bundled Local AI model does not match the pinned model size.')
  }
}
const baseInstaller = path.join(__dirname, 'local-ai-preview-installer.nsh')
let installerInclude = baseInstaller
if (model) {
  const generatedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'qfn-local-ai-installer-'))
  installerInclude = path.join(generatedDirectory, 'local-ai-preview-installer.nsh')
  fs.writeFileSync(installerInclude,
    `!define QFN_INSTALL_BUNDLED_MODEL 1\n!define QFN_MODEL_FILE "${CANDIDATE.sha256}.gguf"\n!include "${baseInstaller.replace(/\\/g, '/')}"\n`, 'utf8')
  process.on('exit', () => fs.rmSync(generatedDirectory, { recursive: true, force: true }))
}

module.exports = {
  ...build,
  // Share the regular preview identity so NSIS upgrades that install in place
  // and keeps the user's existing app data and settings.
  appId: build.appId,
  productName: build.productName,
  artifactName: model
    ? 'Quiz-From-Notes-Local-AI-Preview-Model-Included-${version}-${arch}.${ext}'
    : 'Quiz-From-Notes-Local-AI-Preview-Download-Model-Later-${version}-${arch}.${ext}',
  directories: {
    ...build.directories,
    output: model ? 'dist/local-ai-preview-model-included' : 'dist/local-ai-preview',
  },
  nsis: {
    ...build.nsis,
    allowToChangeInstallationDirectory: false,
    include: installerInclude,
  },
  extraResources: [
    {
      from: runtime,
      to: 'local-ai-runtime',
      filter: ['**/*'],
    },
    {
      from: localUi,
      to: 'app-ui',
      filter: ['**/*'],
    },
  ],
  publish: null,
}
