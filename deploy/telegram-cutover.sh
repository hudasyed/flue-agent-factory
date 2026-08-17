#!/usr/bin/env bash
set -euo pipefail

exec 9>/run/lock/flue-agent-deploy.lock
if ! flock -n 9; then echo 'Another Flue deployment or cutover is already running.' >&2; exit 1; fi

mode="${1:-}"
case "$mode" in
  polling|disabled) ;;
  *) echo "usage: $0 polling|disabled" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
state=/srv/flue-agent/secrets/deployment.env
if [[ ! -f "$state" ]]; then echo "Missing $state" >&2; exit 2; fi
set -a
# shellcheck disable=SC1090
source "$state"
set +a
compose=(docker compose --env-file "$state" -f "$root/deploy/compose.yml")

write_mode() {
  local value="$1"
  local temporary="${state}.tmp.$$"
  awk -v replacement="TELEGRAM_MODE=$value" '
    BEGIN { replaced = 0 }
    /^[[:space:]]*TELEGRAM_MODE=/ {
      if (!replaced) print replacement
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) print replacement }
  ' "$state" > "$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$state"
}

gateway_service() {
  local container="${REPLACED_GATEWAY_CONTAINER:-}"
  local profile="${REPLACED_GATEWAY_PROFILE:-}"
  if [[ -z "$container" && -z "$profile" ]]; then return 1; fi
  if [[ ! "$container" =~ ^[a-zA-Z0-9_.-]+$ || ! "$profile" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
    echo 'REPLACED_GATEWAY_CONTAINER and REPLACED_GATEWAY_PROFILE must both be valid names.' >&2
    return 2
  fi
  printf '/run/service/gateway-%s\n' "$profile"
}

restore_replaced_gateway() {
  local service
  if ! service="$(gateway_service)"; then
    if [[ -z "${REPLACED_GATEWAY_CONTAINER:-}" && -z "${REPLACED_GATEWAY_PROFILE:-}" ]]; then return; fi
    return 1
  fi
  docker exec "$REPLACED_GATEWAY_CONTAINER" sh -c 'rm -f "$1/down"; /command/s6-svc -u "$1"' -- "$service"
}

if [[ "$mode" == disabled ]]; then
  write_mode disabled
  "${compose[@]}" up -d app
  restore_replaced_gateway
  echo 'Flue polling is disabled; the configured replacement gateway was restored if present.'
  exit 0
fi

status="$(curl --fail --silent --show-error http://127.0.0.1:3210/api/status)"
if [[ "$(jq -r '.openai.status' <<<"$status")" != connected ]]; then
  echo 'OpenAI device authorization is not connected; refusing Telegram cutover.' >&2
  exit 1
fi
if [[ "$(jq -r '.telegram.mode' <<<"$status")" != disabled ]]; then
  echo 'Flue must be staged in disabled Telegram mode before cutover.' >&2
  exit 1
fi

rollback() {
  echo 'Cutover failed; restoring the replacement gateway and disabling Flue polling.' >&2
  write_mode disabled || true
  "${compose[@]}" up -d app >/dev/null 2>&1 || true
  restore_replaced_gateway >/dev/null 2>&1 || true
}
trap rollback ERR

write_mode polling
"${compose[@]}" up -d app
for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:3210/readyz >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent http://127.0.0.1:3210/readyz >/dev/null
status="$(curl --fail --silent --show-error http://127.0.0.1:3210/api/status)"
if [[ "$(jq -r '.telegram.mode' <<<"$status")" != polling ]] \
  || [[ "$(jq -r '.telegram.polling.status' <<<"$status")" != running ]]; then
  echo 'Flue did not enter a healthy Telegram polling state.' >&2
  exit 1
fi
if service="$(gateway_service)"; then
  docker exec "$REPLACED_GATEWAY_CONTAINER" test -f "$service/down"
elif [[ -n "${REPLACED_GATEWAY_CONTAINER:-}" || -n "${REPLACED_GATEWAY_PROFILE:-}" ]]; then
  exit 1
fi
trap - ERR
echo 'Telegram cut over: Flue polling is active and the configured replacement gateway is down if present.'
