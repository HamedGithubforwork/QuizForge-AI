"""Bounded temporary-host helpers retained for the production recovery drill."""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import base64
import ipaddress
import json
import os
from pathlib import Path
import re
import tempfile
import time

from botocore.config import Config
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    SSHCertificate,
    SSHCertificateType,
    Encoding,
    PrivateFormat,
    PublicFormat,
    NoEncryption,
    load_ssh_public_identity,
)

REGION = "ca-central-1"
GROUP = "quizforge-capacity-test"
ROLE = "quizforge-capacity-test-cleanup"
PURPOSE = "quizforge-capacity-test"
PREFIX = "qf-capacity-"
APP_SHA = "bff2ab7612951fe1612268af3772794651ea86c8"
HARNESS_SHA = "52f44f16794369601f21e429b15389efcf7d62e4"
BUNDLE = "small_3_0"
BLUEPRINT = "ubuntu_24_04"
MAX_MONTHLY_USD = 12
TTL_SECONDS = 7200

HERE = Path(__file__).resolve().parent
RESULTS = Path("lightsail-results")
BOOTSTRAP = HERE / "recovery_host_bootstrap.sh"
CONFIG = Config(
    connect_timeout=10,
    read_timeout=30,
    retries={"total_max_attempts": 1, "mode": "standard"},
)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def account_id(value):
    if not re.fullmatch(r"[0-9]{12}", value):
        raise ValueError("Invalid AWS account ID")
    return value


def test_name(value):
    if not re.fullmatch(r"[1-9][0-9]{0,19}-[1-9][0-9]{0,4}", value):
        raise ValueError("Test ID must be GitHub run ID-attempt")
    return PREFIX + value


def cleanup_policy(account):
    account_id(account)
    return {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Action": ["lightsail:DeleteInstance"],
            "Resource": f"arn:aws:lightsail:{REGION}:{account}:Instance/*",
            "Condition": {"StringEquals": {"aws:ResourceTag/Purpose": PURPOSE}},
        }],
    }


def cleanup_trust(account):
    account_id(account)
    return {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "scheduler.amazonaws.com"},
            "Action": "sts:AssumeRole",
            "Condition": {"StringEquals": {
                "aws:SourceAccount": account,
                "aws:SourceArn": (
                    f"arn:aws:scheduler:{REGION}:{account}:schedule-group/{GROUP}"
                ),
            }},
        }],
    }


def save(name, value):
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / name).write_text(
        json.dumps(value, indent=2, default=str) + "\n",
        encoding="utf-8",
    )


def tags(instance):
    return {item["key"]: item.get("value", "") for item in instance.get("tags", [])}


def owned(instance, name):
    return (
        instance.get("name") == name
        and tags(instance).get("Purpose") == PURPOSE
        and tags(instance).get("TestId") == name.removeprefix(PREFIX)
    )


def pages(client, method, key, **kwargs):
    values = []
    while True:
        result = getattr(client, method)(**kwargs)
        values.extend(result[key])
        if not result.get("nextPageToken"):
            return values
        kwargs["pageToken"] = result["nextPageToken"]


def check_bundle(bundles):
    bundle = next((item for item in bundles if item["bundleId"] == BUNDLE), None)
    require(bundle is not None, "Reviewed bundle is unavailable; do not select a substitute")
    require(
        bundle.get("isActive")
        and bundle.get("price", 999) <= MAX_MONTHLY_USD
        and bundle.get("cpuCount") == 2
        and bundle.get("ramSizeInGb") == 2
        and bundle.get("diskSizeInGb") == 60
        and bundle.get("publicIpv4AddressCount") == 1
        and "LINUX_UNIX" in bundle.get("supportedPlatforms", []),
        "Bundle/price differs from the reviewed 2 GB plan",
    )
    return {
        key: bundle[key]
        for key in ("bundleId", "price", "cpuCount", "ramSizeInGb", "diskSizeInGb")
    }


def get_instance(client, name):
    try:
        return client.get_instance(instanceName=name)["instance"]
    except ClientError as error:
        if error.response["Error"]["Code"] != "NotFoundException":
            raise
        return None


def preflight(clients, account):
    ls, scheduler, iam, free = clients
    checks = {}
    blockers = []

    def inspect(name, call):
        try:
            checks[name] = call()
        except ClientError as error:
            blockers.append(name + ": " + error.response["Error"]["Code"])
        except RuntimeError as error:
            blockers.append(name + ": " + str(error))

    def plan():
        state = free.get_account_plan_state()
        require(state.get("accountPlanStatus") == "ACTIVE", "Account plan is not active")
        return {key: state.get(key) for key in ("accountPlanType", "accountPlanStatus")}

    def blueprint():
        value = next(
            (
                item
                for item in pages(
                    ls,
                    "get_blueprints",
                    "blueprints",
                    includeInactive=False,
                )
                if item["blueprintId"] == BLUEPRINT
            ),
            {},
        )
        require(
            value.get("isActive") and value.get("platform") == "LINUX_UNIX",
            "Reviewed Ubuntu blueprint unavailable",
        )
        return BLUEPRINT

    def cleanup():
        role = iam.get_role(RoleName=ROLE)["Role"]
        require(
            role["Arn"] == f"arn:aws:iam::{account}:role/{ROLE}",
            "Unexpected cleanup role",
        )
        require(
            role["AssumeRolePolicyDocument"] == cleanup_trust(account),
            "Cleanup role trust differs from reviewed policy",
        )
        attached = iam.list_attached_role_policies(RoleName=ROLE)
        require(
            not attached.get("AttachedPolicies") and not attached.get("IsTruncated"),
            "Cleanup role has unexpected managed permissions",
        )
        names = iam.list_role_policies(RoleName=ROLE)
        require(
            names.get("PolicyNames") == ["delete-capacity-test"]
            and not names.get("IsTruncated"),
            "Unexpected cleanup role policies",
        )
        policy = iam.get_role_policy(
            RoleName=ROLE,
            PolicyName="delete-capacity-test",
        )["PolicyDocument"]
        require(
            policy == cleanup_policy(account),
            "Cleanup permissions differ from reviewed deletion-only policy",
        )
        group = scheduler.get_schedule_group(Name=GROUP)
        require(group.get("State") == "ACTIVE", "Cleanup schedule group is not active")
        return "reviewed role and group exist; delivery still requires a real test"

    def empty():
        instances = pages(ls, "get_instances", "instances")
        require(
            not any(
                tags(item).get("Purpose") == PURPOSE
                or item["name"].startswith(PREFIX)
                for item in instances
            ),
            "An earlier capacity instance remains; clean it up first",
        )
        return True

    def zone():
        regions = ls.get_regions(includeAvailabilityZones=True)["regions"]
        region = next(item for item in regions if item["name"] == REGION)
        zones = sorted(
            zone["zoneName"]
            for zone in region["availabilityZones"]
            if zone.get("state") == "available"
        )
        require(bool(zones), "No Canadian availability zone is available")
        return zones[0]

    inspect("account_plan", plan)
    inspect(
        "bundle",
        lambda: check_bundle(
            pages(ls, "get_bundles", "bundles", includeInactive=False)
        ),
    )
    inspect("blueprint", blueprint)
    inspect("cleanup", cleanup)
    inspect("no_previous_test_instance", empty)
    inspect("availability_zone", zone)
    result = {
        "region": REGION,
        "mutations": 0,
        "checks": checks,
        "blockers": blockers,
        "application_sha": APP_SHA,
        "harness_sha": HARNESS_SHA,
        "deadline_hours": 2,
        "launch_permission_proven": False,
        "live_test_performed": False,
    }
    save("preflight.json", result)
    print(json.dumps(result, indent=2), flush=True)
    require(not blockers, "Read-only preflight has blockers; no instance created")
    return result


def schedule_request(name, account, deadline):
    return {
        "Name": name,
        "GroupName": GROUP,
        "ClientToken": name,
        "ScheduleExpression": "at(" + deadline.strftime("%Y-%m-%dT%H:%M:%S") + ")",
        "ScheduleExpressionTimezone": "UTC",
        "FlexibleTimeWindow": {"Mode": "OFF"},
        "State": "ENABLED",
        "ActionAfterCompletion": "DELETE",
        "Target": {
            "Arn": "arn:aws:scheduler:::aws-sdk:lightsail:deleteInstance",
            "RoleArn": f"arn:aws:iam::{account}:role/{ROLE}",
            "Input": json.dumps({
                "InstanceName": name,
                "ForceDeleteAddOns": True,
            }),
            "RetryPolicy": {
                "MaximumEventAgeInSeconds": 3600,
                "MaximumRetryAttempts": 10,
            },
        },
    }


def arm(scheduler, name, account, deadline):
    request = schedule_request(name, account, deadline)
    try:
        scheduler.create_schedule(**request)
    except ClientError as error:
        detail = error.response.get("Error", {})
        reason = str(detail.get("Code", "ClientError"))
        if reason == "ValidationException":
            reason += ": " + " ".join(str(detail.get("Message", "")).split())[:1000]
        raise RuntimeError("Cleanup schedule creation rejected: " + reason) from None
    actual = scheduler.get_schedule(Name=name, GroupName=GROUP)
    for key in (
        "ScheduleExpression",
        "ScheduleExpressionTimezone",
        "FlexibleTimeWindow",
        "State",
        "ActionAfterCompletion",
        "Target",
    ):
        require(actual.get(key) == request[key], "Deletion schedule read-back mismatch")


def host_bootstrap():
    key = Ed25519PrivateKey.generate()
    private = key.private_bytes(Encoding.PEM, PrivateFormat.OpenSSH, NoEncryption())
    public = key.public_key().public_bytes(
        Encoding.OpenSSH,
        PublicFormat.OpenSSH,
    ).decode()
    script = BOOTSTRAP.read_text(encoding="utf-8")
    require(
        script.count("__CAPACITY_HOST_KEY_BASE64__") == 1,
        "Expected one disposable host-key placeholder",
    )
    return (
        script.replace(
            "__CAPACITY_HOST_KEY_BASE64__",
            base64.b64encode(private).decode(),
        ),
        public,
    )


def wait_running(ls, name):
    deadline = time.monotonic() + 480
    while time.monotonic() < deadline:
        instance = get_instance(ls, name)
        if instance and instance["state"]["name"] == "running":
            require(owned(instance, name), "New instance ownership mismatch")
            require(
                instance["bundleId"] == BUNDLE
                and instance["blueprintId"] == BLUEPRINT
                and not instance.get("addOns"),
                "Unexpected instance configuration",
            )
            return instance
        time.sleep(5)
    raise RuntimeError("Instance startup deadline exceeded")


def wait_ssh_details(ls, instance, wait_seconds=300):
    deadline = time.monotonic() + wait_seconds
    previous_missing = None
    while True:
        access = ls.get_instance_access_details(
            instanceName=instance["name"],
            protocol="ssh",
        ).get("accessDetails", {})
        missing = [
            key
            for key in (
                "ipAddress",
                "instanceName",
                "username",
                "privateKey",
                "certKey",
            )
            if not access.get(key)
        ]
        if not missing:
            return access
        if time.monotonic() >= deadline:
            raise RuntimeError(
                "AWS SSH details not ready before deadline; missing fields: "
                + ", ".join(missing)
            )
        if missing != previous_missing:
            print("Waiting for AWS SSH fields: " + ", ".join(missing), flush=True)
            previous_missing = missing
        time.sleep(5)


def validate_ssh_certificate(access):
    try:
        certificate = load_ssh_public_identity(access["certKey"].encode())
        require(
            isinstance(certificate, SSHCertificate),
            "AWS SSH credential is not a certificate",
        )
        certificate.verify_cert_signature()
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError("Invalid AWS SSH certificate") from None

    now = datetime.now(timezone.utc)
    require(certificate.type == SSHCertificateType.USER, "Unexpected SSH certificate type")
    require(
        b"ubuntu" in certificate.valid_principals,
        "SSH certificate does not name the expected user",
    )
    require(
        certificate.valid_after <= now.timestamp(),
        "SSH certificate is not yet valid",
    )
    require(
        certificate.valid_before > now.timestamp() + 30,
        "SSH credential lifetime too short",
    )
    if access.get("expiresAt") is not None:
        expiry = access["expiresAt"]
        require(
            isinstance(expiry, datetime) and expiry > now + timedelta(seconds=30),
            "SSH API credential lifetime too short",
        )


def ssh_access(ls, instance, directory, pinned_host_key):
    access = wait_ssh_details(ls, instance)
    address = str(ipaddress.IPv4Address(access["ipAddress"]))
    require(
        address == instance["publicIpAddress"]
        and access["instanceName"] == instance["name"],
        "SSH endpoint mismatch",
    )
    require(access["username"] == "ubuntu", "Unexpected SSH account")
    validate_ssh_certificate(access)
    require(
        re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/=]+", pinned_host_key),
        "Invalid pinned test host key",
    )

    for name, value in (
        ("identity", access["privateKey"]),
        ("identity-cert.pub", access["certKey"]),
        ("known_hosts", address + " " + pinned_host_key),
    ):
        path = directory / name
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        with os.fdopen(descriptor, "w") as handle:
            handle.write(value.rstrip("\n") + "\n")

    options = [
        "-i",
        str(directory / "identity"),
        "-o",
        "CertificateFile=" + str(directory / "identity-cert.pub"),
        "-o",
        "UserKnownHostsFile=" + str(directory / "known_hosts"),
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
    ]
    return options, "ubuntu@" + address


@contextmanager
def ssh_connection(ls, instance, pinned_host_key):
    with tempfile.TemporaryDirectory(
        prefix="qf-ssh-",
        dir=os.environ["RUNNER_TEMP"],
    ) as tmp:
        yield ssh_access(ls, instance, Path(tmp), pinned_host_key)


def cleanup_instance(ls, name, wait_seconds=300):
    instance = get_instance(ls, name)
    if instance is None:
        return {
            "instance_absent": True,
            "schedule_retained": True,
            "note": "Fallback schedule remains armed, including for ambiguous creation errors",
        }
    require(
        owned(instance, name),
        "Refusing to delete an instance without the exact test ownership tags",
    )
    ls.delete_instance(instanceName=name, forceDeleteAddOns=True)
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        if get_instance(ls, name) is None:
            return {"instance_absent": True, "schedule_retained": True}
        time.sleep(5)
    raise RuntimeError(
        "Deletion not confirmed; keep the independent cleanup schedule armed"
    )
