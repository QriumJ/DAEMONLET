// App-owned POSIX process group. Closing the parent pipe also tears down descendants.
import {spawn} from 'node:child_process'
const [client,profile,organization]=process.argv.slice(2)
if(process.platform!=='darwin'&&process.platform!=='linux'||!client||!profile||!/^org-[A-Za-z0-9]{8,64}$/.test(organization))process.exit(1)
let stopping=false
function stop(){
 if(stopping)return
 stopping=true
 try{process.kill(-process.pid,'SIGTERM')}catch{}
 // Keep this group leader alive until the whole owned group receives the final signal.
 setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL')}catch{process.exit(1)}},1500)
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('SIGHUP',stop)
process.stdin.on('end',stop);process.stdin.on('close',stop);process.stdin.on('error',stop);process.stdin.resume()
const child=spawn(client,['run','--profile-file',profile,'--control-plane.organization-id',organization,'--mcp.stdio-send-initialized-notification'],{env:process.env,stdio:'ignore'})
delete process.env.CONTROL_PLANE_API_KEY;delete process.env.OPENAI_API_KEY
child.once('error',stop);child.once('exit',stop)
