#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VPS for Beam. Run as root.
set -euo pipefail

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git ufw

# Docker Engine + Compose plugin from Docker's official apt repository.
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# Only SSH and HTTPS reach the machine.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

if [ ! -d /opt/beam ]; then
  git clone https://github.com/Lightlabs-main/Beam.git /opt/beam
fi
echo "bootstrap done: put secrets in /opt/beam/deploy/.env, then run deploy/up.sh"
