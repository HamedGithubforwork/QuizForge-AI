"""Read-only readiness checks and strict live HTTPS verification for staging.

Never requests certificates, changes DNS, reads secrets, or contacts production.
AWS imports are lazy so the safety tests run with only the Python standard library.
"""
from datetime import datetime, timedelta, timezone
import json
import os
import re
import ssl
import subprocess
import sys
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener, HTTPSHandler


def require(condition, message):
    if not condition:
        raise ValueError(message)


def settings(env):
    host = env.get("TF_VAR_staging_hostname", "")
    arn = env.get("TF_VAR_staging_certificate_arn", "")
    zone = env.get("TF_VAR_staging_zone_id", "")
    require(re.fullmatch(r"staging-api\.([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}", host),
            "Configure a dedicated staging-api hostname for a domain you control.")
    require(re.fullmatch(r"arn:aws:acm:ca-central-1:[0-9]{12}:certificate/[a-f0-9-]{36}", arn),
            "Configure an issued ca-central-1 ACM certificate ARN.")
    require(re.fullmatch(r"Z[A-Z0-9]+", zone), "Configure the existing public Route 53 zone ID.")
    return host, arn, zone


def covers(name, host):
    name = name.lower().rstrip(".")
    return name == host or (name.startswith("*.") and name.count(".") == host.count(".")
                            and host.endswith(name[1:]))


def validate_certificate(certificate, host, arn, account, now):
    require(arn.split(":")[4] == account, "Certificate must belong to this AWS account.")
    require(certificate.get("CertificateArn") == arn, "Certificate identity mismatch.")
    require(certificate.get("Status") == "ISSUED", "Certificate is not issued.")
    require(certificate.get("Type") == "AMAZON_ISSUED", "Use an ACM-issued public certificate.")
    require(certificate.get("NotBefore", now + timedelta(days=1)) <= now,
            "Certificate validity has not started.")
    require(certificate.get("NotAfter", now) > now + timedelta(days=7),
            "Certificate expires within seven days.")
    require(any(covers(name, host) for name in certificate.get("SubjectAlternativeNames", [])),
            "Certificate does not cover the staging hostname.")


def validate_zone(zone, host, records):
    require(zone["Config"].get("PrivateZone") is False, "Staging requires a public DNS zone.")
    name = zone["Name"].lower().rstrip(".")
    require(host != name and host.endswith("." + name), "Staging hostname must be within the selected zone.")
    require(not any(record["Name"].lower().rstrip(".") == host for record in records),
            "An existing DNS record uses this hostname; refusing to replace it.")


def preflight():
    import boto3
    host, arn, zone_id = settings(os.environ)
    require(os.getenv("FUNCTIONAL_VALIDATION") != "true" and os.getenv("HISTORY_VALIDATION") != "true",
            "Run HTTPS validation separately from legacy HTTP functional/history tests.")
    acm = boto3.client("acm", region_name="ca-central-1")
    account = boto3.client("sts").get_caller_identity()["Account"]
    validate_certificate(acm.describe_certificate(CertificateArn=arn)["Certificate"],
                         host, arn, account, datetime.now(timezone.utc))
    dns = boto3.client("route53")
    zone = dns.get_hosted_zone(Id=zone_id)["HostedZone"]
    records = dns.list_resource_record_sets(HostedZoneId=zone_id, StartRecordName=host, MaxItems="10")["ResourceRecordSets"]
    validate_zone(zone, host, records)
    print("PASS: certificate account/region/validity/hostname and unused public staging DNS name verified")


def inspect():
    import boto3
    dns = boto3.client("route53")
    zones = [zone for page in dns.get_paginator("list_hosted_zones").paginate()
             for zone in page["HostedZones"] if not zone["Config"]["PrivateZone"]]
    print(f"Public Route 53 hosted zones: {len(zones)}")
    # Do not publish unrelated domain names, contact information or private DNS names.
    print(f"Public zones whose name contains quizforge: {sum('quizforge' in z['Name'].lower() for z in zones)}")
    registrar = boto3.client("route53domains", region_name="us-east-1")
    domains = [domain for page in registrar.get_paginator("list_domains").paginate() for domain in page["Domains"]]
    print(f"Domains registered through Route 53: {len(domains)}")
    for region in ("ca-central-1", "us-east-1"):
        acm = boto3.client("acm", region_name=region)
        certificates = [certificate for page in acm.get_paginator("list_certificates").paginate(
            Includes={"keyTypes": ["RSA_1024", "RSA_2048", "RSA_3072", "RSA_4096", "EC_prime256v1", "EC_secp384r1", "EC_secp521r1"]})
                        for certificate in page["CertificateSummaryList"]]
        issued = sum(c.get("Status") == "ISSUED" for c in certificates)
        print(f"ACM certificates in {region}: {len(certificates)} ({issued} issued)")
    try:
        settings(os.environ)
    except ValueError:
        print("HTTPS readiness: NOT CONFIGURED. No staging domain/certificate/zone configuration is available.")
    else:
        preflight()
    print("Read-only inventory complete. No AWS resources, certificates or DNS records were created or modified.")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, headers=None):
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    opener = build_opener(NoRedirect, HTTPSHandler(context=context))
    try:
        response = opener.open(Request(url, headers=headers or {}), timeout=15)
    except HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read()


def live():
    host, _, _ = settings(os.environ)
    output = json.loads(subprocess.check_output(["terraform", "output", "-json"]))
    base = output["api_url"]["value"]
    require(base == "https://" + host, "Refusing a noncanonical HTTPS endpoint.")
    http = output["api_http_url"]["value"]
    require(re.fullmatch(r"http://quizforge-staging-api-[0-9]+\.ca-central-1\.elb\.amazonaws\.com", http),
            "Refusing an unrelated load balancer.")
    for origin in (http, "http://" + host):
        status, headers, _ = request(origin + "/api/health?https_probe=1")
        require(status == 301 and headers.get("Location") == base + "/api/health?https_probe=1",
                "HTTP must redirect to the canonical HTTPS host with path and query preserved.")
    status, _, body = request(base + "/api/health")
    require(status == 200 and isinstance(json.loads(body), dict), "TLS-verified health probe failed.")
    status, _, _ = request(base + "/api/documents/" + "0" * 64 + "/pages/1")
    require(status == 401, "Protected route must reject an unauthenticated request.")
    status, _, _ = request(base + "/api/health", {"Host": "unrelated.invalid"})
    require(status == 404, "Unexpected Host must not be forwarded to FastAPI.")
    print("PASS: verified TLS/hostname, canonical HTTP redirects, health, authentication rejection and host isolation")


def absent():
    import boto3
    from botocore.exceptions import ClientError
    require(not json.loads(subprocess.check_output(["terraform", "output", "-json"])),
            "Staging Terraform outputs remain after cleanup.")
    for client_name, method, args, missing_code in (
        ("elbv2", "describe_load_balancers", {"Names": ["quizforge-staging-api"]}, "LoadBalancerNotFound"),
        ("elasticache", "describe_replication_groups", {"ReplicationGroupId": "quizforge-staging-valkey"}, "ReplicationGroupNotFoundFault"),
    ):
        try:
            getattr(boto3.client(client_name, region_name="ca-central-1"), method)(**args)
        except ClientError as error:
            require(error.response["Error"]["Code"] == missing_code, "AWS did not confirm resource absence.")
        else:
            raise ValueError("A staging load balancer or cache remains.")
    ecs = boto3.client("ecs", region_name="ca-central-1")
    response = ecs.describe_services(cluster="quizforge-api", services=["quizforge-api-staging"])
    require(all(f["reason"] == "MISSING" for f in response.get("failures", [])), "ECS lookup did not confirm absence.")
    require(all(s["status"] == "INACTIVE" and s["runningCount"] == 0 and s["pendingCount"] == 0
                for s in response.get("services", [])), "Staging ECS service is still active.")
    for page in ecs.get_paginator("list_tasks").paginate(
            cluster="quizforge-api", family="quizforge-api-staging", desiredStatus="RUNNING"):
        require(not page.get("taskArns"), "Staging Fargate tasks remain.")
    host, zone = os.getenv("TF_VAR_staging_hostname", ""), os.getenv("TF_VAR_staging_zone_id", "")
    if host and zone:
        settings(os.environ)
        dns = boto3.client("route53")
        records = dns.list_resource_record_sets(HostedZoneId=zone, StartRecordName=host, MaxItems="10")["ResourceRecordSets"]
        require(not any(record["Name"].lower().rstrip(".") == host for record in records), "Staging DNS record remains.")
        print("PASS: temporary staging DNS alias is absent; prerequisite zone/certificate retained")
    print("PASS: staging ALB, active ECS service, Fargate tasks and Valkey are absent; Terraform outputs empty")


if __name__ == "__main__":
    try:
        {"inspect": inspect, "preflight": preflight, "live": live, "absent": absent}[sys.argv[1]]()
    except Exception as error:
        # Static errors only; never print service responses, credentials, or request data.
        print(f"HTTPS readiness/validation failed ({type(error).__name__}).", file=sys.stderr)
        if isinstance(error, ValueError):
            print(str(error), file=sys.stderr)
        raise SystemExit(1)
