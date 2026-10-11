"""Publish a reviewed frontend into an already-running disposable staging site.

Only the staging S3 bucket may be written. No Terraform apply, cloud resource
creation, deletion, credentials, or production endpoints are accepted.
"""
from datetime import datetime, timezone
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import time
from urllib.request import Request, urlopen

import control
from guards import HOST, NAME, permitted_state, public_config

REQUIRED = {
    "aws_s3_bucket.site", "aws_s3_bucket_policy.site",
    "aws_cloudfront_distribution.site", "aws_cognito_user_pool.browser",
    "aws_db_instance.db", "aws_elasticache_replication_group.cache",
    'aws_ecs_service.app["api"]', 'aws_ecs_service.app["identity"]',
}
MINIMUM_REMAINING_SECONDS = 600


def checked_config(resources, values, now=None):
    if not resources:
        raise ValueError("No active staging state; run the full staging workflow first.")
    permitted_state(resources)
    if not REQUIRED.issubset(set(resources)) or not values or values.get("name") != NAME:
        raise ValueError("Required disposable staging resources are missing.")
    data = public_config({
        "pool": values["pool"],
        "client": values["client"],
        "auth_origin": f'https://{values["auth_domain"]}.auth.ca-central-1.amazoncognito.com',
        "frontend_url": f'https://{values["domain"]}',
        "api_url": values["api_url"],
        "deadline": values["deadline"],
    })
    remaining = datetime.fromisoformat(data["deadline"].replace("Z", "+00:00")) - (
        now or datetime.now(timezone.utc)
    )
    if remaining.total_seconds() < MINIMUM_REMAINING_SECONDS:
        raise ValueError("Staging lease is nearly expired; start a fresh full run.")
    return data


def live():
    values = control.values()
    config = checked_config(control.state_resources(), values)
    account = control.client("sts").get_caller_identity()["Account"]
    if values["bucket"] != f"{NAME}-{account}" or config["api_url"] != f"https://{HOST}":
        raise ValueError("Staging ownership checks failed.")
    # Reuse existing integrated-staging verification for TLS, RDS, Cognito,
    # cache and sealed application tasks, before any publication.
    control.verify_config(values)
    s3 = control.client("s3")
    block = s3.get_public_access_block(Bucket=values["bucket"])["PublicAccessBlockConfiguration"]
    if not all(block.get(name) is True for name in (
        "BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"
    )):
        raise ValueError("The staging bucket is not private.")
    if s3.get_bucket_policy_status(Bucket=values["bucket"])["PolicyStatus"]["IsPublic"]:
        raise ValueError("Staging bucket policy is public.")
    policy = json.loads(s3.get_bucket_policy(Bucket=values["bucket"])["Policy"])
    allows = [item for item in policy["Statement"] if item["Effect"] == "Allow"]
    source = f'arn:aws:cloudfront::{account}:distribution/{values["distribution"]}'
    if len(allows) != 1 or any((
        allows[0].get("Action") != "s3:GetObject",
        allows[0].get("Principal") != {"Service": "cloudfront.amazonaws.com"},
        allows[0].get("Resource") != f'arn:aws:s3:::{values["bucket"]}/*',
        allows[0].get("Condition") != {"StringEquals": {"AWS:SourceArn": source}},
    )):
        raise ValueError("Staging bucket is not restricted to the owned CloudFront origin.")
    if s3.head_object(Bucket=values["bucket"], Key="index.html")["ContentLength"] < 30:
        raise ValueError("Staging site has not yet been published.")
    cf = control.client("cloudfront")
    dist = cf.get_distribution(Id=values["distribution"])["Distribution"]
    settings = dist["DistributionConfig"]
    if dist["Status"] != "Deployed" or not settings["Enabled"] or (
        settings["DefaultRootObject"] != "index.html"
    ):
        raise ValueError("Staging distribution not ready.")
    origins = settings["Origins"]["Items"]
    if len(origins) != 1 or origins[0]["DomainName"] != values["origin"]:
        raise ValueError("Staging distribution origin changed.")
    oac = cf.get_origin_access_control(Id=origins[0]["OriginAccessControlId"])["OriginAccessControl"]["OriginAccessControlConfig"]
    if oac["SigningBehavior"] != "always" or oac["SigningProtocol"] != "sigv4":
        raise ValueError("Staging frontend origin is not signed.")
    policy_id = settings["DefaultCacheBehavior"]["CachePolicyId"]
    cache = cf.get_cache_policy(Id=policy_id)["CachePolicy"]["CachePolicyConfig"]
    if any(cache[k] != 0 for k in ("MinTTL", "DefaultTTL", "MaxTTL")):
        raise ValueError("Staging HTML cache cannot be refreshed without invalidation.")
    ecs = control.client("ecs").describe_services(
        cluster=values["cluster"], services=[NAME + "-api", NAME + "-identity"]
    )
    if ecs.get("failures") or len(ecs["services"]) != 2 or any(
        s["status"] != "ACTIVE" or s["desiredCount"] < 1 or s["runningCount"] < 1
        for s in ecs["services"]
    ):
        raise ValueError("Staging application services are not running.")
    return values, config


def export():
    _, config = live()
    Path("integration-config.json").write_text(json.dumps(config, sort_keys=True))
    print("PASS: live disposable staging lease and public frontend settings verified")


def publish():
    values, config = live()
    if json.loads(Path("integration-config.json").read_text()) != config:
        raise ValueError("Frontend was built against an outdated staging configuration.")
    manifest = json.loads(Path("hosting-manifest.json").read_text())
    if control.hosting.inventory("hosting-dist") != manifest:
        raise ValueError("Built frontend does not match artifact manifest.")
    s3 = control.client("s3")
    for key in sorted(manifest, key=lambda item: item == "index.html"):
        content = (Path("hosting-dist") / key).read_bytes()
        if key.startswith("assets/"):
            try:
                old = s3.get_object(Bucket=values["bucket"], Key=key)["Body"].read()
            except control.client("s3").exceptions.NoSuchKey:
                old = None
            if old is not None:
                if hashlib.sha256(old).digest() != hashlib.sha256(content).digest():
                    raise ValueError("An immutable staging asset has a conflicting body.")
                continue
        mime = {".html": "text/html", ".js": "application/javascript",
                ".css": "text/css", ".svg": "image/svg+xml"}.get(
                    Path(key).suffix, mimetypes.guess_type(key)[0] or "application/octet-stream"
                )
        s3.put_object(Bucket=values["bucket"], Key=key, Body=content,
                      ContentType=mime, ServerSideEncryption="AES256",
                      CacheControl="public, max-age=31536000, immutable" if key.startswith("assets/") else "no-store")
    expected = (Path("hosting-dist") / "index.html").read_bytes()
    if s3.get_object(Bucket=values["bucket"], Key="index.html")["Body"].read() != expected:
        raise ValueError("Staging index integrity verification failed.")
    url = config["frontend_url"] + "/"
    for attempt in range(5):
        try:
            with urlopen(Request(url, headers={"User-Agent": "QuizForge-Staging-Probe"}), timeout=15) as response:
                if response.status == 200 and response.read() == expected:
                    break
        except OSError:
            pass
        if attempt == 4:
            raise ValueError("Updated frontend was not visible over staging HTTPS.")
        time.sleep(4)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
        output.write(f"## Fast frontend update succeeded\n\n[Open existing staging URL]({url})\n\n")
        output.write("No database, Cognito, backend, infrastructure or lease changes.\n")
    print("PASS: reviewed frontend published to existing staging URL without infrastructure changes")


if __name__ == "__main__":
    import sys
    try:
        {"export": export, "publish": publish}[sys.argv[1]]()
    except Exception as error:
        # Do not emit AWS service responses, tokens or source text.
        print("Fast staging refresh refused: " + type(error).__name__)
        raise SystemExit(1)
