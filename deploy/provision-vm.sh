#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VM for FinSight. Run as root:
#
#   curl -fsSL <raw url of this file> -o provision-vm.sh   (or scp it over)
#   sudo bash provision-vm.sh
#
# It creates a `finsight` user that can log in with the same SSH key root
# uses, turns off password and root SSH logins, opens only ports 22/80/443,
# installs Docker, adds swap for OCR memory spikes and enables automatic
# security updates. Safe to run again.
set -euo pipefail

readonly APP_USER=finsight
readonly SWAP_SIZE=2G

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo bash $0)." >&2
  exit 1
fi
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  echo "This script targets Ubuntu; found ${PRETTY_NAME:-unknown}." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y upgrade
# age encrypts the nightly database backups (deploy/backup-db.sh).
apt-get -y install ca-certificates curl git ufw fail2ban unattended-upgrades age

# --- user ------------------------------------------------------------------
if ! id "$APP_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$APP_USER"
fi
usermod -aG sudo "$APP_USER"
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "/home/$APP_USER/.ssh"
if [ -s /root/.ssh/authorized_keys ]; then
  install -m 600 -o "$APP_USER" -g "$APP_USER" /root/.ssh/authorized_keys "/home/$APP_USER/.ssh/authorized_keys"
fi
if [ ! -s "/home/$APP_USER/.ssh/authorized_keys" ]; then
  echo "No SSH key for $APP_USER: add one to /root/.ssh/authorized_keys and run again." >&2
  echo "Stopping before SSH is locked down, so this login still works." >&2
  exit 1
fi
# sudo without a password: this user has no password to type.
echo "$APP_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$APP_USER"
chmod 440 "/etc/sudoers.d/90-$APP_USER"

# --- SSH -------------------------------------------------------------------
cat > /etc/ssh/sshd_config.d/90-finsight.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sshd -t
systemctl reload ssh

# --- firewall --------------------------------------------------------------
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban

# --- Docker (official repository) ------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
usermod -aG docker "$APP_USER"
# Container logs are the only logs until a log destination is chosen; cap
# them so they cannot fill the disk.
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
EOF
systemctl restart docker

# Docker publishes ports through its own iptables rules, which bypass ufw.
# That is fine here only because compose publishes nothing but nginx's 80 and
# 443; the backend uses `expose`, not `ports`. Keep it that way.

# --- swap ------------------------------------------------------------------
if ! swapon --show | grep -q /swapfile; then
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- automatic security updates --------------------------------------------
dpkg-reconfigure -f noninteractive unattended-upgrades

timedatectl set-timezone Asia/Manila

echo
echo "Done. Log out, then log back in as: ssh $APP_USER@<this server's IP>"
echo "Root and password logins are now off."
