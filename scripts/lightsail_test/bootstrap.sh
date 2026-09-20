#!/bin/bash
# Only a disposable SSH host identity; no cloud/model/database credentials or
# application data. The placeholder is filled in memory for this test instance.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
mkdir -p /etc/ssh/sshd_config.d /etc/docker
umask 077
printf '%s' '__CAPACITY_HOST_KEY_BASE64__' | base64 --decode > /etc/ssh/quizforge_capacity_host_ed25519_key
chmod 600 /etc/ssh/quizforge_capacity_host_ed25519_key
cat > /etc/ssh/sshd_config.d/00-capacity.conf <<'EOF'
HostKey /etc/ssh/quizforge_capacity_host_ed25519_key
HostKeyAlgorithms ssh-ed25519
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowTcpForwarding no
X11Forwarding no
EOF
sshd -t
systemctl reload ssh
cat > /etc/docker/daemon.json <<'EOF'
{"log-driver":"local","log-opts":{"max-size":"5m","max-file":"2"}}
EOF
apt-get update -qq
apt-get install -y -qq --no-install-recommends docker.io
swapoff -a
systemctl enable --now docker
touch /var/lib/quizforge-capacity-ready
