"""Deliver a run-bound recovery receipt to a still-open hosted browser form.

Only this trusted controller has AWS credentials. Browser state stays inside
the running container; only the one-use code crosses the encrypted handoff.
"""
import json
import os
import re
import time

import boto3
from botocore.exceptions import ClientError

import control
import recovery

BINDINGS = ("pool", "client", "fixture_client", "domain", "deadline", "recovery_run")


def path(name):
    return control.Path(os.environ["RUNNER_TEMP"]) / name


def receipt(v):
    recovery.live_state(v)
    value = json.loads(os.environ["COGNITO_RECOVERY_RECEIPT"])
    assert set(value) == {"run_id", "code"} and value["run_id"] == v["recovery_run"]
    assert isinstance(value["code"], str) and re.fullmatch(r"[0-9]{6}", value["code"])
    return value


def prepare():
    v = control.values()
    recovery.live_state(v)
    recovery.empty()
    email = control.rehearsal_email()
    control.prepare()
    bundle = json.loads(path("cognito-browser-bundle.json").read_text())
    user = bundle["users"]["mapped"]
    boto3.client("cognito-idp", region_name="ca-central-1").admin_update_user_attributes(
        UserPoolId=v["pool"], Username=user["subject"], UserAttributes=[
            {"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"}])
    user["email"] = email
    for value in bundle["users"].values():
        value.pop("fixture_access")
        value.pop("fixture_refresh")
    bundle.update(controller_sha=os.environ["GITHUB_SHA"], recovery={"mode": "live"})
    control.private_file("cognito-browser-bundle.json", json.dumps(bundle))
    print("PASS: disposable verified-email hosted recovery fixture prepared; public signup remains closed")


def accept():
    v = control.values()
    value = receipt(v)
    encoded = json.dumps({**v, "controller_sha": os.environ["GITHUB_SHA"], "code": value["code"]})
    assert len(encoded.encode()) <= 4096
    recovery.ssm().put_parameter(Name=recovery.HOSTED_RECEIPT, Value=encoded, Type="SecureString", Tier="Standard", Overwrite=False,
        Tags=[{"Key": "Project", "Value": "QuizForge-AI"}, {"Key": "Temporary", "Value": "true"}])
    print("PASS: receipt encrypted for the active hosted recovery run; no browser state or credentials persisted")


def validate_delivery(parameter, bundle):
    recovery.live_state(bundle)
    assert parameter["Name"] == recovery.HOSTED_RECEIPT and parameter["Type"] == "SecureString"
    assert len(parameter["Value"].encode()) <= 4096
    data = json.loads(parameter["Value"])
    assert set(data) == set(BINDINGS) | {"controller_sha", "code"}
    assert all(data[k] == bundle[k] for k in (*BINDINGS, "controller_sha"))
    assert isinstance(data["code"], str) and re.fullmatch(r"[0-9]{6}", data["code"])
    return data["code"]


def deliver():
    bundle = json.loads(path("cognito-browser-bundle.json").read_text())
    assert bundle["recovery"] == {"mode": "live"}
    recovery.live_state(bundle)
    client = recovery.ssm()
    deadline = time.monotonic() + 480
    while time.monotonic() < deadline:
        try:
            parameter = client.get_parameter(Name=recovery.HOSTED_RECEIPT, WithDecryption=True)["Parameter"]
        except ClientError as error:
            assert error.response["Error"]["Code"] == "ParameterNotFound"
            time.sleep(3)
            continue
        code = validate_delivery(parameter, bundle)
        # The 0700 parent directory is mounted read-only into the browser.
        # Atomic rename prevents a partial read; no env/argv carries the code.
        temp = control.private_file("hosted-handoff/receipt.tmp", json.dumps({"code": code}))
        temp.replace(path("hosted-handoff/receipt.json"))
        print("PASS: validated code delivered privately to the active browser")
        return
    raise AssertionError("Hosted receipt was not delivered within the bounded window")
