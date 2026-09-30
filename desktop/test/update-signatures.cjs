'use strict'
// Real Electron/NSIS downloader and Windows Authenticode checks. Test-only local
// feed/configuration overrides never ship in the application ASAR.
const { app } = require('electron')
// A startup assertion must fail CI, not open Electron's modal error dialog.
process.on('uncaughtException', error => {
  console.error(`Update acceptance startup failure: ${error.message}`)
  app.exit(1)
})
console.log('Update acceptance: initializing Electron harness')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { createHash, randomUUID } = require('node:crypto')
const { NsisUpdater } = require('electron-updater')
const { getNetSession } = require('electron-updater/out/electronHttpExecutor')
const { createUpdates, loadApprovedConfiguration } = require('../src/updates.cjs')

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_OS !== 'Windows') {
  throw Error('Update signature acceptance requires disposable Windows CI')
}
const root = fs.realpathSync(process.argv[2])
assert.equal(path.dirname(root), fs.realpathSync(process.env.RUNNER_TEMP))
assert.match(path.basename(root), /^qfn-update-signatures-[a-f0-9]{32}$/)
const { publisherName } = JSON.parse(fs.readFileSync(path.join(root, 'publisher.json'), 'utf8'))
assert.match(publisherName, /^CN=QFN CI expected [a-f0-9]{32}$/)
const userData = path.join(root, 'user-data')
fs.mkdirSync(userData)
app.setPath('userData', userData)
app.enableSandbox()
let stage = 'startup', server
const cacheDirectories = []
const watchdog = setTimeout(() => { console.error(`Update acceptance timed out: ${stage}`); app.exit(1) }, 180_000)

async function checksum(file) {
  const hash = createHash('sha512')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('base64')
}

app.whenReady().then(async () => {
  const assets = {}
  for (const name of ['expected', 'other', 'unsigned', 'tampered']) {
    const file = path.join(root, `${name}.exe`)
    assets[name] = { file, sha512: await checksum(file), size: fs.statSync(file).size }
  }
  let active = 'expected', badChecksum = false, downloads = 0, blockedRequests = 0
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    if (pathname === '/latest.yml') {
      const asset = assets[active]
      response.setHeader('Content-Type', 'application/yaml')
      // A synthetic newer version exercises downloading only; never installed.
      response.end(JSON.stringify({ version: '9999.0.0', files: [{
        url: `${active}.exe`, size: asset.size,
        sha512: badChecksum ? Buffer.alloc(64).toString('base64') : asset.sha512,
      }] }))
    } else if (pathname === `/${active}.exe`) {
      downloads++
      response.setHeader('Content-Length', assets[active].size)
      fs.createReadStream(assets[active].file).pipe(response)
    } else { response.writeHead(404).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  getNetSession().webRequest.onBeforeRequest((details, callback) => {
    const allowed = new URL(details.url).origin === origin
    if (!allowed) blockedRequests++
    callback({ cancel: !allowed })
  })
  for (const scenario of [
    { name: 'expected', accepted: true },
    { name: 'other', error: 'ERR_UPDATER_INVALID_SIGNATURE' },
    { name: 'unsigned', error: 'ERR_UPDATER_INVALID_SIGNATURE' },
    { name: 'tampered', error: 'ERR_UPDATER_INVALID_SIGNATURE' },
    { name: 'expected', badChecksum: true, error: 'ERR_CHECKSUM_MISMATCH' },
  ]) {
    stage = scenario.badChecksum ? 'checksum rejection' : `${scenario.name} signature`
    active = scenario.name
    badChecksum = scenario.badChecksum === true
    const configDirectory = path.join(root, randomUUID())
    fs.mkdirSync(configDirectory)
    fs.writeFileSync(path.join(configDirectory, 'app-update.yml'), JSON.stringify({
      provider: 'generic', url: origin, publisherName: [publisherName],
      updaterCacheDirName: `qfn-ci-update-${randomUUID()}`,
    }))
    assert.equal(loadApprovedConfiguration(configDirectory), false, 'Production must refuse the local test feed')
    const updater = new NsisUpdater()
    const prompts = [], errors = []
    let readyEvents = 0
    const subject = createUpdates({ updater, prompt: async kind => { prompts.push(kind); return false },
      beforeInstall: async () => { throw Error('Acceptance must never install a fixture') } })
    // Explicitly restricted to this non-packaged CI harness.
    updater.forceDevUpdateConfig = true
    updater.disableDifferentialDownload = true
    updater.updateConfigPath = path.join(configDirectory, 'app-update.yml')
    updater.on('error', error => errors.push(error.code))
    updater.on('update-downloaded', () => readyEvents++)
    const helper = await updater.getOrCreateDownloadHelper()
    cacheDirectories.push(helper.cacheDir)
    const before = downloads
    await subject.check(true)
    assert.equal(downloads, before + 1, 'Must download the real EXE')
    assert.equal(blockedRequests, 0, 'Updater attempted a non-local request')
    if (scenario.accepted) {
      assert.equal(subject.status().phase, 'ready')
      assert.deepEqual(prompts, ['restart'])
      assert.deepEqual(errors, [])
      assert.equal(readyEvents, 1)
      assert.equal(await checksum(updater.installerPath), assets.expected.sha512)
    } else {
      assert.equal(subject.status().phase, 'error')
      assert.deepEqual(prompts, ['error'])
      assert.ok(errors.includes(scenario.error), `${stage}: expected ${scenario.error}, got ${errors.join(',')}`)
      assert.equal(readyEvents, 0)
      assert.equal(updater.installerPath, null)
      assert.deepEqual(fs.readdirSync(helper.cacheDirForPendingUpdate), [], 'Rejected downloads must be removed')
      // Recover in the same running updater after a bad download, without reinstalling the app.
      active = 'expected'; badChecksum = false
      await subject.check(true)
      assert.equal(subject.status().phase, 'ready')
      assert.deepEqual(prompts, ['error', 'restart'])
      assert.equal(readyEvents, 1)
      assert.equal(await checksum(updater.installerPath), assets.expected.sha512)
    }
    assert.equal(updater.autoInstallOnAppQuit, false)
    assert.equal(updater.quitAndInstallCalled, false)
    subject.dispose()
    console.log(`Windows update acceptance passed: ${stage}${scenario.accepted ? '' : ' and recovery'}`)
  }
}).then(async () => {
  await cleanup()
  console.log('Real Windows updater accepted the expected signer, rejected wrong/unsigned/tampered/checksum-invalid downloads, and recovered without installation')
  app.exit(0)
}).catch(async error => {
  console.error(`Windows update acceptance failed at ${stage}: ${error.message}`)
  await cleanup()
  app.exit(1)
})

async function cleanup() {
  clearTimeout(watchdog)
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  for (const directory of cacheDirectories) fs.rmSync(directory, { recursive: true, force: true })
}
