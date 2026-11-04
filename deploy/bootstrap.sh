#!/usr/bin/env bash
# Run as root on the VM by deploy.sh before every deploy (ssh … 'sudo bash -s' < deploy/bootstrap.sh). It does what
# cloud-init does at first boot, again, and safely: on Oracle's VMs DNS is sometimes not up yet when cloud-init runs, so
# its package install can fail once and never retry. Changes nothing when everything is in place.

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt_install() {
  for attempt in 1 2 3 4 5; do
    if apt-get update -q && apt-get install -yq "$@"; then return 0; fi
    echo "apt failed (attempt $attempt), retrying in 10 s…" >&2
    sleep 10
  done
  return 1
}

# Docker and Compose.
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  echo "Installing Docker…"
  # iptables-persistent asks about saving rules: answer for it.
  echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
  echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
  apt_install docker.io docker-compose-v2 rsync iptables-persistent
fi
systemctl enable --now docker >/dev/null
usermod -aG docker ubuntu

# Ports 80 and 443 in the host firewall (Oracle's Ubuntu images reject everything but SSH), before the final REJECT.
for port in 443 80; do
  if ! iptables -C INPUT -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT 2>/dev/null &&
     ! iptables -C INPUT -p tcp -m tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    iptables -I INPUT 5 -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT
  fi
done
# Saved every time, so the rules survive a reboot even when first boot couldn't save them.
netfilter-persistent save >/dev/null 2>&1 || true

# Swap, for builds on small VMs.
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null; }
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

mkdir -p /opt/grid-maker && chown ubuntu:ubuntu /opt/grid-maker
echo "bootstrap: docker $(docker --version | awk '{print $3}' | tr -d ,), compose $(docker compose version --short)"
