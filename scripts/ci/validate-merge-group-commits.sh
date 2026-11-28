#!/usr/bin/env bash
set -euo pipefail

BASE_SHA="${MERGE_GROUP_BASE_SHA:-}"
HEAD_SHA="${MERGE_GROUP_HEAD_SHA:-}"
CURRENT_SHA="${CURRENT_SHA:-}"
# Bound each origin read to 120 seconds, with a 10-second termination grace.
# Validate the complete canonical decimal range before passing it to timeout;
# do not use shell arithmetic on an untrusted, potentially oversized value.
FETCH_TIMEOUT_SECONDS="${FETCH_TIMEOUT_SECONDS:-120}"
if [[ ! "${FETCH_TIMEOUT_SECONDS}" =~ ^([1-9]|[1-9][0-9]|1[01][0-9]|120)$ ]]; then
  echo "Fetch timeout must be a canonical decimal integer from 1 through 120." >&2
  exit 2
fi

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

fetch_main_history() {
  local mode="$1"
  local status=0
  local -a fetch_args=(fetch --no-tags origin refs/heads/main)
  if [[ -n "${mode}" ]]; then fetch_args=(fetch "${mode}" --no-tags origin refs/heads/main); fi
  if timeout --signal=TERM --kill-after=10s "${FETCH_TIMEOUT_SECONDS}s" git "${fetch_args[@]}" >/dev/null 2>&1; then
    return 0
  else
    status=$?
  fi
  if [[ "${status}" -eq 124 || "${status}" -eq 137 ]]; then
    echo "Timed out after ${FETCH_TIMEOUT_SECONDS}s fetching merge-group base history from origin." >&2
  else
    echo "Could not fetch merge-group base history from origin (exit ${status})." >&2
  fi
  exit 1
}

git cat-file -e "${HEAD_SHA}^{commit}"
if ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
  if [[ "$(git rev-parse --is-shallow-repository)" == "true" ]]; then
    fetch_main_history --unshallow
  else
    fetch_main_history
  fi
fi
git cat-file -e "${BASE_SHA}^{commit}"
git merge-base --is-ancestor "${BASE_SHA}" "${HEAD_SHA}" || {
  echo "Merge-group base is not an ancestor of its checked-out head." >&2
  exit 1
}

git diff --name-only "${BASE_SHA}" "${HEAD_SHA}"
