'use strict'

const fs = require('node:fs')
const path = require('node:path')

const directory = process.argv[2]
if (!directory || !path.isAbsolute(path.resolve(directory))) {
  throw new Error('Pass the built frontend directory.')
}
const root = fs.realpathSync(directory)
const indexPath = path.join(root, 'index.html')
const html = fs.readFileSync(indexPath, 'utf8')
if (!html.includes('<title>Quiz From Notes</title>') || !html.includes('./assets/')) {
  throw new Error('Built frontend is not configured for the bundled desktop origin.')
}

const assetReferences = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^\"]+)"/g)]
if (assetReferences.length < 2) throw new Error('Built frontend is missing its local entry assets.')
const assets = fs.readdirSync(path.join(root, 'assets'))
const javascript = assets.filter(name => name.endsWith('.js'))
  .map(name => fs.readFileSync(path.join(root, 'assets', name), 'utf8')).join('\n')
if (!javascript.includes('Local AI preview') || !javascript.includes('Process PDF on this computer')) {
  throw new Error('Built frontend does not include the branch Local AI interface.')
}
for (const match of assetReferences) {
  const asset = path.resolve(root, match[1])
  if (!asset.startsWith(root + path.sep) || !fs.statSync(asset).isFile()) {
    throw new Error('Built frontend references a missing or invalid local asset.')
  }
}
console.log(`Verified bundled Local AI interface: ${assetReferences.length} local entry assets`)
