'use strict'
// Public portable API; platform implementations remain explicit composition choices.
const { LocalAiError, createLocalAiProvider } = require('./local-ai-provider.cjs')
const { createModelStoreContract } = require('./model-store-contract.cjs')
module.exports = Object.freeze({ LocalAiError, createLocalAiProvider, createModelStoreContract })
