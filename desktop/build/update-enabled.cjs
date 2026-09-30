'use strict'
// Used only by the existing signed-build gate. No token ships with the app.
const { build } = require('../package.json')
module.exports = {
  ...build,
  forceCodeSigning: true,
  publish: { provider: 'github', owner: 'HamedGithubforwork', repo: 'QuizForge-AI', private: false, releaseType: 'release' },
  win: { ...build.win, verifyUpdateCodeSignature: true },
}
