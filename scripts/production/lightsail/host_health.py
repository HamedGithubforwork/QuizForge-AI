"""Publish a bounded, metadata-only heartbeat using metric-only credentials."""
from pathlib import Path
import shutil
from urllib.error import HTTPError
from urllib.request import Request, ProxyHandler, build_opener

import boto3
from botocore.config import Config


def healthy():
    disk = shutil.disk_usage('/var/lib/quizforge')
    if disk.free < max(3 * 1024**3, disk.total * .1):
        return False
    # Explicit local endpoints, no proxy or arbitrary URLs and no response bodies.
    opener = build_opener(ProxyHandler({}))
    for port, route, status in ((8000, '/api/health', 200), (8001, '/identity/session', 403)):
        try:
            with opener.open(Request(f'http://127.0.0.1:{port}{route}'), timeout=5) as response:
                if response.status != status:
                    return False
        except HTTPError as error:
            error.close()
            if error.code != status:
                return False
        except Exception:
            return False
    return True


def main():
    ok = healthy()
    boto3.client('cloudwatch', region_name='ca-central-1', config=Config(
        connect_timeout=5, read_timeout=10, retries={'total_max_attempts': 2}, ignore_configured_endpoint_urls=True)).put_metric_data(
            Namespace='QuizForge/Host', MetricData=[{'MetricName': 'Healthy', 'Value': int(ok), 'Unit': 'Count',
                'Dimensions': [{'Name': 'Deployment', 'Value': 'production-lightsail'}]}])
    print('Host heartbeat published; healthy=' + str(ok))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Host heartbeat failed; external missing-data alarm applies') from None
