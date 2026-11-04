#!/usr/bin/env bash
# One command to take Instagram Grid Maker live on Stellar mainnet, hosted free on Oracle Cloud's Always Free tier.
#
#   ./deploy.sh              provision (Terraform), register (your wallet, first time only), build and start, check
#   ./deploy.sh --no-open    same, printing the wallet approval link instead of opening a browser
#   ./deploy.sh status       where the service stands (provider-kit status)
#   ./deploy.sh logs         follow the service's logs on the VM
#   ./deploy.sh ssh          a shell on the VM
#   ./deploy.sh destroy      delete the VM and its network (the registration on chain stays)
#   ./deploy.sh ci           once: let GitHub Actions deploy every push to main (.github/workflows/ci-cd.yml)
#
# Safe to run again: Terraform changes only what differs, `provider-kit launch` signs nothing once the registration is
# in place, and the app is rebuilt from your current code. No Stellar secret key is used or stored anywhere: the one-time
# registration is approved in your own wallet.

set -euo pipefail
cd "$(dirname "$0")"

TF=deploy/terraform
SECRETS=deploy/.secrets
KEY="$SECRETS/id_ed25519"
CI_KEY="$SECRETS/github_actions_ed25519"
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

# A value from terraform.tfvars, which beats the TF_VAR_ values this script exports; and setting one there.
tfvar_get() { sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"(.*)\".*/\1/p" "$TF/terraform.tfvars" 2>/dev/null | tail -1; }
tfvar_set() {
  local file="$TF/terraform.tfvars"
  touch "$file"
  { grep -vE "^[[:space:]]*$1[[:space:]]*=" "$file" || true; printf '%s = "%s"\n' "$1" "$2"; } > "$file.tmp"
  mv "$file.tmp" "$file"
}

# The git commit being deployed, as the service reports it at / (GitHub Actions uses the same 12 characters).
revision() {
  local rev
  rev="$(git rev-parse --short=12 HEAD 2>/dev/null || echo local)"
  [ -z "$(git status --porcelain 2>/dev/null)" ] || rev="$rev-dirty"
  echo "$rev"
}

# GitHub Actions' access: its own key on the VM, and what the workflow needs as repository settings. Only the key is
# a secret; the VM's address, host key, origin and agent id are public anyway.
sync_ci() {
  local repo ip known
  repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
  ip="$(tf_out public_ip)"
  ssh_vm 'k="$(cat)"; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF "$k" ~/.ssh/authorized_keys || printf "%s\n" "$k" >> ~/.ssh/authorized_keys' < "$CI_KEY.pub"
  known="$(ssh-keygen -F "$ip" -f "$SECRETS/known_hosts" | grep -v '^#')"
  [ -n "$known" ] || die "No host key for $ip in $SECRETS/known_hosts."
  gh secret set DEPLOY_SSH_KEY --repo "$repo" < "$CI_KEY"
  gh variable set DEPLOY_HOST --repo "$repo" --body "$ip"
  gh variable set DEPLOY_KNOWN_HOSTS --repo "$repo" --body "$known"
  gh variable set SERVICE_ORIGIN --repo "$repo" --body "$(tf_out origin)"
  gh variable set AGENT_ID --repo "$repo" --body "$(envget AGENT_ID)"
  ok "GitHub Actions in $repo deploys to $ip"
}

setup_ci() {
  command -v gh >/dev/null || die "Install the GitHub CLI (https://cli.github.com), then: gh auth login"
  gh auth status >/dev/null 2>&1 || die "The GitHub CLI isn't logged in: gh auth login (an invalid GH_TOKEN in your shell causes this too)."
  gh repo view --json nameWithOwner >/dev/null 2>&1 || die "This folder has no GitHub repository yet: create it and push first."
  [ -n "$(tf_out public_ip)" ] && [ -n "$(envget AGENT_ID)" ] || die "Deploy once with ./deploy.sh first."
  ssh_vm true || die "Can't reach the VM over SSH from here."

  bold "Making SSH key-only on the VM"
  ssh_vm "sudo bash -s" < deploy/bootstrap.sh

  bold "Opening SSH to GitHub's runners"
  # Their addresses change all the time, so port 22 opens to all; the VM accepts keys only.
  tfvar_set ssh_cidr "0.0.0.0/0"
  export_tf_vars
  tf init -input=false >/dev/null
  tf apply -input=false -auto-approve -target=oci_core_security_list.public
  ok "port 22 open, key-only"

  bold "Giving GitHub Actions its own deploy key"
  [ -f "$CI_KEY" ] || ssh-keygen -q -t ed25519 -N "" -C "instagram-grid-maker-github-actions" -f "$CI_KEY"
  sync_ci
  printf '\n\033[1mDone.\033[0m Every push to main now tests and deploys. Watch it with: gh run watch\n'
}

case "${1:-}" in
  ci)
    setup_ci; exit ;;
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
  *) die "Unknown command: $1. Use ./deploy.sh [status|logs|ssh|destroy|ci|--no-open]." ;;
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
# SSH from this computer only, unless terraform.tfvars says otherwise (./deploy.sh ci opens it to GitHub's runners).
if [ -n "$(tfvar_get ssh_cidr)" ]; then
  TF_VAR_ssh_cidr="$(tfvar_get ssh_cidr)"
else
  MY_IP="$(curl -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$MY_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then export TF_VAR_ssh_cidr="$MY_IP/32"; fi
fi
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

bold "Writing the production settings to the VM"
ssh_vm "sudo mkdir -p $REMOTE/deploy && sudo chown -R ubuntu:ubuntu /opt/grid-maker"
# Settings for the container: production values only. The facilitator key stays in this file, readable by ubuntu only.
# GitHub Actions deploys keep using it as it is: change a setting here, then run ./deploy.sh again.
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
ok "written"

# Copies the code, builds, restarts, and waits until the new revision answers over HTTPS: the same as GitHub Actions.
SSH_KEY="$KEY" SSH_KNOWN_HOSTS="$SECRETS/known_hosts" ORIGIN="$ORIGIN" AGENT_ID="$AGENT_ID" REVISION="$(revision)" \
  deploy/ship.sh "$IP" || die "The new version didn't come up. ./deploy.sh logs shows why."

# ── 5. Check from outside ───────────────────────────────────────────────────────────────────────────────────────────
# A replaced VM has a new address: keep GitHub Actions pointed at it.
if [ -f "$CI_KEY" ]; then
  bold "Updating GitHub Actions' deploy settings"
  if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then sync_ci; else
    echo "  gh isn't logged in; if the VM's address changed, run ./deploy.sh ci."
  fi
fi

bold "Status"
npx provider-kit status --url "$ORIGIN" || true
printf '\n\033[1mDone.\033[0m Instagram Grid Maker is live at %s\n' "$ORIGIN"
