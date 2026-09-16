"""Trusted workflow runner: inspect private RDS, run VPC probes, confirm cleanup.

Never retrieves database passwords. ECS resolves Secrets Manager references.
"""
import json
import subprocess
import sys
import time

NAME = "quizforge-rds-rehearsal"


def aws(*args, absent=False):
    result = subprocess.run(["aws", *args, "--output", "json"], capture_output=True, text=True, timeout=90)
    if result.returncode:
        if absent and ("DBInstanceNotFound" in result.stderr or "DBSnapshotNotFound" in result.stderr):
            return None
        raise RuntimeError(f"AWS {args[0]} {args[1]} failed")
    return json.loads(result.stdout or "{}")


def outputs():
    result = subprocess.run(["terraform", "output", "-json", "probe"], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, "No rehearsal Terraform outputs"
    return json.loads(result.stdout)


def check_database(identifier, values):
    db = aws("rds", "describe-db-instances", "--db-instance-identifier", identifier)["DBInstances"][0]
    assert db["DBInstanceStatus"] == "available"
    assert not db["PubliclyAccessible"] and db["StorageEncrypted"]
    assert db["BackupRetentionPeriod"] == 1 and db["DBInstanceClass"] == "db.t4g.micro"
    assert db["Engine"] == "postgres" and db["EngineVersion"].startswith("17.") and not db["MultiAZ"]
    assert {s["VpcSecurityGroupId"] for s in db["VpcSecurityGroups"]} == {values["database_group"]}
    assert {s["SubnetIdentifier"] for s in db["DBSubnetGroup"]["Subnets"]} == set(values["private_subnets"])
    group = aws("ec2", "describe-security-groups", "--group-ids", values["database_group"])["SecurityGroups"][0]
    rules = group["IpPermissions"]
    assert len(rules) == 1
    rule = rules[0]
    assert rule["IpProtocol"] == "tcp" and rule["FromPort"] == rule["ToPort"] == 5432
    assert not rule.get("IpRanges") and not rule.get("Ipv6Ranges") and not rule.get("PrefixListIds")
    assert [g["GroupId"] for g in rule["UserIdGroupPairs"]] == [values["security_group"]]
    print(f"PASS: {identifier} is private, encrypted, backed up, and reachable only from the app security group")


def ensure_parameters_active(identifier):
    deadline = time.monotonic() + 900
    rebooted = False
    while time.monotonic() < deadline:
        db = aws("rds", "describe-db-instances", "--db-instance-identifier", identifier)["DBInstances"][0]
        statuses = {group["ParameterApplyStatus"] for group in db["DBParameterGroups"]}
        if db["DBInstanceStatus"] == "available" and statuses == {"in-sync"}:
            print(f"PASS: {identifier} parameter group is active")
            return
        if db["DBInstanceStatus"] == "available" and "pending-reboot" in statuses and not rebooted:
            aws("rds", "reboot-db-instance", "--db-instance-identifier", identifier)
            rebooted = True
            print(f"Waiting for {identifier} to activate its static TLS parameter")
        time.sleep(15)
    raise RuntimeError("Database parameters did not become active within fifteen minutes")


def run_probe(phase):
    values = outputs()
    identifier = NAME if phase == "seed" else NAME + "-restore"
    ensure_parameters_active(identifier)
    check_database(identifier, values)
    if phase == "verify-restored":
        snapshot = aws("rds", "describe-db-snapshots", "--db-snapshot-identifier", NAME + "-verified-seed")["DBSnapshots"][0]
        assert snapshot["Status"] == "available" and snapshot["Encrypted"]
        assert snapshot["DBInstanceIdentifier"] == NAME
    overrides = {"containerOverrides": [{"name": "probe", "command": ["python", "probe.py", phase],
                  "environment": [{"name": "PGHOST", "value": values["source_host" if phase == "seed" else "restored_host"]}]}]}
    response = aws("ecs", "run-task", "--cluster", values["cluster"], "--launch-type", "FARGATE",
                   "--task-definition", values["task_definition"], "--started-by", NAME,
                   "--network-configuration", json.dumps({"awsvpcConfiguration": {
                       "subnets": values["subnets"], "securityGroups": [values["security_group"]], "assignPublicIp": "ENABLED"}}),
                   "--overrides", json.dumps(overrides))
    tasks = response.get("tasks", [])
    assert len(tasks) == 1 and not response.get("failures"), "Could not start the VPC rehearsal probe"
    arn = tasks[0]["taskArn"]
    try:
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            task = aws("ecs", "describe-tasks", "--cluster", values["cluster"], "--tasks", arn)["tasks"][0]
            if task["lastStatus"] == "STOPPED":
                stream = "rds-rehearsal/probe/" + arn.rsplit("/", 1)[-1]
                events = aws("logs", "get-log-events", "--log-group-name", values["log_group"],
                             "--log-stream-name", stream, "--start-from-head")["events"]
                for event in events:
                    if event["message"].startswith(("PASS:", "ERROR:")):
                        print(event["message"])
                assert task["containers"][0].get("exitCode") == 0, "Private PostgreSQL probe failed"
                return
            time.sleep(10)
        raise RuntimeError("VPC rehearsal probe exceeded ten minutes")
    finally:
        aws("ecs", "stop-task", "--cluster", values["cluster"], "--task", arn, "--reason", "Rehearsal probe finished")


def stop_tasks():
    arns = aws("ecs", "list-tasks", "--cluster", "quizforge-api", "--started-by", NAME)["taskArns"]
    for arn in arns:
        aws("ecs", "stop-task", "--cluster", "quizforge-api", "--task", arn, "--reason", "Rehearsal cleanup")
    if arns:
        aws("ecs", "wait", "tasks-stopped", "--cluster", "quizforge-api", "--tasks", *arns)
    print("PASS: all rehearsal Fargate tasks are stopped")


def confirm_absent():
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        databases = [aws("rds", "describe-db-instances", "--db-instance-identifier", name, absent=True)
                     for name in (NAME, NAME + "-restore")]
        snapshot = aws("rds", "describe-db-snapshots", "--db-snapshot-identifier", NAME + "-verified-seed", absent=True)
        tasks = aws("ecs", "list-tasks", "--cluster", "quizforge-api", "--started-by", NAME)["taskArns"]
        backups = aws("rds", "describe-db-instance-automated-backups")["DBInstanceAutomatedBackups"]
        retained = [b for b in backups if b.get("DBInstanceIdentifier") in (NAME, NAME + "-restore")]
        if not any(databases) and snapshot is None and not tasks and not retained:
            print("PASS: source database, restored database, test snapshot, automated backups and rehearsal tasks are absent")
            return
        print("Waiting for AWS to finish deleting rehearsal resources and backup metadata")
        time.sleep(30)
    raise RuntimeError("Rehearsal cleanup was not confirmed within fifteen minutes")


if __name__ == "__main__":
    try:
        action = sys.argv[1]
        if action in ("seed", "verify-restored"): run_probe(action)
        elif action == "stop-tasks": stop_tasks()
        elif action == "confirm-absent": confirm_absent()
        else: raise ValueError("Unknown rehearsal operation")
    except Exception as error:
        print(f"::error::RDS rehearsal failed: {type(error).__name__}: {error}")
        sys.exit(1)
