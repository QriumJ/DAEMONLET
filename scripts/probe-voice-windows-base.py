"""Explicit Windows GPU probe of base-only PyTorch speech, no source/env updates."""
import argparse,hashlib,json,os,queue,subprocess,threading,time,uuid,wave
from pathlib import Path
p=argparse.ArgumentParser()
for name in ['python','worker','model','output']:p.add_argument('--'+name,required=True,type=Path)
a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False);cache=a.output/'session';cache.mkdir()
report=dict(status='RUNNING',scope='Windows PyTorch CUDA base-only',physicalListening='NOT_TESTED',measurements=[],cancellations=[])
q=queue.Queue()
with (a.output/'worker.log').open('w',encoding='utf-8') as log:
 w=subprocess.Popen([str(a.python),'-B','-u',str(a.worker)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,encoding='utf-8',env={**os.environ,'PYTHONUTF8':'1','PYTHONDONTWRITEBYTECODE':'1','PYTHONNOUSERSITE':'1','PYTHONPATH':''})
 def reader():
  for line in w.stdout:
   try:q.put(json.loads(line))
   except Exception:q.put(RuntimeError('invalid protocol'))
  q.put(RuntimeError('worker exited'))
 threading.Thread(target=reader,daemon=True).start()
 def send(kind,**data):
  request=dict(protocolVersion=1,type=kind,requestId=str(uuid.uuid4()),**data);w.stdin.write(json.dumps(request,ensure_ascii=False)+'\n');w.stdin.flush();return request
 def receive(timeout=120):
  v=q.get(timeout=timeout)
  if isinstance(v,Exception):raise v
  if v.get('type')=='error':raise RuntimeError(v.get('code'))
  return v
 binding=dict(characterId='diagnostic',revision='diagnostic',conversationId=str(uuid.uuid4()),messageId=str(uuid.uuid4()),requestId=str(uuid.uuid4()),epoch=1,speechEpoch=1,personaHash='diagnostic',semanticHash='diagnostic',modelId='12B',voiceProfileId='voxcpm2_default',voiceProfileVersion='32279effe8c19989596f05d353d1447f51d9e915',voiceFingerprint='base',runtimeSessionId=str(uuid.uuid4()),executionProfile='cuda-compiled')
 def stream(text,cancel=False):
  binding['speechEpoch']+=1;request=send('stream',streamVersion=1,synthesisId=str(uuid.uuid4()),text=text,binding=binding,segmentIndex=0,style=None)
  digest=hashlib.sha256();samples=chunks=0;start=time.perf_counter();first=None;cancel_request=None
  while True:
   row=receive()
   if row['type']=='synthesis-started':continue
   if row['type']=='audio-chunk':
    assert row['requestId']==request['requestId'] and row['binding']==binding and row['chunkIndex']==chunks and row['sampleOffset']==samples
    file=cache/(row['audioId']+'.wav')
    with wave.open(str(file)) as audio:
     assert (audio.getframerate(),audio.getnchannels(),audio.getsampwidth())==(48000,1,2)
     data=audio.readframes(audio.getnframes());assert len(data)//2==row['sampleCount']
    file.unlink();digest.update(data);samples+=len(data)//2;chunks+=1
    first=first if first is not None else (time.perf_counter()-start)*1000
    if cancel:
     if chunks==3:
      target=dict(requestId=request['requestId'],synthesisId=request['synthesisId'],runtimeSessionId=binding['runtimeSessionId'],speechEpoch=binding['speechEpoch']);cancel_start=time.perf_counter();cancel_request=send('cancel-stream',target=target)
    else:
     w.stdin.write(json.dumps(dict(protocolVersion=1,type='credit',requestId=request['requestId'],chunkIndex=row['chunkIndex']))+'\n');w.stdin.flush()
   elif row['type']=='cancelled':
    assert cancel_request and row['requestId']==cancel_request['requestId'] and row['target']==target and row['cleanupComplete'] and row['keptWarm'];assert not list(cache.glob('*.wav'))
    return dict(cancelMs=(time.perf_counter()-cancel_start)*1000,samePid=w.poll() is None,**row)
   elif row['type']=='synthesis-finished':
    assert not cancel and row['totalSamples']==samples and row['totalChunks']==chunks
    return dict(hash=digest.hexdigest(),firstReceivedMs=first,**row)
 try:
  send('init',baseModel=True,executionProfile='compiled',package='',model=str(a.model),cache=str(cache),compilerCache=str(a.output/'compiler-cache'))
  ready=receive(900);assert ready['type']=='ready' and ready['mode']=='base' and ready['loadedKeys']==0 and ready['referenceSha256'] is None and ready['dtype']=='bfloat16'
  report['audit']=ready;report['measurements'].append(stream('응, 듣고 있어. 지금은 어떤 이야기를 할까?'))
  reference=report['measurements'][0]['hash']
  for _ in range(3):
   report['cancellations'].append(stream('기본 모델만 사용하는 음성 시험입니다. 잠시 중단했다가 다시 이야기할게요.',True))
   recovered=stream('응, 듣고 있어. 지금은 어떤 이야기를 할까?');assert recovered['hash']==reference;report['measurements'].append(recovered)
  report['measurements'].append(stream('내일 오후 세 시에 다시 확인해 줘.'))
  report['status']='PASS';print(json.dumps(report,ensure_ascii=False))
 except BaseException as e:report.update(status='FAIL',error=str(e));raise
 finally:
  if w.poll() is None:
   try:send('shutdown');w.stdin.close();w.wait(timeout=10)
   except Exception:subprocess.run(['taskkill','/PID',str(w.pid),'/T','/F'],capture_output=True);w.wait(timeout=10)
  report['ownedWorkerExited']=w.poll() is not None;(a.output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
