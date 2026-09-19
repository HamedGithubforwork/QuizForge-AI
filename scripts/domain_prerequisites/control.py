"""Guard the isolated domain stack and report actual DNS/certificate readiness."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

DOMAIN = "quizfromnotes.com"
HOSTNAME = "staging-api." + DOMAIN
ROOT = Path(__file__).resolve().parents[2]
TF = ROOT / "infra/aws/domain"
ALLOWED = {
    "aws_route53_zone.domain", "aws_acm_certificate.staging_api",
    "aws_route53_record.validation",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def output():
    result = subprocess.check_output(["terraform", f"-chdir={TF}", "output", "-json"], text=True)
    return {key: entry["value"] for key, entry in json.loads(result).items()}


def check_existing_zones(zones, owned_id):
    matches = [zone for zone in zones if zone["Name"].rstrip(".").lower() == DOMAIN]
    require(all(zone["Id"].split("/")[-1] == owned_id for zone in matches),
            "The domain already has a zone outside this Terraform state; refuse a duplicate or takeover.")
    require(all(not zone["Config"]["PrivateZone"] for zone in matches),
            "The domain prerequisite zone must be public.")


def preflight():
    import boto3
    dns = boto3.client("route53")
    zones = [zone for page in dns.get_paginator("list_hosted_zones").paginate()
             for zone in page["HostedZones"]]
    check_existing_zones(zones, output().get("zone_id"))
    print("PASS: no unmanaged duplicate domain zone")


def check_plan(plan):
    managed = [change for change in plan.get("resource_changes", []) if change["mode"] == "managed"]
    require({change["address"] for change in managed} == ALLOWED,
            "Plan must contain exactly the domain zone, staging certificate and validation CNAME.")
    for item in managed:
        require(item["change"]["actions"] in (["create"], ["no-op"]),
                "Preparation only permits creation or no-op; updates, replacements and deletion need separate review.")
        value = item["change"]["after"]
        if item["address"] == "aws_route53_zone.domain":
            require(value.get("name") == DOMAIN and value.get("force_destroy") is False and not value.get("vpc"),
                    "Plan must create only the public registered-domain zone.")
        elif item["address"] == "aws_acm_certificate.staging_api":
            require(value.get("domain_name") == HOSTNAME and value.get("validation_method") == "DNS"
                    and value.get("key_algorithm") == "RSA_2048" and not value.get("certificate_authority_arn")
                    and value.get("options", [{}])[0].get("export") == "DISABLED"
                    and set(value.get("subject_alternative_names") or []) <= {HOSTNAME},
                    "Certificate must cover only staging, use DNS and disable export.")
        else:
            require(value.get("allow_overwrite") is False and value.get("ttl") == 300,
                    "Validation record must not overwrite DNS.")
            # ACM determines the random CNAME during creation; verify it again
            # from AWS in report(), before declaring preparation complete.
            if "name" not in item["change"].get("after_unknown", {}):
                require(value.get("type") == "CNAME" and
                        re.fullmatch(r"_[a-zA-Z0-9-]+\." + re.escape(HOSTNAME) + r"\.?", value.get("name", "")),
                        "Only the exact staging ACM validation CNAME is allowed.")


def report(verify=False):
    import boto3
    values = output()
    require(values.get("staging_hostname") == HOSTNAME, "Unexpected staging hostname in domain state.")
    zone_id = values["zone_id"]
    arn = values["certificate_arn"]
    account = boto3.client("sts").get_caller_identity()["Account"]
    require(arn.startswith(f"arn:aws:acm:ca-central-1:{account}:certificate/"),
            "Wrong certificate account or region.")
    dns = boto3.client("route53")
    zone = dns.get_hosted_zone(Id=zone_id)
    require(zone["HostedZone"]["Name"].rstrip(".") == DOMAIN and not zone["HostedZone"]["Config"]["PrivateZone"],
            "Wrong or private domain zone.")
    nameservers = sorted(zone["DelegationSet"]["NameServers"])
    require(nameservers == sorted(values["name_servers"]) and len(nameservers) == 4,
            "AWS nameservers do not match Terraform outputs.")
    cert = boto3.client("acm", region_name="ca-central-1").describe_certificate(CertificateArn=arn)["Certificate"]
    require(cert["DomainName"] == HOSTNAME and set(cert["SubjectAlternativeNames"]) == {HOSTNAME}
            and cert["Type"] == "AMAZON_ISSUED" and cert.get("Options", {}).get("Export") == "DISABLED",
            "Certificate scope, public issuance or non-exportability is incorrect.")
    validation = cert["DomainValidationOptions"]
    require(len(validation) == 1 and validation[0]["ValidationMethod"] == "DNS", "Unexpected validation method.")
    record = validation[0]["ResourceRecord"]
    require(record["Type"] == "CNAME" and record["Name"].endswith("." + HOSTNAME + ".")
            and record["Value"].endswith(".acm-validations.aws."), "Unexpected ACM validation record.")
    actual = dns.list_resource_record_sets(HostedZoneId=zone_id, StartRecordName=record["Name"],
                                          StartRecordType="CNAME", MaxItems="1")["ResourceRecordSets"]
    require(len(actual) == 1 and actual[0]["Name"] == record["Name"] and actual[0]["Type"] == "CNAME"
            and actual[0]["ResourceRecords"] == [{"Value": record["Value"]}], "ACM DNS record is missing or incorrect.")
    require(cert["Status"] in {"PENDING_VALIDATION", "ISSUED"}, "Certificate request has failed or expired.")
    lines = ["## Domain prerequisites", f"Domain: `{DOMAIN}`", f"Certificate status: **{cert['Status']}**",
             "At Porkbun, replace the domain nameservers with these four values:"]
    lines.extend(f"- `{name}`" for name in nameservers)
    lines.extend(["", "Repository variables to use after DNS delegation and successful verify:",
                  f"- `AWS_STAGING_API_HOSTNAME`: `{HOSTNAME}`",
                  f"- `AWS_STAGING_CERTIFICATE_ARN`: `{arn}`",
                  f"- `AWS_STAGING_ZONE_ID`: `{zone_id}`",
                  "", "Route 53 zone: USD 0.50/month plus applicable DNS queries. Non-exportable public ACM certificate: no certificate charge.",
                  "No application traffic, production records, ALB, ECS service, RDS, Valkey or NAT were created by this workflow."])
    if verify:
        public_ns = subprocess.check_output(["dig", "+short", "+time=5", "+tries=1", "NS", DOMAIN], text=True)
        require({line.rstrip(".").lower() for line in public_ns.splitlines()} == set(nameservers),
                "Public DNS delegation has not propagated to the four AWS nameservers.")
        sys.path.insert(0, str(ROOT / "scripts"))
        from aws_staging_https import validate_certificate, validate_zone
        from datetime import datetime, timezone
        validate_certificate(cert, HOSTNAME, arn, account, datetime.now(timezone.utc))
        records = dns.list_resource_record_sets(HostedZoneId=zone_id, StartRecordName=HOSTNAME, MaxItems="10")["ResourceRecordSets"]
        validate_zone(zone["HostedZone"], HOSTNAME, records)
        lines.append("PASS: public delegation, issued certificate and unused staging hostname verified. Live HTTPS staging has not yet run.")
    else:
        lines.append("Preparation complete; this does not establish HTTPS readiness. Delegate nameservers, then run verify.")
    summary = "\n\n".join(lines) + "\n"
    print(summary)
    if os.getenv("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as handle:
            handle.write(summary)


if __name__ == "__main__":
    try:
        operation = sys.argv[1]
        if operation == "preflight":
            preflight()
        elif operation == "plan":
            check_plan(json.loads(Path(sys.argv[2]).read_text()))
            print("PASS: saved plan only creates domain prerequisites; no replacement, deletion or application deployment")
        elif operation in {"report", "verify"}:
            report(verify=operation == "verify")
        else:
            raise ValueError("Unsupported domain operation.")
    except Exception as error:
        # No contact data, private keys, registrar credentials or certificate bodies.
        detail = getattr(error, "response", {}).get("Error", {})
        if detail:
            print(f"Domain setup failed: {getattr(error, 'operation_name', 'AWS')} {detail.get('Code', 'Error')}", file=sys.stderr)
        else:
            print(f"Domain setup failed: {error}", file=sys.stderr)
        sys.exit(1)
