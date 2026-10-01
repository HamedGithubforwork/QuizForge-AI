import assert from 'node:assert/strict'
import test from 'node:test'
import { checkSources, syntax } from './check-module-boundaries.mjs'

function sources(overrides = {}) {
  return new Map(Object.entries({
    'frontend/src/components/decks/index.ts': "export { default } from './DecksPage'",
    'frontend/src/components/decks/DecksPage.tsx': "import Detail from './DeckDetailView'; export default Detail",
    'frontend/src/components/decks/DeckDetailView.tsx': 'export default function Detail() {}',
    'desktop/src/local-ai-provider.cjs': 'module.exports = {}',
    'desktop/src/model-store-contract.cjs': "const api = require('./local-ai-provider.cjs')",
    'desktop/src/local-ai.cjs': "module.exports = require('./local-ai-provider.cjs')",
    'desktop/src/windows-local-ai-provider.cjs': "const core = require('./local-ai-provider.cjs')",
    'desktop/src/windows-process-guard.cjs': "const path = require('node:path')",
    'desktop/src/local-runtime.cjs': "const http = require('node:http')",
    'desktop/src/local-model-store.cjs': "const fs = require('node:fs/promises')",
    'desktop/src/main.cjs': "require('./local-ai.cjs'); require('./windows-local-ai-provider.cjs')",
    ...overrides,
  }))
}

test('established feature entries, internal imports, generated type reexports and platform adapters pass', () => {
  assert.deepEqual(checkSources(sources({ 'frontend/src/Consumer.tsx': "import Decks from './components/decks'; import type { CardRow } from './types/api.generated'" })), [])
})
test('comments and ordinary strings are not imports', () => {
  assert.deepEqual(syntax("// require('electron')\nconst s = \"import('electron')\"", 'test.cjs').imports, [])
})
test('static, side-effect, re-export, require, template and dynamic literal imports are parsed', () => {
  assert.deepEqual(syntax("import 'a'; export * from 'b'; import x = require('c'); require(`d`); import('e')", 'test.ts').imports, ['a', 'b', 'c', 'd', 'e'])
})
test('private deck imports are rejected through direct, re-export and normalized paths', () => {
  for (const code of ["import X from './components/decks/DeckDetailView'", "export * from './components/decks/DeckDetailView'",
    "import('./components/decks/../decks/DeckDetailView')", "require('./components/decks/DeckDetailView')"]) {
    assert.ok(checkSources(sources({ 'frontend/src/Consumer.tsx': code })).some(v => v.includes('deck public API')))
  }
})
test('portable contracts reject Node, Windows adapters, globals and computed imports', () => {
  for (const code of ["require('node:fs')", "import('./windows-local-ai-provider.cjs')", "process.platform", "Buffer.from('x')",
    "globalThis['process'].platform", 'require(moduleName)']) {
    assert.ok(checkSources(sources({ 'desktop/src/local-ai-provider.cjs': code })).some(v => v.includes('portable core')))
  }
})
test('platform adapters cannot reach Electron subpaths or normalized composition modules', () => {
  for (const code of ["require('electron/main')", "import './unused/../main.cjs'", "export * from './preload.cjs'"]) {
    assert.ok(checkSources(sources({ 'desktop/src/local-runtime.cjs': code })).some(v => v.includes('Electron composition')))
  }
})
test('outside Local AI callers must use the public entry instead of helpers', () => {
  assert.ok(checkSources(sources({ 'desktop/src/menu.cjs': "require('./local-ai-provider.cjs')" })).some(v => v.includes('Local AI public API')))
})
test('deleting a protected module or breaking syntax cannot silently pass', () => {
  const missing = sources(); missing.delete('desktop/src/local-ai.cjs')
  assert.ok(checkSources(missing).some(v => v.includes('missing')))
  assert.ok(checkSources(sources({ 'desktop/src/local-ai.cjs': 'const =' })).some(v => v.includes('cannot parse')))
})
