// Synthetic QA only: caller must supply a helper compiled for the isolated QA target.
// Never include credential values or native exception text in evidence.
export async function checkCredentialStore(store) {
  const report = {status:'RUNNING',target:'fixed compile-time QA-v1; production target untouched',synthetic:true,actualKey:'NOT READ OR STORED',checks:[],cleaned:false};
  const key='sk-'+'syntheticWindowsQA'.repeat(3);
  let owned=false;
  try {
    if(!await store.available())throw Error('STORE_LOCKED');
    if(await store.has())throw Error('QA_ITEM_ALREADY_EXISTS');
    report.checks.push('initially missing');
    try{await store.get();throw Error('EXPECTED_MISSING')}catch(e){if(e?.message!=='KEY_MISSING')throw e}
    owned=true;
    await store.put(key);
    if(!await store.has()||await store.get()!==key)throw Error('SAVE_READ_FAILED');
    report.checks.push('save/read');
    await store.put(key+'replacement');
    if(await store.get()!==key+'replacement')throw Error('REPLACE_FAILED');
    report.checks.push('replace');
    try{await store.put('invalid');throw Error('EXPECTED_REJECTION')}catch(e){if(e?.message!=='INVALID_KEY')throw e}
    report.checks.push('invalid rejected');
    await store.remove();
    if(await store.has())throw Error('DELETE_FAILED');
    await store.remove();
    report.checks.push('delete/idempotent');
    report.status='PASS';
  } catch(e) {
    report.status='FAIL';
    report.error=['STORE_LOCKED','QA_ITEM_ALREADY_EXISTS','SAVE_READ_FAILED','REPLACE_FAILED','EXPECTED_MISSING','EXPECTED_REJECTION','DELETE_FAILED'].includes(e?.message)?e.message:'QA_STORE_FAILED';
  } finally {
    if(owned){
      try{
        await store.remove();
        report.cleaned=!await store.has();
        if(!report.cleaned)throw Error('QA_CLEANUP_FAILED');
      }catch{
        report.cleaned=false;
        report.status='FAIL';
        report.cleanupError='QA_CREDENTIAL_CLEANUP_FAILED';
      }
    }
  }
  return report;
}

export function credentialQaPassed(credential,processResult){
  return credential?.status==='PASS'&&credential.cleaned===true&&processResult?.success===true&&processResult.exitCode===0;
}

export function finalQaStatus(report){
  if(!credentialQaPassed(report.credential,report.credentialProcess))return 'FAIL';
  return report.voice?.status==='PASS'&&report.renderer?.status==='PASS'&&report.manual?.status==='PASS'?'PASS':'INCOMPLETE';
}
