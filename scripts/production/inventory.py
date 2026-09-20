"""Read-only AWS launch inventory. Never read secrets or publish account details."""
import json
import os

import boto3
from botocore.exceptions import ClientError


DOMAIN = "quizfromnotes.com"
NAMES = {DOMAIN + ".", "www." + DOMAIN + ".", "api." + DOMAIN + "."}


def inspect(check):
    try:
        return {"status": "verified", "result": check()}
    except ClientError as error:
        # AWS messages may contain account IDs and resource names. Emit codes only.
        return {"status": "unknown", "error_code": error.response["Error"]["Code"]}
    except (AttributeError, KeyError):
        return {"status": "unknown", "error_code": "UnsupportedResponse"}


def account_plan():
    data = boto3.client("freetier", region_name="us-east-1").get_account_plan_state()
    # Public Actions logs must not contain balances, billing amounts or dates.
    return {key: data.get(key) for key in ("accountPlanType", "accountPlanStatus")}


def dns():
    client = boto3.client("route53")
    zone = client.get_hosted_zone(Id=os.environ["ZONE_ID"])["HostedZone"]
    if zone["Name"] != DOMAIN + "." or zone["Config"]["PrivateZone"]:
        raise ValueError("Configured zone is not the public application zone")
    records = []
    for page in client.get_paginator("list_resource_record_sets").paginate(HostedZoneId=zone["Id"]):
        records.extend({"name": r["Name"], "type": r["Type"]}
                       for r in page["ResourceRecordSets"] if r["Name"] in NAMES)
    return records


def certificates(region):
    client = boto3.client("acm", region_name=region)
    result = []
    for page in client.get_paginator("list_certificates").paginate():
        for cert in page["CertificateSummaryList"]:
            if cert["DomainName"] not in {DOMAIN, "www." + DOMAIN, "api." + DOMAIN}:
                continue
            detail = client.describe_certificate(CertificateArn=cert["CertificateArn"])["Certificate"]
            result.append({"domain": detail["DomainName"], "status": detail["Status"],
                           "expires": detail.get("NotAfter")})
    return result


def budgets():
    account = boto3.client("sts").get_caller_identity()["Account"]
    client = boto3.client("budgets", region_name="us-east-1")
    result = []
    for page in client.get_paginator("describe_budgets").paginate(AccountId=account):
        for budget in page["Budgets"]:
            # Existing account-wide budgets are counted, without exposing names,
            # filters, linked accounts or alert recipients in this public repo.
            result.append({"type": budget["BudgetType"], "period": budget["TimeUnit"]})
    return result


def main():
    report = {"account_plan": inspect(account_plan), "application_dns": inspect(dns),
              "api_certificates": inspect(lambda: certificates("ca-central-1")),
              "frontend_certificates": inspect(lambda: certificates("us-east-1")),
              "budgets": inspect(budgets)}
    print(json.dumps(report, default=str, sort_keys=True, indent=2))
    print("Read-only inventory complete. Unknown checks are blockers, not successful verification.")


if __name__ == "__main__":
    main()
