#!/usr/bin/env bash
set -euo pipefail

BASE_SHA="${MERGE_GROUP_BASE_SHA:-}"
HEAD_SHA="${MERGE_GROUP_HEAD_SHA:-}"
CURRENT_SHA="${CURRENT_SHA:-}"

require_sha() {
  local value="$1"
  local description="$2"
  if [[ ! "${value}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "${description} must be a full lowercase 40-character commit SHA." >&2
    exit 2
  fi
}

require_sha "${BASE_SHA}" "Merge-group base SHA"
require_sha "${HEAD_SHA}" "Merge-group head SHA"
require_sha "${CURRENT_SHA}" "Checked-out SHA"

if [[ "${HEAD_SHA}" != "${CURRENT_SHA}" ]]; then
  echo "Merge-group head does not match the checked-out workflow SHA." >&2
  exit 2
fi

git cat-file -e "${HEAD_SHA}^{commit}"
if ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
  if [[ "$(git rev-parse --is-shallow-repository)" == "true" ]]; then
    git fetch --unshallow --no-tags origin refs/heads/main
  else
    git fetch --no-tags origin refs/heads/main
  fi
fi
git cat-file -e "${BASE_SHA}^{commit}"
git merge-base --is-ancestor "${BASE_SHA}" "${HEAD_SHA}" || {
  echo "Merge-group base is not an ancestor of its checked-out head." >&2
  exit 1
}

git diff --name-only "${BASE_SHA}" "${HEAD_SHA}"
