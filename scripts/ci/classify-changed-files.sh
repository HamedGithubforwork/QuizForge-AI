#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

EVENT_NAME="${EVENT_NAME:-}"
BEFORE_SHA="${BEFORE_SHA:-}"
CURRENT_SHA="${CURRENT_SHA:-}"
BASE_SHA="${BASE_SHA:-}"
HEAD_SHA="${HEAD_SHA:-}"
MERGE_GROUP_BASE_SHA="${MERGE_GROUP_BASE_SHA:-}"
MERGE_GROUP_HEAD_SHA="${MERGE_GROUP_HEAD_SHA:-}"
CHANGED_FILES_PATH="${CHANGED_FILES_PATH:-}"

require_sha() {
  local value="$1"
  local description="$2"
  if [[ ! "${value}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "${description} must be a full lowercase 40-character commit SHA." >&2
    exit 2
  fi
}

[[ -n "${CHANGED_FILES_PATH}" ]] || { echo "Changed-files output path is required." >&2; exit 2; }

case "${EVENT_NAME}" in
  pull_request)
    require_sha "${BASE_SHA}" "Pull request base SHA"
    require_sha "${HEAD_SHA}" "Pull request head SHA"
    git cat-file -e "${BASE_SHA}^{commit}"
    git cat-file -e "${HEAD_SHA}^{commit}"
    git diff --name-only "${BASE_SHA}" "${HEAD_SHA}" > "${CHANGED_FILES_PATH}"
    ;;
  merge_group)
    MERGE_GROUP_BASE_SHA="${MERGE_GROUP_BASE_SHA}" \
      MERGE_GROUP_HEAD_SHA="${MERGE_GROUP_HEAD_SHA}" \
      CURRENT_SHA="${CURRENT_SHA}" \
      bash "${SCRIPT_DIR}/validate-merge-group-commits.sh" > "${CHANGED_FILES_PATH}"
    ;;
  push)
    require_sha "${CURRENT_SHA}" "Push current SHA"
    if [[ -n "${BEFORE_SHA}" && "${BEFORE_SHA}" != "0000000000000000000000000000000000000000" ]]; then
      require_sha "${BEFORE_SHA}" "Push before SHA"
      git cat-file -e "${BEFORE_SHA}^{commit}"
      git diff --name-only "${BEFORE_SHA}" "${CURRENT_SHA}" > "${CHANGED_FILES_PATH}"
    else
      git cat-file -e "${CURRENT_SHA}^{commit}"
      git show --pretty="" --name-only "${CURRENT_SHA}" > "${CHANGED_FILES_PATH}"
    fi
    ;;
  *)
    echo "Unsupported CI change-classification event." >&2
    exit 2
    ;;
esac

echo "Changed files:"
cat "${CHANGED_FILES_PATH}"

backend=false
frontend=false
playwright=false
desktop_diagnostic=false
autonomy_tests=false

while IFS= read -r file; do
  case "${file}" in
    backend/*|.python-version|.github/workflows/backend-ecr.yml)
      backend=true
      ;;
    frontend/*)
      frontend=true
      playwright=true
      ;;
    e2e/tests/*|e2e/integration-tests/*|e2e/canary-tests/*|e2e/support/*|e2e/playwright.config.ts|e2e/playwright.canary.config.ts|e2e/package.json|e2e/package-lock.json|.github/workflows/authenticated-canary.yml|.github/workflows/deployment-smoke.yml)
      playwright=true
      ;;
    .github/workflows/ci.yml)
      backend=true
      frontend=true
      playwright=true
      autonomy_tests=true
      ;;
    desktop/scripts/diagnose-targeted-practice.cjs|desktop/scripts/prepare-targeted-practice-model.cjs|desktop/test/diagnose-targeted-practice.test.cjs|desktop/test/diagnose-targeted-practice.integration.cjs|desktop/test/prepare-targeted-practice-model.test.cjs)
      desktop_diagnostic=true
      ;;
    scripts/autonomy/optimization-orchestrator.cjs|scripts/autonomy/test/optimization-orchestrator.test.cjs|scripts/autonomy/automatic-merge-policy.cjs|scripts/autonomy/test/automatic-merge-policy.test.cjs|scripts/autonomy/github-native-preflight.cjs|scripts/autonomy/test/github-native-preflight.test.cjs|scripts/autonomy/github-pr-risk-review.cjs|scripts/autonomy/test/github-pr-risk-review.test.cjs|scripts/autonomy/run-trusted-github-verifier.cjs|scripts/autonomy/integration-coordinator.cjs|scripts/autonomy/test/integration-coordinator.test.cjs|scripts/autonomy/trusted-integration-verifier.cjs|scripts/autonomy/test/trusted-integration-verifier.test.cjs|docs/autonomy/integration-task-graph.json|.github/workflows/quizforge-autonomy-bridge.yml|.github/workflows/trusted-github-pr-verification.yml)
      autonomy_tests=true
      ;;
  esac
done < "${CHANGED_FILES_PATH}"

{
  echo "backend=${backend}"
  echo "frontend=${frontend}"
  echo "playwright=${playwright}"
  echo "desktop_diagnostic=${desktop_diagnostic}"
  echo "autonomy_tests=${autonomy_tests}"
} >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
