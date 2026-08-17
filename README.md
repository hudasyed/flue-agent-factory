# Flue Agent Factory

A private Flue software factory with an owner-only Telegram front door and LAN-only status UI.

## Runtime shape

- Orchestrator: MiniMax M3, high reasoning.
- Researcher subagent: MiniMax M3, high reasoning.
- Developer and Operator subagents: GPT-5.6 Luna, xhigh reasoning through OpenAI subscription OAuth.
- Reviewer subagent: GPT-5.6 Sol, medium reasoning; the only role allowed to request promotion or infrastructure execution.
- PostgreSQL: Flue durability plus application-owned sessions, tasks, Telegram deduplication, and approvals.
- Workspace execution: one resource-limited Docker container per command, with only that session mounted and no application secrets or source-repository mounts.
- Change promotion: standalone task checkout, committed-state review fingerprint, owner approval, clean-source preflight, and rollback on merge failure.

## Telegram

The default deployment uses grammY long polling and does not require public ingress. The same application includes Flue's verified Telegram webhook channel and can switch with `TELEGRAM_MODE=webhook` once `PUBLIC_TELEGRAM_WEBHOOK_URL` is available.

Commands: `/new`, `/sessions`, `/switch`, `/status`, `/cancel`, `/help`.

## Local verification

```sh
npm ci
npm test
npm run check
npm run build
```

The tests cover credential persistence, isolated checkout creation, review invalidation (including untracked content), symlink write confinement, and reviewed promotion.

Copy [.env.example](.env.example) to an ignored `.env` for local use, or to `/srv/flue-agent/secrets/deployment.env` for the host deployment. It documents the Telegram owner, LAN, Bitwarden, firewall, SSH, and resource settings. OpenAI subscription authorization is initiated from the LAN dashboard.

## Deployment

The reference deployment uses `/srv/flue-agent`. Secrets are resolved from a configured Bitwarden Secrets Manager project at process startup; raw values are not stored in this repository. Trusted review metadata lives under `/srv/flue-agent/state`, outside agent workspace mounts. The dashboard listens on port `3210`; both the application and nftables restrict it to the LAN ranges configured in `deployment.env`. Docker bridge ranges are deliberately not trusted by default.

Deployments are Git-native; application directories are not copied to the server. `deploy/release.sh` fetches an exact commit into `/srv/flue-agent/releases/<commit>`, checks that the checkout is clean, optionally verifies its signature, activates it through `/srv/flue-agent/current`, and retains `/srv/flue-agent/previous` for rollback. Every attempt is recorded in `/srv/flue-agent/state/deployments.jsonl`.

For the one-time bootstrap, clone the Git repository on the host, install and edit both environment files, then invoke the release manager from that checkout. Use a root-owned SSH deploy key or another non-interactive Git credential for private repositories.

```sh
sudo install -d -m 0750 /srv/flue-agent/secrets
sudo install -m 0600 .env.example /srv/flue-agent/secrets/deployment.env
sudo install -m 0600 deploy/release.env.example /srv/flue-agent/secrets/release.env
sudoedit /srv/flue-agent/secrets/deployment.env
sudoedit /srv/flue-agent/secrets/release.env
sudo ./deploy/release.sh main
```

If infrastructure tools are enabled, store their SSH configuration outside the repository and set `INFRA_SSH_CONFIG_SOURCE` and `INFRA_SSH_TARGETS`. [deploy/ssh-config.example](deploy/ssh-config.example) shows the required strict host-key settings.

The successful bootstrap installs `flue-agent-release` into `/usr/local/sbin`. Normal releases, including CI-triggered releases, require only a small SSH command; no source files travel over SSH:

```sh
sudo flue-agent-release main             # configured branch
sudo flue-agent-release v1.2.3           # tag
sudo flue-agent-release <full-commit>     # exact commit
sudo flue-agent-release --status
sudo flue-agent-release --rollback
```

The outer release manager provides immutable Git provenance and release rollback. Its inner `deploy/install.sh` layer runs tests, typechecking, the production build, Compose validation, a restricted workspace-container smoke test, readiness checks, and automatic image rollback. `/healthz` reports the running commit; `/readyz` additionally checks PostgreSQL and, in polling mode, confirms that Telegram polling actually started. Concurrent deploys and Telegram cutovers share the same host lock.

This hardening release deliberately refuses startup if it finds an older session containing shared-git `.factory` metadata. Finish or archive those legacy task directories before deployment; the installer will keep the prior image running instead of silently trusting or converting an old approval.

The four Bitwarden secret names are configured through `BWS_TELEGRAM_SECRET_KEY`, `BWS_MINIMAX_SECRET_KEY`, `BWS_DATABASE_SECRET_KEY`, and `BWS_TELEGRAM_WEBHOOK_SECRET_KEY`. The runtime machine account only needs read access.

Deployment stages with `TELEGRAM_MODE=disabled`, so it cannot contend with Hermes for the bot token. After the dashboard reports OpenAI as connected, cut over with:

```sh
sudo /srv/flue-agent/current/deploy/telegram-cutover.sh polling
```

The cutover helper verifies OpenAI auth, optionally disables a configured s6-managed replacement gateway, starts Flue polling, and rolls back automatically if Flue does not become healthy. Manual rollback is:

```sh
sudo /srv/flue-agent/current/deploy/telegram-cutover.sh disabled
```
