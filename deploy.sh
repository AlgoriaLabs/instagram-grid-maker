#!/usr/bin/env bash
# One command to take Instagram Grid Maker live on Stellar mainnet, hosted free on Oracle Cloud's Always Free tier.
#
#   ./deploy.sh              provision (Terraform), register (your wallet, first time only), build and start, check
#   ./deploy.sh --no-open    same, printing the wallet approval link instead of opening a browser
#   ./deploy.sh status       where the service stands (provider-kit status)
#   ./deploy.sh logs         follow the service's logs on the VM
#   ./deploy.sh ssh          a shell on the VM
#   ./deploy.sh destroy      delete the VM and its network (the registration on chain stays)
#
# Safe to run again: Terraform changes only what differs, `provider-kit launch` signs nothing once the registration is
# in place, and the app is rebuilt from your current code. No Stellar secret key is used or stored anywhere: the one-time
# registration is approved in your own wallet.

set -euo pipefail
cd "$(dirname "$0")"

TF=deploy/terraform
SECRETS=deploy/.secrets
KEY="$SECRETS/id_ed25519"
OCI_CONFIG="${OCI_CONFIG_FILE:-$HOME/.oci/config}"
PROFILE="${OCI_PROFILE:-DEFAULT}"
REMOTE=/opt/grid-maker/app

bold() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# A value from .env, without surrounding quotes.
envget() { { grep -E "^$1=" .env 2>/dev/null || true; } | tail -1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
# A key from the profile's section of ~/.oci/config.
ociget() {
  awk -v section="[$PROFILE]" -v key="$1" '
    $0 == section { inside = 1; next }
    /^\[/ { inside = 0 }
    inside { split($0, kv, "="); k = kv[1]; gsub(/[ \t\r]/, "", k); if (k == key) { v = substr($0, index($0, "=") + 1); gsub(/^[ \t]+|[ \t\r]+$/, "", v); print v; exit } }
  ' "$OCI_CONFIG"
}

tf() { terraform -chdir="$TF" "$@"; }
tf_out() { tf output -raw "$1" 2>/dev/null; }
ssh_vm() { ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$SECRETS/known_hosts" -o ConnectTimeout=10 -o BatchMode=yes "ubuntu@$(tf_out public_ip)" "$@"; }

export_tf_vars() {
  [ -f "$OCI_CONFIG" ] || die "No $OCI_CONFIG. Create an Oracle Cloud API key first: see README.md, \"Oracle Cloud account\"."
  TF_VAR_tenancy_ocid="$(ociget tenancy)"
  TF_VAR_region="${OCI_REGION:-$(ociget region)}"
  [ -n "$TF_VAR_tenancy_ocid" ] || die "No tenancy= in the [$PROFILE] profile of $OCI_CONFIG."
  [ -n "$TF_VAR_region" ] || die "No region= in the [$PROFILE] profile of $OCI_CONFIG."
  TF_VAR_oci_profile="$PROFILE"
  TF_VAR_ssh_public_key="$(cat "$KEY.pub" 2>/dev/null || true)"
  export TF_VAR_tenancy_ocid TF_VAR_region TF_VAR_oci_profile TF_VAR_ssh_public_key
}

case "${1:-}" in
  status)
    exec npx provider-kit status --url "$(tf_out origin)" ;;
  logs)
    ssh_vm "cd $REMOTE/deploy && sudo docker compose logs -f --tail 200"; exit ;;
  ssh)
    ssh -i "$KEY" -o UserKnownHostsFile="$SECRETS/known_hosts" "ubuntu@$(tf_out public_ip)"; exit ;;
  destroy)
    export_tf_vars
    tf destroy
    echo "The VM is gone. The Stellar 8004 registration still names its old address: ./deploy.sh again re-registers a new one."
    exit ;;
  -*|"") ;;
  *) die "Unknown command: $1. Use ./deploy.sh [status|logs|ssh|destroy|--no-open]." ;;
esac

# ── 1. Preflight ────────────────────────────────────────────────────────────────────────────────────────────────────
bold "Checking this computer"
for tool in terraform node npm ssh ssh-keygen rsync curl; do
  command -v "$tool" >/dev/null || die "$tool is not installed."
done
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' || die "Node.js 22.13 or later is needed."
[ -f .env ] || cp .env.example .env
NETWORK="$(envget STELLAR_NETWORK)"; NETWORK="${NETWORK:-stellar:testnet}"
if [ "$NETWORK" = "stellar:pubnet" ] && [ -z "$(envget FACILITATOR_AUTH)" ]; then
  die "FACILITATOR_AUTH is empty in .env. Get a free key at https://channels.openzeppelin.com/gen and set FACILITATOR_AUTH=\"Bearer <key>\"."
fi
if [ "$NETWORK" = "stellar:pubnet" ] && [[ "$(envget FACILITATOR_AUTH)" != Bearer\ * ]]; then
  die "FACILITATOR_AUTH must start with \"Bearer \": set FACILITATOR_AUTH=\"Bearer <key>\" in .env."
fi
mkdir -p "$SECRETS" && chmod 700 "$SECRETS"
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C "instagram-grid-maker-deploy" -f "$KEY"
export_tf_vars
MY_IP="$(curl -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
if [[ "$MY_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then export TF_VAR_ssh_cidr="$MY_IP/32"; fi
ok "network $NETWORK, Oracle region $TF_VAR_region, SSH from ${TF_VAR_ssh_cidr:-anywhere}"

# ── 2. Infrastructure ──────────────────────────────────────────────────────────────────────────────────────────────
bold "Provisioning the Oracle Cloud VM (Terraform)"
# The OCI provider is a ~68 MB download from GitHub, once: cached in ~/.terraform.d/plugin-cache for later runs.
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$HOME/.terraform.d/plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"
if [ ! -d "$TF/.terraform/providers" ]; then
  echo "  Downloading Terraform's Oracle provider (~68 MB, first run only; it can take a few minutes)…"
fi
tf init -input=false
# Always Free A1 capacity is often short in one availability domain: try the others before giving up.
start_ad="${TF_VAR_availability_domain_index:-0}"
applied=""
for ad in $(printf '%s\n' "$start_ad" 0 1 2 | awk '!seen[$0]++'); do
  log="$SECRETS/terraform-apply.log"
  if TF_VAR_availability_domain_index="$ad" tf apply -input=false -auto-approve 2>&1 | tee "$log"; then
    applied=yes
    break
  fi
  if grep -q "Out of host capacity" "$log"; then
    echo "  Availability domain $ad has no free capacity for this shape; trying the next one."
    continue
  fi
  grep -q "Invalid index" "$log" && break
  die "terraform apply failed (see above)."
done
[ -n "$applied" ] || die "No availability domain had capacity. Try later, or set TF_VAR_instance_shape=VM.Standard.E2.1.Micro (README.md)."
ORIGIN="$(tf_out origin)"
IP="$(tf_out public_ip)"
ok "VM at $IP, service address $ORIGIN"

# ── 3. Build, and register on Stellar (your wallet approves, once) ─────────────────────────────────────────────────
bold "Building"
[ -d node_modules ] || npm ci
npm run build >/dev/null
ok "built"

bold "Registering $ORIGIN on Stellar ($NETWORK)"
echo "  provider-kit launch opens a page where your wallet approves the USDC trustline, the Stellar 8004 registration"
echo "  and a verification request. On mainnet the account needs a few XLM. It signs nothing when all is in place."
npx provider-kit launch \
  --start "node --env-file-if-exists=.env --disable-warning=ExperimentalWarning dist/server.js" \
  --url "$ORIGIN" --no-deploy --no-wait "$@"
PAY_TO="$(envget PAY_TO)"
AGENT_ID="$(envget AGENT_ID)"
[ -n "$PAY_TO" ] && [ -n "$AGENT_ID" ] || die "launch did not finish: PAY_TO or AGENT_ID is still empty in .env. Run ./deploy.sh again."
ok "agent $AGENT_ID, paid to $PAY_TO"

# ── 4. Ship ─────────────────────────────────────────────────────────────────────────────────────────────────────────
bold "Waiting for the VM to finish its first boot"
for _ in $(seq 1 60); do
  ssh_vm "test -f /opt/grid-maker/.cloud-init-done" 2>/dev/null && break
  sleep 10
done
ssh_vm "test -f /opt/grid-maker/.cloud-init-done" || die "The VM is not ready after 10 minutes: ./deploy.sh ssh, then: sudo cloud-init status --long"
ok "ready"

bold "Making sure the VM has Docker and its firewall rules"
ssh_vm "sudo bash -s" < deploy/bootstrap.sh

bold "Copying the project and starting it"
rsync -az --delete -e "ssh -i $KEY -o UserKnownHostsFile=$SECRETS/known_hosts -o BatchMode=yes" \
  --exclude node_modules --exclude dist --exclude .env --exclude '.env.*' --exclude 'jobs.sqlite*' --exclude outputs \
  --exclude .git --exclude deploy/.secrets --exclude deploy/terraform --exclude deploy/app.env --exclude deploy/site.env \
  ./ "ubuntu@$IP:$REMOTE/"
# Settings for the container: production values only. The facilitator key stays in this file, readable by ubuntu only.
{
  echo "STELLAR_NETWORK=$NETWORK"
  echo "PUBLIC_ORIGIN=$ORIGIN"
  echo "PAY_TO=$PAY_TO"
  echo "AGENT_ID=$AGENT_ID"
  for name in FACILITATOR_AUTH FACILITATOR_URL SOROBAN_RPC_URL GRID_PRICE_USDC; do
    value="$(envget "$name")"
    [ -n "$value" ] && echo "$name=$value"
  done
  true
} | ssh_vm "umask 077 && cat > $REMOTE/deploy/app.env"
echo "SITE_ADDRESS=$(tf_out hostname)" | ssh_vm "cat > $REMOTE/deploy/site.env"
ssh_vm "cd $REMOTE/deploy && sudo docker compose up -d --build --remove-orphans && sudo docker image prune -f >/dev/null"
ok "containers started"

# ── 5. Check from outside ───────────────────────────────────────────────────────────────────────────────────────────
bold "Waiting for $ORIGIN to answer over HTTPS"
MANIFEST="$ORIGIN/.well-known/stellar-agent-services.json"
live=""
for _ in $(seq 1 40); do
  if curl -fsS --max-time 10 "$MANIFEST" 2>/dev/null | grep -Eq "\"agentId\": *$AGENT_ID([^0-9]|\$)"; then live=yes; break; fi
  sleep 6
done
[ -n "$live" ] || die "$MANIFEST does not serve agent $AGENT_ID yet. ./deploy.sh logs shows why."
ok "live: $MANIFEST"

bold "Status"
npx provider-kit status --url "$ORIGIN" || true
printf '\n\033[1mDone.\033[0m Instagram Grid Maker is live at %s\n' "$ORIGIN"
