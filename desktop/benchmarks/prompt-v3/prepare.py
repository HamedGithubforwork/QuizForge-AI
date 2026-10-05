"""Download one reviewed official model asset and verify its pinned digest."""
import argparse
import hashlib
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'candidates.json').read_text(encoding='utf-8'))
    model = next((row for row in manifest['candidates'] if row['id'] == args.candidate), None)
    if model is None:
        parser.error('Unknown reviewed candidate')
    destination = args.directory / model['id']
    destination.mkdir(parents=True, exist_ok=False)
    output = destination / model['filename']
    partial = output.with_suffix(output.suffix + '.partial')
    url = f"https://huggingface.co/{model['repository']}/resolve/{model['revision']}/{model['filename']}"
    digest = hashlib.sha256()
    size = 0
    request = urllib.request.Request(url, headers={'User-Agent': 'QuizForge-local-ai-evaluation/3'})
    with urllib.request.urlopen(request, timeout=300) as response, partial.open('xb') as target:
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > model['bytes']:
                raise ValueError('Model asset exceeds pinned size')
            digest.update(chunk)
            target.write(chunk)
    if size != model['bytes'] or digest.hexdigest() != model['sha256']:
        partial.unlink(missing_ok=True)
        raise ValueError('Model size or SHA-256 mismatch')
    partial.replace(output)
    print(json.dumps({'candidate': model['id'], 'bytes': size, 'sha256': digest.hexdigest()}))


if __name__ == '__main__':
    main()
