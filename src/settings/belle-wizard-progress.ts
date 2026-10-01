/** Only a bounded navigation index is retained. No target, key, consent or completed flag. */
export const BELLE_WIZARD_PROGRESS='daemonlet.belle-wizard.step.v1'
export function restoredWizardStep(value:string|null):number{
 return value!==null&&/^[0-5]$/.test(value)?Number(value):0
}
export function wizardRuntimeReady(state:{state:string;config:unknown;credentialStored:boolean;secureStore:string;error:string|null}):boolean{
 return state.state==='ready'&&Boolean(state.config)&&state.credentialStored&&state.secureStore!=='unavailable'&&!state.error
}
export function wizardNextAllowed(step:number,state:{config:unknown;credentialStored:boolean;state:string;secureStore:string;error:string|null},installed:boolean):boolean{
 if(step===2)return Boolean(state.config&&state.credentialStored)
 if(step===3)return wizardRuntimeReady(state)
 if(step===4)return wizardRuntimeReady(state)&&installed
 return step<5
}
