"""Trusted VPC setup/verification only; never part of the application image."""
import json
import os
import re
import secrets
import sys
import traceback
import uuid

import boto3
import psycopg

from probe import connection_options, fingerprint, fixtures

CANARY_USER = uuid.UUID(int=3)


def main(phase):
    assert phase in ("prepare-api", "verify-api")
    options, local = connection_options()
    assert not local, "The API profile only runs in the isolated RDS rehearsal"
    manager = boto3.client("secretsmanager")
    session = json.loads(manager.get_secret_value(SecretId=os.environ["RDS_SESSION_SECRET_ARN"])["SecretString"])
    subject = str(uuid.UUID(session["user_id"]))
    issuer = session["issuer"]
    if session.get("provider") == "cognito":
        assert re.fullmatch(r"https://cognito-idp\.ca-central-1\.amazonaws\.com/ca-central-1_[A-Za-z0-9]+", issuer)
    else:
        assert issuer.startswith("https://") and issuer.endswith("/auth/v1")
    assert subject not in {str(uuid.UUID(int=i)) for i in (1, 2, 3)}
    with psycopg.connect(**options, user=os.environ["PGUSER"], password=os.environ["PGPASSWORD"]) as owner:
        assert fingerprint(owner.execute("SELECT * FROM app.quiz_history").fetchall()) == fingerprint(fixtures())
        if phase == "prepare-api":
            password = secrets.token_urlsafe(32)
            with owner.transaction():
                owner.execute("INSERT INTO app.users(id) VALUES (%s)", (CANARY_USER,))
                owner.execute("INSERT INTO app.user_identities(issuer,subject,user_id) VALUES (%s,%s,%s)",
                              (issuer, subject, CANARY_USER))
                with psycopg.ClientCursor(owner) as cursor:
                    cursor.execute("ALTER ROLE quizforge_app PASSWORD %s", (password,))
            manager.put_secret_value(SecretId=os.environ["RDS_APP_SECRET_ARN"],
                                     SecretString=json.dumps({"username": "quizforge_app", "password": password}))
            print("PASS: isolated canary identity and separate application credential prepared")
        else:
            assert owner.execute("SELECT count(*) AS n FROM app.quiz_history WHERE user_id=%s", (CANARY_USER,)).fetchone()["n"] == 0
            assert owner.execute("SELECT count(*) AS n FROM app.users").fetchone()["n"] == 3
            assert owner.execute("SELECT count(*) AS n FROM app.user_identities").fetchone()["n"] == 3
            print("PASS: HTTP canary removed its rows and all eight foreign-owner fixtures retain their original checksum")


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except Exception as error:
        line = traceback.extract_tb(error.__traceback__)[-1].lineno
        print(f"ERROR: isolated API setup/verification failed ({type(error).__name__}, line {line})")
        sys.exit(1)
