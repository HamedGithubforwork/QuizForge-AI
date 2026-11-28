'use strict'

// Entry point for the trusted workflow_run job. It reads only GitHub's event
// envelope and authenticated API observations; it never checks out or executes
// the triggering PR's code, reads artifacts/caches, or authorizes a merge.
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const { inspectGithubWorkflowRunRiskReview } = require('./github-pr-risk-review.cjs')

const REPOSITORY = 'HamedGithubforwork/QuizForge-AI'
const REPOSITORY_ID = 1307099196
const CI_WORKFLOW_ID = 330113334
const SHA = /^[a-f0-9]{40}$/
const MAX_EVENT_BYTES = 1024 * 1024

function unverified(reason) {
  return Object.freeze({status:'UNVERIFIED',mergeAuthorized:false,reason})
}

async function runTrustedGithubVerifier() {
  const env = process.env
  try {
    if (env.GITHUB_EVENT_NAME !== 'workflow_run' || env.GITHUB_REPOSITORY !== REPOSITORY ||
        env.GITHUB_REF !== 'refs/heads/main' || !SHA.test(env.GITHUB_SHA ?? '') ||
        typeof env.GITHUB_EVENT_PATH !== 'string' || !env.GITHUB_EVENT_PATH) {
      return unverified('trusted_default_branch_context_invalid')
    }
    const eventStat = fs.statSync(env.GITHUB_EVENT_PATH)
    if (!eventStat.isFile() || eventStat.size < 2 || eventStat.size > MAX_EVENT_BYTES) {
      return unverified('event_payload_invalid')
    }
    const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH,'utf8'))
    const run = event?.workflow_run
    if (!Number.isSafeInteger(run?.id) || run.id < 1 || run.workflow_id !== CI_WORKFLOW_ID ||
        run.event !== 'pull_request' || run.repository?.id !== REPOSITORY_ID ||
        run.head_repository?.id !== REPOSITORY_ID || !SHA.test(run.head_sha ?? '')) {
      return unverified('trigger_event_untrusted_or_incomplete')
    }
    const checkedOutSha = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()
    if (checkedOutSha !== env.GITHUB_SHA) return unverified('trusted_checkout_sha_mismatch')
    const evidence = await inspectGithubWorkflowRunRiskReview({workflowRunId:run.id})
    if (evidence.status === 'OBSERVATION_ONLY' && evidence.baseSha !== env.GITHUB_SHA) {
      return unverified('trusted_default_branch_revision_changed')
    }
    // Return a fixed allowlist only. Do not expose API payloads, reviewer text,
    // credentials, raw errors, prompts, or arbitrary workflow event fields.
    const report = {
      status:evidence.status,
      mergeAuthorized:false,
      reason:evidence.reason,
      repositoryId:evidence.repositoryId ?? REPOSITORY_ID,
      triggerWorkflowRunId:run.id,
    }
    if (Number.isSafeInteger(evidence.prNumber)) report.prNumber = evidence.prNumber
    if (SHA.test(evidence.headSha ?? '')) report.headSha = evidence.headSha
    if (SHA.test(evidence.baseSha ?? '')) report.baseSha = evidence.baseSha
    if (SHA.test(evidence.diffSha256 ?? '')) report.diffSha256 = evidence.diffSha256
    if (evidence.risk && ['low_risk','high_risk','unknown'].includes(evidence.risk.risk)) {
      report.risk = evidence.risk.risk
    }
    return Object.freeze(report)
  } catch {
    return unverified('trusted_runtime_unavailable_or_invalid')
  }
}

async function main() {
  if (process.argv.length !== 2) {
    process.stdout.write(JSON.stringify(unverified('unexpected_arguments')) + '\n')
    process.exitCode = 1
    return
  }
  const report = await runTrustedGithubVerifier()
  process.stdout.write(JSON.stringify(report) + '\n')
  if (report.status !== 'OBSERVATION_ONLY' || report.mergeAuthorized !== false) process.exitCode = 1
}

if (require.main === module) main()

module.exports = { runTrustedGithubVerifier }
