/** Syntax-aware checks for the concrete feature boundaries in ARCHITECTURE.md.
 * Not a security sandbox or a general JavaScript data-flow analyzer.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CODE = /\.(?:[cm]?js|tsx?)$/
const DECKS = 'frontend/src/components/decks/'
const DECK_ENTRIES = new Set([DECKS + 'index.ts', DECKS + 'DecksPage.tsx'])
const CORE = new Set(['desktop/src/local-ai-provider.cjs', 'desktop/src/model-store-contract.cjs', 'desktop/src/local-ai-capability.cjs', 'desktop/src/local-ai-manager.cjs', 'desktop/src/local-quiz-generator.cjs', 'desktop/src/local-ai.cjs'])
const LOCAL_AI_OWNER = new Set([...CORE, 'desktop/src/windows-local-ai-provider.cjs'])
const PLATFORM = new Set(['desktop/src/local-runtime.cjs', 'desktop/src/local-model-store.cjs', 'desktop/src/windows-local-ai-provider.cjs', 'desktop/src/windows-process-guard.cjs', 'desktop/src/windows-hardware-probe.cjs', 'desktop/src/windows-local-ai-manager.cjs'])
const ELECTRON_ENTRIES = new Set(['desktop/src/main.cjs', 'desktop/src/preload.cjs', 'desktop/src/native-bridge.cjs'])
const normal = value => path.posix.normalize(value.replaceAll('\\', '/'))

export function syntax(source, filename) {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const imports = [], globals = []
  function add(node) {
    imports.push(node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null)
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression)
    } else if (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node.arguments[0])
    }
    if (ts.isIdentifier(node) && ['process', 'Buffer'].includes(node.text)) globals.push(node.text)
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'globalThis' &&
        ts.isStringLiteral(node.argumentExpression) && ['process', 'Buffer'].includes(node.argumentExpression.text)) globals.push(node.argumentExpression.text)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return { imports, globals, parseErrors: tree.parseDiagnostics.length }
}

function resolveLocal(source, specifier, files) {
  if (!specifier.startsWith('.')) return null
  const base = normal(path.posix.join(path.posix.dirname(source), specifier))
  return [base, ...['.ts', '.tsx', '.cjs', '.mjs', '.js'].map(ext => base + ext),
    ...['index.ts', 'index.tsx', 'index.cjs', 'index.js'].map(name => base + '/' + name)]
    .find(candidate => files.has(candidate)) ?? base
}

export function checkSources(input) {
  const files = new Map([...input].map(([name, source]) => [normal(name), source]))
  const violations = []
  for (const required of [...CORE, ...PLATFORM, ...DECK_ENTRIES]) {
    if (!files.has(required)) violations.push(`Required module is missing: ${required}`)
  }
  for (const [name, source] of files) {
    if (!CODE.test(name)) continue
    const found = syntax(source, name)
    if (found.parseErrors) violations.push(`${name}: cannot parse module`)
    if (CORE.has(name) && found.globals.length) violations.push(`${name}: portable core uses Node globals`)
    for (const specifier of found.imports) {
      if (specifier === null) {
        if (CORE.has(name)) violations.push(`${name}: portable core has a computed import`)
        continue
      }
      const target = resolveLocal(name, specifier, files)
      if (CORE.has(name) && (!target || !CORE.has(target))) violations.push(`${name}: portable core imports ${specifier}`)
      if (PLATFORM.has(name) && (specifier === 'electron' || specifier.startsWith('electron/') || ELECTRON_ENTRIES.has(target))) {
        violations.push(`${name}: platform adapter imports Electron composition via ${specifier}`)
      }
      if (target?.startsWith(DECKS) && CODE.test(target) && !name.startsWith(DECKS) && !DECK_ENTRIES.has(target)) {
        violations.push(`${name}: import deck public API instead of ${specifier}`)
      }
      if (CORE.has(target) && target !== 'desktop/src/local-ai.cjs' && !LOCAL_AI_OWNER.has(name)) {
        violations.push(`${name}: import Local AI public API instead of ${specifier}`)
      }
    }
  }
  return [...new Set(violations)].sort()
}

function sourceFiles(directory, root, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Source symlinks must be reviewed: ' + filename)
    if (entry.isDirectory()) sourceFiles(filename, root, files)
    else if (CODE.test(filename)) files.set(normal(path.relative(root, filename)), fs.readFileSync(filename, 'utf8'))
  }
}

export function checkRepository(root = ROOT) {
  const files = new Map()
  for (const relative of ['frontend/src', 'desktop/src']) sourceFiles(path.join(root, relative), root, files)
  return checkSources(files)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = checkRepository()
  if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1 }
  else console.log('Feature and Local AI module boundaries passed.')
}
