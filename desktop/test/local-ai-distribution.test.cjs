'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const policy = require('../src/local-ai-distribution-policy.json')
const runtime = require('../src/local-runtime-manifest.json')
const { CANDIDATE } = require('../src/local-model-store.cjs')
const desktopPackage = require('../package.json')

test('distribution policy is pinned to the exact evaluated runtime and model', () => {
  assert.equal(policy.schema, 1)
  assert.equal(policy.runtime.version, runtime.version)
  assert.equal(policy.runtime.archive_sha256, runtime.archiveSha256)
  assert.equal(policy.runtime.delivery, 'bundle_before_activation')
  assert.equal(policy.runtime.automatic_download, false)
  assert.equal(policy.runtime.package_kind, 'server-only')
  assert.equal(policy.runtime.package_file_count, 26)
  assert.equal(runtime.package, 'server-only')
  assert.equal(Object.keys(runtime.files).length, 26)
  assert.equal(runtime.archiveSha256,
    'b0cb46635aa4a028c272b74dc1966178b57157b4be199985e4d5e62cc6664338')
  assert.ok(Object.hasOwn(runtime.files, 'ggml-vulkan.dll'))

  assert.equal(policy.model.id, CANDIDATE.id)
  assert.equal(policy.model.display_name, CANDIDATE.displayName)
  assert.equal(policy.model.repository, CANDIDATE.repository)
  assert.equal(policy.model.revision, CANDIDATE.revision)
  assert.equal(policy.model.license, CANDIDATE.license)
  assert.equal(policy.model.user_disclosure, 'settings_and_native_confirmation')
  assert.equal(policy.model.sha256, CANDIDATE.sha256)
  assert.equal(policy.model.bytes, CANDIDATE.bytes)
  assert.match(CANDIDATE.url, new RegExp('/resolve/' + policy.model.revision + '/'))
  assert.match(CANDIDATE.url, new RegExp('/' + policy.model.filename.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&') + '$'))
  assert.equal(policy.model.delivery, 'explicit_user_download')
  assert.equal(policy.model.automatic_download, false)
  assert.equal(policy.activation_blockers.includes('add_user_visible_model_license_disclosure'), false)
})

test('runtime policy requires all known license notice families before activation', () => {
  const notices = new Map(policy.runtime.required_notices.map(item => [item.name, item.license]))
  assert.equal(notices.get('llama.cpp'), 'MIT')
  assert.equal(notices.get('nlohmann/json'), 'MIT')
  assert.equal(notices.get('LLVM OpenMP'), 'Apache-2.0 WITH LLVM-exception')
  assert.ok(Object.hasOwn(runtime.files, 'LICENSE-LLAMA-CPP'))
  assert.ok(Object.hasOwn(runtime.files, 'LICENSE-JSONHPP'))
  assert.ok(Object.hasOwn(runtime.files, 'LICENSE-LLVM-OpenMP'))
  assert.equal(Object.keys(runtime.files).some(name =>
    /bench|quantize|perplexity|tokenize|rpc-server|llama-cli/.test(name)), false)
  assert.deepEqual(policy.activation_blockers, [
    'approve_code_signing_and_distribution_channel',
  ])
  assert.equal(policy.readiness.internal_preview_technical_ready, true)
  assert.equal(policy.readiness.public_distribution_approved, false)
  assert.deepEqual(new Set(policy.readiness.completed_evidence), new Set([
    'minimal_runtime_payload_real_windows',
    'runtime_notices_packaged_and_verified',
    'product_quality_performance_acceptance',
    'user_visible_model_license_disclosure',
    'desktop_dependency_audit',
  ]))
})

test('current desktop packages still contain no bundled runtime payload', () => {
  assert.deepEqual(desktopPackage.build.files, ['src/**/*', 'package.json'])
  assert.equal(desktopPackage.scripts['pack:local-ai-preview'].includes('local-ai-preview.cjs'), true)
  const root = path.resolve(__dirname, '..')
  for (const candidate of [
    path.join(root, 'local-ai-runtime'),
    path.join(root, 'resources', 'local-ai-runtime'),
  ]) {
    assert.equal(fs.existsSync(candidate), false)
  }
  assert.equal(policy.store_policy.runtime_executable_download,
    'blocked_by_project_policy_pending_store_review')
})
