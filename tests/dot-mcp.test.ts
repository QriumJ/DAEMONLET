import {afterEach,expect,it,vi} from 'vitest'
import {PassThrough} from 'node:stream'
import {createMcpHandler,runStdio,localForward,tools} from '../scripts/dot-presentation-mcp.mjs'
async function ready(forward:any=vi.fn(async()=>({accepted:true}))){const handler=createMcpHandler(forward);await handler({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});await handler({jsonrpc:'2.0',method:'notifications/initialized'});return {handler,forward}}
it('negotiates stdio tools and declares all writes without resources/history',async()=>{const {handler}=await ready();const r:any=await handler({jsonrpc:'2.0',id:2,method:'tools/list'});expect(r.result.tools.map((t:any)=>t.name)).toEqual(['present','cancel']);expect(tools.every(t=>!t.annotations.readOnlyHint&&!t.annotations.openWorldHint)).toBe(true);expect(await handler({jsonrpc:'2.0',id:3,method:'resources/list'})).toMatchObject({error:{code:-32601}})})
it('requires initialize and returns tool errors without leaking private exception strings',async()=>{const h=createMcpHandler(async()=>{});expect(await h({jsonrpc:'2.0',id:1,method:'tools/list'})).toMatchObject({error:{code:-32000}});const {handler}=await ready(async()=>{throw Error('/private/secret.txt')});expect(await handler({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'present',arguments:{text:'x'}}})).toMatchObject({result:{isError:true,content:[{text:'DOT_UNAVAILABLE'}]}})})
it('cannot override internal dispatch or call arbitrary methods',async()=>{const {handler,forward}=await ready();for(const params of [{name:'shell',arguments:{}},{name:'present',arguments:{type:'cancel',text:'x'}},{name:'cancel',arguments:{path:'/tmp'}}])expect(await handler({jsonrpc:'2.0',id:2,method:'tools/call',params})).toMatchObject({error:{code:-32602}});expect(forward).not.toHaveBeenCalled()})
it('stdio handles Unicode split across chunks and emits only JSON-RPC',async()=>{const input=new PassThrough(),output=new PassThrough(),data:string[]=[];output.on('data',b=>data.push(b.toString()));const {handler,forward}=await ready();runStdio(input,output,handler);const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'present',arguments:{text:'안녕 😀'}}})+'\n');input.write(b.subarray(0,b.length-4));input.write(b.subarray(b.length-4));await vi.waitFor(()=>expect(data).toHaveLength(1));expect(JSON.parse(data[0]).id).toBe(4);expect(forward).toHaveBeenCalledWith({type:'present',text:'안녕 😀'});input.destroy();output.destroy()})
it('rejects invalid or missing session endpoint configuration',()=>{expect(()=>localForward({})).toThrow('DOT_CONFIG');expect(()=>localForward({DAEMONLET_DOT_TOKEN:'x'.repeat(32),DAEMONLET_DOT_PORT:'0'})).toThrow();expect(()=>localForward({DAEMONLET_DOT_TOKEN:'x'.repeat(32),DAEMONLET_DOT_PORT:'39471'})).not.toThrow()})
it('bounds oversized stdio input without executing a tool',()=>{const input=new PassThrough(),output=new PassThrough(),write=vi.fn();output.on('data',write);const h=vi.fn();runStdio(input,output,h);input.write('x'.repeat(16385));expect(input.destroyed).toBe(true);expect(h).not.toHaveBeenCalled();expect(JSON.parse(write.mock.calls[0][0].toString()).error.code).toBe(-32600);output.destroy()})

afterEach(()=>vi.restoreAllMocks())
it('local forward projects only bounded presentation acknowledgements',async()=>{vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({accepted:true,sequence:2,poseFallback:false,voice:'off',privateHistory:'secret'})));const f=localForward({DAEMONLET_DOT_TOKEN:'a'.repeat(32)});expect(await f({type:'cancel'})).toEqual({accepted:true,sequence:2,poseFallback:false,voice:'off'})})
it('local forward rejects oversized or malformed app responses',async()=>{const fetch=vi.spyOn(globalThis,'fetch'),f=localForward({DAEMONLET_DOT_TOKEN:'a'.repeat(32)});for(const body of ['x'.repeat(4097),JSON.stringify({accepted:true,sequence:2,poseFallback:false,voice:'arbitrary'})]){fetch.mockResolvedValueOnce(new Response(body));await expect(f({type:'cancel'})).rejects.toThrow('DOT_UNAVAILABLE')}})

const modernMeta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}
const modern=(method:string,params:Record<string,unknown>={})=>({jsonrpc:'2.0',id:10,method,params:{...params,_meta:modernMeta}})
it('supports modern discovery without initializing or invoking the app',async()=>{
 const forward=vi.fn(),h=createMcpHandler(forward)
 expect(await h(modern('server/discover'))).toMatchObject({result:{resultType:'complete',supportedVersions:['2026-07-28','2025-06-18'],capabilities:{tools:{}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'daemonlet-presentation'}}}})
 expect(await h(modern('tools/list'))).toMatchObject({result:{resultType:'complete',tools}})
 expect(forward).not.toHaveBeenCalled()
})
it('serves modern present/cancel independently with the same bounded dispatch',async()=>{
 const forward=vi.fn(async(_command:any)=>({accepted:true,sequence:1,poseFallback:false,voice:'off'})),h=createMcpHandler(forward)
 for(const params of [{name:'present',arguments:{text:'벨이야.',pose:'happy',speak:false}},{name:'cancel',arguments:{}}])expect(await h(modern('tools/call',params))).toMatchObject({result:{resultType:'complete',content:[{type:'text'}]}})
 expect(forward.mock.calls.map(c=>c[0])).toEqual([{type:'present',text:'벨이야.',pose:'happy',speak:false},{type:'cancel'}])
})
it.each([
 {},
 {_meta:{}},
 {_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}},
 {_meta:{'io.modelcontextprotocol/clientCapabilities':{}}},
 {_meta:{...modernMeta,'io.modelcontextprotocol/clientCapabilities':[]}},
 {_meta:{...modernMeta,'io.modelcontextprotocol/clientCapabilities':null}},
 {_meta:{...modernMeta,'io.modelcontextprotocol/clientInfo':{name:'x'}}},
 {_meta:{...modernMeta,'io.modelcontextprotocol/protocolVersion':'not-a-version'}},
 {path:'/private',_meta:modernMeta},
])('rejects malformed modern discovery metadata/params without forwarding: %j',async params=>{
 const forward=vi.fn(),h=createMcpHandler(forward)
 expect(await h({jsonrpc:'2.0',id:1,method:'server/discover',params})).toMatchObject({error:{code:-32602}})
 expect(forward).not.toHaveBeenCalled()
})
it.each(['1900-01-01','2027-01-01','2025-06-18'])('rejects unsupported per-request revision %s rather than enabling a session',async version=>{
 const forward=vi.fn(),h=createMcpHandler(forward)
 expect(await h({jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:{...modernMeta,'io.modelcontextprotocol/protocolVersion':version}}})).toMatchObject({error:{code:-32022,data:{supported:['2026-07-28','2025-06-18'],requested:version}}})
 expect(await h({jsonrpc:'2.0',id:2,method:'tools/list'})).toMatchObject({error:{code:-32000}})
 expect(forward).not.toHaveBeenCalled()
})
it('keeps legacy notification gating and repeated initialize rejection while interleaving modern requests',async()=>{
 const h=createMcpHandler(vi.fn())
 await h(modern('tools/list'))
 expect(await h({jsonrpc:'2.0',id:1,method:'tools/list'})).toMatchObject({error:{code:-32000}})
 expect(await h({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-06-18'}})).toMatchObject({result:{protocolVersion:'2025-06-18'}})
 expect(await h({jsonrpc:'2.0',id:3,method:'tools/list'})).toMatchObject({error:{code:-32000}})
 await h(modern('server/discover'))
 await h({jsonrpc:'2.0',method:'notifications/initialized'})
 const legacy:any=await h({jsonrpc:'2.0',id:4,method:'tools/list'})
 expect(legacy.result.tools).toEqual(tools);expect(legacy.result.resultType).toBeUndefined()
 expect(await h({jsonrpc:'2.0',id:5,method:'initialize',params:{protocolVersion:'2025-06-18'}})).toMatchObject({error:{code:-32602}})
})
it('legacy negotiation selects only the implemented legacy revision for a different offered version',async()=>{
 const h=createMcpHandler(vi.fn())
 expect(await h({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2099-01-01'}})).toMatchObject({result:{protocolVersion:'2025-06-18'}})
})
it('does not add resources, prompts, arbitrary tools or modern initialize',async()=>{
 const forward=vi.fn(),h=createMcpHandler(forward)
 for(const method of ['resources/list','prompts/list','shell','initialize'])expect(await h(modern(method))).toMatchObject({error:{code:-32601}})
 for(const params of [{name:'shell'},{name:'present',arguments:{text:'x',type:'cancel'}},{name:'cancel',arguments:{path:'/tmp'}},{name:'cancel',extra:'x'}])expect(await h(modern('tools/call',params))).toMatchObject({error:{code:-32602}})
 expect(forward).not.toHaveBeenCalled()
})
it('rejects invalid modern list params and keeps exception details private',async()=>{
 const h=createMcpHandler(async()=>{throw Error('/private/key')})
 expect(await h(modern('tools/list',{cursor:'arbitrary'}))).toMatchObject({error:{code:-32602}})
 expect(await h(modern('tools/call',{name:'cancel'}))).toMatchObject({result:{resultType:'complete',isError:true,content:[{text:'DOT_UNAVAILABLE'}]}})
})
it('rejects invalid params/metadata shapes instead of treating them as stateless consent',async()=>{
 const h=createMcpHandler(vi.fn())
 for(const params of [null,[],{_meta:[]},{_meta:'secret'}])expect(await h({jsonrpc:'2.0',id:1,method:'tools/list',params})).toMatchObject({error:{code:-32602}})
})
