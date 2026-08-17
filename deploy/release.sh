#!/usr/bin/env bash
set -euo pipefail
umask 027

deployment_root="${FLUE_DEPLOYMENT_ROOT:-/srv/flue-agent}"
release_root="$deployment_root/releases"
mirror="$deployment_root/source.git"
current_link="$deployment_root/current"
previous_link="$deployment_root/previous"
release_config="$deployment_root/secrets/release.env"
deployment_log="$deployment_root/state/deployments.jsonl"
lock_file="${FLUE_DEPLOY_LOCK_FILE:-/run/lock/flue-agent-deploy.lock}"

install -d -m 0750 "$deployment_root/secrets" "$release_root" "$deployment_root/state"
if [[ "${FLUE_DEPLOY_LOCK_HELD:-0}" != 1 ]]; then
  exec 9>"$lock_file"
  if ! flock -n 9; then echo 'Another Flue deployment or cutover is already running.' >&2; exit 1; fi
fi

if [[ -f "$release_config" ]]; then
  # shellcheck disable=SC1090
  source "$release_config"
fi
health_url="${FLUE_HEALTH_URL:-http://127.0.0.1:3210/healthz}"
release_command="${FLUE_RELEASE_COMMAND_PATH:-/usr/local/sbin/flue-agent-release}"

main() {
command="${1:-${FLUE_GIT_REF:-main}}"
case "$command" in
  --status)
    printf 'current:  %s\n' "$(readlink "$current_link" 2>/dev/null || echo none)"
    printf 'previous: %s\n' "$(readlink "$previous_link" 2>/dev/null || echo none)"
    if [[ -f "$deployment_log" ]]; then tail -n 10 "$deployment_log"; fi
    exit 0
    ;;
  --rollback)
    target="$(readlink "$previous_link" 2>/dev/null || true)"
    commit="$(validate_release "$target")"
    deploy_release "$target" "$commit" rollback
    exit 0
    ;;
  --*)
    echo "usage: $0 [git-ref|--rollback|--status]" >&2
    exit 2
    ;;
esac

git_url="${FLUE_GIT_URL:-}"
if [[ -z "$git_url" ]]; then
  echo "FLUE_GIT_URL is required; configure it in $release_config" >&2
  exit 2
fi

if [[ ! -d "$mirror" ]]; then
  temporary_mirror="${mirror}.creating.$$"
  trap 'rm -rf -- "$temporary_mirror"' EXIT
  git clone --mirror "$git_url" "$temporary_mirror"
  mv "$temporary_mirror" "$mirror"
  trap - EXIT
else
  configured_url="$(git --git-dir="$mirror" remote get-url origin)"
  if [[ "$configured_url" != "$git_url" ]]; then
    echo 'Configured Git URL does not match the existing deployment mirror.' >&2
    exit 1
  fi
fi

git --git-dir="$mirror" fetch --force --prune --tags origin "$command"
commit="$(git --git-dir="$mirror" rev-parse --verify 'FETCH_HEAD^{commit}')"
if [[ "${FLUE_REQUIRE_SIGNED_COMMITS:-0}" == 1 ]]; then
  git --git-dir="$mirror" verify-commit "$commit"
fi

target="$release_root/$commit"
if [[ -e "$target" ]]; then
  validate_release "$target" >/dev/null
else
  if ! git --git-dir="$mirror" worktree add --detach "$target" "$commit"; then
    git --git-dir="$mirror" worktree remove --force "$target" >/dev/null 2>&1 || true
    rm -rf -- "$target"
    exit 1
  fi
fi

deploy_release "$target" "$commit" deploy
prune_releases || echo 'Warning: release retention cleanup failed.' >&2
}

validate_release() {
  local target="${1:-}"
  local name
  name="$(basename "$target")"
  if [[ ! "$name" =~ ^[0-9a-f]{40}$ ]] || [[ "$target" != "$release_root/$name" ]] || [[ ! -d "$target" ]]; then
    echo 'No valid previous immutable release is available.' >&2
    return 1
  fi
  local actual
  actual="$(git -C "$target" rev-parse --verify HEAD)"
  if [[ "$actual" != "$name" ]]; then
    echo "Release checkout does not match its commit identity: $target" >&2
    return 1
  fi
  if [[ -n "$(git -C "$target" status --porcelain=v1 --untracked-files=all)" ]]; then
    echo "Release checkout is not clean: $target" >&2
    return 1
  fi
  printf '%s\n' "$name"
}

deploy_release() {
  local target="$1"
  local commit="$2"
  local operation="$3"
  local old_target old_commit
  old_target="$(readlink "$current_link" 2>/dev/null || true)"
  old_commit=''
  if [[ -n "$old_target" ]]; then
    if ! old_commit="$(validate_release "$old_target")"; then
      echo 'The current release pointer is invalid; refusing to replace an unknown deployment.' >&2
      return 1
    fi
  fi

  if ! FLUE_DEPLOY_LOCK_HELD=1 RELEASE_ID="$commit" "$target/deploy/install.sh"; then
    record_deployment failed "$operation" "$commit" "$old_commit"
    return 1
  fi

  local running_release
  if ! running_release="$(curl --fail --silent --show-error "$health_url" | jq -r '.release // empty')"; then
    running_release=''
  fi
  if [[ "$running_release" != "$commit" ]]; then
    echo "Release identity mismatch: expected $commit, running ${running_release:-unknown}" >&2
    if [[ -n "$old_target" && -x "$old_target/deploy/install.sh" && -n "$old_commit" ]]; then
      FLUE_DEPLOY_LOCK_HELD=1 RELEASE_ID="$old_commit" "$old_target/deploy/install.sh" || true
    fi
    record_deployment failed "$operation" "$commit" "$old_commit"
    return 1
  fi

  if ! install -m 0755 "$target/deploy/release.sh" "$release_command"; then
    echo "Could not install the release command at $release_command" >&2
    if [[ -n "$old_target" && -x "$old_target/deploy/install.sh" ]]; then
      FLUE_DEPLOY_LOCK_HELD=1 RELEASE_ID="$old_commit" "$old_target/deploy/install.sh" || true
    fi
    record_deployment failed "$operation" "$commit" "$old_commit"
    return 1
  fi

  if [[ -n "$old_target" && "$old_target" != "$target" && "$old_target" == "$release_root/"* ]]; then
    atomic_link "$old_target" "$previous_link"
  fi
  atomic_link "$target" "$current_link"
  printf '%s\n' "$commit" > "${deployment_root}/state/active-release.tmp.$$"
  chmod 0600 "${deployment_root}/state/active-release.tmp.$$"
  mv "${deployment_root}/state/active-release.tmp.$$" "${deployment_root}/state/active-release"
  record_deployment succeeded "$operation" "$commit" "$old_commit"
  printf 'Activated release %s (%s).\n' "$commit" "$operation"
}

atomic_link() {
  local target="$1"
  local link="$2"
  local temporary="${link}.next.$$"
  ln -s "$target" "$temporary"
  if mv -Tf "$temporary" "$link" 2>/dev/null; then return; fi
  # BSD mv has no -T. Production uses GNU's atomic replacement; this fallback
  # keeps bootstrap/status tooling portable on BSD/macOS.
  rm -f "$link"
  mv -f "$temporary" "$link"
}

record_deployment() {
  local status="$1"
  local operation="$2"
  local commit="$3"
  local previous="$4"
  touch "$deployment_log"
  chmod 0600 "$deployment_log"
  printf '{"time":"%s","status":"%s","operation":"%s","commit":"%s","previous":"%s"}\n' \
    "$(date -u +%FT%TZ)" "$status" "$operation" "$commit" "$previous" >> "$deployment_log"
}

prune_releases() {
  local keep="${FLUE_KEEP_RELEASES:-5}"
  if [[ "$keep" == 0 ]]; then return; fi
  if [[ ! "$keep" =~ ^[1-9][0-9]*$ ]]; then echo 'FLUE_KEEP_RELEASES must be zero or a positive integer.' >&2; return 1; fi
  local current previous count path name
  current="$(readlink "$current_link" 2>/dev/null || true)"
  previous="$(readlink "$previous_link" 2>/dev/null || true)"
  count=0
  while IFS= read -r path; do
    name="$(basename "$path")"
    [[ "$name" =~ ^[0-9a-f]{40}$ ]] || continue
    count=$((count + 1))
    if (( count <= keep )) || [[ "$path" == "$current" || "$path" == "$previous" ]]; then continue; fi
    git --git-dir="$mirror" worktree remove --force "$path"
  done < <(find "$release_root" -mindepth 1 -maxdepth 1 -type d -print0 | xargs -0 stat -c '%Y %n' | sort -rn | cut -d' ' -f2-)
  git --git-dir="$mirror" worktree prune
}

main "$@"
