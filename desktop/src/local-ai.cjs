'use strict'
// Public portable API; platform implementations remain explicit composition choices.
const { LocalAiError, createLocalAiProvider } = require('./local-ai-provider.cjs')
const { createModelStoreContract } = require('./model-store-contract.cjs')
const { evaluateLocalAiCapability } = require('./local-ai-capability.cjs')
const { createLocalAiManager } = require('./local-ai-manager.cjs')
const { createLocalQuizService } = require('./local-quiz-service.cjs')
const { LocalDocumentQuizError, createLocalDocumentQuizService } = require('./local-document-quiz-service.cjs')
module.exports = Object.freeze({
  LocalAiError,
  createLocalAiProvider,
  createModelStoreContract,
  evaluateLocalAiCapability,
  createLocalAiManager,
  createLocalQuizService,
  LocalDocumentQuizError,
  createLocalDocumentQuizService,
})
