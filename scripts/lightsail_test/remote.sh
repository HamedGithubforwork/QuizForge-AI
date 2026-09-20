#!/bin/bash
# Execute only the credential-free synthetic image. SSH carries no AWS secrets.
set -euo pipefail
cd /home/ubuntu
test "$#" -eq 2
image_sha=$1
application_sha=$2
[[ "$image_sha" =~ ^[a-f0-9]{64}$ ]]
[[ "$application_sha" =~ ^[a-f0-9]{40}$ ]]
echo "$image_sha  capacity-image.tar.gz" | sha256sum --check --status
test -f /var/lib/quizforge-capacity-ready
test "$(docker info --format '{{.CgroupVersion}}')" = 2
test "$(nproc)" -eq 2
mkdir -p capacity-results
python3 - <<'PY'
import json, pathlib, platform
memory = {r.split(':')[0]: int(r.split()[1]) for r in pathlib.Path('/proc/meminfo').read_text().splitlines()}
assert 1800 * 1024 <= memory['MemTotal'] <= 2100 * 1024, 'Require the real 2 GB host'
assert memory['SwapTotal'] == 0, 'Host swap must be disabled'
cpu = next((r.split(':', 1)[1].strip() for r in pathlib.Path('/proc/cpuinfo').read_text().splitlines()
            if r.startswith('model name')), 'unknown')
pathlib.Path('capacity-results/host.json').write_text(json.dumps({
    'live_aws_instance': True, 'architecture': platform.machine(), 'kernel': platform.release(),
    'cpu_model': cpu, 'memory_total_kib': memory['MemTotal'], 'memory_available_before_kib': memory['MemAvailable']}, indent=2))
PY
docker load -i capacity-image.tar.gz >/dev/null
rm capacity-image.tar.gz
# The host monitor is outside the laboratory cgroup and records no identities.
python3 -u - <<'PY' > capacity-results/host-memory.jsonl &
import json, pathlib, time
while True:
    m = {r.split(':')[0]: int(r.split()[1]) for r in pathlib.Path('/proc/meminfo').read_text().splitlines()}
    print(json.dumps({'epoch': time.time(), 'available_kib': m['MemAvailable'], 'swap_free_kib': m['SwapFree']}), flush=True)
    time.sleep(2)
PY
monitor_pid=$!
trap 'kill "$monitor_pid" 2>/dev/null || true; docker rm -f capacity >/dev/null 2>&1 || true' EXIT
overall=0
for profile in burst sustained; do
  cpus=2
  if [ "$profile" = sustained ]; then cpus=0.4; fi
  mkdir -p "capacity-results/$profile"
  set +e
  timeout --signal=TERM --kill-after=15s 1000s docker run --name capacity \
    --network none --memory 1536m --memory-swap 1536m --cpus "$cpus" \
    --pids-limit 192 --shm-size 64m --cap-drop ALL --security-opt no-new-privileges \
    --log-driver local --log-opt max-size=5m --log-opt max-file=2 \
    -e APPLICATION_SHA="$application_sha" quizforge-capacity:checked \
    > "capacity-results/$profile/synthetic.log" 2>&1
  result=$?
  set -e
  echo "$result" > "capacity-results/$profile/exit-code.txt"
  if [ "$result" != 0 ]; then overall=1; fi
  docker cp capacity:/results/. "capacity-results/$profile/" || overall=1
  docker inspect --format '{{json .State}}' capacity > "capacity-results/$profile/container-state.json"
  docker rm -f capacity >/dev/null
done
echo "$overall" > capacity-results/exit-code.txt
# Failures are retained and returned to the controller after artifact collection.
exit 0
