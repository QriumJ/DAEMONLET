/** Public DTOs contain neither credentials, environment, paths nor raw client output. */
export const BELLE_CONNECTION_IPC={snapshot:'belle-connection.snapshot',refresh:'belle-connection.refresh',configure:'belle-connection.configure',connect:'belle-connection.connect',disconnect:'belle-connection.disconnect',auto:'belle-connection.auto',forget:'belle-connection.forget',changed:'belle-connection.changed',guide:'belle-connection.guide'} as const
export type BelleConnectionConfig={tunnelId:string;organizationId:string;autoConnect:boolean;consentVersion:1}
export type BelleConnectionState='unconfigured'|'disconnected'|'checking'|'connecting'|'ready'|'reconnecting'|'error'|'external'
export type BelleConnectionSnapshot={state:BelleConnectionState;config:BelleConnectionConfig|null;credentialStored:boolean;secureStore:'macos-keychain'|'windows-credential-manager'|'unavailable';clientVersion:string|null;nodeVersion:string|null;error:string|null;retry:number;muted:boolean}
export const BELLE_GUIDE_URLS={tunnels:"https://platform.openai.com/settings/organization/tunnels",keys:"https://platform.openai.com/settings/organization/api-keys",plugins:"https://chatgpt.com/plugins",tunnelDocs:"https://developers.openai.com/api/docs/guides/secure-mcp-tunnels",pluginDocs:"https://developers.openai.com/plugins/deploy/connect-chatgpt"} as const
export type BelleGuide=keyof typeof BELLE_GUIDE_URLS
export function belleGuideUrl(value:unknown):string|null{return typeof value==='string'&&Object.hasOwn(BELLE_GUIDE_URLS,value)?BELLE_GUIDE_URLS[value as BelleGuide]:null}
export type BelleConnectionApi={openGuide:(guide:BelleGuide)=>Promise<void>;snapshot:()=>Promise<BelleConnectionSnapshot>;refresh:()=>Promise<BelleConnectionSnapshot>;configure:(value:{tunnelId:string;organizationId:string;key:string})=>Promise<BelleConnectionSnapshot>;connect:()=>Promise<BelleConnectionSnapshot>;disconnect:()=>Promise<BelleConnectionSnapshot>;setAutoConnect:(value:boolean)=>Promise<BelleConnectionSnapshot>;forget:()=>Promise<BelleConnectionSnapshot>;subscribe:(listener:(value:BelleConnectionSnapshot)=>void)=>()=>void}
export function connectionIds(value:unknown):{tunnelId:string;organizationId:string}|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const v=value as Record<string,unknown>
 return typeof v.tunnelId==='string'&&/^tunnel_[a-f0-9]{32}$/.test(v.tunnelId)&&typeof v.organizationId==='string'&&/^org-[A-Za-z0-9]{8,64}$/.test(v.organizationId)?{tunnelId:v.tunnelId,organizationId:v.organizationId}:null
}
export function validRuntimeKey(value:unknown):value is string{return typeof value==='string'&&/^sk-[A-Za-z0-9_-]{20,1020}$/.test(value)}
export function restoredConnectionConfig(value:unknown):BelleConnectionConfig|null{
 const ids=connectionIds(value);if(!ids||!value||typeof value!=='object')return null
 const v=value as Record<string,unknown>
 if(v.consentVersion!==1||Object.keys(v).some(k=>!['tunnelId','organizationId','autoConnect','consentVersion'].includes(k)))return null
 return {...ids,autoConnect:v.autoConnect===true,consentVersion:1}
}
