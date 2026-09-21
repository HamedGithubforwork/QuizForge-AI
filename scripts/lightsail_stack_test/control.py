"""Trusted controller for one temporary current-stack test; no permanent deploy."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import signal
import boto3

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'lightsail_test'))
import host_control as core
from policy import REGION, test_name

APP = '807a4084237f6db544620cdb8322108ebf52251c'
CONFIGURATION = '62e39f33d715cc83928390cfd5ff1728008c4053'
HERE=Path(__file__).resolve().parent


def benchmark(ls, instance, image, digest, pinned):
    deadline=time.monotonic()+600
    while time.monotonic()<deadline:
        with core.ssh_connection(ls,instance,pinned) as (options,target):
            ready=subprocess.run(['ssh',*options,target,'test -f /var/lib/quizforge-capacity-ready'],capture_output=True,timeout=25)
        if ready.returncode==0:break
        time.sleep(5)
    else:raise RuntimeError('Verified host bootstrap did not become ready')
    with core.ssh_connection(ls,instance,pinned) as (options,target):
        subprocess.run(['scp',*options,str(image),target+':/home/ubuntu/stack-bundle.tar.gz'],check=True,capture_output=True,timeout=300)
    try:
        with core.ssh_connection(ls,instance,pinned) as (options,target),(HERE/'remote.sh').open('rb') as script:
            subprocess.run(['ssh',*options,target,f'sudo bash -s -- {digest}'],stdin=script,check=True,capture_output=True,timeout=1200)
    finally:
        with core.ssh_connection(ls,instance,pinned) as (options,target):
            subprocess.run(['scp',*options,'-r',target+':/home/ubuntu/capacity-results',str(core.RESULTS)],check=True,capture_output=True,timeout=90)
    root=core.RESULTS/'capacity-results'
    report=json.loads((root/'stack-capacity.json').read_text())
    core.require(report.get('environment')=='aws-lightsail-2gb' and report.get('application_sha')==APP
        and report.get('configuration_sha')==CONFIGURATION and report.get('synthetic_data') is True
        and report.get('paid_model_calls')==0 and report.get('passed') is True,
        'Current stack capacity result missing, mismatched or failed')
    core.require((root/'exit-code.txt').read_text().strip()=='0','Remote capacity command failed')
    print(json.dumps(report,indent=2),flush=True)


def main():
    core.require(os.environ.get('GITHUB_REF')=='refs/heads/main'
        and os.environ.get('GITHUB_EVENT_NAME')=='workflow_dispatch','Manual trusted main required')
    operation=os.environ.get('OPERATION','inspect')
    core.require(operation in ('inspect','run','cleanup'),'Unsupported operation')
    account=boto3.client('sts',config=core.CONFIG).get_caller_identity()['Account']
    core.require(account==os.environ['TEST_ACCOUNT_ID'],'AWS account mismatch')
    clients=(boto3.client('lightsail',region_name=REGION,config=core.CONFIG),
        boto3.client('scheduler',region_name=REGION,config=core.CONFIG),
        boto3.client('iam',region_name=REGION,config=core.CONFIG),
        boto3.client('freetier',region_name='us-east-1',config=core.CONFIG))
    if operation=='inspect':core.preflight(clients,account,app_sha=APP,harness_sha=CONFIGURATION)
    elif operation=='run':
        name=test_name(os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT'])
        core.run(clients,account,name,app_sha=APP,harness_sha=CONFIGURATION,benchmark_fn=benchmark)
    else:
        print(json.dumps(core.cleanup_instance(clients[0],test_name(os.environ['TEST_ID']))))

if __name__=='__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    def expired(*_): raise RuntimeError('Controller deadline reached; cleaning up')
    signal.signal(signal.SIGALRM, expired)
    try:main()
    except Exception as error:
        print('Stack rehearsal stopped: '+core.failure_summary(error),file=sys.stderr)
        sys.exit(1)
