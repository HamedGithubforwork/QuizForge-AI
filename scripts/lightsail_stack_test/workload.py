"""Measure the six real services with concurrent OCR and bounded backup work."""
import json
import math
import os
from pathlib import Path
import subprocess
import threading
import time
from urllib.request import Request, urlopen
import psycopg

HERE = Path(__file__).resolve().parent

def exercise(root, compose, env, *, ci):
    output = Path(os.environ.get('STACK_RESULTS', '/home/ubuntu/capacity-results'))
    output.mkdir(parents=True, exist_ok=True)
    def run(*args):
        return subprocess.run(args, check=True, stdin=subprocess.DEVNULL, capture_output=True, text=True).stdout
    # The owner credentials and fixture rows never leave the disposable machine.
    from database import options
    with psycopg.connect(**options(env)) as conn:
        conn.execute("INSERT INTO app.users VALUES ('00000000-0000-0000-0000-000000000001')")
        conn.execute("""INSERT INTO app.quiz_history(user_id,quiz_title,source_filename,difficulty,question_type,
            question_count,score,percentage,quiz_data,selected_answers)
            SELECT '00000000-0000-0000-0000-000000000001','Synthetic capacity fixture','synthetic.pdf',
            'medium','multiple_choice',1,1,100,jsonb_build_object('synthetic',repeat('quizforge fixture ',800)),
            '{}'::jsonb FROM generate_series(1,400)""")
    ids = run(*compose,'ps','-q').split()
    assert len(ids)==6, 'All six services must be running'
    before = json.loads(run('docker','inspect',*ids))
    assert sum(s['HostConfig']['Memory'] for s in before) + 256*1024**2 <= 1536*1024**2
    assert all(s['HostConfig']['CgroupParent']=='quizforge.slice' for s in before)
    assert all(s['HostConfig']['Memory']==s['HostConfig']['MemorySwap'] for s in before)
    groups = [p for p in Path('/sys/fs/cgroup').rglob('quizforge.slice') if (p/'memory.events').is_file()]
    assert len(groups)==1, 'Expected the dedicated aggregate memory cgroup'
    group=groups[0]
    assert (group/'memory.max').read_text().strip()==str(1536*1024**2)
    assert (group/'memory.swap.max').read_text().strip()=='0'
    def counters():
        return {k:int(v) for k,v in (r.split() for r in (group/'memory.events').read_text().splitlines())}
    initial=counters()
    finished=threading.Event()
    samples=[]
    latency=[]
    errors=[]
    def monitor():
        while not finished.is_set():
            mem={r.split(':')[0]:int(r.split()[1]) for r in Path('/proc/meminfo').read_text().splitlines()}
            samples.append({'epoch':time.time(),'host_available_kib':mem['MemAvailable'],
                            'aggregate_bytes':int((group/'memory.current').read_text())})
            finished.wait(.25)
    def health():
        while not finished.is_set():
            started=time.monotonic()
            try:
                with urlopen(Request('http://127.0.0.1/api/health',headers={'Host':'api.quizfromnotes.com'}),timeout=3) as response:
                    assert response.status==200
                    response.read(4096)
                latency.append(time.monotonic()-started)
            except Exception as error:
                errors.append(type(error).__name__)
            finished.wait(.2)
    threads=[threading.Thread(target=monitor),threading.Thread(target=health)]
    for t in threads:t.start()
    backup_env=root/'backup-load.env'
    backup_env.write_text('\n'.join(f'{k}={v}' for k,v in (env|{'PGSSLROOTCERT':'/run/ca.pem','AWS_EC2_METADATA_DISABLED':'true'}).items())+'\n')
    backup_env.chmod(0o600)
    network=json.loads(run(*compose,'config','--format','json'))['networks']['default']['name']
    backup_args=['docker','run','--name','qf-stack-backup','--network',network,
        '--memory','256m','--memory-swap','256m','--cpus','.5','--pids-limit','64',
        '--cgroup-parent','quizforge.slice','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
        '--tmpfs','/tmp:size=32m,mode=1777,noexec,nosuid,nodev','--env-file',str(backup_env),
        '-v','/etc/quizforge/db-ca.pem:/run/ca.pem:ro',
        '-v',str(HERE/'backup_workload.py')+':/app/backup_workload.py:ro',
        'quizforge-ci-operations','python','/app/backup_workload.py']
    report={'environment':'github-ci' if ci else 'aws-lightsail-2gb','synthetic_data':True,'paid_model_calls':0,
        'application_sha':'807a4084237f6db544620cdb8322108ebf52251c',
        'configuration_sha':'62e39f33d715cc83928390cfd5ff1728008c4053','passed':False}
    backup=None
    try:
        backup=subprocess.Popen(backup_args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        # Use the application's actual isolated PDF worker inside its API cgroup.
        ocr=json.loads(run(*compose,'exec','-T','api','python','-c',(HERE/'ocr_workload.py').read_text()))
        stdout,stderr=backup.communicate(timeout=90)
        assert backup.returncode==0, 'Backup process failed (raw output suppressed)'
        backup_report=json.loads(stdout)
        final=counters()
        after=json.loads(run('docker','inspect',*ids,'qf-stack-backup'))
        report.update(ocr=ocr,backup=backup_report,health_requests=len(latency),health_errors=len(errors),
            health_p95_seconds=sorted(latency)[max(0,math.ceil(len(latency)*.95)-1)] if latency else None,
            host_min_available_kib=min(s['host_available_kib'] for s in samples),
            aggregate_peak_bytes=max(s['aggregate_bytes'] for s in samples),
            oom_events=final.get('oom',0)-initial.get('oom',0),oom_kills=final.get('oom_kill',0)-initial.get('oom_kill',0),
            container_oom=any(s['State']['OOMKilled'] for s in after),
            unexpected_restarts=any(a['RestartCount']!=b['RestartCount'] for a,b in zip(after[:6],before)),
            six_services_running=all(s['State']['Running'] for s in after[:6]))
        assert report['health_requests']>=30 and not errors
        assert report['health_p95_seconds']<2
        assert report['host_min_available_kib']>=128*1024
        assert not any(report[k] for k in ('oom_events','oom_kills','container_oom','unexpected_restarts'))
        assert report['six_services_running'] and ocr['passed'] and backup_report['passed']
        report['passed']=True
    except Exception as error:
        report['failure_type']=type(error).__name__
        raise
    finally:
        finished.set()
        for t in threads:t.join(timeout=4)
        if backup and backup.poll() is None:
            subprocess.run(['docker','kill','qf-stack-backup'],capture_output=True)
            backup.communicate(timeout=15)
        subprocess.run(['docker','rm','-f','qf-stack-backup'],capture_output=True)
        backup_env.unlink(missing_ok=True)
        (output/'stack-capacity.json').write_text(json.dumps(report,indent=2)+'\n')
        (output/'memory-samples.json').write_text(json.dumps(samples)+'\n')
        print(json.dumps(report),flush=True)
