import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {rewriteRigWorkerUrl,assertQaWorkerArtifact} from '../rig-worker-bundle.mjs';
test('only the QA worker URL is rewritten to executable JavaScript',()=>{
  const source='const unrelated="keep";new Worker(new URL("./RigDecodeWorker.ts", import.meta.url),{type:"module"})';
  assert.equal(rewriteRigWorkerUrl(source),'const unrelated="keep";new Worker(new URL("./rig-decode-worker.js", import.meta.url),{type:"module"})');
});
for(const source of ['new URL("./OtherWorker.ts", import.meta.url)','new URL("./RigDecodeWorker.ts", import.meta.url);new URL("./RigDecodeWorker.ts", import.meta.url)'])test('changed source fails closed: '+source,()=>assert.throws(()=>rewriteRigWorkerUrl(source),/SOURCE_CHANGED/));
async function fixture(t){const dist=await mkdtemp(join(tmpdir(),'daemonlet-worker-bundle-'));t.after(()=>rm(dist,{recursive:true,force:true}));return dist;}
test('original missing .ts worker is rejected',async t=>{const d=await fixture(t);await writeFile(join(d,'pet.js'),'new URL("./RigDecodeWorker.ts",import.meta.url)');await assert.rejects(assertQaWorkerArtifact(d),/URL_NOT_COMPILED/)});
test('compiled URL with missing asset is rejected',async t=>{const d=await fixture(t);await writeFile(join(d,'pet.js'),'new URL("./rig-decode-worker.js",import.meta.url)');await assert.rejects(assertQaWorkerArtifact(d),/ASSET_MISSING/)});
test('wrong worker contents are rejected',async t=>{const d=await fixture(t);await writeFile(join(d,'pet.js'),'new URL("./rig-decode-worker.js",import.meta.url)');await writeFile(join(d,'rig-decode-worker.js'),'not the worker');await assert.rejects(assertQaWorkerArtifact(d),/ASSET_INVALID/)});
test('compiled URL and worker artifact pass together',async t=>{const d=await fixture(t);await writeFile(join(d,'pet.js'),'new URL("./rig-decode-worker.js",import.meta.url)');await writeFile(join(d,'rig-decode-worker.js'),'self.onmessage=e=>self.postMessage(e.data)');assert.deepEqual(await assertQaWorkerArtifact(d),{workerUrl:'rig-decode-worker.js',workerExists:true})});
