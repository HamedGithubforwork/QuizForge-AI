'use strict'

// Public values from Partner Center > Product identity, never guessed defaults.
const { build } = require('../package.json')
const { PROTOCOL } = require('../src/native-protocol.cjs')
function value(name, pattern) {
  const input = process.env[name]
  if (!input || !pattern.test(input)) throw new Error(`Set ${name} to the exact Partner Center value.`)
  return input
}
module.exports = {
  ...build,
  directories: { ...build.directories, output: 'dist/store' },
  publish: null,
  forceCodeSigning: false, // Microsoft signs accepted Store submissions.
  win: { target: [{ target: 'appx', arch: ['x64'] }], signAndEditExecutable: false },
  protocols: [{ name: 'Quiz From Notes sign-in', schemes: [PROTOCOL] }],
  appx: {
    identityName: value('QFN_STORE_IDENTITY_NAME', /^[A-Za-z0-9.-]{3,50}$/),
    publisher: value('QFN_STORE_PUBLISHER', /^CN=[A-Za-z0-9 -]{1,120}$/),
    publisherDisplayName: value('QFN_STORE_PUBLISHER_DISPLAY_NAME', /^[^<>&"'\x00-\x1f\x7f]{1,100}$/),
    displayName: value('QFN_STORE_DISPLAY_NAME', /^[^<>&"'\x00-\x1f\x7f]{1,100}$/),
    applicationId: 'QuizFromNotes',
    languages: ['en-US'],
    capabilities: ['runFullTrust', 'internetClient'],
    addAutoLaunchExtension: false,
    setBuildNumber: false,
    minVersion: '10.0.17763.0',
  },
}
