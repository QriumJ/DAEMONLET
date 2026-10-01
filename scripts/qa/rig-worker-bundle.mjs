import {readFile,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const workerName='rig-decode-worker.js';
export function rewriteRigWorkerUrl(source){
  const original='new URL("./RigDecodeWorker.ts", import.meta.url)';
  if(source.split(original).length!==2)throw Error('QA_RIG_WORKER_SOURCE_CHANGED');
  return source.replace(original,'new URL("./'+workerName+'", import.meta.url)');
}

export function qaBrowserPlugins(repo){
  return [
    {name:'qa-compiled-rig-worker',setup(b){b.onLoad({filter:/[\\/]loadRigAsync\.ts$/},async args=>{
      if(resolve(args.path)!==resolve(repo,'src/engine/anime25d/loadRigAsync.ts'))throw Error('QA_UNEXPECTED_RIG_LOADER');
      return {contents:rewriteRigWorkerUrl(await readFile(args.path,'utf8')),loader:'ts'};
    })}},
    {name:'qa-agpsd-debug-util',setup(b){b.onResolve({filter:/^util$/},()=>({path:'util',namespace:'qa-util'}));b.onLoad({filter:/.*/,namespace:'qa-util'},()=>({contents:'export function inspect(){return String("QA descriptor");}',loader:'js'}))}}
  ];
}

export async function assertQaWorkerArtifact(dist){
  const pet=await readFile(join(dist,'pet.js'),'utf8');
  if(pet.includes('./RigDecodeWorker.ts')||!pet.includes('./'+workerName))throw Error('QA_RIG_WORKER_URL_NOT_COMPILED');
  try{await access(join(dist,workerName))}catch{throw Error('QA_RIG_WORKER_ASSET_MISSING')}
  const worker=await readFile(join(dist,workerName),'utf8');
  if(!worker.includes('self.onmessage')||!worker.includes('postMessage'))throw Error('QA_RIG_WORKER_ASSET_INVALID');
  return {workerUrl:workerName,workerExists:true};
}

export async function bundleQaRenderer(build,{repo,dist,extra}){
  await build({entryPoints:[join(repo,'src/engine/anime25d/RigDecodeWorker.ts')],outfile:join(dist,workerName),bundle:true,platform:'browser',format:'esm',plugins:qaBrowserPlugins(repo)});
  const source=await readFile(join(repo,'src/qa/AllPoseLipSyncSmoke.ts'),'utf8');
  await build({stdin:{contents:source+'\n'+extra,resolveDir:join(repo,'src/qa'),loader:'ts'},outfile:join(dist,'pet.js'),bundle:true,platform:'browser',format:'esm',define:{global:'globalThis'},plugins:qaBrowserPlugins(repo)});
  return assertQaWorkerArtifact(dist);
}
