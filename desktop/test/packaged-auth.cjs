'use strict'
// Loads the installed ASAR module/dependency under real Electron without IO/auth.
const { app } = require('electron')
const path = require('node:path')
const assert = require('node:assert/strict')
const timeout = setTimeout(() => { console.error('Packaged authentication check timed out'); app.exit(1) }, 20_000)
app.whenReady().then(async () => {
  const { createNativeAuthClient } = require(path.join(process.argv[2], 'src/native-auth-client.cjs'))
  const client = await createNativeAuthClient({ poolId: 'ca-central-1_Synthetic', clientId: 'syntheticclient',
    fetchImpl: () => { throw new Error('This packaging check must not contact the network') } })
  assert.equal(typeof client.exchange, 'function')
  assert.equal(typeof client.refresh, 'function')
  assert.equal(typeof client.revoke, 'function')
  clearTimeout(timeout)
  console.log('Installed authentication module and JWT dependency loaded without network access')
  app.exit(0)
}).catch(() => {
  console.error('Installed authentication module or JWT dependency could not load')
  clearTimeout(timeout)
  app.exit(1)
})
