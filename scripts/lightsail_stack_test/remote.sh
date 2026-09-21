#!/bin/bash
# No cloud credentials or model key enter this disposable host.
set -euo pipefail
cd /home/ubuntu
test "$#" -eq 1
bundle_sha=$1
[[ "$bundle_sha" =~ ^[a-f0-9]{64}$ ]]
echo "$bundle_sha  stack-bundle.tar.gz" | sha256sum --check --status
test -f /var/lib/quizforge-capacity-ready
test "$(docker info --format '{{.CgroupVersion}}')" = 2
test "$(nproc)" -eq 2
python3 - <<'PY'
from pathlib import Path
m={r.split(':')[0]:int(r.split()[1]) for r in Path('/proc/meminfo').read_text().splitlines()}
assert 1800*1024 <= m['MemTotal'] <= 2100*1024
assert m['SwapTotal']==0
PY
mkdir -p capacity-results
test ! -e stack-source
mkdir stack-source
tar -xzf stack-bundle.tar.gz -C stack-source
rm stack-bundle.tar.gz
install -d /usr/local/lib/docker/cli-plugins
install -m 0755 stack-source/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
docker load -i stack-source/images.tar >/dev/null
rm stack-source/images.tar
apt-get update -qq
apt-get install -y -qq --no-install-recommends python3-venv
python3 -m venv /home/ubuntu/stack-venv
/home/ubuntu/stack-venv/bin/pip install --require-hashes -r stack-source/candidate/scripts/rds_rehearsal/requirements.lock >/dev/null
set +e
timeout --signal=TERM --kill-after=20s 750s /home/ubuntu/stack-venv/bin/python stack-source/scripts/lightsail_stack_test/fixture.py </dev/null >capacity-results/synthetic.log 2>&1
result=$?
set -e
echo "$result" >capacity-results/exit-code.txt
# The controller must collect failures before asserting the result.
exit 0
