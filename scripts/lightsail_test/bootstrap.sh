#!/bin/bash
# No credentials or application data in user data. No website ports are opened.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
mkdir -p /etc/ssh/sshd_config.d /etc/docker
cat > /etc/ssh/sshd_config.d/00-capacity.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowTcpForwarding no
X11Forwarding no
EOF
systemctl reload ssh
cat > /etc/docker/daemon.json <<'EOF'
{"log-driver":"local","log-opts":{"max-size":"5m","max-file":"2"}}
EOF
apt-get update -qq
apt-get install -y -qq --no-install-recommends docker.io
swapoff -a
systemctl enable --now docker
touch /var/lib/quizforge-capacity-ready
