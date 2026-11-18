'use strict'

// Read-only GitHub evidence inspection. This module is deliberately not wired
// to the automatic-merge evaluator and never grants merge authority.
const crypto = require('node:crypto')

const REPOSITORY = 'HamedGithubforwork/QuizForge-AI'
const REPOSITORY_ID = 1307099196
const OWNER_ID = 148009407
const TARGET = 'main'
const RULESET_ID = 21886458
const REQUIRED_GATE = 'Required PR gate'
const ACTIONS_APP_ID = 15368
const CI_WORKFLOW_ID = 330113334
const API = 'https://api.github.com/repos/' + REPOSITORY
const SHA = /^[a-f0-9]{40}$/
const SHA256 = /^[a-f0-9]{64}$/
const PAGE_SIZE = 100
const MAX_PAGES = 10
const MAX_FILES = PAGE_SIZE * MAX_PAGES
const MAX_DIFF_BYTES = 2_000_000
const AUTH_TOKEN_ENV = 'QUIZFORGE_GITHUB_READ_TOKEN'
const TRUSTED_RUNTIME_WORKFLOW_ID = 330113334

// Snapshot of the protected-main workflow inventory at the runtime PR baseline.
// Any workflow addition, removal, or edit requires a separately reviewed
// inventory update, so stale or candidate-authored workflow state fails closed.
const TRUSTED_WORKFLOW_BLOBS = Object.freeze({
  '.github/workflows/ai-live-canary.yml':'c0842f3cd1548461c6220cd832f55d4980d49310',
  '.github/workflows/aws-backup-activation-cloud.yml':'d9f1e744751396e111d8553eaf4980bd12366b3d',
  '.github/workflows/aws-backup-activation.yml':'35244d5ac793c3fe2c0ccb7334ec681bde48731f',
  '.github/workflows/aws-budget-alerts.yml':'6d247bee921551781c2bf97cee0116016285d379',
  '.github/workflows/aws-integrated-staging-frontend-update.yml':'2912a8b8d57693b5bcd6bc5cab00ec57d5d0628d',
  '.github/workflows/aws-integrated-staging.yml':'a1fd3bc47692a55e76be73abad2bdd49ee10624e',
  '.github/workflows/aws-production-inventory.yml':'e5572c4b94566e4c783c46cadf6e17f12180c488',
  '.github/workflows/aws-staging-ai-budget.yml':'9c78fff515dac04a49a020121465952ff70aefa6',
  '.github/workflows/backend-ecr.yml':'9773184f818d0fd313b9955723b02e1de8c2fb28',
  '.github/workflows/ci.yml':'ec4d5b0153a897597761ca4ea142074803ac5efa',
  '.github/workflows/cognito-sms-activation.yml':'422c0b9fd8bc9f14a8b66af0893dbd46ccc630c1',
  '.github/workflows/desktop-auth-readiness.yml':'36f487901e7c0fe2d6d7da6839c157eae0839746',
  '.github/workflows/desktop-native-client-registration.yml':'04f0c946007c48ce4b384dd15d9b16f62f3ba38b',
  '.github/workflows/lightsail-app-stage.yml':'41474f447242407ece98d60c2f7b7b122d7756e1',
  '.github/workflows/lightsail-backup-timer-activation.yml':'28389ab386bdfbaeb1d468a286b729c87302f1cb',
  '.github/workflows/lightsail-backup.yml':'c77ad9492d4c7dbb692b6eb526ce3804347cfe84',
  '.github/workflows/lightsail-cognito-hosted-ui-style.yml':'e013a59247a9436ac89b2ae15702e3959af0a618',
  '.github/workflows/lightsail-database-migrations.yml':'eaeda6e25ca4cb17fdf4dbd4d6fe98955ea3c5f4',
  '.github/workflows/lightsail-frontend-hotfix.yml':'b5e9369de5e0d490ce17e020d924668119029b7f',
  '.github/workflows/lightsail-manual-control.yml':'9462a82dc4be5b1520fb2f86ffec97b1b4df7275',
  '.github/workflows/lightsail-production-quiz-e2e.yml':'8c9246ad53cee6b4053e8c45193425bb45a5f9a3',
  '.github/workflows/lightsail-production-recovery-drill.yml':'70a5d04aaeb51aa31e07c4aa63f3f413892f9d6d',
  '.github/workflows/lightsail-production.yml':'54939344065a69501e2e803ba07b6a108f88676b',
  '.github/workflows/lightsail-release-candidate-build.yml':'2e70f1397a6c477409fa337996bf73fb1d7511ca',
  '.github/workflows/lightsail-release-promote.yml':'36144e6f6cd1c83c01a16555c05ca2e1d994aefc',
  '.github/workflows/lightsail-ssh-host-trust-probe.yml':'d2f00b9fb3484412f25c4c75886227ed78ecfbe1',
  '.github/workflows/lightsail-study-notifier-activation.yml':'11e93dcb952464d634105fcfe9716601fd3076e8',
  '.github/workflows/local-ai-prompt-v3.yml':'777112cece7c1cb1a17a44d5e048949438cf632f',
  '.github/workflows/local-ai-prompt-v4.yml':'b8ecaadd4ade39a70434684e01ccdc1f1a0fbc0f',
  '.github/workflows/local-ai-targeted-practice-diagnostic.yml':'d5e9bcd4f00e91cf62581bc6faa33c739ebfe782',
  '.github/workflows/mutation-testing.yml':'2e8b35b9ccfff60a2081cd53c46c3c05dea223c5',
  '.github/workflows/production-google-activation.yml':'b85f94ca46fc10c58e40d128030760162644f0f2',
  '.github/workflows/production-google-incident.yml':'448eaf1dea7b44456dd5408c651b2b0e3d245eb9',
  '.github/workflows/production-google-oauth-readiness.yml':'94c4fcdece112a3901ae5230718adeaec951d1b9',
  '.github/workflows/production-google-terraform-plan.yml':'4b0d9944c942de1fd89513c06ad29961af6bcb44',
  '.github/workflows/production-schema.yml':'012d05ed199d9af3f5572c14a674bd4ef513d719',
  '.github/workflows/quizforge-autonomy-bridge.yml':'2e99858a2147c06dd075a14fa1c3241d3372bc27',
  '.github/workflows/security.yml':'826c236ab211865c0b20fb4f1f64a0df3b2592ec',
  '.github/workflows/terraform-aws.yml':'c55cc313a606310ec29c7d7911950c3b0cbf39ba',
  '.github/workflows/trusted-github-pr-verification.yml':'25399ed3fc55e393c36c7537ed0b4781f4c8ff48',
})

const TRUSTED_CODE_PATHS = Object.freeze([
  'scripts/autonomy/github-pr-risk-review.cjs',
  'scripts/autonomy/github-native-preflight.cjs',
  'scripts/autonomy/automatic-merge-policy.cjs',
  'scripts/autonomy/run-trusted-github-verifier.cjs',
])

const PROTECTED_PATHS = Object.freeze([
  'AGENTS.md', 'CODEOWNERS', '.github/CODEOWNERS', 'SECURITY.md',
  '.github/', '.codex/agents/', 'scripts/autonomy/', 'scripts/ci/',
  'terraform/', 'infra/', 'infrastructure/', 'database/migrations/',
  'db/migrations/', 'backend/migrations/', 'backend/migration/',
  'backend/alembic/', 'migrations/', 'release/', 'releases/',
  'production/', 'scripts/production/', '.github/staging-update-requests/',
])

// Exact main-push side-effect inventory reviewed from the workflow blobs above.
// These are deliberately broad path rules; unknown matches are never low risk.
const WORKFLOW_EFFECT_RULES = Object.freeze([
  { workflow:'backend-ecr.yml', effect:'aws_ecr_publish', matches:path => path.startsWith('backend/') },
  { workflow:'terraform-aws.yml', effect:'aws_terraform_apply', matches:path =>
    path.startsWith('infra/aws/') || path === '.terraform.lock.hcl' },
  { workflow:'aws-integrated-staging-frontend-update.yml', effect:'aws_staging_mutation', matches:path =>
    /^\.github\/staging-update-requests\/[^/]+\.json$/.test(path) },
  { workflow:'lightsail-cognito-hosted-ui-style.yml', effect:'production_cognito_ui_mutation', matches:path =>
    path.startsWith('scripts/production/lightsail/cognito-hosted-ui-') ||
    path.startsWith('scripts/production/lightsail/style_cognito_hosted_ui') ||
    path.startsWith('scripts/production/lightsail/test_style_cognito_hosted_ui') },
  { workflow:'lightsail-release-candidate-build.yml', effect:'aws_ecr_release_candidate_publish', matches:path =>
    path.startsWith('frontend/') || path === 'scripts/production/build.py' ||
    path.startsWith('scripts/production/lightsail/') },
  { workflow:'production-google-terraform-plan.yml', effect:'aws_read_only_terraform_plan', matches:path =>
    path.startsWith('infra/aws/lightsail-production/') ||
    path.startsWith('scripts/production/lightsail/google_plan_guard') ||
    path.startsWith('scripts/production/lightsail/package_recovery') },
])

class GitHubReadError extends Error {
  constructor(reason) { super(reason); this.reason = reason }
}

function isRateLimitResponse(response, payload) {
  const remaining = response.headers?.get?.('x-ratelimit-remaining')
  const retryAfter = response.headers?.get?.('retry-after')
  const message = typeof payload?.message === 'string' ? payload.message.toLowerCase() : ''
  return remaining === '0' || Boolean(retryAfter) || /rate limit|secondary rate limit/.test(message)
}

function createAuthenticatedReadClient(token = process.env[AUTH_TOKEN_ENV]) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 512 ||
      !/^[A-Za-z0-9_]+$/.test(token)) {
    throw new GitHubReadError(token ? 'authentication_context_invalid' : 'authentication_context_missing')
  }
  // Capture the credential once. An environment/account switch between API
  // requests cannot mix observations from two authentication contexts.
  const pinnedToken = token
  return async function readAuthenticatedGithub(url) {
    let parsed
    try { parsed = new URL(url) } catch { throw new GitHubReadError('github_request_invalid') }
    if (parsed.origin !== 'https://api.github.com' ||
        !parsed.pathname.startsWith('/repos/' + REPOSITORY + '/') &&
        parsed.pathname !== '/repos/' + REPOSITORY) {
      throw new GitHubReadError('github_request_out_of_scope')
    }
    let response
    try {
      response = await fetch(parsed.toString(), {
        method:'GET',
        headers: {
          Accept:'application/vnd.github+json',
          Authorization:'Bearer ' + pinnedToken,
          'X-GitHub-Api-Version':'2022-11-28',
          'User-Agent':'QuizForge-read-only-pr-risk-review',
          'Cache-Control':'no-cache',
        },
        redirect:'error',
        signal:AbortSignal.timeout(8000),
      })
    } catch { throw new GitHubReadError('github_unavailable_or_redirect_rejected') }
    if (response.status === 404) return {__httpStatus:404}
    if (response.status === 401) throw new GitHubReadError('authentication_invalid_or_expired')
    if (response.status === 429) throw new GitHubReadError('github_rate_limited')
    if (response.status === 403) {
      let payload = null
      try { payload = await response.clone().json() } catch {}
      throw new GitHubReadError(isRateLimitResponse(response, payload)
        ? 'github_rate_limited' : 'github_permission_denied')
    }
    if (!response.ok) throw new GitHubReadError('github_read_failed')
    try { return await response.json() }
    catch { throw new GitHubReadError('github_response_invalid') }
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function blocked(reason, details = {}) {
  return Object.freeze({status:'UNVERIFIED',mergeAuthorized:false,reason,...details})
}

function validRepoPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 500 &&
    !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function paginateUrl(path, page) {
  return API + path + (path.includes('?') ? '&' : '?') + 'per_page=' + PAGE_SIZE + '&page=' + page
}

async function readAllArray(path, read, {countFromResponse = false, expectedCount, itemKey} = {}) {
  const values = []
  const identities = new Set()
  let totalCount
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await read(paginateUrl(path, page))
    const array = countFromResponse ? response?.[itemKey] : response
    if (!Array.isArray(array) || array.length > PAGE_SIZE) return null
    if (countFromResponse) {
      if (!Number.isSafeInteger(response.total_count) || response.total_count < 0 ||
          response.total_count > MAX_FILES ||
          (totalCount !== undefined && response.total_count !== totalCount)) return null
      totalCount = response.total_count
    }
    for (const item of array) {
      const identity = item?.id ?? item?.filename ?? item?.number
      if (identity === undefined || identities.has(String(identity))) return null
      identities.add(String(identity))
      values.push(item)
    }
    const expected = countFromResponse ? totalCount : expectedCount
    if (expected !== undefined && values.length === expected) return values
    if (expected !== undefined && values.length > expected) return null
    if (array.length < PAGE_SIZE) {
      if (expected !== undefined && values.length !== expected) return null
      return values
    }
    if (page === MAX_PAGES) return null
  }
  return null
}

async function readWorkflowInventory(ref, read) {
  const result = await read(API + '/contents/.github/workflows?ref=' + ref)
  if (!Array.isArray(result) || result.length !== Object.keys(TRUSTED_WORKFLOW_BLOBS).length) return null
  const observed = new Map()
  for (const file of result) {
    if (file?.type !== 'file' || !validRepoPath(file.path) ||
        !file.path.startsWith('.github/workflows/') || !SHA.test(file.sha ?? '') || observed.has(file.path)) return null
    observed.set(file.path,file.sha)
  }
  const expectedPaths = Object.keys(TRUSTED_WORKFLOW_BLOBS).sort()
  if (JSON.stringify([...observed.keys()].sort()) !== JSON.stringify(expectedPaths)) return null
  for (const [path,expectedSha] of Object.entries(TRUSTED_WORKFLOW_BLOBS)) {
    if (observed.get(path) !== expectedSha) return null
  }
  return observed
}

async function verifyTrustedCode(baseSha, headSha, read) {
  const rows = await Promise.all(TRUSTED_CODE_PATHS.map(async path => {
    const [baseFile,headFile] = await Promise.all([
      read(API + '/contents/' + path + '?ref=' + baseSha),
      read(API + '/contents/' + path + '?ref=' + headSha),
    ])
    return baseFile?.type === 'file' && headFile?.type === 'file' &&
      SHA.test(baseFile.sha ?? '') && baseFile.sha === headFile.sha
  }))
  return rows.every(Boolean)
}

function validatedFileList(files, expectedCount) {
  if (!Array.isArray(files) || files.length !== expectedCount || files.length > MAX_FILES) return null
  const seen = new Set()
  const normalized = []
  let diffBytes = 0
  for (const file of files) {
    if (!validRepoPath(file?.filename) || seen.has(file.filename) ||
        !['added','removed','modified','renamed','copied','changed'].includes(file.status) ||
        !SHA.test(file.sha ?? '') || typeof file.patch !== 'string' ||
        !Number.isSafeInteger(file.additions) || file.additions < 0 ||
        !Number.isSafeInteger(file.deletions) || file.deletions < 0 ||
        !Number.isSafeInteger(file.changes) || file.changes !== file.additions + file.deletions) return null
    seen.add(file.filename)
    if (file.status === 'renamed' && !validRepoPath(file.previous_filename)) return null
    if (file.status !== 'renamed' && file.previous_filename !== undefined && file.previous_filename !== null) return null
    diffBytes += Buffer.byteLength(file.patch,'utf8')
    if (diffBytes > MAX_DIFF_BYTES) return null
    normalized.push({
      filename:file.filename,status:file.status,previous_filename:file.previous_filename ?? null,
      sha:file.sha,additions:file.additions,deletions:file.deletions,changes:file.changes,patch:file.patch,
    })
  }
  normalized.sort((a,b) => a.filename.localeCompare(b.filename))
  const serialized = JSON.stringify(normalized)
  return {files:normalized,diffSha256:sha256(serialized),diffBytes}
}

const HIGH_RISK_PATH_RE = /(?:^|\/)(?:auth|authentication|authorization|permissions?|secrets?|credentials?|identity|oauth|cognito|billing|payments?|database|migrations?|schema|terraform|infrastructure|infra|deployment|deploy|production|release|security|grading|grounding|validator|merge-queue|merge-policy)(?:\/|\.|-|$)/i
const SENSITIVE_DIFF_RE = /(?:\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b|\b(?:aws_secret_access_key|aws_access_key_id|aws_session_token|api[_-]?key|bearer[_ -]?token|client[_ -]?secret|private[_ -]?key|secret[_ -]?access[_ -]?key|password|secret|access_token|refresh_token|authorization)\b\s*[:=])/i

function safeCategory(file) {
  const path = file.filename
  if (file.status === 'removed' || file.status === 'renamed' || file.status === 'copied' || file.status === 'changed') return 'unknown'
  if (/^docs\/(?!autonomy\/|security\/|deployment\/|releases?\/)/i.test(path) &&
      /\.(?:md|mdx|txt)$/i.test(path)) return 'documentation'
  if (/^frontend\/src\/(?:styles\/|.*\.module\.css$)/.test(path) &&
      /\.css$/i.test(path) && !/\b(?:url\s*\(|@import|expression\s*\()/i.test(file.patch)) return 'low_risk_ui'
  return 'unknown'
}

function classifyRisk(fileSet) {
  const effects = new Map()
  let unknownRisk = false
  const categories = new Set()
  const highRiskPaths = []
  for (const file of fileSet) {
    const paths = [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]
    for (const path of paths) {
      const protectedPath = PROTECTED_PATHS.some(prefix => path === prefix || path.startsWith(prefix)) || HIGH_RISK_PATH_RE.test(path)
      if (protectedPath || SENSITIVE_DIFF_RE.test(file.patch)) highRiskPaths.push(path)
      for (const rule of WORKFLOW_EFFECT_RULES) {
        if (rule.matches(path)) effects.set(rule.workflow,rule.effect)
      }
    }
    const category = safeCategory(file)
    if (category === 'unknown') unknownRisk = true
    else categories.add(category)
  }
  const workflowEffects = [...effects].map(([workflow,effect]) => ({workflow,effect})).sort((a,b) => a.workflow.localeCompare(b.workflow))
  if (highRiskPaths.length || workflowEffects.length) return {
    risk:'high_risk',categories:[...categories],
    highRiskPaths:[...new Set(highRiskPaths)].sort(),workflowEffects,
  }
  if (unknownRisk || categories.size === 0) return {risk:'unknown',categories:[...categories],highRiskPaths:[],workflowEffects}
  return {risk:'low_risk',categories:[...categories].sort(),highRiskPaths:[],workflowEffects}
}

function checkProtectedRules(ruleset) {
  if (ruleset?.id !== RULESET_ID || ruleset.enforcement !== 'active' ||
      ruleset.source_type !== 'Repository' || ruleset.source !== REPOSITORY ||
      ruleset.target !== 'branch' || !Array.isArray(ruleset.bypass_actors) ||
      ruleset.bypass_actors.length !== 0 || !Array.isArray(ruleset.rules) ||
      !Array.isArray(ruleset.conditions?.ref_name?.include) ||
      !ruleset.conditions.ref_name.include.includes('~DEFAULT_BRANCH') ||
      !Array.isArray(ruleset.conditions.ref_name.exclude) ||
      ruleset.conditions.ref_name.exclude.length !== 0) return null
  const statusRule = ruleset.rules.find(rule => rule.type === 'required_status_checks')?.parameters
  const prRule = ruleset.rules.find(rule => rule.type === 'pull_request')?.parameters
  if (statusRule?.strict_required_status_checks_policy !== true ||
      !Array.isArray(statusRule.required_status_checks) || statusRule.required_status_checks.length === 0 ||
      !prRule || !Number.isSafeInteger(prRule.required_approving_review_count) ||
      !Array.isArray(prRule.required_reviewers)) return null
  if (prRule.required_reviewers.length !== 0) return null
  return {
    requiredChecks:statusRule.required_status_checks,
    requiredApprovals:prRule.required_approving_review_count,
    rulesetSha256:sha256(JSON.stringify(ruleset)),
  }
}

function checkRulesetInventory(rulesets) {
  if (!Array.isArray(rulesets) || rulesets.some(item => !Number.isSafeInteger(item?.id) ||
      typeof item.enforcement !== 'string')) return null
  const active = rulesets.filter(item => item.enforcement === 'active')
  if (active.length !== 1 || active[0].id !== RULESET_ID || active[0].target !== 'branch' ||
      active[0].source_type !== 'Repository' || active[0].source !== REPOSITORY) return null
  return true
}

function checkEffectiveRules(effective, ruleset) {
  if (!Array.isArray(effective) || effective.length === 0) return null
  const allowed = new Set(['deletion','non_fast_forward','pull_request','required_status_checks'])
  if (effective.some(rule => !allowed.has(rule?.type) || rule.ruleset_id !== RULESET_ID ||
      rule.ruleset_source_type !== 'Repository' || rule.ruleset_source !== REPOSITORY)) return null
  const pull = effective.find(rule => rule.type === 'pull_request')?.parameters
  const status = effective.find(rule => rule.type === 'required_status_checks')?.parameters
  const configuredPull = ruleset.rules.find(rule => rule.type === 'pull_request')?.parameters
  const configuredStatus = ruleset.rules.find(rule => rule.type === 'required_status_checks')?.parameters
  if (!pull || !status || !configuredPull || !configuredStatus ||
      pull.required_approving_review_count !== configuredPull.required_approving_review_count ||
      JSON.stringify(pull.required_reviewers) !== JSON.stringify(configuredPull.required_reviewers) ||
      status.strict_required_status_checks_policy !== configuredStatus.strict_required_status_checks_policy ||
      JSON.stringify(status.required_status_checks) !== JSON.stringify(configuredStatus.required_status_checks)) return null
  return sha256(JSON.stringify(effective))
}

function verifyReviews(reviews, pr, headSha, requiredApprovals) {
  if (!Array.isArray(reviews)) return null
  const latest = new Map()
  for (const review of reviews) {
    if (!Number.isSafeInteger(review?.id) || !Number.isSafeInteger(review?.user?.id) ||
        typeof review.user.login !== 'string' || typeof review.user.type !== 'string' ||
        typeof review.state !== 'string' || typeof review.submitted_at !== 'string' ||
        typeof review.body !== 'string' || review.body.trim() !== '' ||
        !SHA.test(review.commit_id ?? '')) return null
    const previous = latest.get(review.user.id)
    const time = Date.parse(review.submitted_at)
    if (!Number.isFinite(time)) return null
    if (!previous || time > previous.time || (time === previous.time && review.id > previous.review.id)) {
      latest.set(review.user.id,{review,time})
    }
  }
  let approvals = 0
  let blockingReview = false
  for (const {review} of latest.values()) {
    if (!['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED'].includes(review.state)) return null
    if (review.state === 'CHANGES_REQUESTED') blockingReview = true
    if (review.state !== 'APPROVED' || review.commit_id !== headSha ||
        review.user.id === pr.user?.id || review.user.type !== 'User' ||
        !['OWNER','MEMBER','COLLABORATOR'].includes(review.author_association)) continue
    approvals += 1
  }
  if (blockingReview || approvals < requiredApprovals) return null
  return {decision:blockingReview ? 'CHANGES_REQUESTED' : approvals ? 'APPROVED' : 'NO_CHANGES_REQUESTED',
    approvals,requiredApprovals,latestReviewCount:latest.size}
}

async function snapshot(prNumber, read, expectedRequiredRunId) {
  const [repo,pr,main,ruleset,rulesets,effectiveRules,classicProtection] = await Promise.all([
    read(API),read(API + '/pulls/' + prNumber),read(API + '/branches/' + TARGET),
    read(API + '/rulesets/' + RULESET_ID),
    readAllArray('/rulesets?includes_parents=true',read),
    read(API + '/rules/branches/' + TARGET),
    read(API + '/branches/' + TARGET + '/protection'),
  ])
  if (repo?.id !== REPOSITORY_ID || repo.owner?.id !== OWNER_ID || repo.full_name !== REPOSITORY ||
      repo.default_branch !== TARGET || repo.allow_auto_merge !== false) return null
  const baseSha = main?.commit?.sha
  const headSha = pr?.head?.sha
  if (main?.protected !== true || !SHA.test(baseSha ?? '') || !SHA.test(headSha ?? '') ||
      pr?.number !== prNumber || pr.state !== 'open' || pr.draft !== false || pr.merged !== false ||
      pr.mergeable !== true || pr.mergeable_state !== 'clean' ||
      pr.base?.ref !== TARGET || pr.base?.repo?.id !== REPOSITORY_ID || pr.base?.sha !== baseSha ||
      pr.head?.repo?.id !== REPOSITORY_ID || !Number.isSafeInteger(pr.changed_files) ||
      pr.changed_files < 1 || pr.changed_files > MAX_FILES || !Number.isSafeInteger(pr.user?.id)) return null
  const rules = checkProtectedRules(ruleset)
  const effectiveRulesSha256 = checkEffectiveRules(effectiveRules,ruleset)
  if (!rules || !checkRulesetInventory(rulesets) || !effectiveRulesSha256 ||
      classicProtection?.__httpStatus !== 404) return null
  const [filesRaw,reviews,comments,discussion,checkRuns,workflowBase,workflowHead,codeTrusted] = await Promise.all([
    readAllArray('/pulls/' + prNumber + '/files',read,{expectedCount:pr.changed_files}),
    readAllArray('/pulls/' + prNumber + '/reviews',read),
    readAllArray('/pulls/' + prNumber + '/comments',read),
    readAllArray('/issues/' + prNumber + '/comments',read),
    readAllArray('/commits/' + headSha + '/check-runs',read,{countFromResponse:true,itemKey:'check_runs'}),
    readWorkflowInventory(baseSha,read),readWorkflowInventory(headSha,read),
    verifyTrustedCode(baseSha,headSha,read),
  ])
  if (!filesRaw || !reviews || !comments || !discussion || !checkRuns || !workflowBase || !workflowHead || !codeTrusted) return null
  if (JSON.stringify([...workflowBase].sort(([a],[b]) => a.localeCompare(b))) !==
      JSON.stringify([...workflowHead].sort(([a],[b]) => a.localeCompare(b)))) return null
  const fileSet = validatedFileList(filesRaw,pr.changed_files)
  if (!fileSet) return null
  const reviewEvidence = verifyReviews(reviews,pr,headSha,rules.requiredApprovals)
  if (!reviewEvidence) return null
  // REST review-comment objects have no resolved-thread field. Never infer that
  // an inline discussion is resolved from its replies or approval state.
  if (comments.length !== 0 || discussion.length !== 0) return null

  const checks = []
  for (const required of rules.requiredChecks) {
    if (typeof required?.context !== 'string' || !Number.isSafeInteger(required.integration_id)) return null
    const named = checkRuns.filter(check => check.name === required.context)
    const matching = named.filter(check => check.app?.id === required.integration_id)
    if (named.length !== 1 || matching.length !== 1 || matching[0].head_sha !== headSha ||
        !Number.isSafeInteger(matching[0].id) || matching[0].id < 1 ||
        !Number.isSafeInteger(matching[0].app?.id) || !SHA.test(matching[0].head_sha ?? '') ||
        matching[0].status !== 'completed' || matching[0].conclusion !== 'success') return null
    checks.push({name:required.context,appId:required.integration_id,checkRunId:matching[0].id})
  }
  const gate = checks.find(check => check.name === REQUIRED_GATE)
  if (!gate || gate.appId !== ACTIONS_APP_ID) return null
  const gateRunId = Number((checkRuns.find(check => check.id === gate.checkRunId)?.details_url ?? '').match(
    /^https:\/\/github\.com\/HamedGithubforwork\/QuizForge-AI\/actions\/runs\/([1-9][0-9]*)\/job\/[1-9][0-9]*$/)?.[1])
  if (!Number.isSafeInteger(gateRunId)) return null
  const [run,associatedPrs] = await Promise.all([
    read(API + '/actions/runs/' + gateRunId),
    // GitHub's Actions run representation can omit pull_requests even for a
    // real PR workflow run. The commit-to-PR endpoint is the independent
    // association source; the run's pull_requests field, when present, must
    // agree with it but is not required to be populated.
    readAllArray('/commits/' + headSha + '/pulls',read),
  ])
  const associatedByCommit = associatedPrs?.some(item =>
    item?.number === prNumber && item.state === 'open' &&
    item.head?.repo?.id === REPOSITORY_ID && item.head?.sha === headSha &&
    item.base?.repo?.id === REPOSITORY_ID && item.base?.ref === TARGET && item.base?.sha === baseSha)
  const runAssociations = run?.pull_requests
  const runAssociationAgrees = runAssociations === undefined ||
    (Array.isArray(runAssociations) && (runAssociations.length === 0 || runAssociations.some(item =>
      item?.number === prNumber && item.head?.repo?.id === REPOSITORY_ID && item.head?.sha === headSha &&
      item.base?.repo?.id === REPOSITORY_ID && item.base?.ref === TARGET && item.base?.sha === baseSha)))
  if (run?.id !== gateRunId || run.workflow_id !== CI_WORKFLOW_ID ||
      run.path !== '.github/workflows/ci.yml' || run.event !== 'pull_request' ||
      run.head_sha !== headSha || run.status !== 'completed' || run.conclusion !== 'success' ||
      run.repository?.id !== REPOSITORY_ID || !associatedByCommit || !runAssociationAgrees ||
      (expectedRequiredRunId !== undefined && gateRunId !== expectedRequiredRunId)) return null
  const risk = classifyRisk(fileSet.files)
  return {
    repositoryId:REPOSITORY_ID,ownerId:OWNER_ID,prNumber,headSha,baseSha,
    diffSha256:fileSet.diffSha256,changedFiles:fileSet.files.length,diffBytes:fileSet.diffBytes,
    risk,reviewEvidence,reviewEvidenceSha256:sha256(JSON.stringify(reviews)),
    rulesetSha256:rules.rulesetSha256,effectiveRulesSha256,checks,workflowRunId:gateRunId,
    reviewThreads:'none_reported_by_rest',
  }
}

async function inspectGithubPrRiskReview(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      !Number.isSafeInteger(options.prNumber) || options.prNumber < 1 ||
      Object.keys(options).some(key => key !== 'prNumber')) {
    return blocked('invalid_input')
  }
  try {
    const read = createAuthenticatedReadClient()
    const first = await snapshot(options.prNumber,read)
    if (!first) return blocked('evidence_missing_stale_or_untrusted')
    const second = await snapshot(options.prNumber,read)
    if (!second || JSON.stringify(first) !== JSON.stringify(second)) {
      return blocked('state_changed_during_inspection')
    }
    if (first.risk.risk === 'high_risk') {
      return Object.freeze({status:'BLOCKED',mergeAuthorized:false,reason:'high_risk_change',...first})
    }
    if (first.risk.risk !== 'low_risk') {
      return blocked('risk_unknown', {repositoryId:REPOSITORY_ID,prNumber:options.prNumber,
        headSha:first.headSha,baseSha:first.baseSha,diffSha256:first.diffSha256,risk:first.risk})
    }
    return Object.freeze({status:'OBSERVATION_ONLY',mergeAuthorized:false,reason:'read_only_evidence_only',...first})
  } catch (error) {
    if (error instanceof GitHubReadError) return blocked(error.reason)
    return blocked('github_unavailable_or_invalid')
  }
}

async function inspectGithubWorkflowRunRiskReview(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      !Number.isSafeInteger(options.workflowRunId) || options.workflowRunId < 1 ||
      Object.keys(options).some(key => key !== 'workflowRunId')) return blocked('invalid_input')
  try {
    const read = createAuthenticatedReadClient()
    const triggerRun = await read(API + '/actions/runs/' + options.workflowRunId)
    if (triggerRun?.id !== options.workflowRunId ||
        triggerRun.workflow_id !== TRUSTED_RUNTIME_WORKFLOW_ID ||
        triggerRun.path !== '.github/workflows/ci.yml' || triggerRun.event !== 'pull_request' ||
        triggerRun.status !== 'completed' || triggerRun.conclusion !== 'success' ||
        triggerRun.repository?.id !== REPOSITORY_ID || !SHA.test(triggerRun.head_sha ?? '')) {
      return blocked('trigger_run_untrusted_or_incomplete')
    }
    const associatedPrs = await readAllArray('/commits/' + triggerRun.head_sha + '/pulls',read)
    if (!associatedPrs) return blocked('trigger_pr_association_unavailable')
    const candidates = associatedPrs.filter(pr => pr?.state === 'open' && pr.base?.ref === TARGET &&
      pr.head?.sha === triggerRun.head_sha && pr.head?.repo?.id === REPOSITORY_ID &&
      pr.base?.repo?.id === REPOSITORY_ID && Number.isSafeInteger(pr.number) && pr.number > 0)
    if (candidates.length !== 1) return blocked('trigger_pr_association_ambiguous')
    const prNumber = candidates[0].number
    const first = await snapshot(prNumber,read,options.workflowRunId)
    if (!first) return blocked('evidence_missing_stale_or_untrusted')
    const second = await snapshot(prNumber,read,options.workflowRunId)
    const finalTriggerRun = await read(API + '/actions/runs/' + options.workflowRunId)
    if (!second || JSON.stringify(first) !== JSON.stringify(second) ||
        JSON.stringify(triggerRun) !== JSON.stringify(finalTriggerRun)) {
      return blocked('state_changed_during_inspection')
    }
    if (first.risk.risk === 'high_risk') {
      return Object.freeze({status:'BLOCKED',mergeAuthorized:false,reason:'high_risk_change',
        ...first,triggerWorkflowRunId:options.workflowRunId})
    }
    if (first.risk.risk !== 'low_risk') {
      return blocked('risk_unknown',{repositoryId:REPOSITORY_ID,prNumber,headSha:first.headSha,
        baseSha:first.baseSha,diffSha256:first.diffSha256,risk:first.risk,
        triggerWorkflowRunId:options.workflowRunId})
    }
    return Object.freeze({status:'OBSERVATION_ONLY',mergeAuthorized:false,reason:'read_only_evidence_only',
      ...first,triggerWorkflowRunId:options.workflowRunId})
  } catch (error) {
    if (error instanceof GitHubReadError) return blocked(error.reason)
    return blocked('github_unavailable_or_invalid')
  }
}

module.exports = {
  inspectGithubPrRiskReview, inspectGithubWorkflowRunRiskReview, classifyRisk, WORKFLOW_EFFECT_RULES,
  TRUSTED_WORKFLOW_BLOBS, TRUSTED_CODE_PATHS,
}
