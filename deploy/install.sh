#!/usr/bin/env bash
set -euo pipefail

if [[ "${FLUE_DEPLOY_LOCK_HELD:-0}" != 1 ]]; then
  exec 9>/run/lock/flue-agent-deploy.lock
  if ! flock -n 9; then echo 'Another Flue deployment or cutover is already running.' >&2; exit 1; fi
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
deployment_env=/srv/flue-agent/secrets/deployment.env
compose=(docker compose --env-file "$deployment_env" -f "$root/deploy/compose.yml")
install -d -m 0750 /srv/flue-agent/secrets /srv/flue-agent/tasks /srv/flue-agent/state /srv/flue-agent/repositories /srv/flue-agent/ssh
install -d -m 0755 /etc/flue-agent
if [[ ! -f "$deployment_env" ]]; then
  echo "Missing $deployment_env; copy .env.example there and configure it before deployment." >&2
  exit 2
fi
set -a
# shellcheck disable=SC1090
source "$deployment_env"
set +a

required_environment=(
  TELEGRAM_OWNER_USER_ID LAN_IPV4_PREFIXES BWS_ACCESS_TOKEN BWS_PROJECT_ID
  BWS_HOST_BINARY_PATH BWS_TELEGRAM_SECRET_KEY BWS_MINIMAX_SECRET_KEY
  BWS_DATABASE_SECRET_KEY BWS_TELEGRAM_WEBHOOK_SECRET_KEY
  DASHBOARD_LAN_INTERFACE DASHBOARD_LAN_CIDR
)
for name in "${required_environment[@]}"; do
  if [[ -z "${!name:-}" ]]; then echo "$name is required in $deployment_env" >&2; exit 2; fi
done
if [[ ! "$DASHBOARD_LAN_INTERFACE" =~ ^[a-zA-Z0-9_.:-]+$ ]]; then
  echo 'DASHBOARD_LAN_INTERFACE contains invalid characters.' >&2
  exit 2
fi
if [[ ! "$DASHBOARD_LAN_CIDR" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]]; then
  echo 'DASHBOARD_LAN_CIDR must be an IPv4 CIDR.' >&2
  exit 2
fi
if [[ -n "${INFRA_SSH_TARGETS:-}" ]]; then
  if [[ -z "${INFRA_SSH_CONFIG_SOURCE:-}" || ! -f "$INFRA_SSH_CONFIG_SOURCE" ]]; then
    echo 'INFRA_SSH_CONFIG_SOURCE must name a root-owned SSH config when infrastructure targets are enabled.' >&2
    exit 2
  fi
  install -m 0600 "$INFRA_SSH_CONFIG_SOURCE" /srv/flue-agent/ssh/config
fi

firewall_tmp="$(mktemp /etc/flue-agent/firewall.nft.XXXXXX)"
trap 'rm -f -- "$firewall_tmp"' EXIT
printf '%s\n' \
  'table inet flue_agent_firewall {' \
  '  chain input {' \
  '    type filter hook input priority -9; policy accept;' \
  "    iifname \"$DASHBOARD_LAN_INTERFACE\" ip saddr $DASHBOARD_LAN_CIDR tcp dport 3210 accept" \
  "    iifname \"$DASHBOARD_LAN_INTERFACE\" tcp dport 3210 drop" \
  '  }' \
  '}' > "$firewall_tmp"
/usr/sbin/nft -c -f "$firewall_tmp"
install -m 0644 "$firewall_tmp" /etc/flue-agent/firewall.nft
rm -f -- "$firewall_tmp"
trap - EXIT

install -m 0644 "$root/deploy/flue-agent-firewall.service" /etc/systemd/system/flue-agent-firewall.service
systemctl daemon-reload
systemctl enable flue-agent-firewall.service
systemctl reload-or-restart flue-agent-firewall.service
"${compose[@]}" config --quiet

had_app=0
had_workspace=0
previous_release=local
if docker image inspect flue-agent-factory:local >/dev/null 2>&1; then
  docker image tag flue-agent-factory:local flue-agent-factory:rollback
  had_app=1
fi
if docker container inspect flue-agent-factory >/dev/null 2>&1; then
  detected_release="$(docker container inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' flue-agent-factory 2>/dev/null || true)"
  if [[ -n "$detected_release" && "$detected_release" != '<no value>' ]]; then previous_release="$detected_release"; fi
fi
if docker image inspect flue-agent-workspace:local >/dev/null 2>&1; then
  docker image tag flue-agent-workspace:local flue-agent-workspace:rollback
  had_workspace=1
fi

activated=0
smoke_dir=''
rollback() {
  echo 'Deployment failed; restoring the last known-good images.' >&2
  if [[ -n "$smoke_dir" && -d "$smoke_dir" ]]; then
    rm -f "$smoke_dir/workspace-ready" || true
    rmdir "$smoke_dir" || true
  fi
  "${compose[@]}" logs --tail=100 app >&2 || true
  if [[ "$had_app" == 1 ]]; then docker image tag flue-agent-factory:rollback flue-agent-factory:local || true; fi
  if [[ "$had_workspace" == 1 ]]; then docker image tag flue-agent-workspace:rollback flue-agent-workspace:local || true; fi
  if [[ "$activated" == 1 && "$had_app" == 1 ]]; then
    RELEASE_ID="$previous_release" "${compose[@]}" --profile rollback up -d --force-recreate workspace app >/dev/null 2>&1 || true
  fi
}
trap rollback ERR

"${compose[@]}" --profile image build workspace-image app
smoke_dir="$(mktemp -d /srv/flue-agent/tasks/.workspace-smoke.XXXXXX)"
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m --tmpfs /root:rw,nosuid,nodev,size=64m \
  --pids-limit 64 --memory 512m --cpus 1 --workdir "$smoke_dir" \
  --volume "$smoke_dir:$smoke_dir:rw" flue-agent-workspace:local \
  bash -lc 'node --version >/dev/null && git --version >/dev/null && python3 --version >/dev/null && rg --version >/dev/null && test ! -e /srv/flue-agent/repositories && printf ready > workspace-ready'
test "$(<"$smoke_dir/workspace-ready")" = ready
rm -f "$smoke_dir/workspace-ready"
rmdir "$smoke_dir"

activated=1
"${compose[@]}" up -d app
for _ in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:3210/readyz >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent --show-error http://127.0.0.1:3210/readyz >/dev/null
docker rm -f flue-workspace >/dev/null 2>&1 || true
"${compose[@]}" ps
trap - ERR
