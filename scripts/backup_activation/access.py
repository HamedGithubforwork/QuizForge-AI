"""Restricted OIDC sessions and private, separate Terraform credential profiles.

These are session restrictions on the EXISTING role, not IAM policies to attach.
No identity, trust policy, access key, or managed-policy attachment is changed.
"""
from __future__ import annotations

import configparser
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request

from .contract import REGION, STATE_KEY, WORKSPACE_PREFIX, Settings, Refused, canonical, require

READ_ACTIONS = (
    "s3:ListBucket", "s3:GetBucketLocation", "s3:GetBucketAcl", "s3:GetBucketTagging",
    "s3:GetBucketPublicAccessBlock", "s3:GetBucketOwnershipControls", "s3:GetBucketVersioning",
    "s3:GetEncryptionConfiguration", "s3:GetLifecycleConfiguration", "s3:GetBucketPolicy",
    "s3:GetBucketPolicyStatus", "s3:GetBucketCORS", "s3:GetBucketWebsite", "s3:GetBucketLogging",
    "s3:GetReplicationConfiguration", "s3:GetAccelerateConfiguration", "s3:GetBucketRequestPayment",
    "s3:GetBucketObjectLockConfiguration",
    "iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyTags",
    "sns:GetTopicAttributes", "sns:GetSubscriptionAttributes", "sns:ListSubscriptionsByTopic",
    "sns:ListTagsForResource", "cloudwatch:DescribeAlarms", "cloudwatch:ListTagsForResource",
)
WRITE_ACTIONS = (
    "s3:CreateBucket", "s3:PutBucketTagging", "s3:PutBucketPublicAccessBlock",
    "s3:PutBucketOwnershipControls", "s3:PutBucketVersioning", "s3:PutEncryptionConfiguration",
    "s3:PutLifecycleConfiguration", "s3:PutBucketPolicy", "iam:CreatePolicy", "iam:TagPolicy",
    "sns:CreateTopic", "sns:TagResource", "sns:SetTopicAttributes",
    "cloudwatch:PutMetricAlarm", "cloudwatch:TagResource",
)


def statement(actions, resources, condition=None) -> dict:
    result = {"Effect": "Allow", "Action": actions, "Resource": resources}
    if condition:
        result["Condition"] = condition
    return result


def encode_session_policy(statements: list[dict]) -> str:
    text = canonical({"Version": "2012-10-17", "Statement": statements})
    # No managed-policy ARNs or session tags are passed by this implementation.
    require(text.isascii() and len(text) <= 2048, "SESSION_POLICY_SIZE_EXCEEDED")
    return text


def resource_policy(settings: Settings, write: bool = False) -> str:
    resources = [settings.bucket_arn, settings.topic, settings.alarm,
                 *(settings.policy_arn(name) for name in ("uploader", "recovery", "health"))]
    # Service actions only authorize their own ARN resource types. Combining
    # explicit actions/ARNs reduces JSON size without a wildcard account, name,
    # action, or backup-object permission. State ARNs are deliberately excluded.
    statements = [
        statement(list(READ_ACTIONS) + (list(WRITE_ACTIONS) if write else []), resources),
        statement("sts:GetCallerIdentity", "*"),
    ]
    if write:
        statements.append(statement("sns:Subscribe", settings.topic, {
            "StringEquals": {"sns:Protocol": "email", "sns:Endpoint": settings.email}}))
    return encode_session_policy(statements)


def state_policy(settings: Settings, write: bool = False) -> str:
    bucket = f"arn:aws:s3:::{settings.state_bucket}"
    state = f"{bucket}/{STATE_KEY}"
    return encode_session_policy([
        statement("sts:GetCallerIdentity", "*"),
        statement(["s3:GetBucketLocation", "s3:GetBucketVersioning"], bucket),
        statement("s3:ListBucket", bucket, {"StringEquals": {
            "s3:prefix": [STATE_KEY, STATE_KEY + ".tflock", WORKSPACE_PREFIX + "/"]}}),
        statement(["s3:GetObject"] + (["s3:PutObject"] if write else []), state),
        statement(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], state + ".tflock"),
    ])


def private_write(path: Path, data: str) -> None:
    # Only caller-owned paths below the private temporary directory are used.
    with path.open("w", encoding="utf-8") as stream:
        stream.write(data)
    path.chmod(0o600)


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Refused("OIDC_REDIRECT_REFUSED")


def github_oidc_token(env: dict[str, str]) -> str:
    endpoint = env.get("ACTIONS_ID_TOKEN_REQUEST_URL", "")
    bearer = env.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "")
    url = urllib.parse.urlsplit(endpoint)
    require(url.scheme == "https" and bool(url.hostname)
            and url.hostname.endswith(".actions.githubusercontent.com")
            and url.port in (None, 443) and not url.username and not url.password
            and not url.fragment and bool(bearer), "OIDC_ENVIRONMENT_INVALID")
    query = urllib.parse.parse_qsl(url.query, keep_blank_values=True)
    require(not any(k == "audience" for k, _ in query), "OIDC_AUDIENCE_ALREADY_SET")
    query.append(("audience", "sts.amazonaws.com"))
    target = urllib.parse.urlunsplit(url._replace(query=urllib.parse.urlencode(query)))
    request = urllib.request.Request(target, headers={"Authorization": f"Bearer {bearer}"})
    opener = urllib.request.build_opener(NoRedirects())
    with opener.open(request, timeout=15) as response:
        raw = response.read(131073)
    require(len(raw) <= 131072, "OIDC_RESPONSE_TOO_LARGE")
    token = json.loads(raw).get("value")
    require(isinstance(token, str) and len(token.split(".")) == 3, "OIDC_RESPONSE_INVALID")
    return token


class Sessions:
    def __init__(self, settings: Settings, directory: Path, env: dict[str, str]):
        # Lazy imports keep PR unit tests independent of the AWS SDK.
        import boto3
        from botocore import UNSIGNED
        from botocore.config import Config
        self.settings, self.directory, self.env = settings, directory, env
        self.boto3, self.Config = boto3, Config
        self.config = Config(ignore_configured_endpoint_urls=True, connect_timeout=10,
                             read_timeout=20, retries={"total_max_attempts": 2, "mode": "standard"})
        self.sts = boto3.client("sts", region_name=REGION, config=Config(
            signature_version=UNSIGNED, ignore_configured_endpoint_urls=True,
            connect_timeout=10, read_timeout=20, retries={"total_max_attempts": 1}))
        self.credentials: dict[str, dict] = {}

    def obtain(self, profile: str, policy: str) -> None:
        require(profile in {"qf-resources", "qf-state"}, "PROFILE_INVALID")
        require(policy.isascii() and len(policy) <= 2048, "SESSION_POLICY_SIZE_EXCEEDED")
        token = github_oidc_token(self.env)
        result = self.sts.assume_role_with_web_identity(
            RoleArn=self.settings.role, RoleSessionName="qf-backup-" + profile[3:],
            WebIdentityToken=token, Policy=policy, DurationSeconds=1800)
        require(result.get("PackedPolicySize", 0) <= 100, "PACKED_SESSION_POLICY_SIZE_EXCEEDED")
        credentials = result["Credentials"]
        self.credentials[profile] = credentials
        identity = self.client("sts", profile).get_caller_identity()
        require(identity.get("Account") == self.settings.account, "AWS_ACCOUNT_MISMATCH")
        expected_role_name = self.settings.role.rsplit("/", 1)[1]
        prefix = f"arn:aws:sts::{self.settings.account}:assumed-role/{expected_role_name}/"
        require(identity.get("Arn", "").startswith(prefix), "AWS_SESSION_ROLE_MISMATCH")

    def prepare(self, write: bool = False, include_state: bool = True) -> None:
        # Check EVERY requested policy size before asking STS for credentials.
        resources = resource_policy(self.settings, write)
        state = state_policy(self.settings, write) if include_state else None
        self.credentials.clear()
        self.obtain("qf-resources", resources)
        if state is not None:
            self.obtain("qf-state", state)
        self.write_profiles()

    def client(self, service: str, profile: str = "qf-resources"):
        credentials = self.credentials[profile]
        return self.boto3.client(service, region_name=REGION, config=self.config,
            aws_access_key_id=credentials["AccessKeyId"],
            aws_secret_access_key=credentials["SecretAccessKey"],
            aws_session_token=credentials["SessionToken"])

    def write_profiles(self) -> None:
        from io import StringIO
        credentials_file = configparser.ConfigParser(interpolation=None)
        config_file = configparser.ConfigParser(interpolation=None)
        for name, values in self.credentials.items():
            credentials_file[name] = {"aws_access_key_id": values["AccessKeyId"],
                "aws_secret_access_key": values["SecretAccessKey"],
                "aws_session_token": values["SessionToken"]}
            config_file["profile " + name] = {"region": REGION}
        for name, data in (("credentials", credentials_file), ("config", config_file)):
            buffer = StringIO()
            data.write(buffer)
            private_write(self.directory / name, buffer.getvalue())

    def terraform_env(self) -> dict[str, str]:
        # No ambient AWS credentials, endpoint overrides, TF_CLI_ARGS, proxy,
        # debug logging, user CLI config, or GitHub token reaches Terraform.
        result = {key: self.env[key] for key in ("PATH", "LANG", "LC_ALL") if key in self.env}
        private_write(self.directory / "terraform.rc", "disable_checkpoint = true\n")
        result.update({
            "HOME": str(self.directory), "TMPDIR": str(self.directory),
            "AWS_SHARED_CREDENTIALS_FILE": str(self.directory / "credentials"),
            "AWS_CONFIG_FILE": str(self.directory / "config"), "AWS_PROFILE": "qf-resources",
            "AWS_REGION": REGION, "AWS_DEFAULT_REGION": REGION, "AWS_SDK_LOAD_CONFIG": "1",
            "AWS_EC2_METADATA_DISABLED": "true", "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS": "true",
            "TF_IN_AUTOMATION": "true", "TF_INPUT": "false", "TF_WORKSPACE": "default",
            "TF_CLI_CONFIG_FILE": str(self.directory / "terraform.rc"),
            "TF_DATA_DIR": str(self.directory / "tfdata"), "CHECKPOINT_DISABLE": "1",
            "TF_VAR_alert_email": self.settings.email,
        })
        return result
