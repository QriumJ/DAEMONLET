"""Application-protocol adapter for the separately receipted native Metal engine."""
import array
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading
import time
import uuid
import wave
import math
from control import StreamCancelled
from seed_contract import request_seed
from gguf_runtime import validate
from worker import sha, ADAPTER, REVISION


class GgufWorker:
    def __init__(self, emit):
        self.emit = emit
        self.native = None
        self.converter = None
        self.active = None
        self.stream_files = []
        self.output = queue.Queue(maxsize=4)
        self.closing = threading.Event()

    def _send(self, value):
        if self.native is None or self.native.poll() is not None:
            raise ValueError('STREAM_CLEANUP')
        self.native.stdin.write(json.dumps(value, ensure_ascii=False)+'\n')
        self.native.stdin.flush()

    def _receive(self, timeout=60, checkpoint=None):
        deadline = time.monotonic()+timeout
        while time.monotonic()<deadline:
            if checkpoint:
                checkpoint()
            try:
                value = self.output.get(timeout=min(.02, max(.001,deadline-time.monotonic())))
            except queue.Empty:
                if self.native.poll() is not None:
                    raise ValueError('STREAM_CLEANUP')
                continue
            if isinstance(value, Exception):
                raise value
            return value
        raise ValueError('STREAM_CLEANUP')

    def initialize(self, request):
        started = time.perf_counter()
        if request.get('executionProfile') != 'gguf-metal-f16':
            raise ValueError('EXECUTION_PROFILE')
        assets = validate(Path(request['package']),Path(request['model']),request.get('ggufCache'),self)
        self.cache = Path(request['cache'])
        self.cache.mkdir(parents=True,exist_ok=True)
        environment = {k:v for k,v in os.environ.items() if not k.startswith(('GGML_','LLAMA_','DYLD_','LD_'))}
        self.native = subprocess.Popen([str(assets[k]) for k in ['binary','base','acoustic','reference']],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,env=environment,cwd=str(assets['binary'].parent))
        self.native_log = ''
        def logs():
            for line in self.native.stderr:
                self.native_log = (self.native_log+line)[-131072:]
        threading.Thread(target=logs,daemon=True).start()
        def reader():
            try:
                while not self.closing.is_set():
                    line = self.native.stdout.readline(2_000_001)
                    if not line:raise ValueError('STREAM_CLEANUP')
                    if len(line)>2_000_000 or not line.endswith('\n'):raise ValueError('PROTOCOL_LIMIT')
                    value = json.loads(line)
                    while not self.closing.is_set():
                        try:self.output.put(value,timeout=.1);break
                        except queue.Full:pass
            except Exception as error:
                if not self.closing.is_set():
                    try:self.output.put(error,timeout=.2)
                    except queue.Full:pass
        threading.Thread(target=reader,daemon=True).start()
        ready = self._receive()
        if ready.get('seedContract') != 1:raise ValueError('VOICE_SEED_UNSUPPORTED')
        # The engine rejects a non-Metal acoustic backend; also require all LM layers.
        deadline=time.monotonic()+1
        while 'offloaded 29/29 layers to GPU' not in self.native_log and time.monotonic()<deadline:time.sleep(.01)
        if ready.get('type')!='ready' or ready.get('backend')!='Metal' or ready.get('pid')!=self.native.pid or ready.get('referenceCacheBuilds')!=1 or 'offloaded 29/29 layers to GPU' not in self.native_log or 'falling back to CPU' in self.native_log:
            raise ValueError('UNSUPPORTED_DEVICE')
        return dict(seedContract=1,workerPid=os.getpid(),nativePid=self.native.pid,loadMs=(time.perf_counter()-started)*1000,
                    executionProfile='gguf-metal-f16',backend='Metal',dtype='float16-weights',
                    adapterSha256=assets['selected']['adapterSha256'],modelRevision=REVISION,referenceSha256=sha(assets['reference']),
                    adapterRepresentation='merged-once-fp32-then-f16',mergedKeys=384,mergedMatrices=192,
                    missingKeys=0,skippedKeys=0,referenceCacheBuilds=1,compileCounts={},
                    runtimeFingerprint=sha(Path(__file__).with_name('runtime-gguf-macos.json')),**assets['cacheAudit'])

    def stream(self, request, credit):
        seed=request_seed(request);text=request.get('text')
        if request.get('streamVersion')!=1 or not isinstance(text,str) or not text.strip() or len(text)>400 or len(text.encode())>1600 or request.get('style') is not None:
            raise ValueError('SYNTHESIS_INPUT')
        ident=self.active=request['synthesisId'];start=time.perf_counter();total=chunks=native_index=native_offset=0;first=None;peak=blocked=0
        self.stream_files=[]
        self._send(dict(type='generate',id=ident,text=text,seed=seed))
        ended=False
        def checkpoint():
            if hasattr(credit,'checkpoint'):credit.checkpoint(chunks)
        def terminal(row):
            if row.get('effectiveSeed')!=seed:raise ValueError('VOICE_SEED_MISMATCH')
            if row.get('id')!=ident or row.get('type')!='end' or row.get('error') or row.get('cleanupComplete') is not True or row.get('cancelled') or row.get('samples')!=native_offset:
                raise ValueError('STREAM_CLEANUP')
            self.active=None
            checkpoint()
        while not ended:
            waited=time.perf_counter();credit(chunks);blocked+=(time.perf_counter()-waited)*1000
            pcm=[]
            # Three native 160ms patches per application chunk. Three credits still
            # bound the queue (1.44s), while the final tail covers successor prefill.
            # Cancellation is polled between/while waiting for EACH native patch.
            for _ in range(3):
                if native_index:self._send(dict(type='credit',id=ident,index=native_index-1))
                row=self._receive(checkpoint=checkpoint)
                if row.get('effectiveSeed')!=seed:raise ValueError('VOICE_SEED_MISMATCH')
                if row.get('id')!=ident:raise ValueError('STREAM_CANCEL_BINDING')
                if row.get('type')=='end':
                    terminal(row);ended=True;break
                checkpoint();part=row.get('pcm')
                if row.get('type')!='chunk' or row.get('index')!=native_index or row.get('offset')!=native_offset or not isinstance(part,list) or not 0<len(part)<=16000 or native_offset+len(part)>48000*60 or not all(type(x) in (int,float) and math.isfinite(x) for x in part):
                    raise ValueError('INVALID_WAVEFORM')
                pcm.extend(part);native_index+=1;native_offset+=len(part)
                if row.get('final') is True:
                    terminal(self._receive(checkpoint=checkpoint));ended=True;break
            if not pcm:break
            checkpoint()
            magnitude=max(map(abs,pcm));peak=max(peak,magnitude)
            audio_id=str(uuid.uuid4());path=self.cache/(audio_id+'.wav');temporary=self.cache/(audio_id+'.partial');self.stream_files.extend([temporary,path])
            samples=array.array('h',(int(max(-1,min(1,x))*32767) for x in pcm))
            if sys.byteorder!='little':samples.byteswap()
            with wave.open(str(temporary),'wb') as output:
                output.setnchannels(1);output.setsampwidth(2);output.setframerate(48000);output.writeframes(samples.tobytes())
            temporary.replace(path);elapsed=(time.perf_counter()-start)*1000
            if first is None:first=elapsed
            self.emit('audio-chunk',request['requestId'],effectiveSeed=seed,audioId=audio_id,binding=request['binding'],synthesisId=ident,segmentIndex=request['segmentIndex'],chunkIndex=chunks,sampleOffset=total,sampleCount=len(pcm),sampleRate=48000,firstChunkReadyMs=first)
            total+=len(pcm);chunks+=1
        if not total or total!=native_offset or peak<1e-7:raise ValueError('INVALID_WAVEFORM')
        elapsed=(time.perf_counter()-start)*1000
        return dict(effectiveSeed=seed,synthesisId=ident,totalSamples=total,totalChunks=chunks,firstChunkReadyMs=first,generationMs=elapsed,producerBlockedMs=blocked,rtf=elapsed/(total/48))

    def synthesize(self, request):
        raise ValueError('EXECUTION_PROFILE')

    def cancel_stream(self):
        if self.active:
            ident=self.active;self._send(dict(type='cancel',id=ident));deadline=time.monotonic()+1.2
            while time.monotonic()<deadline:
                row=self._receive(timeout=max(.001,deadline-time.monotonic()))
                if row.get('id')!=ident:raise ValueError('STREAM_CANCEL_BINDING')
                if row.get('type')=='end':
                    if row.get('cleanupComplete') is not True or row.get('error'):raise ValueError('STREAM_CLEANUP')
                    self.active=None;break
            if self.active:raise ValueError('STREAM_CLEANUP')
        for path in self.stream_files:path.unlink(missing_ok=True)
        self.stream_files=[]

    def reuse_audit(self):
        return dict(nativePid=self.native.pid,referenceCacheBuilds=1,compileCounts={})

    def close(self):
        converting=self.converter
        if converting and converting.poll() is None:
            converting.terminate()
            try:converting.wait(timeout=.7)
            except subprocess.TimeoutExpired:converting.kill();converting.wait(timeout=.3)
        child=self.native
        if child is None:return
        try:
            if child.poll() is None:
                self._send(dict(type='quit'));child.wait(timeout=.7)
        except Exception:
            if child.poll() is None:
                child.terminate()
                try:child.wait(timeout=.3)
                except subprocess.TimeoutExpired:child.kill();child.wait(timeout=.3)
        finally:
            self.closing.set()
            for pipe in [child.stdin,child.stdout,child.stderr]:
                # Reader threads own their read handles; closing them here can block.
                if pipe is child.stdin:
                    try:pipe.close()
                    except OSError:pass
