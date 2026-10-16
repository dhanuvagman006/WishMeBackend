#!/usr/bin/env bash
# First-time setup of a fresh Ubuntu 24.04 VPS. Run once as root:  bash harden-vps.sh <deploy-user> "<ssh public key>"
# It installs Docker, a firewall (22/80/443 only), automatic security updates, fail2ban, docker-rollout, age and rclone,
# creates the deploy user with your SSH key, and installs the nightly backup timer. It does NOT disable password SSH
# logins by itself: do that only after confirming key login works (instructions printed at the end).
set -euo pipefail

DEPLOY_USER="${1:?deploy user name}"
PUBKEY="${2:?ssh public key for the deploy user}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y upgrade
apt-get -y install ca-certificates curl gnupg ufw fail2ban unattended-upgrades age rclone jq

# Docker Engine + compose plugin from Docker's repository.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Zero-downtime replica replacement for docker compose.
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL https://raw.githubusercontent.com/wowu/docker-rollout/main/docker-rollout -o /usr/local/lib/docker/cli-plugins/docker-rollout
chmod +x /usr/local/lib/docker/cli-plugins/docker-rollout

# Firewall: SSH, HTTP, HTTPS (and HTTP/3) only. Postgres and Redis are never published.
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

dpkg-reconfigure -f noninteractive unattended-upgrades
systemctl enable --now fail2ban

# Deploy user: can run docker, key-only.
id "$DEPLOY_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$DEPLOY_USER"
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
echo "$PUBKEY" > "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"

install -d -m 750 -o root -g "$DEPLOY_USER" /opt/wishme /opt/wishme/scripts /opt/wishme/backups

# Nightly backup at 02:30 server time.
cat > /etc/systemd/system/wishme-backup.service <<EOF
[Unit]
Description=WishMe encrypted database backup
[Service]
Type=oneshot
ExecStart=/opt/wishme/scripts/backup.sh
EOF
cat > /etc/systemd/system/wishme-backup.timer <<EOF
[Unit]
Description=Nightly WishMe backup
[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable wishme-backup.timer

cat <<EOF

Done. Next steps:
 1. From your computer, confirm:  ssh ${DEPLOY_USER}@<this server>
 2. Only then disable password logins: set "PasswordAuthentication no" and "PermitRootLogin prohibit-password"
    in /etc/ssh/sshd_config.d/99-hardening.conf, then: systemctl reload ssh
 3. Copy docker-compose.yml, Caddyfile, scripts/ and a filled .env (mode 600) into /opt/wishme.
 4. Configure rclone (rclone config) with a B2 key that can write but not delete, and set BACKUP_RCLONE_REMOTE
    and BACKUP_AGE_RECIPIENT in .env.
 5. docker compose run --rm migrate && docker compose up -d
EOF
