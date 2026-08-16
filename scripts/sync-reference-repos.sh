#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
REPOS_DIR="$PROJECT_ROOT/.repos"

mkdir -p "$REPOS_DIR"

sync_repo() {
  local name="$1"
  local url="$2"
  local destination="$REPOS_DIR/$name"

  if [[ ! -e "$destination" ]]; then
    git clone -- "$url" "$destination"
    return
  fi

  if [[ ! -d "$destination/.git" ]]; then
    printf 'error: %s exists but is not a Git repository\n' "$destination" >&2
    return 1
  fi

  local actual_url
  actual_url="$(git -C "$destination" remote get-url origin)"
  if [[ "$actual_url" != "$url" ]]; then
    printf 'error: %s has origin %s; expected %s\n' \
      "$destination" "$actual_url" "$url" >&2
    return 1
  fi

  if [[ -n "$(git -C "$destination" status --porcelain)" ]]; then
    printf 'error: %s has local changes; preserve or discard before syncing\n' \
      "$destination" >&2
    return 1
  fi

  git -C "$destination" pull --ff-only --prune
}

sync_repo "pi" "https://github.com/earendil-works/pi.git"
sync_repo "opencode" "https://github.com/anomalyco/opencode.git"
