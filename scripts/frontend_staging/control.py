"""Trusted, main-only controller for disposable private S3 + CloudFront hosting."""
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import boto3
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[2]
TF = ROOT / "infra/aws/frontend-staging"
NAME = "quizforge-frontend-staging"


def output():
    return json.loads(subprocess.check_output(["terraform", f"-chdir={TF}", "output", "-json"]))


def inventory(directory):
    files = {}
    total = 0
    for path in sorted(Path(directory).rglob("*")):
        if path.is_symlink():
            raise ValueError("Symlinks are not deployment artifacts")
        if not path.is_file():
            continue
        key = path.relative_to(directory).as_posix()
        if not (key in {"index.html", "favicon.svg", "icons.svg"} or re.fullmatch(
                r"assets/[A-Za-z0-9_-]+\.(?:js|css|svg|png|webp|woff2?)", key)):
            raise ValueError("Unexpected artifact path")
        content = path.read_bytes()
        total += len(content)
        if total > 20 * 1024 * 1024 or len(files) >= 100:
            raise ValueError("Hosting artifact exceeds size or file budget")
        files[key] = {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}
    if "index.html" not in files or not any(k.endswith(".js") for k in files):
        raise ValueError("Missing application entrypoint")
    return files


def configure():
    if output():
        raise ValueError("Stop the previous frontend staging environment first")
    deadline = (datetime.now(timezone.utc) + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    (TF / "hosting.auto.tfvars.json").write_text(json.dumps({"deadline": deadline}))
    print("Frontend hosting lease: one hour; workflow always destroys after validation")


def publish():
    value = output()["hosting"]["value"]
    account = boto3.client("sts").get_caller_identity()["Account"]
    if value["bucket"] != f"{NAME}-{account}":
        raise ValueError("Refusing an unrelated bucket")
    files = inventory(ROOT / "hosting-dist")
    if files != json.loads((ROOT / "hosting-manifest.json").read_text()):
        raise ValueError("Artifact manifest mismatch")
    s3 = boto3.client("s3", region_name="ca-central-1")
    if s3.list_objects_v2(Bucket=value["bucket"], MaxKeys=1).get("KeyCount", 0):
        raise ValueError("Fresh staging bucket must be empty")
    # Validate the security boundary against AWS, not just the Terraform source.
    block = s3.get_public_access_block(Bucket=value["bucket"])["PublicAccessBlockConfiguration"]
    assert all(block.get(k) is True for k in (
        "BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"))
    assert s3.get_bucket_policy_status(Bucket=value["bucket"])["PolicyStatus"]["IsPublic"] is False
    policy = json.loads(s3.get_bucket_policy(Bucket=value["bucket"])["Policy"])
    allows = [s for s in policy["Statement"] if s["Effect"] == "Allow"]
    assert len(allows) == 1
    assert allows[0]["Principal"] == {"Service": "cloudfront.amazonaws.com"}
    assert allows[0]["Action"] == "s3:GetObject"
    assert allows[0]["Resource"] == f"arn:aws:s3:::{value['bucket']}/*"
    assert allows[0]["Condition"]["StringEquals"]["AWS:SourceArn"] == (
        f"arn:aws:cloudfront::{account}:distribution/{value['distribution']}")
    encryption = s3.get_bucket_encryption(Bucket=value["bucket"])["ServerSideEncryptionConfiguration"]
    assert encryption["Rules"][0]["ApplyServerSideEncryptionByDefault"]["SSEAlgorithm"] == "AES256"
    assert s3.get_bucket_ownership_controls(Bucket=value["bucket"])["OwnershipControls"]["Rules"] == [
        {"ObjectOwnership": "BucketOwnerEnforced"}]
    cf = boto3.client("cloudfront")
    config = cf.get_distribution_config(Id=value["distribution"])["DistributionConfig"]
    origin = config["Origins"]["Items"]
    assert len(origin) == 1 and origin[0]["DomainName"] == value["origin"]
    oac = cf.get_origin_access_control(Id=origin[0]["OriginAccessControlId"])["OriginAccessControl"]["OriginAccessControlConfig"]
    assert oac["SigningBehavior"] == "always" and oac["SigningProtocol"] == "sigv4"
    assert config["ViewerCertificate"]["CloudFrontDefaultCertificate"] is True
    for behavior in [config["DefaultCacheBehavior"], *config.get("CacheBehaviors", {}).get("Items", [])]:
        assert behavior["ViewerProtocolPolicy"] == "redirect-to-https"
        assert set(behavior["AllowedMethods"]["Items"]) == {"GET", "HEAD"}
    # Upload immutable assets first, then the uncached entrypoint. No invalidation needed.
    for key in sorted(files, key=lambda key: key == "index.html"):
        content_type = {".js": "application/javascript", ".css": "text/css", ".html": "text/html"}.get(
            Path(key).suffix, mimetypes.guess_type(key)[0] or "application/octet-stream")
        s3.put_object(Bucket=value["bucket"], Key=key, Body=(ROOT / "hosting-dist" / key).read_bytes(),
                      ContentType=content_type, ServerSideEncryption="AES256",
                      CacheControl="public, max-age=31536000, immutable" if key.startswith("assets/") else "no-store")
    with open(os.environ["GITHUB_OUTPUT"], "a") as target:
        target.write(f"url=https://{value['domain']}\norigin=https://{value['origin']}\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as target:
        target.write(f"Hosting-only frontend: https://{value['domain']}\n\n"
                     "API and authentication are disconnected. Always-cleanup removes this environment after the test.\n")
    print("PASS: private encrypted S3, distribution-scoped OAC, HTTPS and artifact hashes verified; files uploaded")


def missing(call, codes, **kwargs):
    try:
        call(**kwargs)
    except ClientError as error:
        if error.response["Error"]["Code"] in codes:
            return
        raise
    raise AssertionError("Temporary resource still exists")


def absent():
    assert not output(), "Terraform outputs remain"
    account = boto3.client("sts").get_caller_identity()["Account"]
    s3 = boto3.client("s3", region_name="ca-central-1")
    missing(s3.head_bucket, {"404", "NoSuchBucket"}, Bucket=f"{NAME}-{account}")
    cf = boto3.client("cloudfront")
    for page in cf.get_paginator("list_distributions").paginate():
        assert all(d.get("Comment") != NAME for d in page.get("DistributionList", {}).get("Items", []))
    missing(cf.describe_function, {"NoSuchFunctionExists"}, Name=NAME, Stage="DEVELOPMENT")
    marker = None
    while True:
        args = {"Marker": marker} if marker else {}
        values = cf.list_origin_access_controls(**args)["OriginAccessControlList"]
        assert all(v["Name"] != NAME for v in values.get("Items", []))
        if not values.get("IsTruncated"):
            break
        marker = values["NextMarker"]
    for method, key, item_key in (
        (cf.list_cache_policies, "CachePolicyList", "CachePolicy"),
        (cf.list_response_headers_policies, "ResponseHeadersPolicyList", "ResponseHeadersPolicy"),
    ):
        marker = None
        while True:
            values = method(Type="custom", **({"Marker": marker} if marker else {})).get(key, {})
            for item in values.get("Items", []):
                assert not item[item_key][item_key + "Config"]["Name"].startswith(NAME)
            marker = values.get("NextMarker")
            if not marker:
                break
    print("PASS: frontend S3 bucket/objects, CloudFront distribution, OAC, function and policies are absent; state outputs empty")


if __name__ == "__main__":
    try:
        {"configure": configure, "publish": publish, "absent": absent}[sys.argv[1]]()
    except Exception as error:
        # Never print service responses, environment variables or untrusted build text.
        import traceback
        frame = traceback.extract_tb(error.__traceback__)[-1]
        print(f"Frontend staging failed: {type(error).__name__} at {Path(frame.filename).name}:{frame.lineno}", file=sys.stderr)
        raise SystemExit(1)
