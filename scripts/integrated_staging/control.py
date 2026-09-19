"""Trusted main-only orchestration. No production user data; existing OpenAI key stays in the guard."""
from datetime import datetime, timedelta, timezone
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import traceback
from uuid import UUID

import boto3
from botocore.exceptions import ClientError
from guards import HOST, NAME, owned_task, permitted_state, public_config

ROOT = Path(__file__).resolve().parents[2]
TF = ROOT / "infra/aws/integrated-staging"
REGION = "ca-central-1"


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


hosting = module("integrated_hosting", "scripts/frontend_staging/control.py")
https = module("integrated_https", "scripts/aws_staging_https.py")
functional = module("integrated_pdf", "scripts/aws_staging_functional.py")
cognito = module("integrated_cognito", "scripts/rds_rehearsal/cognito_profile.py")


def client(service):
    return boto3.client(service, region_name=REGION)


def tf(*args):
    return subprocess.check_output(["terraform", f"-chdir={TF}", *args], text=True)


def values():
    return json.loads(tf("output", "-json")).get("integration", {}).get("value")


def state_resources():
    # A brand-new backend has no object. Never classify denied access or other
    # backend errors as empty state: only S3's explicit missing-object response.
    try:
        client("s3").head_object(Bucket=os.environ["TF_VAR_foundation_state_bucket"],
                                 Key="quizforge/integrated-staging/terraform.tfstate")
    except ClientError as error:
        if error.response["Error"]["Code"] in {"404", "NoSuchKey"}:
            return []
        raise
    return tf("state", "list").splitlines()


def write_vars(v):
    assert set(v) == {"deadline", "api_image", "probe_image", "enable_api"}
    (TF / "integration.auto.tfvars.json").write_text(json.dumps(v))


def configure():
    assert not state_resources(), "Stop existing integrated staging first"
    # Reuse the existing certificate/account/region/public-zone/no-overwrite gates.
    https.preflight()
    assert os.environ["TF_VAR_hostname"] == HOST
    deadline = (datetime.now(timezone.utc) + timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_vars(dict(deadline=deadline, api_image=os.environ["INTEGRATED_API_IMAGE"],
                    probe_image=os.environ["INTEGRATED_PROBE_IMAGE"], enable_api=False))
    print("PASS: empty integration state and existing HTTPS prerequisites verified; two-hour edge lease")


def push():
    ecr = client("ecr")
    repository = ecr.describe_repositories(repositoryNames=["quizforge-api"])["repositories"][0]["repositoryUri"]
    assert re.fullmatch(r"[0-9]{12}\.dkr\.ecr\.ca-central-1\.amazonaws\.com/quizforge-api", repository)
    password = subprocess.check_output(["aws", "ecr", "get-login-password", "--region", REGION])
    subprocess.run(["docker", "login", "--username", "AWS", "--password-stdin", repository.split("/")[0]],
                   input=password, check=True, stdout=subprocess.DEVNULL)
    for kind in ("api", "probe"):
        run = os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]
        assert re.fullmatch(r"[0-9]+-[0-9]+", run)
        tag = "integrated-" + kind + "-" + run
        subprocess.run(["docker", "tag", "quizforge-integrated-" + kind + ":tested", repository + ":" + tag], check=True)
        subprocess.run(["docker", "push", repository + ":" + tag], check=True)
        digest = ecr.describe_images(repositoryName="quizforge-api", imageIds=[{"imageTag":tag}])["imageDetails"][0]["imageDigest"]
        assert re.fullmatch(r"sha256:[a-f0-9]{64}", digest)
        with open(os.environ["GITHUB_ENV"], "a") as target:
            target.write("INTEGRATED_" + kind.upper() + "_IMAGE=" + repository + "@" + digest + "\n")


def export():
    v = values()
    config = public_config(dict(pool=v["pool"], client=v["client"], auth_origin="https://" + v["auth_domain"] + ".auth.ca-central-1.amazoncognito.com",
                                frontend_url="https://" + v["domain"], api_url=v["api_url"], deadline=v["deadline"]))
    Path("integration-config.json").write_text(json.dumps(config))
    print("PASS: exported public build settings only; no users, tokens, passwords or private resource metadata")


def verify_config(v):
    pool = client("cognito-idp").describe_user_pool(UserPoolId=v["pool"])["UserPool"]
    assert pool["Name"] == NAME and pool["UserPoolTier"] == "LITE" and pool["MfaConfiguration"] == "ON"
    assert pool["AdminCreateUserConfig"]["AllowAdminCreateUserOnly"] is True
    assert not pool.get("SmsConfiguration")
    app = client("cognito-idp").describe_user_pool_client(UserPoolId=v["pool"], ClientId=v["client"])["UserPoolClient"]
    assert app["CallbackURLs"] == ["https://" + v["domain"] + "/auth/callback"]
    assert app["LogoutURLs"] == ["https://" + v["domain"] + "/"]
    assert app["AllowedOAuthFlows"] == ["code"] and not app.get("ClientSecret")
    assert app["EnableTokenRevocation"] and app["PreventUserExistenceErrors"] == "ENABLED"
    assert app["ExplicitAuthFlows"] == ["ALLOW_REFRESH_TOKEN_AUTH"]
    db = client("rds").describe_db_instances(DBInstanceIdentifier=NAME)["DBInstances"][0]
    assert db["DBInstanceStatus"] == "available" and not db["PubliclyAccessible"] and db["StorageEncrypted"]
    assert db["DBInstanceClass"] == "db.t4g.micro" and not db["MultiAZ"] and db["BackupRetentionPeriod"] == 1
    assert db["Endpoint"]["Address"] == v["db_host"]
    assert {r["VpcSecurityGroupId"] for r in db["VpcSecurityGroups"]} == {v["db_security_group"]}
    groups = db["DBParameterGroups"]
    assert len(groups) == 1 and groups[0]["DBParameterGroupName"] == NAME and groups[0]["ParameterApplyStatus"] == "in-sync"
    parameters = [p for page in client("rds").get_paginator("describe_db_parameters").paginate(DBParameterGroupName=NAME) for p in page["Parameters"]]
    assert [p["ParameterValue"] for p in parameters if p["ParameterName"] == "rds.force_ssl"] == ["1"]
    rules = client("ec2").describe_security_groups(GroupIds=[v["db_security_group"]])["SecurityGroups"][0]["IpPermissions"]
    assert len(rules) == 1 and rules[0]["FromPort"] == rules[0]["ToPort"] == 5432
    assert not rules[0].get("IpRanges") and not rules[0].get("Ipv6Ranges")
    assert [g["GroupId"] for g in rules[0]["UserIdGroupPairs"]] == [v["security_group"]]
    for kind in ("api", "identity"):
        task = client("ecs").describe_task_definition(taskDefinition=NAME + "-" + kind)["taskDefinition"]
        assert not task.get("taskRoleArn")
        container = task["containerDefinitions"][0]
        assert container["readonlyRootFilesystem"] and container["user"] == "10001:10001"
        assert all(not e["name"].startswith(("SUPABASE", "IDENTITY_SUPABASE")) for e in container["environment"])
        environment = {e["name"]: e["value"] for e in container["environment"]}
        if kind == "api":
            assert environment["OPENAI_API_KEY"] == "staging-budget-guard"
            assert environment["OPENAI_BASE_URL"] == "http://127.0.0.1:8002/v1"
            assert environment["REDIS_URL"] == v["redis_url"]
            assert len(task["containerDefinitions"]) == 2
            guard = task["containerDefinitions"][1]
            assert guard["name"] == "generation-guard" and guard["image"] == v["probe_image"]
            assert not guard.get("portMappings") and guard["readonlyRootFilesystem"]
            assert guard["secrets"] == [{"name":"OPENAI_API_KEY", "valueFrom":
                "arn:aws:ssm:ca-central-1:" + client("sts").get_caller_identity()["Account"] + ":parameter/quizforge/prod/OPENAI_API_KEY"}]
        else:
            assert len(task["containerDefinitions"]) == 1
            assert not any(k.startswith("OPENAI") for k in environment)
        assert len(container["secrets"]) == 1
    cache = client("elasticache").describe_replication_groups(ReplicationGroupId=NAME)["ReplicationGroups"][0]
    assert cache["Status"] == "available" and cache["TransitEncryptionEnabled"] and cache["AtRestEncryptionEnabled"]
    assert cache["TransitEncryptionMode"] == "required" and cache["CacheNodeType"] == "cache.t4g.micro"
    assert len(cache["MemberClusters"]) == 1 and cache["SnapshotRetentionLimit"] == 0
    assert v["redis_url"] == "rediss://" + cache["NodeGroups"][0]["PrimaryEndpoint"]["Address"] + ":6379/0"
    rules = client("ec2").describe_security_groups(GroupIds=[v["cache_security_group"]])["SecurityGroups"][0]["IpPermissions"]
    assert len(rules) == 1 and rules[0]["FromPort"] == rules[0]["ToPort"] == 6379
    assert not rules[0].get("IpRanges") and not rules[0].get("Ipv6Ranges")
    assert [g["GroupId"] for g in rules[0]["UserIdGroupPairs"]] == [v["security_group"]]
    print("PASS: private encrypted Valkey and loopback-only capped generation guard verified")
    print("PASS: exact HTTPS Cognito callbacks/MFA, private forced-TLS RDS and credential-isolated application tasks")


def prepare():
    v = values()
    verify_config(v)
    c = client("cognito-idp")
    users = {}
    for name in ("mapped", "unmapped", "unverified"):
        email = "qf-integrated-" + name + "@example.invalid"
        password = "Qf9!" + secrets.token_urlsafe(28)
        c.admin_create_user(UserPoolId=v["pool"], Username=email, MessageAction="SUPPRESS", UserAttributes=[
            {"Name":"email", "Value":email}, {"Name":"email_verified", "Value":"false" if name == "unverified" else "true"}])
        c.admin_set_user_password(UserPoolId=v["pool"], Username=email, Password=password, Permanent=True)
        login = c.admin_initiate_auth(UserPoolId=v["pool"], ClientId=v["fixture_client"], AuthFlow="ADMIN_USER_PASSWORD_AUTH",
                                    AuthParameters={"USERNAME":email, "PASSWORD":password})
        assert login["ChallengeName"] == "MFA_SETUP" and "AuthenticationResult" not in login
        association = c.associate_software_token(Session=login["Session"])
        secret = association["SecretCode"]
        verified = c.verify_software_token(Session=association["Session"], UserCode=cognito.totp(secret, time.time()))
        assert verified["Status"] == "SUCCESS"
        auth = c.admin_respond_to_auth_challenge(UserPoolId=v["pool"], ClientId=v["fixture_client"], ChallengeName="MFA_SETUP",
            Session=verified["Session"], ChallengeResponses={"USERNAME":login.get("ChallengeParameters", {}).get("USERNAME", email)})["AuthenticationResult"]
        user = c.get_user(AccessToken=auth["AccessToken"])
        subject = str(UUID(next(a["Value"] for a in user["UserAttributes"] if a["Name"] == "sub")))
        c.admin_set_user_mfa_preference(UserPoolId=v["pool"], Username=email, SoftwareTokenMfaSettings={"Enabled":True, "PreferredMfa":True})
        users[name] = dict(email=email, password=password, totp=secret, subject=subject,
                           fixture_access=auth["AccessToken"], enrolled_at=int(time.time()))
    bundle = dict(pool=v["pool"], client=v["client"], domain=v["auth_domain"], users=users,
                  frontend_url="https://" + v["domain"], api_url=v["api_url"], csp=v["csp"],
                  origin_url="https://" + v["origin"], deadline=v["deadline"],
                  pdf=base64.b64encode(functional.make_pdf(v["deadline"])).decode())
    client("secretsmanager").put_secret_value(SecretId=v["fixture_secret"], SecretString=json.dumps(bundle))
    print("PASS: three disposable TOTP users prepared; credentials exist only in the temporary encrypted fixture secret")
    run_probe("seed")
    write_vars({k:v[k] for k in ("deadline", "api_image", "probe_image")} | {"enable_api":True})


def run_probe(phase):
    assert phase in ("seed", "verify")
    v = values()
    ecs = client("ecs")
    response = ecs.run_task(cluster=v["cluster"], taskDefinition=v["probe_task"], launchType="FARGATE", startedBy=NAME,
        networkConfiguration={"awsvpcConfiguration":{"subnets":v["subnets"], "securityGroups":[v["security_group"]], "assignPublicIp":"ENABLED"}},
        overrides={"containerOverrides":[{"name":"probe", "command":["python", "probe.py", phase]}]})
    assert len(response.get("tasks", [])) == 1 and not response.get("failures")
    arn = response["tasks"][0]["taskArn"]
    try:
        for _ in range(60):
            task = ecs.describe_tasks(cluster=v["cluster"], tasks=[arn])["tasks"][0]
            assert owned_task(task)
            if task["lastStatus"] == "STOPPED":
                try:
                    events = client("logs").get_log_events(logGroupName=v["log_group"],
                        logStreamName="integration/probe/" + arn.rsplit("/", 1)[-1], startFromHead=True)["events"]
                    for event in events:
                        if event["message"].startswith(("PASS:", "ERROR:")):
                            print(event["message"])
                except client("logs").exceptions.ResourceNotFoundException:
                    pass
                assert task["containers"][0].get("exitCode") == 0, "Private setup/verification probe failed"
                return
            time.sleep(10)
        raise RuntimeError("Private probe exceeded ten minutes")
    finally:
        ecs.stop_task(cluster=v["cluster"], task=arn, reason="Integration probe finished")


def publish():
    v = values()
    account = client("sts").get_caller_identity()["Account"]
    assert v["bucket"] == NAME + "-" + account
    # Reject stale/mismatched build metadata before exposing the frontend.
    config = public_config(json.loads(Path("integration-config.json").read_text()))
    assert (config["pool"], config["client"], config["frontend_url"], config["api_url"], config["deadline"]) == (
        v["pool"], v["client"], "https://" + v["domain"], v["api_url"], v["deadline"])
    manifest = json.loads(Path("hosting-manifest.json").read_text())
    assert hosting.inventory("hosting-dist") == manifest
    s3, cf = client("s3"), client("cloudfront")
    assert not s3.list_objects_v2(Bucket=v["bucket"], MaxKeys=1).get("KeyCount", 0)
    assert all(s3.get_public_access_block(Bucket=v["bucket"])["PublicAccessBlockConfiguration"].values())
    assert not s3.get_bucket_policy_status(Bucket=v["bucket"])["PolicyStatus"]["IsPublic"]
    policy = json.loads(s3.get_bucket_policy(Bucket=v["bucket"])["Policy"])
    allows = [s for s in policy["Statement"] if s["Effect"] == "Allow"]
    assert len(allows) == 1 and allows[0]["Action"] == "s3:GetObject"
    assert allows[0]["Principal"] == {"Service":"cloudfront.amazonaws.com"}
    assert allows[0]["Resource"] == f"arn:aws:s3:::{v['bucket']}/*"
    assert allows[0]["Condition"] == {"StringEquals":{"AWS:SourceArn":f"arn:aws:cloudfront::{account}:distribution/{v['distribution']}"}}
    encryption = s3.get_bucket_encryption(Bucket=v["bucket"])["ServerSideEncryptionConfiguration"]
    assert encryption["Rules"][0]["ApplyServerSideEncryptionByDefault"]["SSEAlgorithm"] == "AES256"
    assert s3.get_bucket_ownership_controls(Bucket=v["bucket"])["OwnershipControls"]["Rules"] == [{"ObjectOwnership":"BucketOwnerEnforced"}]
    config_cf = cf.get_distribution_config(Id=v["distribution"])["DistributionConfig"]
    origins = config_cf["Origins"]["Items"]
    assert len(origins) == 1 and origins[0]["DomainName"] == v["origin"]
    oac = cf.get_origin_access_control(Id=origins[0]["OriginAccessControlId"])["OriginAccessControl"]["OriginAccessControlConfig"]
    assert oac["SigningBehavior"] == "always" and oac["SigningProtocol"] == "sigv4"
    assert config_cf["ViewerCertificate"]["CloudFrontDefaultCertificate"]
    for behavior in [config_cf["DefaultCacheBehavior"], *config_cf.get("CacheBehaviors", {}).get("Items", [])]:
        assert behavior["ViewerProtocolPolicy"] == "redirect-to-https"
        assert set(behavior["AllowedMethods"]["Items"]) == {"GET", "HEAD"}
    for key in sorted(manifest, key=lambda k:k == "index.html"):
        content_type = {".js":"application/javascript", ".css":"text/css", ".html":"text/html", ".svg":"image/svg+xml"}.get(Path(key).suffix, "application/octet-stream")
        s3.put_object(Bucket=v["bucket"], Key=key, Body=(Path("hosting-dist") / key).read_bytes(), ContentType=content_type,
                      ServerSideEncryption="AES256", CacheControl="public, max-age=31536000, immutable" if key.startswith("assets/") else "no-store")
    print("PASS: exact build settings/hashes, private S3 and signed OAC verified; integrated frontend published")


def browser():
    v = values()
    path = Path(os.environ["RUNNER_TEMP"]) / "integration-fixture.json"
    bundle = json.loads(client("secretsmanager").get_secret_value(SecretId=v["fixture_secret"])["SecretString"])
    assert bundle["pool"] == v["pool"] and bundle["api_url"] == "https://" + HOST
    with open(path, "w", opener=lambda p, flags:os.open(p, flags, 0o600)) as out:
        json.dump(bundle, out)
    try:
        subprocess.run(["docker", "run", "--rm", "--name", "qf-integrated-browser", "--read-only",
            "--user", f"{os.getuid()}:{os.getgid()}", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m", "--shm-size", "256m",
            "--mount", f"type=bind,source={path},target=/run/fixture.json,readonly",
            "quizforge-integrated-browser:tested"], check=True, timeout=600)
    finally:
        path.unlink(missing_ok=True)
        subprocess.run(["docker", "rm", "-f", "qf-integrated-browser"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def stop_tasks():
    permitted_state(state_resources())
    ecs = client("ecs")
    # Existing foundation cluster; only exact integration task families qualify.
    for suffix in ("-api", "-identity"):
        response = ecs.describe_services(cluster="quizforge-api", services=[NAME + suffix])
        assert all(f["reason"] == "MISSING" for f in response.get("failures", []))
        for service in response.get("services", []):
            if service["status"] == "ACTIVE":
                ecs.update_service(cluster="quizforge-api", service=NAME + suffix, desiredCount=0)
    for suffix in ("-api", "-identity", "-probe"):
        for page in ecs.get_paginator("list_tasks").paginate(cluster="quizforge-api", family=NAME + suffix, desiredStatus="RUNNING"):
            for arn in page.get("taskArns", []):
                task = ecs.describe_tasks(cluster="quizforge-api", tasks=[arn])["tasks"][0]
                assert owned_task(task)
                ecs.stop_task(cluster="quizforge-api", task=arn, reason="Disposable integrated staging cleanup")
    print("PASS: only exact integration tasks selected for shutdown")


def wait_for_backups_absent(rds, attempts=31, delay=10):
    # RDS deletion and its snapshot inventory can settle at different times.
    # Keep the strict absence requirement; report only this disposable DB's
    # status metadata and fail after a bounded read-only wait.
    for attempt in range(attempts):
        snapshots = [s for page in rds.get_paginator("describe_db_snapshots").paginate()
                     for s in page["DBSnapshots"] if s["DBInstanceIdentifier"] == NAME]
        backups = [b for page in rds.get_paginator("describe_db_instance_automated_backups").paginate()
                   for b in page["DBInstanceAutomatedBackups"] if b["DBInstanceIdentifier"] == NAME]
        if not snapshots and not backups:
            print("PASS: integration snapshots and automated backups are absent")
            return
        if attempt % 6 == 0:
            metadata = [{"type":s.get("SnapshotType"), "status":s.get("Status"),
                         "created_at":str(s.get("SnapshotCreateTime"))} for s in snapshots]
            print("Waiting for integration backup absence: " + json.dumps({"snapshots":metadata,
                  "automated_backup_statuses":[b.get("Status") for b in backups]}), flush=True)
        if attempt + 1 < attempts:
            time.sleep(delay)
    raise AssertionError("Integration backup records remain after five-minute wait")


def absent():
    assert not state_resources() and not values(), "Integration state is not empty"
    # Reuse the proven private-hosting absence checker with this fixed root/name.
    hosting.NAME, hosting.TF = NAME, TF
    hosting.absent()
    for service, method, args, codes in (
        ("elasticache", "describe_replication_groups", {"ReplicationGroupId":NAME}, {"ReplicationGroupNotFoundFault"}),
        ("elasticache", "describe_cache_subnet_groups", {"CacheSubnetGroupName":NAME}, {"CacheSubnetGroupNotFoundFault"}),
        ("elbv2", "describe_load_balancers", {"Names":[NAME]}, {"LoadBalancerNotFound"}),
        ("rds", "describe_db_instances", {"DBInstanceIdentifier":NAME}, {"DBInstanceNotFound"}),
        ("rds", "describe_db_subnet_groups", {"DBSubnetGroupName":NAME}, {"DBSubnetGroupNotFoundFault"}),
        ("rds", "describe_db_parameter_groups", {"DBParameterGroupName":NAME}, {"DBParameterGroupNotFound"}),
    ):
        hosting.missing(getattr(client(service), method), codes, **args)
    cache = client("elasticache")
    assert not [c for page in cache.get_paginator("describe_cache_clusters").paginate()
                for c in page["CacheClusters"] if c.get("ReplicationGroupId") == NAME or c["CacheClusterId"].startswith(NAME + "-")]
    assert not [s for page in cache.get_paginator("describe_snapshots").paginate()
                for s in page["Snapshots"] if s.get("ReplicationGroupId") == NAME or s.get("CacheClusterId", "").startswith(NAME + "-")]
    wait_for_backups_absent(client("rds"))
    assert not client("ec2").describe_security_groups(Filters=[{"Name":"group-name", "Values":[NAME + "-*"]}])["SecurityGroups"]
    for page in client("cognito-idp").get_paginator("list_user_pools").paginate(MaxResults=60):
        assert all(p["Name"] != NAME for p in page["UserPools"])
    account = client("sts").get_caller_identity()["Account"]
    assert not client("cognito-idp").describe_user_pool_domain(Domain="quizforge-integrated-" + account).get("DomainDescription", {}).get("UserPoolId")
    for suffix in ("-application", "-identity", "-fixture"):
        hosting.missing(client("secretsmanager").describe_secret, {"ResourceNotFoundException"}, SecretId=NAME + suffix)
    for suffix in ("-api-exec", "-identity-exec", "-probe-exec", "-setup"):
        hosting.missing(client("iam").get_role, {"NoSuchEntity"}, RoleName=NAME + suffix)
    assert not client("logs").describe_log_groups(logGroupNamePrefix="/quizforge/integrated-staging")["logGroups"]
    ecs = client("ecs")
    for suffix in ("-api", "-identity", "-probe"):
        for page in ecs.get_paginator("list_tasks").paginate(cluster="quizforge-api", family=NAME + suffix, desiredStatus="RUNNING"):
            assert not page.get("taskArns")
        for page in ecs.get_paginator("list_task_definitions").paginate(familyPrefix=NAME + suffix, status="ACTIVE"):
            assert not page.get("taskDefinitionArns")
    response = ecs.describe_services(cluster="quizforge-api", services=[NAME + "-api", NAME + "-identity"])
    assert all(f["reason"] == "MISSING" for f in response.get("failures", []))
    assert all(s["status"] == "INACTIVE" and s["runningCount"] == s["pendingCount"] == 0 for s in response.get("services", []))
    for page in client("elbv2").get_paginator("describe_target_groups").paginate():
        assert all(t["TargetGroupName"] not in {"qf-integrated-api", "qf-integrated-identity"} for t in page["TargetGroups"])
    dns = client("route53").list_resource_record_sets(HostedZoneId=os.environ["TF_VAR_zone_id"], StartRecordName=HOST, MaxItems="10")["ResourceRecordSets"]
    assert all(r["Name"].lower().rstrip(".") != HOST for r in dns)
    print("PASS: integration ALB/ECS/RDS/Valkey/backups/Cognito/secrets/IAM/logs/security groups/DNS absent; reusable zone/certificate retained")


if __name__ == "__main__":
    try:
        action = sys.argv[1]
        if action == "verify":
            run_probe("verify")
        else:
            {"push":push,"configure":configure,"export":export,"prepare":prepare,"publish":publish,
             "browser":browser,"stop-tasks":stop_tasks,"absent":absent}[action]()
    except Exception as error:
        frame = traceback.extract_tb(error.__traceback__)[-1]
        print(f"ERROR: integration {sys.argv[1]} failed ({type(error).__name__} at {Path(frame.filename).name}:{frame.lineno})")
        if isinstance(error, ClientError):
            print("AWS operation/error: " + error.operation_name + "/" + error.response["Error"]["Code"])
        sys.exit(1)
