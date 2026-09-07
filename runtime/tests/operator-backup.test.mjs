import test from 'node:test';
import assert from 'node:assert/strict';
import {handleOperatorRequest,signOperatorRequest} from '../operator-api.mjs';
test('backup_now and export_recovery reuse signed review auth, reject params and stay disconnected until recovery is enabled',async()=>{
  const env={MODE:'review',OPERATOR_ID:'fixture',OPERATOR_BRIDGE_SECRET:'fixture'},now=Date.now();
  for(const operation of ['backup_now','export_recovery']){
    const envelope=await signOperatorRequest(operation,{},env.OPERATOR_ID,env.OPERATOR_BRIDGE_SECRET,now);
    await assert.rejects(handleOperatorRequest(null,envelope,env,now),e=>e.status===503&&e.message.includes('not connected'));
    await assert.rejects(handleOperatorRequest(null,{...envelope,signature:'00'.repeat(32)},env,now),e=>e.status===401);
    await assert.rejects(handleOperatorRequest(null,envelope,{...env,MODE:'live'},now),e=>e.status===401);
    for(const params of [{retentionDays:7},{keyId:'x'},{now:'2026-01-01'},{previousRunStopped:true}]){
      const extra=await signOperatorRequest(operation,params,env.OPERATOR_ID,env.OPERATOR_BRIDGE_SECRET,now);
      await assert.rejects(handleOperatorRequest(null,extra,env,now),e=>e.status===400&&e.message.includes('Unexpected operator request.'));
    }
  }
});
