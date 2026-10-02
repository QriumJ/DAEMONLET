// Public community conversions explicitly selected for this integration.
// This catalog contains weights only: no interpreter, native runtime or private
// character/LoRA derivative is downloadable through these entries.
export type GgufModelId='qwen3-tts-06b-gguf'|'voxcpm2-gguf-f16'
export type GgufModelFile={name:string;bytes:number;sha256:string;url:string}
export type GgufModelCatalogEntry={id:GgufModelId;engine:'qwen3-tts-06b-gguf'|'voxcpm2';title:string;repository:string;revision:string;license:string;publisher:string;upstreamModel:string;communityConversion:true;totalBytes:number;minimumFreeBytes:number;runtimeRepository:string;runtimeCommit:string;files:readonly GgufModelFile[]}
export type GgufModelCatalog={sourcePolicy:'explicitly-approved-community-conversions';models:readonly GgufModelCatalogEntry[]}
export type GgufModelInstallState={id:GgufModelId;supported:boolean;installed:boolean;verified:boolean;phase:'idle'|'preparing'|'downloading'|'verifying'|'publishing';bytes:number;total:number;error:string|null;modelPath?:string;verification:'sha256';runtimeIncluded:false}
const reserve=256*1024**2
const qwenRepository='Serveurperso/Qwen3-TTS-GGUF',qwenRevision='b7ee2e8c7459c3bea99da23e3d178125a7d1713c'
const voxRepository='DennisHuang648/VoxCPM2-GGUF',voxRevision='169f64d8b98bbaab1761e4ca3a83e6af653456cc'
const file=(repository:string,revision:string,name:string,bytes:number,sha256:string):GgufModelFile=>({name,bytes,sha256,url:`https://huggingface.co/${repository}/resolve/${revision}/${name}`})
export const GGUF_MODEL_CATALOG:GgufModelCatalog={sourcePolicy:'explicitly-approved-community-conversions',models:[
 {id:'qwen3-tts-06b-gguf',engine:'qwen3-tts-06b-gguf',title:'Qwen 0.6B Base Q8 + codec Q8',repository:qwenRepository,revision:qwenRevision,license:'Apache-2.0',publisher:'Serveurperso · community conversion',upstreamModel:'Qwen/Qwen3-TTS-12Hz-0.6B-Base',communityConversion:true,totalBytes:1283766112,minimumFreeBytes:1283766112+reserve,runtimeRepository:'ServeurpersoCom/qwentts.cpp',runtimeCommit:'6fae92914045cd83364d2845ceaa0f7969727319',files:[
  file(qwenRepository,qwenRevision,'qwen-talker-0.6b-base-Q8_0.gguf',992615488,'d54dbaf10591421fa764ed630d764efa717ae40cd959bd48c66d4eb1af226426'),
  file(qwenRepository,qwenRevision,'qwen-tokenizer-12hz-Q8_0.gguf',291150624,'1883beeed99348fc35e23dd225e9082f93f6f8c109330a33d935baa8acdbfd94'),
 ]},
 {id:'voxcpm2-gguf-f16',engine:'voxcpm2',title:'VoxCPM2 BaseLM F16 + Acoustic F16',repository:voxRepository,revision:voxRevision,license:'Apache-2.0',publisher:'DennisHuang648 · community conversion',upstreamModel:'OpenBMB/VoxCPM2',communityConversion:true,totalBytes:5073076896,minimumFreeBytes:5073076896+reserve,runtimeRepository:'tc-mb/llama.cpp-omni',runtimeCommit:'873056743b74e1a4ce5dcf7290e2298428e214db',files:[
  file(voxRepository,voxRevision,'VoxCPM2-BaseLM-F16.gguf',3247980544,'8be62e899f8f32b3c2109c99950b46671135a8f40b27b1df720f6823d36cc59e'),
  file(voxRepository,voxRevision,'VoxCPM2-Acoustic-F16.gguf',1825096352,'5bde898488ad635ff55d24da53543768fa33d5e5cdc538ce190e5ef831038e85'),
 ]},
]}
