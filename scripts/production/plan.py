"""Review a new, stopped production plan. Never applies a Terraform plan."""
from collections import Counter
import json
from pathlib import Path
import sys


def review(plan):
    if plan.get("errored") or not plan.get("applyable"):
        raise ValueError("Plan is not a complete applyable infrastructure proposal")
    changes = [c for c in plan.get("resource_changes", []) if c.get("mode") == "managed"]
    if not changes or any(c["change"]["actions"] not in (["create"], ["no-op"]) for c in changes):
        raise ValueError("Initial production proposal may only create resources or leave them unchanged")
    after = {c["address"]: c["change"]["after"] for c in changes}
    db = after["aws_db_instance.db"]
    if (db["identifier"] != "quizforge-production" or db["publicly_accessible"]
            or not db["storage_encrypted"] or not db["deletion_protection"]
            or db["skip_final_snapshot"] or db["delete_automated_backups"] or db["backup_retention_period"] < 7):
        raise ValueError("Database does not meet the retained private production boundary")
    for name in ("api", "identity"):
        if after[f'aws_ecs_service.app["{name}"]']["desired_count"] != 0:
            raise ValueError("Application must remain stopped before data reconciliation")
    if not after["aws_cognito_user_pool.browser"]["admin_create_user_config"][0]["allow_admin_create_user_only"]:
        raise ValueError("Public signup must remain off in the first proposal")
    if any(address.startswith(("aws_route53_record.api[", "aws_route53_record.site[", "aws_route53_record.site_ipv6[")) for address in after):
        raise ValueError("Application routing must not be published by the first proposal")
    return dict(sorted(Counter(c["type"] for c in changes).items()))


if __name__ == "__main__":
    counts = review(json.loads(Path(sys.argv[1]).read_text()))
    print(json.dumps({"resources": sum(counts.values()), "types": counts,
                      "application_tasks": 0, "public_signup": False, "application_dns": False,
                      "applied": False}, indent=2, sort_keys=True))
