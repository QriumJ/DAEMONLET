"""Opt-in real GPU transport checks against an already running local diagnostic."""
import argparse
import hashlib
import json
import re
import struct
import time
import urllib.request
import urllib.error
import uuid
from pathlib import Path


def main():
    p=argparse.ArgumentParser();p.add_argument('--url',default='http://127.0.0.1:47862');p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    if not re.fullmatch(r'http://127\.0\.0\.1:\d+',a.url):raise ValueError('Loopback only')
    if a.output.exists():raise ValueError('New result required')
    page=urllib.request.urlopen(a.url).read().decode();token=re.search(r'name="live-token" content="([^"]+)"',page)[1]
    def status():return json.load(urllib.request.urlopen(a.url+'/status'))
    def post(path,data,origin=None):
        return urllib.request.urlopen(urllib.request.Request(a.url+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json','Origin':origin or a.url,'X-Live-Token':token}),timeout=15)
    pid=status()['pid'];results=[]
    try:post('/cancel',{'id':'foreign'},origin='http://example.invalid');raise AssertionError('Origin accepted')
    except urllib.error.HTTPError as e:assert e.code==403
    baseline=None
    for cycle in range(6):
        if cycle:
            ident=str(uuid.uuid4());cancelled=False;count=0;at=3 if cycle%2 else 1
            with post('/stream',{'id':ident,'text':'먼저 파일을 확인할게. 문제가 없으면 다음 작업으로 넘어가자.'}) as response:
                try:post('/stream',{'id':str(uuid.uuid4()),'text':'응.'});raise AssertionError('Concurrent generation accepted')
                except urllib.error.HTTPError as e:assert e.code==409
                for line in response:
                    row=json.loads(line)
                    if row['type']=='chunk':
                        count+=1
                        assert count<=at
                        if count==at:
                            if at==3:time.sleep(.25) # let the producer wait for credit
                            start=time.monotonic();post('/cancel',{'id':ident}).close();cancelled=True
                        # Deliberately withhold credits: exercise bounded credit wait.
                    else:
                        assert row['id']==ident and row['cancelled'] and row['cleanupComplete'] and not row['error'] and row['pid']==pid
                        results.append(dict(cycle=cycle,cancelChunks=count,ackMs=(time.monotonic()-start)*1000));break
            assert cancelled
        ident=str(uuid.uuid4());digest=hashlib.sha256();offset=0;chunks=0
        with post('/stream',{'id':ident,'text':'오빠, 오늘은 어떤 이야기를 할까?'}) as response:
            post('/cancel',{'id':'stale-speech-id'}).close()
            for line in response:
                row=json.loads(line);assert row['id']==ident
                if row['type']=='chunk':
                    assert row['index']==chunks and row['offset']==offset
                    digest.update(struct.pack('<'+'f'*len(row['pcm']),*row['pcm']));offset+=len(row['pcm']);chunks+=1
                    post('/credit',{'id':ident,'index':row['index']}).close()
                else:
                    assert row['cleanupComplete'] and not row['cancelled'] and not row['error'] and row['pid']==pid
                    break
        current=digest.hexdigest()
        if baseline is None:baseline=current
        assert current==baseline and chunks==19
        results.append(dict(cycle=cycle,recoverySamePcm=True,pid=pid,chunks=chunks))
    a.output.write_text(json.dumps(dict(status='PASS',originRejected=True,busyRejected=True,staleCancelIgnored=True,results=results),indent=2)+'\n')
    print(json.dumps(results))

if __name__=='__main__':main()
