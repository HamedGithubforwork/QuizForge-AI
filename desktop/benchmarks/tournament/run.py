"""Evaluation-only tournament runner. No production imports or model downloads."""
import argparse
import hashlib
import json
import math
import os
import platform
import re
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_inference import payload, request, validate_quiz
from run_cpu import verify_model, wait_ready

ROOT = Path(__file__).parent

def digest(path):
    with Path(path).open('rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()

def flags(quiz, fixture):
    """Conservative review flags, never claimed as a semantic accuracy score."""
    encoded=json.dumps(quiz,ensure_ascii=False).casefold()
    result=[]
    if any(s.casefold() in encoded for s in fixture.get('forbidden',[])):
        result.append('injection_marker_output')
    questions=quiz.get('questions',[]) if isinstance(quiz,dict) else []
    for i,q in enumerate(questions):
        if not isinstance(q,dict): continue
        a=set(re.findall(r'\w+',str(q.get('question','')).casefold()))
        for j,other in enumerate(questions[:i]):
            b=set(re.findall(r'\w+',str(other.get('question','')).casefold()))
            if a and b and len(a&b)/len(a|b)>.72: result.append(f'possible_duplicate:{j}:{i}')
    return result

class Metrics:
    """Sample only the owned server PID, not cumulative unrelated child usage."""
    def __init__(self,pid):
        self.pid=pid; self.peak=None; self.cpu=None; self.samples=0; self.stop=threading.Event()
        self.thread=threading.Thread(target=self.loop,daemon=True)
    def loop(self):
        if platform.system()=='Windows':
            import ctypes
            from ctypes import wintypes as w
            class Memory(ctypes.Structure):
                _fields_=[('cb',w.DWORD),('PageFaultCount',w.DWORD)]+[(n,ctypes.c_size_t) for n in ['PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage']]
            kernel=ctypes.WinDLL('kernel32',use_last_error=True)
            psapi=ctypes.WinDLL('psapi',use_last_error=True)
            kernel.OpenProcess.restype=w.HANDLE
            kernel.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD]
            kernel.GetProcessTimes.argtypes=[w.HANDLE]+[ctypes.POINTER(w.FILETIME)]*4
            kernel.CloseHandle.argtypes=[w.HANDLE]
            psapi.GetProcessMemoryInfo.argtypes=[w.HANDLE,ctypes.POINTER(Memory),w.DWORD]
            handle=kernel.OpenProcess(0x0400|0x0010,False,self.pid)
            if not handle:return
            try:
                while not self.stop.is_set():
                    m=Memory();m.cb=ctypes.sizeof(m)
                    if psapi.GetProcessMemoryInfo(handle,ctypes.byref(m),m.cb):
                        self.peak=max(self.peak or 0,m.PeakWorkingSetSize);self.samples+=1
                    ts=[w.FILETIME() for _ in range(4)]
                    if kernel.GetProcessTimes(handle,*[ctypes.byref(t) for t in ts]):
                        self.cpu=sum((t.dwHighDateTime<<32)|t.dwLowDateTime for t in ts[2:])/1e7
                    self.stop.wait(.25)
            finally:kernel.CloseHandle(handle)
        elif platform.system()=='Linux':
            while not self.stop.is_set():
                try:
                    status=Path(f'/proc/{self.pid}/status').read_text()
                    match=re.search(r'VmHWM:\s+(\d+) kB',status)
                    if match:self.peak=max(self.peak or 0,int(match[1])*1024);self.samples+=1
                    fields=Path(f'/proc/{self.pid}/stat').read_text().rsplit(')',1)[1].split()
                    self.cpu=(int(fields[11])+int(fields[12]))/os.sysconf('SC_CLK_TCK')
                except (OSError,ValueError,IndexError):pass
                self.stop.wait(.25)
    def __enter__(self):self.thread.start();return self
    def __exit__(self,*args):self.stop.set();self.thread.join(2)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for arg in ['runtime','model-file','output']:parser.add_argument('--'+arg,type=Path,required=True)
    parser.add_argument('--candidate',required=True)
    parser.add_argument('--model-sha256',required=True)
    parser.add_argument('--runtime-sha256',required=True)
    parser.add_argument('--limit',type=int,default=0,help='Transport smoke only; excluded from ranking')
    args=parser.parse_args()
    if args.output.exists():parser.error('Refusing to overwrite evidence')
    verify_model(args.model_file,args.model_sha256)
    fixtures=json.loads((ROOT/'fixtures.json').read_text(encoding='utf-8'))
    for f in fixtures:f['pages']={int(k):v for k,v in f['pages'].items()}
    if args.limit:fixtures=fixtures[:args.limit]
    report=dict(schema=1,candidate=args.candidate,synthetic_only=True,paid_model_calls=0,platform=platform.platform(),architecture=platform.machine(),logical_cpus=os.cpu_count(),environment={k:os.environ.get(k) for k in ['GITHUB_RUN_ID','GITHUB_SHA','ImageOS','ImageVersion']},model_sha256=args.model_sha256,model_bytes=args.model_file.stat().st_size,runtime_version='b11317',runtime_archive_sha256=args.runtime_sha256,runtime_executable_sha256=digest(args.runtime),source_hashes={p.name:digest(p) for p in [Path(__file__),ROOT/'fixtures.json',ROOT.parent/'local_inference.py',ROOT.parent/'run_cpu.py',ROOT/'protocol.md']},runtime_settings=dict(threads=2,gpu_layers=0,slots=1,context=4096),request_template=payload({'pages':{}}),smoke_only=bool(args.limit),semantic_review='pending',runs=[])
    def save():
        args.output.parent.mkdir(parents=True,exist_ok=True)
        temporary=args.output.with_suffix('.tmp')
        temporary.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');temporary.replace(args.output)
    save()
    with socket.socket() as probe:probe.bind(('127.0.0.1',8089))
    command=[str(args.runtime.resolve()),'-m',str(args.model_file.resolve()),'--host','127.0.0.1','--port','8089','-c','4096','-t','2','-ngl','0','-np','1','--no-webui']
    with tempfile.TemporaryFile() as log:
        start=time.perf_counter();process=subprocess.Popen(command,stdout=log,stderr=log)
        try:
            with Metrics(process.pid) as metrics:
                wait_ready(process,8089,120)
                report['load_seconds']=round(time.perf_counter()-start,3)
                for fixture in fixtures:
                    start=time.perf_counter();row=dict(fixture=fixture['id'],errors=[])
                    try:
                        response=request(8089,payload(fixture),300)
                        row['raw_response']=response
                        choice=response['choices'][0]
                        row['finish_reason']=choice['finish_reason']
                        if choice['finish_reason']!='stop':row['errors'].append('incomplete_generation')
                        quiz=json.loads(choice['message']['content']);row['quiz']=quiz
                        row['errors']+=validate_quiz(quiz,fixture['pages'],fixture['expected_questions'])
                        row['review_flags']=flags(quiz,fixture)
                    except Exception as e:
                        row['errors'].append(type(e).__name__)
                    row['elapsed_seconds']=round(time.perf_counter()-start,3)
                    report['runs'].append(row);save()
                    print(json.dumps({k:row[k] for k in ['fixture','errors','elapsed_seconds']}),flush=True)
                report['peak_server_rss_bytes']=metrics.peak
                report['server_cpu_seconds']=metrics.cpu
                report['metric_samples']=metrics.samples
        except Exception as e:
            report['infrastructure_error']=type(e).__name__
            # A bounded tail is safe: runtime sees only public model paths and synthetic notes.
            log.seek(0,2);size=log.tell();log.seek(max(0,size-5000))
            report['startup_diagnostic']=log.read().decode('utf-8',errors='replace')
        finally:
            process.terminate()
            try:process.wait(timeout=15)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
    times=[r['elapsed_seconds'] for r in report['runs']]
    generated=[r['elapsed_seconds'] for r,f in zip(report['runs'],fixtures) if f['expected_questions']==5]
    report['summary']=dict(completed=len(times),expected=len(fixtures),structurally_valid=sum(not r['errors'] for r in report['runs']),median_all_seconds=statistics.median(times) if times else None,median_generation_seconds=statistics.median(generated) if generated else None,p95_seconds=sorted(times)[math.ceil(.95*len(times))-1] if times else None)
    save()
    # Quality failures remain evidence, not infrastructure failures that skip other models.
    return 1 if report.get('infrastructure_error') else 0

if __name__=='__main__':raise SystemExit(main())
