"""Loopback-only, isolated GGUF live diagnostic. No dependency/model installation."""
import argparse
import json
import os
from pathlib import Path
import queue
import re
import secrets
import shlex
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'electron/voice'))
from worker import sha, inside, read_json, ADAPTER, CHECKSUMS, MODEL, REVISION
PIN = '873056743b74e1a4ce5dcf7290e2298428e214db'


def main():
    if sys.flags.optimize:
        raise RuntimeError('Validation requires non-optimized Python')
    parser = argparse.ArgumentParser()
    for key in ['source', 'converted', 'package', 'model', 'output']:
        parser.add_argument('--'+key, required=True, type=Path)
    parser.add_argument('--port', type=int, default=47862)
    args = parser.parse_args()
    source, converted, package, model, output = [getattr(args, k).resolve() for k in ['source', 'converted', 'package', 'model', 'output']]
    if output.exists() or output.is_relative_to(ROOT) or any(output.is_relative_to(p) or p.is_relative_to(output) for p in [source,converted,package,model]):
        parser.error('Output must be a new private directory outside inputs/repository')
    assert subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip() == PIN
    assert not subprocess.check_output(['git','-C',str(source),'diff','HEAD'],text=True)
    assert sha(package/'checksums.sha256') == CHECKSUMS
    for line in (package/'checksums.sha256').read_text().splitlines():
        digest,name = line.split('  ',1)
        assert sha(inside(package,name)) == digest
    snapshot = read_json(model/'snapshot-provenance.json')
    assert snapshot['model_id'] == MODEL and snapshot['revision'] == REVISION
    for name,digest in snapshot['files'].items():
        assert sha(inside(model,name)) == digest
    manifest = read_json(converted/'conversion.json')
    assert manifest['status'] == 'PASS_CONVERSION_ONLY' and manifest['sourceCommit'] == PIN and manifest['ggufDtype'] == 'f16'
    assert manifest['adapterSha256'] == ADAPTER and manifest['packageSha256'] == CHECKSUMS and manifest['mergeCount'] == 1
    assert manifest['originalBaseSha256'] == sha(model/'model.safetensors')
    assert manifest['adapterKeys'] == 384 and len(manifest['records']) == manifest['mergedMatrices'] == 192
    assert all(r['ggufExactExpectedCastBytes'] for r in manifest['records'])
    for name,digest in manifest['ggufFiles'].items():
        assert Path(name).name == name and sha(converted/'gguf'/name) == digest
    reference = inside(package,read_json(package/'voice.json')['reference'])
    output.mkdir(parents=True)
    token = secrets.token_urlsafe(32)
    origin = f'http://127.0.0.1:{args.port}'
    pending = queue.Queue(maxsize=8)
    write_lock, owner_lock, event_lock = threading.Lock(),threading.Lock(),threading.Lock()
    state = {'id':None,'ready':False,'pid':None}
    native = None
    def event(value):
        with event_lock:
            with (output/'events.jsonl').open('a') as f:
                f.write(json.dumps(dict(time=time.time(),**value))+'\n')
    def send(value):
        with write_lock:
            if native.poll() is not None:
                raise RuntimeError('Worker exited; restart the diagnostic')
            native.stdin.write(json.dumps(value,ensure_ascii=False)+'\n');native.stdin.flush()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*_): pass
        def allowed(self):
            return self.headers.get('Host') == f'127.0.0.1:{args.port}'
        def reply(self,code,value,kind='application/json'):
            data = value.encode() if isinstance(value,str) else json.dumps(value).encode()
            self.send_response(code);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.end_headers();self.wfile.write(data)
        def do_GET(self):
            if not self.allowed(): return self.reply(403,{'error':'Host rejected'})
            if self.path == '/': return self.reply(200,(Path(__file__).with_name('index.html')).read_text().replace('__TOKEN__',token),'text/html; charset=utf-8')
            if self.path == '/live.js': return self.reply(200,(output/'live.js').read_text(),'application/javascript')
            if self.path == '/status': return self.reply(200,dict(ready=state['ready'] and native.poll() is None,pid=state['pid'],busy=state['id'] is not None))
            return self.reply(404,{'error':'Not found'})
        def do_POST(self):
            if not self.allowed() or self.headers.get('Origin') != origin: return self.reply(403,{'error':'Origin rejected'})
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=8192: raise ValueError('Request size')
                data=json.loads(self.rfile.read(size));ident=data.get('id','')
                supplied=self.headers.get('X-Live-Token') or (data.get('token') if self.path=='/cancel' else '')
                if not isinstance(supplied,str) or not secrets.compare_digest(supplied,token):return self.reply(403,{'error':'Token rejected'})
                if not re.fullmatch(r'[a-zA-Z0-9-]{1,64}',ident):raise ValueError('Invalid id')
                if self.path in ['/cancel','/credit']:
                    with owner_lock:
                        if state['id']==ident:
                            if self.path=='/cancel':send(dict(type='cancel',id=ident));event(dict(type='cancel-request',id=ident))
                            else:
                                index=data.get('index')
                                if type(index)!=int or not 0<=index<600:raise ValueError('Invalid credit')
                                send(dict(type='credit',id=ident,index=index))
                    return self.reply(200,{'accepted':True})
                if self.path!='/stream':return self.reply(404,{'error':'Not found'})
                text=data.get('text','')
                if not isinstance(text,str) or not text.strip() or len(text)>400 or len(text.encode())>1600:raise ValueError('Text limit: 1–400 characters')
                with owner_lock:
                    if state['id'] is not None:return self.reply(409,{'error':'Worker is busy'})
                    if native.poll() is not None:return self.reply(503,{'error':'Worker exited'})
                    state['id']=ident
                    send(dict(type='generate',id=ident,text=text))
                self.send_response(200);self.send_header('Content-Type','application/x-ndjson');self.send_header('Cache-Control','no-store');self.end_headers()
                connected=True;deadline=time.monotonic()+180
                try:
                    while True:
                        row=pending.get(timeout=max(.01,deadline-time.monotonic()))
                        if row.get('type')=='worker-exit':raise RuntimeError('Native worker exited')
                        if row.get('id')!=ident:raise RuntimeError('Worker ownership mismatch')
                        event({k:v for k,v in row.items() if k!='pcm'})
                        if connected:
                            try:self.wfile.write((json.dumps(row)+'\n').encode());self.wfile.flush()
                            except (BrokenPipeError,ConnectionResetError):connected=False;send(dict(type='cancel',id=ident))
                        if row['type']=='end':break
                except Exception as error:
                    event(dict(type='transport-failure',error=str(error)))
                    # A missing cleanup acknowledgment cannot reuse the worker.
                    native.terminate()
                    if connected:
                        try:self.wfile.write((json.dumps(dict(type='end',id=ident,cleanupComplete=False,error=str(error)))+'\n').encode())
                        except OSError:pass
                finally:
                    with owner_lock:state['id']=None
            except (ValueError,KeyError,TypeError) as error:return self.reply(400,{'error':str(error)})
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    server.daemon_threads=True
    try:
        build=source/'build-metal';cmake=build/'tools/omni';flags=(cmake/'CMakeFiles/voxcpm2-cli.dir/flags.make').read_text();includes=next(l.split(' = ',1)[1] for l in flags.splitlines() if l.startswith('CXX_INCLUDES = '));binary=build/'bin/daemonlet-voice-live';obj=output/'worker.o'
        with (output/'build.log').open('w') as log:
            subprocess.run(['/usr/bin/c++','-O3','-DNDEBUG','-std=c++17','-arch','arm64',*shlex.split(includes),'-c',str(Path(__file__).with_name('worker.cpp')),'-o',str(obj)],check=True,stdout=log,stderr=subprocess.STDOUT)
            link=shlex.split((cmake/'CMakeFiles/voxcpm2-cli.dir/link.txt').read_text());link[link.index('CMakeFiles/voxcpm2-cli.dir/voxcpm2/voxcpm2_cli.cpp.o')]=str(obj);link[link.index('-o')+1]=str(binary);subprocess.run(link,cwd=cmake,check=True,stdout=log,stderr=subprocess.STDOUT)
            subprocess.run([str(ROOT/'node_modules/.bin/esbuild'),str(Path(__file__).with_name('client.ts')),'--bundle','--platform=browser','--outfile='+str(output/'live.js')],check=True,stdout=log,stderr=subprocess.STDOUT)
        environment=os.environ.copy();environment.pop('GGML_METAL_PATH_RESOURCES',None)
        log=(output/'native.log').open('w')
        native=subprocess.Popen([str(binary),str(converted/'gguf/VoxCPM2-BaseLM-F16.gguf'),str(converted/'gguf/VoxCPM2-Acoustic-F16.gguf'),str(reference)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,bufsize=1,env=environment)
        def read():
            for line in native.stdout:
                try:row=json.loads(line)
                except ValueError:continue
                pending.put(row)
            pending.put({'type':'worker-exit'})
        threading.Thread(target=read,daemon=True).start()
        ready=pending.get(timeout=45)
        assert ready['type']=='ready'
        log.flush();native_log=(output/'native.log').read_text()
        assert 'custom component backend=MTL0' in native_log and 'offloaded 29/29 layers to GPU' in native_log and 'falling back to CPU' not in native_log
        state.update(ready=True,pid=native.pid)
        receipt=dict(url=origin,pid=os.getpid(),workerPid=native.pid,sourceCommit=PIN,binarySha256=sha(binary),conversionManifestSha256=sha(converted/'conversion.json'),playbackSourceSha256=sha(ROOT/'src/character-chat/AudioPlaybackController.ts'),productionAppChanged=False)
        (output/'server.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt),flush=True)
        event(dict(type='ready',pid=native.pid))
        signal.signal(signal.SIGTERM,lambda *_:(_ for _ in ()).throw(KeyboardInterrupt()))
        server.serve_forever()
    except KeyboardInterrupt:pass
    finally:
        server.server_close()
        if native is not None:
            if native.poll() is None:
                try:send({'type':'quit'});native.wait(timeout=6)
                except Exception:native.kill();native.wait()
            event(dict(type='shutdown',returncode=native.returncode))

if __name__=='__main__':main()
