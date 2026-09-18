"""Bounded, encrypted handoff for the real hosted password-reset form.

Only the trusted controller has AWS credentials. The browser receives a 0600
fixture and writes one private continuation file; neither becomes an artifact.
"""
import base64
import json
import os
import re
from urllib.parse import parse_qs, urlsplit
import zlib

import boto3

import control
import recovery

LIMIT = 48000
BINDINGS = ("pool", "client", "fixture_client", "domain", "deadline", "recovery_run")


def path(name):
    return control.Path(os.environ["RUNNER_TEMP"]) / name


def check_continuation(state, v):
    assert set(state) == {"url", "cookies"}
    host = v["domain"] + ".auth.ca-central-1.amazoncognito.com"
    url = urlsplit(state["url"])
    assert url.scheme == "https" and url.netloc == host and url.path == "/confirmForgotPassword"
    assert not url.fragment and parse_qs(url.query).get("client_id") == [v["client"]]
    assert 0 < len(state["cookies"]) <= 12
    for cookie in state["cookies"]:
        assert cookie["domain"] == host and cookie["secure"] is True
        assert len(cookie["value"]) <= 8000 and cookie["path"].startswith("/")


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
    # The hosted probe creates fresh sessions itself, never restores fixture tokens.
    for value in bundle["users"].values():
        value.pop("fixture_access")
        value.pop("fixture_refresh")
    bundle.update(controller_sha=os.environ["GITHUB_SHA"], recovery={"mode": "start"})
    control.private_file("cognito-browser-bundle.json", json.dumps(bundle))
    print("PASS: disposable verified-email hosted recovery fixture prepared; public signup remains closed")


def save():
    v = control.values()
    recovery.live_state(v)
    recovery.empty()
    bundle = json.loads(path("cognito-browser-bundle.json").read_text())
    state = json.loads(path("hosted-handoff/continuation.json").read_text())
    check_continuation(state, v)
    assert all(bundle[k] == v[k] for k in BINDINGS)
    assert bundle.pop("recovery") == {"mode": "start"}
    bundle["continuation"] = state
    raw = json.dumps(bundle, separators=(",", ":")).encode()
    assert len(raw) <= LIMIT
    encoded = base64.b64encode(zlib.compress(raw)).decode()
    chunks = [encoded[i:i + 4096] for i in range(0, len(encoded), 4096)]
    assert 1 <= len(chunks) <= len(recovery.HOSTED_PARAMETERS)
    for name, value in zip(recovery.HOSTED_PARAMETERS, chunks):
        recovery.ssm().put_parameter(Name=name, Value=value, Type="SecureString", Tier="Standard", Overwrite=False,
            Tags=[{"Key": "Project", "Value": "QuizForge-AI"}, {"Key": "Temporary", "Value": "true"}])
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as out:
        out.write(f"Hosted recovery run {v['recovery_run']} awaits its inbox code until {v['deadline']} UTC.\n\n")
        out.write("Set COGNITO_RECOVERY_RECEIPT to encrypted JSON with run_id and code, then run hosted-recovery-finish-stop. Delete that secret after the test. Run stop immediately if handoff cannot finish. No browser state or codes are stored in artifacts.\n")
    print("PASS: hosted confirmation form and fixture encrypted in bounded Standard SecureStrings; reset is not yet claimed")


def decode(parameters):
    found = {p["Name"]: p for p in parameters}
    names = recovery.HOSTED_PARAMETERS[:len(found)]
    assert found and set(found) == set(names) and len(found) <= 4
    assert all(p["Type"] == "SecureString" and len(p["Value"]) <= 4096 for p in found.values())
    compressed = base64.b64decode("".join(found[name]["Value"] for name in names), validate=True)
    decoder = zlib.decompressobj()
    raw = decoder.decompress(compressed, LIMIT + 1)
    assert len(raw) <= LIMIT and decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail
    return json.loads(raw)


def load():
    v = control.values()
    recovery.live_state(v)
    receipt = json.loads(os.environ["COGNITO_RECOVERY_RECEIPT"])
    assert set(receipt) == {"run_id", "code"} and receipt["run_id"] == v["recovery_run"]
    assert isinstance(receipt["code"], str) and re.fullmatch(r"[0-9]{6}", receipt["code"])
    params = recovery.ssm().get_parameters(Names=recovery.HOSTED_PARAMETERS, WithDecryption=True)["Parameters"]
    bundle = decode(params)
    assert all(bundle[k] == v[k] for k in BINDINGS)
    assert bundle["controller_sha"] == os.environ["GITHUB_SHA"], "Controller changed; stop and start a fresh rehearsal"
    assert bundle["users"]["mapped"]["email"] == control.rehearsal_email()
    check_continuation(bundle["continuation"], v)
    control.configuration(boto3.client("cognito-idp", region_name="ca-central-1"), v)
    bundle["recovery"] = {"mode": "finish", "code": receipt["code"]}
    control.private_file("cognito-browser-bundle.json", json.dumps(bundle))
    with open(os.environ["GITHUB_ENV"], "a") as out:
        out.write("HOSTED_IMAGE_RUN=" + v["recovery_run"] + "\n")
    print("PASS: hosted continuation and receipt bound to the unexpired pool, controller and original image run")
