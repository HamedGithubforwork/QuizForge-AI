"""Real bounded backup export/encryption; no S3-delivery claim or AWS credentials."""
import json
import os
import secrets
import time
import psycopg
from lightsail_backup import connection_options, export_snapshot, seal, unseal

start = time.monotonic()
reports = []
key = secrets.token_bytes(32)
with psycopg.connect(**connection_options(dict(os.environ))) as conn:
    # Repeated snapshots keep backup work overlapping the OCR/health workload.
    while time.monotonic() - start < 30:
        snapshot = export_snapshot(conn)
        archive = seal(snapshot, key)
        assert unseal(archive,key) == snapshot
        reports.append({'rows':len(snapshot['tables']['app.quiz_history']),'bytes':len(archive)})
        time.sleep(.5)
assert reports and all(r['rows']==400 for r in reports)
print(json.dumps({'snapshots':len(reports),'seconds':time.monotonic()-start,
    'maximum_archive_bytes':max(r['bytes'] for r in reports),'encrypted_round_trip':True,
    'aws_upload_tested':False,'passed':True}))
