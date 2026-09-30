import {createServer,type Server} from 'node:http'
import {timingSafeEqual} from 'node:crypto'
import type {DotPresentationService} from './DotPresentationService'
export function dotBridgeConfig(env:NodeJS.ProcessEnv){
 if(env.DAEMONLET_DOT_BRIDGE!=='1')return null
 const token=env.DAEMONLET_DOT_TOKEN??'',port=Number(env.DAEMONLET_DOT_PORT??39471)
 if(!/^[a-zA-Z0-9_-]{32,128}$/.test(token)||!Number.isInteger(port)||port<1024||port>65535)throw Error('DOT_CONFIG')
 return {token,port}
}
/** Internal loopback RPC, not a public MCP endpoint. The stdio adapter is MCP. */
export class DotBridgeServer{
 private server:Server|null=null
 private pending=0
 private lastCall=0
 constructor(private service:DotPresentationService){}
 async start(config:{token:string;port:number}){
  if(this.server)throw Error('DOT_ALREADY_STARTED')
  let boundPort=config.port
  const server=this.server=createServer(async(req,res)=>{
   const reply=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
   const auth=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+config.token)
   if(req.headers.host!==`127.0.0.1:${boundPort}`||req.headers.origin!==undefined||auth.length!==expected.length||!timingSafeEqual(auth,expected)){reply(403,{error:'DOT_ACCESS'});return}
   if(req.method!=='POST'||req.url!=='/present'||!req.headers['content-type']?.startsWith('application/json')){reply(404,{error:'DOT_ENDPOINT'});return}
   if(this.pending>=2){reply(429,{error:'DOT_BUSY'});return}
   ++this.pending
   try{
    let bytes=0;const chunks:Buffer[]=[]
    for await(const chunk of req){bytes+=chunk.length;if(bytes>8192){reply(413,{error:'DOT_SIZE'});return}chunks.push(Buffer.from(chunk))}
    let value:unknown;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{reply(400,{error:'DOT_ARGUMENTS'});return}
    if((value as any)?.type!=='cancel'&&Date.now()-this.lastCall<250){reply(429,{error:'DOT_RATE_LIMIT'});return}
    if((value as any)?.type!=='cancel')this.lastCall=Date.now()
    reply(200,await this.service.present(value))
   }catch(e){reply(400,{error:e instanceof Error&&/^DOT_[A-Z_]+$/.test(e.message)?e.message:'DOT_UNAVAILABLE'})}finally{--this.pending}
  })
  server.requestTimeout=5000;server.headersTimeout=5000;server.timeout=5000
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve()})})}catch(e){this.server=null;server.close();throw e}
  boundPort=(server.address() as {port:number}).port
  return boundPort
 }
 async close(){const server=this.server;this.server=null;if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}}
}
