"""Trusted workflow runner: inspect private RDS, run VPC probes, confirm cleanup.

Never retrieves database passwords. ECS resolves Secrets Manager references.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen
from uuid import UUID

NAME = "quizforge-rds-rehearsal"


def aws(*args, absent=False):
    result = subprocess.run(["aws", *args, "--output", "json"], capture_output=True, text=True, timeout=90)
    if result.returncode:
        if absent and any(code in result.stderr for code in ("DBInstanceNotFound", "DBSnapshotNotFound", "ResourceNotFoundException")):
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
            groups = db["DBParameterGroups"]
            assert len(groups) == 1 and groups[0]["DBParameterGroupName"] == NAME
            # Include engine defaults: RDS can retain Source=engine-default when
            # the explicitly configured value already equals the engine default.
            parameters = aws("rds", "describe-db-parameters", "--db-parameter-group-name", NAME)["Parameters"]
            force_ssl = [p for p in parameters if p["ParameterName"] == "rds.force_ssl"]
            # This allowlisted non-secret metadata helps diagnose API differences.
            print("RDS forced-TLS parameter: " + json.dumps([
                {key: p.get(key) for key in ("ParameterName", "ParameterValue", "Source")} for p in force_ssl]))
            assert len(force_ssl) == 1 and force_ssl[0]["ParameterValue"] == "1", "RDS must require TLS"
            print(f"PASS: {identifier} parameter group is active")
            print("PASS: RDS parameter API confirms rds.force_ssl=1")
            return
        if db["DBInstanceStatus"] == "available" and "pending-reboot" in statuses and not rebooted:
            aws("rds", "reboot-db-instance", "--db-instance-identifier", identifier)
            rebooted = True
            print(f"Waiting for {identifier} to activate its static TLS parameter")
        time.sleep(15)
    raise RuntimeError("Database parameters did not become active within fifteen minutes")


def run_probe(phase):
    values = outputs()
    identifier = NAME + "-restore" if phase == "verify-restored" else NAME
    ensure_parameters_active(identifier)
    check_database(identifier, values)
    if phase == "verify-restored":
        snapshot = aws("rds", "describe-db-snapshots", "--db-snapshot-identifier", NAME + "-verified-seed")["DBSnapshots"][0]
        assert snapshot["Status"] == "available" and snapshot["Encrypted"]
        assert snapshot["DBInstanceIdentifier"] == NAME
    script = "api_profile.py" if phase in ("prepare-api", "verify-api") else "probe.py"
    host = values["restored_host" if phase == "verify-restored" else "source_host"]
    overrides = {"containerOverrides": [{"name": "probe", "command": ["python", script, phase],
                  "environment": [{"name": "PGHOST", "value": host}]}]}
    run_task(values, values["task_definition"], overrides, container="probe", prefix="rds-rehearsal")


def run_task(values, definition, overrides, *, container, prefix):
    response = aws("ecs", "run-task", "--cluster", values["cluster"], "--launch-type", "FARGATE",
                   "--task-definition", definition, "--started-by", NAME,
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
                stream = prefix + "/" + container + "/" + arn.rsplit("/", 1)[-1]
                events = aws("logs", "get-log-events", "--log-group-name", values["log_group"],
                             "--log-stream-name", stream, "--start-from-head")["events"]
                for event in events:
                    if event["message"].startswith(("PASS:", "ERROR:")):
                        print(event["message"])
                tested = [item for item in task["containers"] if item["name"] == container]
                assert len(tested) == 1 and tested[0].get("exitCode") == 0, "Private PostgreSQL probe failed"
                return
            time.sleep(10)
        raise RuntimeError("VPC rehearsal probe exceeded ten minutes")
    finally:
        aws("ecs", "stop-task", "--cluster", values["cluster"], "--task", arn, "--reason", "Rehearsal probe finished")


def prepare_session():
    values = outputs()
    assert values["session_secret"], "API validation was not provisioned"
    url = aws("ssm", "get-parameter", "--name", "/quizforge/prod/SUPABASE_URL")["Parameter"]["Value"].rstrip("/")
    key = aws("ssm", "get-parameter", "--name", "/quizforge/prod/SUPABASE_PUBLISHABLE_KEY",
              "--with-decryption")["Parameter"]["Value"]
    assert url.startswith("https://") and "?" not in url and "#" not in url
    email, password = os.environ["QUIZFORGE_CANARY_EMAIL"], os.environ["QUIZFORGE_CANARY_PASSWORD"]
    assert email and password, "Dedicated Supabase canary credentials are required"
    login = Request(url + "/auth/v1/token?grant_type=password", method="POST",
                    data=json.dumps({"email": email, "password": password}).encode(),
                    headers={"apikey": key, "Content-Type": "application/json"})
    with urlopen(login, timeout=20) as response:
        token = json.load(response)["access_token"]
    verified = Request(url + "/auth/v1/user", headers={"apikey": key, "Authorization": "Bearer " + token})
    with urlopen(verified, timeout=20) as response:
        subject = str(UUID(json.load(response)["id"]))
    session = {"access_token": token, "user_id": subject, "issuer": url + "/auth/v1"}
    # A 0600 temporary file keeps the token out of process arguments and logs.
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as payload:
        json.dump({"SecretId": values["session_secret"], "SecretString": json.dumps(session)}, payload)
        payload.flush()
        aws("secretsmanager", "put-secret-value", "--cli-input-json", "file://" + payload.name)
    print("PASS: verified dedicated Supabase session stored in a disposable encrypted secret")


def run_api():
    values = outputs()
    assert values["api_task"], "API validation was not provisioned"
    definition = aws("ecs", "describe-task-definition", "--task-definition", values["api_task"])["taskDefinition"]
    assert not definition.get("taskRoleArn"), "API/canary must have no AWS task credentials"
    api = next(c for c in definition["containerDefinitions"] if c["name"] == "api")
    assert {s["name"] for s in api["secrets"]} == {"HISTORY_DB_PASSWORD", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"}
    assert all(s["name"] not in ("PGUSER", "PGPASSWORD") for s in api.get("environment", []))
    run_task(values, values["api_task"], {}, container="canary", prefix="rds-api")


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
        secrets = [aws("secretsmanager", "describe-secret", "--secret-id", NAME + suffix, absent=True)
                   for suffix in ("-api-application", "-api-session")]
        if not any(databases) and snapshot is None and not tasks and not retained and not any(secrets):
            print("PASS: source database, restored database, test snapshot, automated backups and rehearsal tasks are absent")
            print("PASS: temporary application credential and Supabase session secrets are absent")
            return
        print("Waiting for AWS to finish deleting rehearsal resources and backup metadata")
        time.sleep(30)
    raise RuntimeError("Rehearsal cleanup was not confirmed within fifteen minutes")


if __name__ == "__main__":
    try:
        action = sys.argv[1]
        if action in ("seed", "verify-restored", "prepare-api", "verify-api"): run_probe(action)
        elif action == "prepare-session": prepare_session()
        elif action == "api": run_api()
        elif action == "stop-tasks": stop_tasks()
        elif action == "confirm-absent": confirm_absent()
        else: raise ValueError("Unknown rehearsal operation")
    except Exception as error:
        print(f"::error::RDS rehearsal failed: {type(error).__name__}")
        sys.exit(1)
