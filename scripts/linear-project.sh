#!/usr/bin/env bash
# Puts the Linear issue that Linear's GitHub Issues sync created for a GitHub issue into the Linear project
# LINEAR_PROJECT (docs/agents/issue-tracker.md): the sync copies GitHub issues into the team, but in no project. Waits
# for the copy (the issue whose sync attachment, `sourceType` github, is the GitHub URL) up to WAIT_SECONDS, then sets
# the project only when the issue has none, so a project someone already chose is kept. Retries Linear's errors, each
# step up to WAIT_SECONDS, but a rejected key, which no retry fixes. Exits 0 when nothing is left to do (set, or kept), 1
# otherwise.
# Usage: LINEAR_API_KEY=… LINEAR_PROJECT=<project id> ISSUE_URL=https://github.com/<owner>/<repo>/issues/<n> \
#   [WAIT_SECONDS=600] scripts/linear-project.sh
set -euo pipefail

key="${LINEAR_API_KEY:?LINEAR_API_KEY is required}"
project="${LINEAR_PROJECT:?LINEAR_PROJECT is required}"
url="${ISSUE_URL:?ISSUE_URL is required}"
wait_seconds="${WAIT_SECONDS:-600}"
deadline=$((SECONDS + wait_seconds))

# Exit statuses of `graphql` and the steps built on it.
readonly FAILED=1 KEY_REJECTED=2

# One GraphQL request; `$1` is the document, `$2` its variables as JSON. Prints `.data`; fails with KEY_REJECTED when
# Linear rejects the key, and with FAILED on any other error.
graphql() {
  local response http_code body
  response="$(
    jq -n --arg query "$1" --argjson variables "$2" '{query: $query, variables: $variables}' |
      curl -sS --max-time 20 -w '\n%{http_code}' https://api.linear.app/graphql \
        -H "Content-Type: application/json" \
        -H "Authorization: $key" \
        --data-binary @-
  )" || return "$FAILED"
  http_code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  case "$http_code" in
  401 | 403)
    echo "Linear rejected LINEAR_API_KEY (HTTP $http_code)." >&2
    return "$KEY_REJECTED"
    ;;
  2??) ;;
  *)
    echo "Linear answered HTTP $http_code." >&2
    return "$FAILED"
    ;;
  esac
  if jq -e '(.errors // []) | length > 0' <<<"$body" >/dev/null; then
    echo "Linear refused the request: $(jq -c '.errors' <<<"$body")" >&2
    return "$FAILED"
  fi
  jq -c '.data' <<<"$body"
}

# Runs `$@` until it succeeds; stops at once on KEY_REJECTED, and at the deadline with `$1`'s name in the message.
until_deadline() {
  local result
  while true; do
    result=0
    "$@" || result=$?
    if [ "$result" -eq 0 ]; then return 0; fi
    if [ "$result" -eq "$KEY_REJECTED" ]; then exit 1; fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "$1 did not succeed within ${wait_seconds}s." >&2
      exit 1
    fi
    sleep 15
  done
}

# The synced copy of the GitHub issue, as `{id, identifier, project}` in $issue; fails while there is none yet.
find_issue() {
  # shellcheck disable=SC2016 # GraphQL variables, not shell ones.
  issue="$(
    graphql 'query($url: String!) { attachmentsForURL(url: $url) { nodes { sourceType issue { id identifier project { name } } } } }' \
      "$(jq -n --arg url "$url" '{url: $url}')" |
      jq -c '.attachmentsForURL.nodes | map(select(.sourceType == "github") | .issue) | first // empty'
  )" || return
  if [ -z "$issue" ]; then
    echo "No synced Linear issue carries $url yet." >&2
    return "$FAILED"
  fi
}

set_project() {
  local data
  # shellcheck disable=SC2016 # GraphQL variables, not shell ones.
  data="$(
    graphql 'mutation($id: String!, $project: String!) { issueUpdate(id: $id, input: {projectId: $project}) { success } }' \
      "$(jq -n --arg id "$(jq -r '.id' <<<"$issue")" --arg project "$project" '{id: $id, project: $project}')"
  )" || return
  if ! jq -e '.issueUpdate.success' <<<"$data" >/dev/null; then
    echo "Linear did not move $(jq -r '.identifier' <<<"$issue") into the project." >&2
    return "$FAILED"
  fi
}

issue=""
until_deadline find_issue

identifier="$(jq -r '.identifier' <<<"$issue")"
current="$(jq -r '.project.name // empty' <<<"$issue")"
if [ -n "$current" ]; then
  echo "$identifier is already in project $current; kept."
  exit 0
fi

deadline=$((SECONDS + wait_seconds))
until_deadline set_project
echo "$identifier ($url) is now in project $project."
