"""Explicit setup of a NEW external Apple Silicon Qwen environment and snapshot.
Run with an existing Python 3.12; never invoked by app/model load. No admin/PATH changes.
"""
import argparse,hashlib,json,os,platform,subprocess,sys,urllib.request,venv
from pathlib import Path
P=json.loads((Path(__file__).resolve().parents[1]/'electron/voice/qwen-mlx-policy.json').read_text())
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  while b:=f.read(8*1024*1024):h.update(b)
 return h.hexdigest()
def run():
 a=argparse.ArgumentParser();a.add_argument('--root',type=Path,required=True);args=a.parse_args();root=args.root
 if sys.platform!='darwin' or platform.machine()!='arm64' or sys.version_info[:2]!=(3,12):raise SystemExit('Python 3.12 / Apple Silicon required')
 if not root.is_absolute() or root.exists() or root.is_relative_to(Path(__file__).resolve().parents[1]):raise SystemExit('Choose a NEW absolute directory outside source')
 root.mkdir();cache=root/'cache';cache.mkdir();evidence=root/'evidence';evidence.mkdir();prefix=root/'env';venv.create(prefix,with_pip=True)
 python=prefix/'bin/python';env=dict(os.environ,PIP_CACHE_DIR=str(cache/'pip'),TMPDIR=str(cache),PYTHONNOUSERSITE='1')
 packages=[k+'=='+v for k,v in P['dependencies'].items()]+['soundfile==0.14.0','scipy==1.18.1','numpy==2.5.3']
 subprocess.run([str(python),'-m','pip','install','--index-url','https://pypi.org/simple','--only-binary=:all:','--report',str(evidence/'pip-report.json'),*packages],env=env,check=True)
 subprocess.run([str(python),'-m','pip','check'],env=env,check=True)
 # Record actual wheel bytes from pip's downloaded cache, bound to report hashes.
 bodies={sha(p):p.stat().st_size for p in cache.rglob('*.body')}
 pip=json.loads((evidence/'pip-report.json').read_text());wheels=[]
 for item in pip['install']:
  info=item['download_info'];digest=info['archive_info']['hashes']['sha256'];size=bodies.get(digest)
  if size is None:raise ValueError('PACKAGE_RECEIPT_MISSING')
  wheels.append(dict(name=item['metadata']['name'],version=item['metadata']['version'],url=info['url'],sha256=digest,bytes=size,license=item['metadata'].get('license_expression') or item['metadata'].get('license') or item['metadata'].get('classifiers')))
 model=root/'model';model.mkdir();files=[]
 for name,f in P['files'].items():
  path=model/name;path.parent.mkdir(parents=True,exist_ok=True);url=f"https://huggingface.co/{P['model']}/resolve/{P['revision']}/{name}";part=path.with_suffix(path.suffix+'.part')
  with urllib.request.urlopen(url,timeout=90) as response,part.open('wb') as out:
   while b:=response.read(8*1024*1024):out.write(b)
  if part.stat().st_size!=f['bytes']:raise ValueError('MODEL_BYTES')
  digest=sha(part)
  if 'sha256' in f:
   if digest!=f['sha256']:raise ValueError('MODEL_HASH')
  else:
   b=part.read_bytes()
   if hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()!=f['gitSha1']:raise ValueError('MODEL_HASH')
  part.replace(path);files.append(dict(name=name,url=url,bytes=f['bytes'],sha256=digest,license=P['license']))
 receipt=dict(engine=P['engine'],backend='mlx',revision=P['revision'],prefix=str(prefix),pythonVersion=sys.version,interpreter=str(python.resolve()),interpreterSha256=sha(python.resolve()),sourcePolicySha256=sha(Path(__file__).resolve().parents[1]/'electron/voice/qwen-mlx-policy.json'),model=P['model'],conversionPublisher=P['conversionPublisher'],modelBytes=P['totalBytes'],files=files,wheels=wheels,existingEnvironmentsModified=False)
 (prefix/'qwen-runtime.json').write_text(json.dumps(receipt,indent=2)+'\n');(evidence/'manifest.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print('Setup verified. Select',python,'and',model,'in experimental Qwen settings.')
if __name__=='__main__':run()
