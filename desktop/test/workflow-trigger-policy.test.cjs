'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')

const root = path.resolve(__dirname, '../..')
function workflow(name) {
  return yaml.load(fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8'))
}

test('Required PR gate keeps its name and runs locked desktop tests for desktop changes', () => {
  const ci = workflow('ci.yml')
  assert.equal(ci.jobs['required-pr-gate'].name, 'Required PR gate')
  assert.equal(ci.on.pull_request, null,
    'stacked and regular PRs must both receive the normal required workflow')
  assert.ok(ci.jobs['required-pr-gate'].needs.includes('desktop-tests'))
  assert.equal(ci.jobs['desktop-tests'].if, "needs.changes.outputs.desktop == 'true'")
  assert.equal(ci.jobs['desktop-tests']['runs-on'], 'windows-2025')
  assert.equal(ci.jobs['desktop-tests']['timeout-minutes'], 20)
  assert.ok(ci.jobs['desktop-tests'].steps.some(step => step.run === 'npm ci'))
  assert.ok(ci.jobs['desktop-tests'].steps.some(step => step.run === 'npm test'))
  assert.match(ci.jobs.changes.outputs.desktop, /steps\.changes\.outputs\.desktop/)
})

test('real-model Local AI acceptance remains explicit and does not run automatically for PRs', () => {
  for (const name of [
    'local-runtime-validation.yml',
    'local-ai-model-comparison.yml',
    'local-ai-product-acceptance.yml',
    'local-ai-real-pdf-desktop.yml',
  ]) {
    const events = workflow(name).on
    assert.ok(Object.hasOwn(events, 'workflow_dispatch'), name + ' must remain manually available')
    assert.equal(events.pull_request, undefined, `${name} must not auto-run for ordinary PRs`)
  }
})