#!/usr/bin/env bash
set -euo pipefail

unset $(git rev-parse --local-env-vars)
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPOS_DIR="$PROJECT_ROOT/.repos"

# Linked worktrees symlink each reference to the main checkout's clone instead
# of cloning their own copy. Bare repositories have no main checkout to share.
BASE_REPOS_DIR="$REPOS_DIR"
if [[ "$(git -C "$PROJECT_ROOT" rev-parse --path-format=absolute --git-dir)" != "$(git -C "$PROJECT_ROOT" rev-parse --path-format=absolute --git-common-dir)" ]]; then
  main_root="$(git -C "$PROJECT_ROOT" worktree list --porcelain | awk '
    NR == 1 { root = substr($0, 10) }
    NR == 2 && $0 == "bare" { bare = 1 }
    END { if (!bare) print root }
  ')"
  if [[ -n "$main_root" ]]; then
    BASE_REPOS_DIR="$main_root/.repos"
  fi
fi

mkdir -p "$REPOS_DIR" "$BASE_REPOS_DIR"

# Worktree hooks can run concurrently against the shared base clones.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$BASE_REPOS_DIR/.sync.lock"
  flock 9
fi

update_clone() {
  local url="$1"
  local destination="$2"

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

link_clone() {
  local target="$1"
  local link="$2"

  if [[ -L "$link" ]]; then
    if [[ "$(readlink -- "$link")" == "$target" ]]; then
      return
    fi
    rm -- "$link"
  elif [[ -e "$link" ]]; then
    printf 'error: %s is a separate clone; remove it to share %s\n' \
      "$link" "$target" >&2
    return 1
  fi

  ln -s -- "$target" "$link"
}

sync_repo() {
  local name="$1"
  local url="$2"

  update_clone "$url" "$BASE_REPOS_DIR/$name"
  if [[ "$BASE_REPOS_DIR" != "$REPOS_DIR" ]]; then
    link_clone "$BASE_REPOS_DIR/$name" "$REPOS_DIR/$name"
  fi
}

sync_repo "pi" "https://github.com/earendil-works/pi.git"
sync_repo "opencode" "https://github.com/anomalyco/opencode.git"
sync_repo "codex" "https://github.com/openai/codex.git"
sync_repo "oh-my-pi" "https://github.com/can1357/oh-my-pi.git"
