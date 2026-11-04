#!/usr/bin/env bash
# Ships this checkout to the VM, rebuilds and restarts the service, and waits until the new revision answers over
# HTTPS. Used by ./deploy.sh and by GitHub Actions (.github/workflows/ci-cd.yml). It doesn't touch the VM's settings:
# deploy/app.env and deploy/site.env are written there by ./deploy.sh.
#
#   SSH_KEY=<private key> SSH_KNOWN_HOSTS=<file> ORIGIN=https://… AGENT_ID=<id> REVISION=<git sha> deploy/ship.sh <vm-ip>

set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${1:?usage: deploy/ship.sh <vm-ip>}"
: "${SSH_KEY:?}" "${SSH_KNOWN_HOSTS:?}" "${ORIGIN:?}" "${AGENT_ID:?}"
REVISION="${REVISION:-unknown}"
[[ "$REVISION" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Bad REVISION: $REVISION" >&2; exit 1; }
REMOTE=/opt/grid-maker/app
# accept-new on your computer; GitHub Actions passes SSH_STRICT=yes with the VM's known host key.
SSH_OPTS=(-i "$SSH_KEY" -o UserKnownHostsFile="$SSH_KNOWN_HOSTS" -o StrictHostKeyChecking="${SSH_STRICT:-accept-new}"
  -o ConnectTimeout=10 -o BatchMode=yes)

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
remote() { ssh "${SSH_OPTS[@]}" "ubuntu@$HOST" "$@"; }

step "Making sure the VM has Docker, its firewall rules and key-only SSH"
remote "sudo bash -s" < deploy/bootstrap.sh
remote "test -f $REMOTE/deploy/app.env && test -f $REMOTE/deploy/site.env" ||
  { echo "The VM has no deploy/app.env yet: run ./deploy.sh once from your computer." >&2; exit 1; }

step "Copying revision $REVISION"
rsync -az --delete --exclude-from=deploy/rsync-exclude -e "ssh ${SSH_OPTS[*]}" ./ "ubuntu@$HOST:$REMOTE/"

step "Building and restarting"
remote "cd $REMOTE/deploy && sudo env APP_REVISION=$REVISION docker compose up -d --build --remove-orphans && sudo docker image prune -f >/dev/null"

step "Waiting for $ORIGIN to serve revision $REVISION"
for _ in $(seq 1 40); do
  if curl -fsS --max-time 10 "$ORIGIN/" 2>/dev/null | grep "\"revision\":\"$REVISION\"" >/dev/null &&
     curl -fsS --max-time 10 "$ORIGIN/.well-known/stellar-agent-services.json" 2>/dev/null |
       grep -E "\"agentId\": *$AGENT_ID([^0-9]|\$)" >/dev/null; then
    printf '  \033[32m✓\033[0m live: %s (revision %s)\n' "$ORIGIN" "$REVISION"
    exit 0
  fi
  sleep 6
done
echo "$ORIGIN doesn't serve revision $REVISION with agent $AGENT_ID after 4 minutes. Containers:" >&2
remote "cd $REMOTE/deploy && sudo docker compose ps" >&2 || true
echo "Run ./deploy.sh logs on your computer to see why." >&2
exit 1
