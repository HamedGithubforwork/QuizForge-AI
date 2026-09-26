#!/bin/sh
# Disposable recovery-drill host identity and Docker runtime only.
set -eu
export DEBIAN_FRONTEND=noninteractive
mkdir -p /etc/ssh/sshd_config.d /etc/docker
install -d -m 0755 /run/sshd /var/lib
umask 077
printf '%s' '__CAPACITY_HOST_KEY_BASE64__' | base64 --decode > /etc/ssh/ssh_host_ed25519_key
chmod 600 /etc/ssh/ssh_host_ed25519_key
ssh-keygen -y -f /etc/ssh/ssh_host_ed25519_key > /etc/ssh/ssh_host_ed25519_key.pub
cat > /etc/ssh/sshd_config.d/00-capacity.conf <<'EOF'
HostKey /etc/ssh/ssh_host_ed25519_key
HostKeyAlgorithms ssh-ed25519
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowTcpForwarding no
X11Forwarding no
EOF
sed -i '1iInclude /etc/ssh/sshd_config.d/00-capacity.conf' /etc/ssh/sshd_config
/usr/sbin/sshd -t
systemctl reload-or-restart ssh
cat > /etc/docker/daemon.json <<'EOF'
{"log-driver":"local","log-opts":{"max-size":"5m","max-file":"2"}}
EOF
apt-get update -qq
apt-get install -y -qq --no-install-recommends docker.io
swapoff -a
systemctl enable --now docker
touch /var/lib/quizforge-capacity-ready
