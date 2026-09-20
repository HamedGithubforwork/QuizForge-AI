"""Initialize only a fresh private production DB and separate runtime secrets."""
import json
import os
from pathlib import Path
import secrets

import boto3
import psycopg
from psycopg import sql

from database import options


def main():
    # Each secret exists before SQL is committed. Values stay in this process and
    # Secrets Manager; Terraform state never contains runtime role passwords.
    client = boto3.client("secretsmanager", region_name="ca-central-1")
    roles = {"quizforge_app": "APPLICATION_SECRET", "quizforge_identity": "IDENTITY_SECRET",
             "quizforge_generation": "GENERATION_SECRET"}
    passwords = {role: secrets.token_urlsafe(48) for role in roles}
    with psycopg.connect(**options(os.environ)) as conn:
        if conn.execute("SELECT 1 FROM pg_namespace WHERE nspname IN ('app','billing')").fetchone():
            raise ValueError("Target is not fresh; refusing to reset schema or credentials")
        with conn.transaction():
            conn.execute(Path(__file__).with_name("schema.sql").read_text())
            conn.execute(Path(__file__).with_name("generation_budget.sql").read_text())
            for role, secret_env in roles.items():
                with psycopg.ClientCursor(conn) as cursor:
                    cursor.execute(sql.SQL("ALTER ROLE {} PASSWORD %s").format(sql.Identifier(role)), (passwords[role],))
                client.put_secret_value(SecretId=os.environ[secret_env],
                                        SecretString=json.dumps({"password": passwords[role]}))
    print("PASS: fresh production schema created; separate restricted roles; model quota disabled")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("ERROR: bootstrap stopped (" + type(error).__name__ + "); no error values are logged")
        raise SystemExit(1) from None
