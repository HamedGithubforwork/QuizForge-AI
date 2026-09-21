"""Manual, bounded Lightsail laboratory. Builds never execute with AWS credentials."""
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (SSHCertificate, SSHCertificateType, Encoding,
                                                         PrivateFormat, PublicFormat, NoEncryption,
                                                         load_ssh_public_identity)

from policy import (APP_SHA, HARNESS_SHA, REGION, GROUP, ROLE, PURPOSE, BUNDLE,
                    BLUEPRINT, MAX_MONTHLY_USD, TTL_SECONDS, cleanup_policy,
                    cleanup_trust, test_name)

HERE = Path(__file__).resolve().parents[1] / 'lightsail_test'
RESULTS = Path('lightsail-results')
CONFIG = Config(connect_timeout=10, read_timeout=30, retries={'total_max_attempts': 1, 'mode': 'standard'})


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def save(name, value):
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / name).write_text(json.dumps(value, indent=2, default=str) + '\n')


def failure_summary(error):
    if isinstance(error, ClientError):
        detail = error.response.get('Error', {})
        operation = str(error.operation_name)
        message = operation + ': ' + str(detail.get('Code', 'ClientError'))
        # These requests carry no secrets. Never dump access-details responses,
        # subprocess output, request headers or credentials to diagnose a denial.
        if operation in ('CreateInstances', 'GetSchedule'):
            reason = ' '.join(str(detail.get('Message', '')).split())
            reason = re.sub(r'[A-Za-z0-9+/]{80,}={0,2}', '[redacted]', reason)
            message += ': ' + reason[:1000]
        return message
    return str(error) if isinstance(error, RuntimeError) else type(error).__name__


def tags(instance):
    return {t['key']: t.get('value', '') for t in instance.get('tags', [])}


def owned(instance, name):
    return (instance.get('name') == name and tags(instance).get('Purpose') == PURPOSE
            and tags(instance).get('TestId') == name.removeprefix('qf-capacity-'))


def pages(client, method, key, **kwargs):
    values = []
    while True:
        result = getattr(client, method)(**kwargs)
        values.extend(result[key])
        if not result.get('nextPageToken'):
            return values
        kwargs['pageToken'] = result['nextPageToken']


def check_bundle(bundles):
    bundle = next((b for b in bundles if b['bundleId'] == BUNDLE), None)
    require(bundle is not None, 'Reviewed bundle is unavailable; do not select a substitute')
    require(bundle.get('isActive') and bundle.get('price', 999) <= MAX_MONTHLY_USD
            and bundle.get('cpuCount') == 2 and bundle.get('ramSizeInGb') == 2
            and bundle.get('diskSizeInGb') == 60 and bundle.get('publicIpv4AddressCount') == 1
            and 'LINUX_UNIX' in bundle.get('supportedPlatforms', []), 'Bundle/price differs from the reviewed 2 GB plan')
    return {k: bundle[k] for k in ('bundleId', 'price', 'cpuCount', 'ramSizeInGb', 'diskSizeInGb')}


def get_instance(client, name):
    try:
        return client.get_instance(instanceName=name)['instance']
    except ClientError as error:
        if error.response['Error']['Code'] != 'NotFoundException':
            raise
        return None


def preflight(clients, account, *, app_sha=APP_SHA, harness_sha=HARNESS_SHA):
    ls, scheduler, iam, free = clients
    checks = {}
    blockers = []

    def inspect(name, call):
        try:
            checks[name] = call()
        except ClientError as error:
            blockers.append(name + ': ' + error.response['Error']['Code'])
        except RuntimeError as error:
            blockers.append(name + ': ' + str(error))

    def plan():
        state = free.get_account_plan_state()
        require(state.get('accountPlanStatus') == 'ACTIVE', 'Account plan is not active')
        return {k: state.get(k) for k in ('accountPlanType', 'accountPlanStatus')}

    def blueprint():
        value = next((b for b in pages(ls, 'get_blueprints', 'blueprints', includeInactive=False)
                      if b['blueprintId'] == BLUEPRINT), {})
        require(value.get('isActive') and value.get('platform') == 'LINUX_UNIX', 'Reviewed Ubuntu blueprint unavailable')
        return BLUEPRINT

    def cleanup():
        role = iam.get_role(RoleName=ROLE)['Role']
        require(role['Arn'] == f'arn:aws:iam::{account}:role/{ROLE}', 'Unexpected cleanup role')
        require(role['AssumeRolePolicyDocument'] == cleanup_trust(account), 'Cleanup role trust differs from reviewed policy')
        attached = iam.list_attached_role_policies(RoleName=ROLE)
        require(not attached.get('AttachedPolicies') and not attached.get('IsTruncated'), 'Cleanup role has unexpected managed permissions')
        names = iam.list_role_policies(RoleName=ROLE)
        require(names.get('PolicyNames') == ['delete-capacity-test'] and not names.get('IsTruncated'), 'Unexpected cleanup role policies')
        policy = iam.get_role_policy(RoleName=ROLE, PolicyName='delete-capacity-test')['PolicyDocument']
        require(policy == cleanup_policy(account), 'Cleanup permissions differ from reviewed deletion-only policy')
        group = scheduler.get_schedule_group(Name=GROUP)
        require(group.get('State') == 'ACTIVE', 'Cleanup schedule group is not active')
        return 'reviewed role and group exist; delivery still requires a real test'

    def empty():
        instances = pages(ls, 'get_instances', 'instances')
        require(not any(tags(i).get('Purpose') == PURPOSE or i['name'].startswith('qf-capacity-')
                        for i in instances), 'An earlier capacity instance remains; clean it up first')
        return True

    def zone():
        regions = ls.get_regions(includeAvailabilityZones=True)['regions']
        region = next(r for r in regions if r['name'] == REGION)
        zones = sorted(z['zoneName'] for z in region['availabilityZones'] if z.get('state') == 'available')
        require(bool(zones), 'No Canadian availability zone is available')
        return zones[0]

    inspect('account_plan', plan)
    inspect('bundle', lambda: check_bundle(pages(ls, 'get_bundles', 'bundles', includeInactive=False)))
    inspect('blueprint', blueprint)
    inspect('cleanup', cleanup)
    inspect('no_previous_test_instance', empty)
    inspect('availability_zone', zone)
    result = {'region': REGION, 'mutations': 0, 'checks': checks, 'blockers': blockers,
              'application_sha': app_sha, 'harness_sha': harness_sha, 'deadline_hours': 2,
              'launch_permission_proven': False, 'live_test_performed': False}
    save('preflight.json', result)
    print(json.dumps(result, indent=2), flush=True)
    require(not blockers, 'Read-only preflight has blockers; no instance created')
    return result


def schedule_request(name, account, deadline):
    return {'Name': name, 'GroupName': GROUP, 'ClientToken': name,
        'ScheduleExpression': 'at(' + deadline.strftime('%Y-%m-%dT%H:%M:%S') + ')',
        'ScheduleExpressionTimezone': 'UTC', 'FlexibleTimeWindow': {'Mode': 'OFF'},
        'State': 'ENABLED', 'ActionAfterCompletion': 'DELETE',
        'Target': {'Arn': 'arn:aws:scheduler:::aws-sdk:lightsail:deleteInstance',
            'RoleArn': f'arn:aws:iam::{account}:role/{ROLE}',
            # Scheduler's universal AWS SDK target requires PascalCase fields,
            # unlike Lightsail's lower-camel boto3/wire request model.
            'Input': json.dumps({'InstanceName': name, 'ForceDeleteAddOns': True}),
            'RetryPolicy': {'MaximumEventAgeInSeconds': 3600, 'MaximumRetryAttempts': 10}}}


def arm(scheduler, name, account, deadline):
    request = schedule_request(name, account, deadline)
    # Always arm and read back the external deletion schedule BEFORE CreateInstances.
    try:
        scheduler.create_schedule(**request)
    except ClientError as error:
        # This request contains only the reviewed role, test name and deletion
        # target. Expose its validation reason without logging arbitrary AWS
        # responses (especially temporary SSH credentials from other APIs).
        detail = error.response.get('Error', {})
        reason = str(detail.get('Code', 'ClientError'))
        if reason == 'ValidationException':
            reason += ': ' + ' '.join(str(detail.get('Message', '')).split())[:1000]
        raise RuntimeError('Cleanup schedule creation rejected: ' + reason) from None
    actual = scheduler.get_schedule(Name=name, GroupName=GROUP)
    for key in ('ScheduleExpression', 'ScheduleExpressionTimezone', 'FlexibleTimeWindow',
                'State', 'ActionAfterCompletion', 'Target'):
        require(actual.get(key) == request[key], 'Deletion schedule read-back mismatch')


def cleanup_instance(ls, name, wait_seconds=300):
    instance = get_instance(ls, name)
    if instance is None:
        return {'instance_absent': True, 'schedule_retained': True,
                'note': 'Fallback schedule remains armed, including for ambiguous creation errors'}
    require(owned(instance, name), 'Refusing to delete an instance without the exact test ownership tags')
    ls.delete_instance(instanceName=name, forceDeleteAddOns=True)
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        if get_instance(ls, name) is None:
            return {'instance_absent': True, 'schedule_retained': True}
        time.sleep(5)
    raise RuntimeError('Deletion not confirmed; keep the independent cleanup schedule armed')


def wait_running(ls, name):
    deadline = time.monotonic() + 480
    while time.monotonic() < deadline:
        instance = get_instance(ls, name)
        if instance and instance['state']['name'] == 'running':
            require(owned(instance, name), 'New instance ownership mismatch')
            require(instance['bundleId'] == BUNDLE and instance['blueprintId'] == BLUEPRINT
                    and not instance.get('addOns'), 'Unexpected instance configuration')
            return instance
        time.sleep(5)
    raise RuntimeError('Instance startup deadline exceeded')


def wait_ssh_details(ls, instance, wait_seconds=300):
    # Instance state can become running before AWS publishes credentials.
    # Host identity is pinned from the unique key installed by our bootstrap.
    deadline = time.monotonic() + wait_seconds
    previous_missing = None
    while True:
        access = ls.get_instance_access_details(instanceName=instance['name'], protocol='ssh').get('accessDetails', {})
        missing = [key for key in ('ipAddress', 'instanceName', 'username', 'privateKey', 'certKey')
                   if not access.get(key)]
        if not missing:
            return access
        if time.monotonic() >= deadline:
            raise RuntimeError('AWS SSH details not ready before deadline; missing fields: ' + ', '.join(missing))
        if missing != previous_missing:
            print('Waiting for AWS SSH fields: ' + ', '.join(missing), flush=True)
            previous_missing = missing
        time.sleep(5)


def validate_ssh_certificate(access):
    # The certificate itself comes from the authenticated AWS API. Its signed
    # validity interval remains available when the optional expiresAt is absent.
    try:
        certificate = load_ssh_public_identity(access['certKey'].encode())
        require(isinstance(certificate, SSHCertificate), 'AWS SSH credential is not a certificate')
        certificate.verify_cert_signature()
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError('Invalid AWS SSH certificate') from None
    now = datetime.now(timezone.utc)
    require(certificate.type == SSHCertificateType.USER, 'Unexpected SSH certificate type')
    require(b'ubuntu' in certificate.valid_principals, 'SSH certificate does not name the expected user')
    require(certificate.valid_after <= now.timestamp(), 'SSH certificate is not yet valid')
    # A certificate is checked at authentication, not for an established session.
    # Fetch a fresh one per connection and retain headroom for ConnectTimeout=10.
    require(certificate.valid_before > now.timestamp() + 30, 'SSH credential lifetime too short')
    if access.get('expiresAt') is not None:
        expiry = access['expiresAt']
        require(isinstance(expiry, datetime) and expiry > now + timedelta(seconds=30),
                'SSH API credential lifetime too short')


def host_bootstrap():
    # A unique server identity is generated locally and delivered only in the
    # authenticated CreateInstances request. It grants no client login access.
    key = Ed25519PrivateKey.generate()
    private = key.private_bytes(Encoding.PEM, PrivateFormat.OpenSSH, NoEncryption())
    public = key.public_key().public_bytes(Encoding.OpenSSH, PublicFormat.OpenSSH).decode()
    script = (HERE / 'bootstrap.sh').read_text()
    require(script.count('__CAPACITY_HOST_KEY_BASE64__') == 1, 'Expected one disposable host-key placeholder')
    return script.replace('__CAPACITY_HOST_KEY_BASE64__', base64.b64encode(private).decode()), public


def ssh_access(ls, instance, directory, pinned_host_key):
    access = wait_ssh_details(ls, instance)
    address = str(ipaddress.IPv4Address(access['ipAddress']))
    require(address == instance['publicIpAddress'] and access['instanceName'] == instance['name'], 'SSH endpoint mismatch')
    require(access['username'] == 'ubuntu', 'Unexpected SSH account')
    validate_ssh_certificate(access)
    require(re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+', pinned_host_key), 'Invalid pinned test host key')
    known = [address + ' ' + pinned_host_key + '\n']
    for name, value in [('identity', access['privateKey']), ('identity-cert.pub', access['certKey']),
                        ('known_hosts', ''.join(known))]:
        path = directory / name
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as handle:
            handle.write(value.rstrip('\n') + '\n')
    options = ['-i', str(directory / 'identity'), '-o', 'CertificateFile=' + str(directory / 'identity-cert.pub'),
        '-o', 'UserKnownHostsFile=' + str(directory / 'known_hosts'), '-o', 'GlobalKnownHostsFile=/dev/null',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
        '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3']
    return options, 'ubuntu@' + address


@contextmanager
def ssh_connection(ls, instance, pinned_host_key):
    # Never reuse a short-lived AWS login certificate for a later connection.
    with tempfile.TemporaryDirectory(prefix='qf-ssh-', dir=os.environ['RUNNER_TEMP']) as tmp:
        yield ssh_access(ls, instance, Path(tmp), pinned_host_key)


def ssh_probe_status(result):
    # Only fixed categories leave this function: stderr can contain key paths
    # or other untrusted text and must never be copied into workflow logs.
    if result.returncode == 0:
        return 'ready'
    if result.returncode == 1:
        return 'authenticated; bootstrap not ready'
    error = result.stderr.decode(errors='replace').lower()
    for needles, status in (
        (('error in libcrypto', 'invalid format'), 'private key encoding rejected'),
        (('permission denied',), 'login rejected'),
        (('host key verification failed', 'remote host identification has changed'), 'host identity rejected'),
        (('no matching host key type',), 'host algorithm rejected'),
        (('connection refused',), 'connection refused'),
        (('timed out',), 'connection timed out'),
        (('network is unreachable', 'no route to host'), 'network unavailable'),
        (('connection reset', 'connection closed'), 'connection closed'),
    ):
        if any(needle in error for needle in needles):
            return status
    return 'unclassified SSH failure'


def metrics(ls, name, start):
    result = {}
    for metric, unit in [('CPUUtilization', 'Percent'), ('BurstCapacityPercentage', 'Percent'),
                         ('BurstCapacityTime', 'Seconds')]:
        try:
            data = ls.get_instance_metric_data(instanceName=name, metricName=metric,
                period=60, startTime=start, endTime=datetime.now(timezone.utc), unit=unit,
                statistics=['Average', 'Minimum', 'Maximum'])
            result[metric] = data.get('metricData', [])
        except ClientError as error:
            result[metric] = {'unavailable': error.response['Error']['Code']}
    save('aws-cpu-metrics.json', result)


def benchmark(ls, instance, image, digest, pinned_host_key):
    print('Stage: waiting for bootstrap with fresh credentials and the pinned host key', flush=True)
    deadline = time.monotonic() + 600
    previous_status = None
    while time.monotonic() < deadline:
        with ssh_connection(ls, instance, pinned_host_key) as (options, target):
            ready = subprocess.run(['ssh', *options, target, 'test -f /var/lib/quizforge-capacity-ready'],
                capture_output=True, timeout=25)
        status = ssh_probe_status(ready)
        if status != previous_status:
            print('SSH readiness: ' + status, flush=True)
            previous_status = status
        if ready.returncode == 0:
            break
        time.sleep(5)
    else:
        raise RuntimeError('Docker bootstrap/verified SSH deadline exceeded: ' + str(previous_status))
    print('Stage: transferring checked synthetic image', flush=True)
    with ssh_connection(ls, instance, pinned_host_key) as (options, target):
        subprocess.run(['scp', *options, str(image), target + ':/home/ubuntu/capacity-image.tar.gz'],
            check=True, capture_output=True, timeout=300)
    try:
        print('Stage: running burst and sustained OCR profiles', flush=True)
        with ssh_connection(ls, instance, pinned_host_key) as (options, target), (HERE / 'remote.sh').open('rb') as script:
            subprocess.run(['ssh', *options, target, f'sudo bash -s -- {digest} {APP_SHA}'], stdin=script,
                check=True, capture_output=True, timeout=2200)
    finally:
        # No raw PDFs, cloud credentials or production data exist in this image.
        with ssh_connection(ls, instance, pinned_host_key) as (options, target):
            subprocess.run(['scp', *options, '-r', target + ':/home/ubuntu/capacity-results', str(RESULTS)],
                check=True, capture_output=True, timeout=90)
    reports = []
    host_path = RESULTS / 'capacity-results' / 'host.json'
    if host_path.is_file():
        print(json.dumps({'capacity_host': json.loads(host_path.read_text())}), flush=True)
    for profile in ('burst', 'sustained'):
        path = RESULTS / 'capacity-results' / profile / 'capacity.json'
        report = json.loads(path.read_text())
        require(report.get('application_sha') == APP_SHA and report.get('synthetic_data') is True
                and report.get('paid_model_calls') == 0, 'Unexpected benchmark identity/data boundary')
        print(json.dumps({'capacity_profile': profile, 'report': report}), flush=True)
        # Preserve the original harness report byte-for-byte. This wrapper records placement.
        reports.append({'profile': profile, 'passed': report.get('passed') is True})
        diagnostic = json.loads((path.parent / 'ocr-comparison.json').read_text())
        validate_comparison(diagnostic, profile)
        print(json.dumps({'ocr_comparison_profile': profile, 'report': diagnostic}), flush=True)
    exit_code = (RESULTS / 'capacity-results/exit-code.txt').read_text().strip()
    require(exit_code == '0' and all(p['passed'] for p in reports), 'Measured profile failed; targets are not waived')


def validate_comparison(report, profile):
    from ocr_comparison import summarize
    expected_cpu = 2 if profile == 'burst' else .4
    script_hash = hashlib.sha256((HERE / 'ocr_comparison.py').read_bytes()).hexdigest()
    require(report.get('application_sha') == APP_SHA and report.get('comparison_script_sha256') == script_hash
            and report.get('synthetic_data') is True and report.get('paid_model_calls') == 0,
            'Unexpected OCR comparison source/data boundary')
    require(report.get('cpu_limit') == expected_cpu and report.get('pairs') == 6
            and report.get('dpi') == 150 and report.get('page_segmentation_mode') == 3
            and report.get('ocr_threads') == 1 and len(report.get('samples', [])) == 12
            and report.get('passed') is True, 'Incomplete or failed controlled OCR comparison')
    require(report.get('summary') == summarize(report['samples'])
            and all(c['quality_passed'] for c in report['summary'].values()),
            'OCR comparison summary or quality mismatch')


def run(clients, account, name, *, app_sha=APP_SHA, harness_sha=HARNESS_SHA, benchmark_fn=benchmark):
    ls, scheduler, _, _ = clients
    image = Path('capacity-build/capacity-image.tar.gz')
    require(image.is_file() and 0 < image.stat().st_size < 2 * 1024**3, 'Bounded prebuilt image artifact required')
    manifest = json.loads(Path('capacity-build/manifest.json').read_text())
    with image.open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
    require(manifest == {'application_sha': app_sha, 'harness_sha': harness_sha, 'image_sha256': digest},
            'Prebuilt image digest or pinned source mismatch')
    inspected = preflight(clients, account, app_sha=app_sha, harness_sha=harness_sha)
    with urlopen('https://checkip.amazonaws.com', timeout=10) as response:
        runner_ip = ipaddress.IPv4Address(response.read(64).decode().strip())
    require(runner_ip.is_global, 'Public runner IPv4 required')
    start = datetime.now(timezone.utc)
    deadline = start + timedelta(seconds=TTL_SECONDS)
    report = {'test_id': name.removeprefix('qf-capacity-'), 'region': REGION, 'bundle': BUNDLE,
              'application_sha': app_sha, 'harness_sha': harness_sha, 'image_sha256': digest,
              'started_at': start, 'delete_at': deadline, 'live_test_performed': False,
              'cleanup_schedule_verified': False, 'instance_creation_attempted': False,
              'monthly_bundle_usd': inspected['checks']['bundle']['price'], 'scheduled_cleanup_is_not_a_spending_cap': True}
    save('run.json', report)
    # Finish ordinary work within 50 minutes so the one-hour AWS session still
    # has time for metrics and confirmed deletion. This is separate from TTL.
    signal.alarm(3000)
    try:
        arm(scheduler, name, account, deadline)
        report['cleanup_schedule_verified'] = True
        # Do not retry CreateInstances: a timeout can represent an accepted request.
        require(datetime.now(timezone.utc) < deadline - timedelta(minutes=90), 'Too little time remains before cleanup')
        user_data, pinned_host_key = host_bootstrap()
        report['instance_creation_attempted'] = True
        ls.create_instances(instanceNames=[name], availabilityZone=inspected['checks']['availability_zone'],
            blueprintId=BLUEPRINT, bundleId=BUNDLE, ipAddressType='ipv4', addOns=[],
            tags=[{'key': 'Purpose', 'value': PURPOSE}, {'key': 'TestId', 'value': report['test_id']},
                  {'key': 'DeleteAfter', 'value': deadline.isoformat()}],
            userData=user_data)
        instance = wait_running(ls, name)
        ports = [{'fromPort': 22, 'toPort': 22, 'protocol': 'tcp', 'cidrs': [str(runner_ip) + '/32'], 'ipv6Cidrs': []}]
        ls.put_instance_public_ports(instanceName=name, portInfos=ports)
        actual = ls.get_instance_port_states(instanceName=name)['portStates']
        opened = [p for p in actual if p.get('state') == 'open']
        require(len(opened) == 1 and all(opened[0].get(k, []) == v for k, v in ports[0].items()), 'SSH-only firewall read-back failed')
        report['live_test_performed'] = True
        benchmark_fn(ls, instance, image, digest, pinned_host_key)
        report['all_profiles_passed'] = True
    finally:
        signal.alarm(0)
        try:
            if report['live_test_performed']:
                metrics(ls, name, start)
        finally:
            try:
                report['cleanup'] = cleanup_instance(ls, name)
            except Exception as error:
                report['cleanup'] = {'instance_absent': False, 'error_type': type(error).__name__,
                                     'schedule_retained': True, 'manual_check_required': True}
                raise
            finally:
                save('run.json', report)
                print(json.dumps(report, indent=2, default=str), flush=True)


def main():
    operation = os.environ.get('OPERATION', 'inspect')
    require(operation in ('inspect', 'run', 'cleanup'), 'Unsupported operation')
    require(os.environ.get('GITHUB_REF') == 'refs/heads/main'
            and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch', 'Manual main-branch invocation required')
    account = boto3.client('sts', config=CONFIG).get_caller_identity()['Account']
    require(account == os.environ['TEST_ACCOUNT_ID'], 'AWS account mismatch')
    clients = (boto3.client('lightsail', region_name=REGION, config=CONFIG),
               boto3.client('scheduler', region_name=REGION, config=CONFIG),
               boto3.client('iam', config=CONFIG), boto3.client('freetier', region_name='us-east-1', config=CONFIG))
    if operation == 'inspect':
        preflight(clients, account)
    else:
        ident = os.environ['TEST_ID'] if operation == 'cleanup' else os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT']
        name = test_name(ident)
        if operation == 'cleanup':
            result = cleanup_instance(clients[0], name)
            save('cleanup.json', result)
            print(json.dumps(result))
        else:
            run(clients, account, name)


if __name__ == '__main__':
    # SIGTERM from workflow cancellation still attempts finally cleanup. AWS deletion
    # remains independent of this process, including SIGKILL and runner loss.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    def elapsed(*_):
        raise RuntimeError('50-minute controller deadline reached; cleaning up')
    signal.signal(signal.SIGALRM, elapsed)
    try:
        main()
    except Exception as error:
        print('FAIL: ' + failure_summary(error), file=sys.stderr)
        raise SystemExit(1)
