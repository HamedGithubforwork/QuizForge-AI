#!/bin/sh
# Base host only. No secrets, application, DNS or data migration in cloud-init.
set -eu
export DEBIAN_FRONTEND=noninteractive
install -d -m 0755 /etc/ssh/sshd_config.d /etc/docker /opt/quizforge
install -d -m 0700 /etc/quizforge /var/lib/quizforge
cat > /etc/ssh/sshd_config.d/00-quizforge.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
X11Forwarding no
AllowTcpForwarding no
EOF
/usr/sbin/sshd -t
systemctl reload-or-restart ssh
cat > /etc/docker/daemon.json <<'EOF'
{"log-driver":"local","log-opts":{"max-size":"5m","max-file":"2"},"exec-opts":["native.cgroupdriver=systemd"]}
EOF
apt-get update -qq
apt-get install -y -qq --no-install-recommends docker.io docker-compose-v2 unattended-upgrades
swapoff -a
systemctl enable --now docker
# Provisioning does not enable any QuizForge service or schedule.
touch /var/lib/quizforge/base-host-ready
