"""Download only reviewed owner assets, verify before parsing, optionally convert."""
import argparse, hashlib, json, shutil, subprocess, sys, urllib.request
from pathlib import Path
ROOT=Path(__file__).parent

def download(url,path,sha=None,size=None,git_blob=None):
    if path.exists(): raise ValueError('Refusing to overwrite model asset')
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix(path.suffix+'.partial')
    h=hashlib.sha256()
    with urllib.request.urlopen(url,timeout=300) as response,tmp.open('wb') as out:
        while chunk:=response.read(1024*1024):out.write(chunk);h.update(chunk)
    if sha and h.hexdigest()!=sha:raise ValueError('Asset SHA-256 mismatch')
    if size is not None and tmp.stat().st_size!=size:raise ValueError('Asset size mismatch')
    if git_blob:
        b=hashlib.sha1(b'blob '+str(tmp.stat().st_size).encode()+b'\0'+tmp.read_bytes()).hexdigest()
        if b!=git_blob:raise ValueError('Source git blob mismatch')
    tmp.replace(path)
    return h.hexdigest()

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--candidate',required=True);p.add_argument('--directory',type=Path,required=True)
    p.add_argument('--llama-source',type=Path);p.add_argument('--quantize',type=Path)
    a=p.parse_args();manifest=json.loads((ROOT/'candidates.json').read_text())
    m=next(m for m in manifest['candidates'] if m['id']==a.candidate)
    base=f'https://huggingface.co/{m["repository"]}/resolve/{m["revision"]}/'
    dest=a.directory/a.candidate;dest.mkdir(parents=True,exist_ok=False)
    model=dest/'model.gguf';record=dict(m)
    if m['delivery']=='official_owner_gguf':download(base+m['filename'],model,m['sha256'],m['bytes'])
    else:
        if not a.llama_source or not a.quantize:p.error('Conversion requires pinned tooling')
        revision=subprocess.check_output(['git','-C',str(a.llama_source),'rev-parse','HEAD'],text=True).strip()
        if revision!=manifest['runtime_source_revision']:raise ValueError('Conversion source mismatch')
        source=dest/'source';source.mkdir()
        for f in m['source_files']:
            path=source/f['rfilename']
            if not path.resolve().is_relative_to(source.resolve()):raise ValueError('Unsafe source path')
            lfs=f.get('lfs',{})
            download(base+f['rfilename'],path,lfs.get('sha256'),f.get('size'),None if lfs else f['blobId'])
        bf16=dest/'source-bf16.gguf'
        subprocess.run([sys.executable,str(a.llama_source/'convert_hf_to_gguf.py'),str(source),'--outtype','bf16','--outfile',str(bf16)],check=True,timeout=1800)
        subprocess.run([str(a.quantize),str(bf16),str(model),'Q4_K_M'],check=True,timeout=1800)
        bf16.unlink()
        # Preserve required source notices without retaining large weights.
        for name in ['LICENSE','README.md']:
            if (source/name).exists():shutil.copy(source/name,dest/name)
        shutil.rmtree(source)
        record['conversion_source_revision']=revision
        record['conversion_tool_sha256']=hashlib.sha256((a.llama_source/'convert_hf_to_gguf.py').read_bytes()).hexdigest()
        record['quantizer_sha256']=hashlib.sha256(a.quantize.read_bytes()).hexdigest()
        record['python_packages']=subprocess.check_output([sys.executable,'-m','pip','freeze'],text=True).splitlines()
    with model.open('rb') as f:record['sha256']=hashlib.file_digest(f,'sha256').hexdigest()
    record['bytes']=model.stat().st_size
    (dest/'provenance.json').write_text(json.dumps(record,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(dict(candidate=a.candidate,sha256=record['sha256'],bytes=record['bytes'])))
if __name__=='__main__':main()
