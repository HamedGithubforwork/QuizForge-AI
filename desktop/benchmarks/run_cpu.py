"""Own a temporary CPU runtime for the synthetic benchmark; no downloads."""
import argparse
import hashlib
import http.client
import json
import platform
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def verify_model(path, expected):
    with path.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
            raise ValueError('Model checksum mismatch')


def wait_ready(process, port, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError('Local runtime exited during startup')
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=1)
        try:
            connection.request('GET', '/health')
            response = connection.getresponse()
            if response.status == 200 and json.loads(response.read(4096)).get('status') == 'ok':
                return
        except (OSError, ValueError, http.client.HTTPException):
            pass
        finally:
            connection.close()
        time.sleep(0.25)
    raise TimeoutError('Local runtime startup timed out')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--model-file', type=Path, required=True)
    parser.add_argument('--model-sha256', required=True)
    parser.add_argument('--runtime-version', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    verify_model(args.model_file, args.model_sha256)  # Before native model parsing.
    # Refuse to benchmark an unrelated listener already occupying the fixed port.
    import socket
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 8089))
    command = [str(args.runtime.resolve()), '-m', str(args.model_file.resolve()),
               '--host', '127.0.0.1', '--port', '8089', '-c', '4096', '-t', '2',
               '-ngl', '0', '-np', '1', '--no-webui']
    # Runtime logs may contain local paths. Keep them temporary, never in artifacts.
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen(command, stdout=log, stderr=log)
        try:
            wait_ready(process, 8089)
            completed = subprocess.run([
                sys.executable, str(Path(__file__).with_name('local_inference.py')),
                '--model-file', str(args.model_file), '--model-sha256', args.model_sha256,
                '--runtime-version', args.runtime_version, '--timeout', '300',
                '--repeats', '1', '--output', str(args.output),
            ], timeout=930, check=False)
        finally:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=5)
    if args.output.exists():
        report = json.loads(args.output.read_text(encoding='utf-8'))
        report['runtime_settings'] = {'threads': 2, 'gpu_layers': 0, 'slots': 1, 'context': 4096}
        report['peak_child_rss_kib'] = None
        if platform.system() == 'Linux':
            import resource
            report['peak_child_rss_kib'] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    return completed.returncode


if __name__ == '__main__':
    raise SystemExit(main())
