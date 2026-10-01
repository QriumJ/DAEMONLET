import test from 'node:test';
import assert from 'node:assert/strict';
import {checkCredentialStore,credentialQaPassed,finalQaStatus} from '../credential-check.mjs';

function fakeStore(mode){
  let value,removes=0,gets=0;
  return {
    async available(){return true},
    async has(){if(mode==='verification-throws'&&removes===3)throw Error('native failure');return mode==='item-remains'&&removes===3||value!==undefined},
    async get(){gets++;if(value===undefined)throw Error('KEY_MISSING');return value},
    async put(key){if(key==='invalid')throw Error('INVALID_KEY');value=key},
    async remove(){removes++;if(mode==='deletion-throws'&&removes===3)throw Error('native failure with private contents');value=undefined},
    get removes(){return removes},get gets(){return gets}
  };
}
const successfulProcess={success:true,exitCode:0};
const passingReport=credential=>({credential,credentialProcess:successfulProcess,voice:{status:'PASS'},renderer:{status:'PASS'},manual:{status:'PASS'}});

test('successful CRUD proves final removal before PASS',async()=>{
  const store=fakeStore(),report=await checkCredentialStore(store);
  assert.equal(store.removes,3);assert.equal(report.cleaned,true);assert.equal(report.status,'PASS');
  assert.equal(credentialQaPassed(report,successfulProcess),true);assert.equal(finalQaStatus(passingReport(report)),'PASS');
});
for(const mode of ['deletion-throws','verification-throws','item-remains']){
  test('last cleanup '+mode+' cannot retain earlier PASS',async()=>{
    const report=await checkCredentialStore(fakeStore(mode));
    assert.deepEqual(report.checks,['initially missing','save/read','replace','invalid rejected','delete/idempotent']);
    assert.equal(report.cleaned,false);assert.equal(report.status,'FAIL');assert.equal(report.cleanupError,'QA_CREDENTIAL_CLEANUP_FAILED');
    assert.equal(JSON.stringify(report).includes('private contents'),false);
    assert.equal(credentialQaPassed(report,successfulProcess),false);assert.equal(finalQaStatus(passingReport(report)),'FAIL');
  });
}
test('existing synthetic item is preserved and never reported cleaned',async()=>{
  let mutations=0;
  const report=await checkCredentialStore({available:async()=>true,has:async()=>true,put:async()=>mutations++,remove:async()=>mutations++});
  assert.equal(mutations,0);assert.equal(report.status,'FAIL');assert.equal(report.error,'QA_ITEM_ALREADY_EXISTS');assert.equal(report.cleaned,false);
});
test('failure during save still attempts and proves owned cleanup',async()=>{
  const store=fakeStore();store.put=async()=>{throw Error('native failed')};
  const report=await checkCredentialStore(store);
  assert.equal(store.removes,1);assert.equal(report.cleaned,true);assert.equal(report.status,'FAIL');
});
for(const cleaned of [false,undefined,'true']){
  test('overall result requires boolean cleaned=true: '+String(cleaned),()=>{
    assert.equal(finalQaStatus(passingReport({status:'PASS',cleaned})),'FAIL');
  });
}
for(const processResult of [undefined,{success:false,exitCode:1},{success:false,exitCode:0},{success:true,exitCode:null},{success:true,exitCode:1}]){
  test('overall result rejects missing or unsuccessful process '+JSON.stringify(processResult),()=>{
    assert.equal(finalQaStatus({...passingReport({status:'PASS',cleaned:true}),credentialProcess:processResult}),'FAIL');
  });
}
test('successful credential does not turn incomplete GUI into PASS',()=>{
  assert.equal(finalQaStatus({...passingReport({status:'PASS',cleaned:true}),manual:{status:'INCOMPLETE'}}),'INCOMPLETE');
});
