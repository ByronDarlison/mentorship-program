import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createAdministrativeConnection} from '../operator-tools.mjs';
import {signOperatorRequest,handleOperatorRequest} from '../operator-api.mjs';
async function connect(t,server){
  const client=new Client({name:'test-client',version:'1'},{capabilities:{}}),[a,b]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});await Promise.all([server.connect(a),client.connect(b)]);return client;
}
const shown=result=>JSON.parse(result.content[0].text);
test('actual connection defaults disabled and model arguments cannot bypass it',async t=>{
  let calls=0;const client=await connect(t,createAdministrativeConnection({callBackend:async()=>{calls++;}}));
  const result=await client.callTool({name:'program_action',arguments:{operation:'administration',params:{approved:true}}});assert.equal(result.isError,true);assert.equal(calls,0);
});
test('preparation never mutates; execution passes the exact previously reviewed action',async t=>{
  const inspect={applications:[{id:'fictional',role:'mentee',answers:{name:'Alex Example'}}],pairs:[]};
  const args={operation:'administration',params:{id:'action',name:'participant_decision',applicationId:'fictional',version:1,decision:'approved',readiness:true}};
  const calls=[];
  const disabled=await connect(t,createAdministrativeConnection({callBackend:async(operation,params)=>{calls.push({operation,params});return operation==='inspect'?inspect:{decision:'approved',version:2};}}));
  const proposal=shown(await disabled.callTool({name:'program_prepare_action',arguments:args}));
  assert.match(JSON.stringify(proposal),/Alex Example/);assert.match(JSON.stringify(proposal),/readiness/);
  assert.equal(calls.filter(c=>c.operation==='administration').length,0);
  const blocked=await disabled.callTool({name:'program_action',arguments:{operation:proposal.operation,params:proposal.params}});
  assert.equal(blocked.isError,true);assert.match(blocked.content[0].text,/Chat actions are not enabled/);assert.equal(calls.filter(c=>c.operation==='administration').length,0);
  const executed=[];
  const enabled=await connect(t,createAdministrativeConnection({chatActionsEnabled:true,callBackend:async(operation,params)=>{executed.push({operation,params});return {decision:'approved',version:2};}}));
  const saved=await enabled.callTool({name:'program_action',arguments:{operation:proposal.operation,params:proposal.params}});
  assert.deepEqual(executed.at(-1),{operation:proposal.operation,params:proposal.params});
  assert.deepEqual(shown(saved),{savedResult:{decision:'approved',version:2}});
});
test('signed requests reject modified actions, old operator identity, expiry and unverified mutation mode',async()=>{
  const env={MODE:'review',OPERATOR_ID:'fixture-chair',OPERATOR_BRIDGE_SECRET:'fictional-test-secret-not-a-credential'},now=Date.now();
  const envelope=await signOperatorRequest('administration',{id:'fictional'},env.OPERATOR_ID,env.OPERATOR_BRIDGE_SECRET,now);
  await assert.rejects(handleOperatorRequest(null,envelope,env,now),e=>e.status===403);
  await assert.rejects(handleOperatorRequest(null,{...envelope,payload:{...envelope.payload,operation:'inspect'}},env,now),e=>e.status===401);
  await assert.rejects(handleOperatorRequest(null,envelope,{...env,OPERATOR_ID:'replacement'},now),e=>e.status===401);
  await assert.rejects(handleOperatorRequest(null,envelope,env,now+120001),e=>e.status===401);
  await assert.rejects(handleOperatorRequest(null,{payload:{approved:true}},env,now),e=>e.status===401);
});
test('disabled deletion never executes an unavailable action',async t=>{
  let calls=0;const client=await connect(t,createAdministrativeConnection({callBackend:async()=>{calls++;}}));
  const result=await client.callTool({name:'program_action',arguments:{operation:'delete_participant',params:{}}});assert.equal(result.isError,true);assert.equal(calls,0);
});
test('deletion preparation includes the current preview and reviewed hash; execution does not regenerate it',async t=>{
  const calls=[],preview={applicationId:'fixture',reviewHash:'current-hash',unresolved:[{missing:['value']}],effect:'Private pending results become totals.'};
  const client=await connect(t,createAdministrativeConnection({chatActionsEnabled:true,callBackend:async(operation,params)=>{
    calls.push({operation,params});
    if(operation==='deletion_preview')return preview;
    if(operation==='inspect')return {applications:[{id:'fixture',role:'mentee',answers:{name:'Alex Example'}}],pairs:[]};
    if(params.reviewHash!=='current-hash')throw new Error('stale review hash');
    return {activeRecordsDeleted:true};
  }}));
  const args={operation:'delete_participant',params:{applicationId:'fixture',reviewHash:'stale-model-hash'}};
  const proposal=shown(await client.callTool({name:'program_prepare_action',arguments:args}));
  const body=JSON.stringify(proposal);
  for(const value of ['Alex Example','Private pending','current-hash','missing'])assert.ok(body.includes(value));
  assert.deepEqual(proposal.params,{applicationId:'fixture',reviewHash:'current-hash'});
  assert.equal(calls.filter(c=>c.operation==='delete_participant').length,0);
  await client.callTool({name:'program_action',arguments:{operation:proposal.operation,params:proposal.params}});
  assert.deepEqual(calls.at(-1),{operation:'delete_participant',params:{applicationId:'fixture',reviewHash:'current-hash'}});
  const stale=await client.callTool({name:'program_action',arguments:args});
  assert.equal(stale.isError,true);assert.match(stale.content[0].text,/stale review hash/);
  assert.deepEqual(calls.at(-1),{operation:'delete_participant',params:{applicationId:'fixture',reviewHash:'stale-model-hash'}});
});
test('unavailable deletion preview returns a clear error without changing records',async t=>{
  let calls=0;const client=await connect(t,createAdministrativeConnection({callBackend:async()=>{calls++;throw new Error('not found');}}));
  const result=await client.callTool({name:'program_prepare_action',arguments:{operation:'delete_participant',params:{applicationId:'missing'}}});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/No change was made/);assert.equal(calls,1);
});
test('small upper clock skew is tolerated while malformed operator input is actionable',async()=>{
  const env={MODE:'review',OPERATOR_ID:'fixture',OPERATOR_BRIDGE_SECRET:'fixture'},now=Date.now();
  for(const skew of [1,1000,30000]){
    const envelope=await signOperatorRequest('administration',{},env.OPERATOR_ID,env.OPERATOR_BRIDGE_SECRET,now+skew);
    await assert.rejects(handleOperatorRequest(null,envelope,env,now),e=>e.status===403);
  }
  const future=await signOperatorRequest('administration',{},env.OPERATOR_ID,env.OPERATOR_BRIDGE_SECRET,now+30001);await assert.rejects(handleOperatorRequest(null,future,env,now),e=>e.status===401);
  for(const [operation,params,message] of [['unknown',{},'Unknown named'],['administration',undefined,'parameters must']]){
    const envelope=await signOperatorRequest(operation,params,env.OPERATOR_ID,env.OPERATOR_BRIDGE_SECRET,now);await assert.rejects(handleOperatorRequest(null,envelope,env,now),e=>e.status===400&&e.message.includes(message));
  }
});
test('classification preparation names its participant and displays the saved answer',async t=>{
  const calls=[],record={id:'request',application_id:'fixture',version:3,answers:{value:'Fictional answer'},classifications:{value:'Unclear'}};
  const client=await connect(t,createAdministrativeConnection({chatActionsEnabled:true,callBackend:async(operation,params)=>{
    calls.push({operation,params});
    if(operation==='inspect')return {applications:[{id:'fixture',role:'mentor',answers:{name:'Alex Example'}}],pairs:[]};
    if(operation==='followups')return {requests:[record]};
    return {version:4};
  }}));
  const action={operation:'correct_classification',params:{id:'action',requestId:'request',version:3,field:'value',classification:'Yes',conditions:''}};
  const proposal=shown(await client.callTool({name:'program_prepare_action',arguments:action}));
  assert.match(JSON.stringify(proposal.affected),/Alex Example/);
  assert.equal(proposal.currentAnswer,'Fictional answer');assert.equal(proposal.currentClassification,'Unclear');
  assert.deepEqual(proposal.params,action.params);
  assert.equal(calls.filter(c=>c.operation==='correct_classification').length,0);
  await client.callTool({name:'program_action',arguments:{operation:proposal.operation,params:proposal.params}});
  assert.deepEqual(calls.at(-1),action);
  const stale=await client.callTool({name:'program_prepare_action',arguments:{...action,params:{...action.params,version:2}}});
  assert.equal(stale.isError,true);assert.equal(calls.filter(c=>c.operation==='correct_classification').length,1);
});
test('follow-ups and recommendations are read-only; action description requires actual approval rather than model flags',async t=>{
  const calls=[],client=await connect(t,createAdministrativeConnection({callBackend:async op=>{calls.push(op);return {ok:true};}}));
  const listed=await client.listTools();
  for(const name of ['program_followups','program_recommendations','program_prepare_action']){assert.equal(listed.tools.find(t=>t.name===name).annotations.readOnlyHint,true);}
  for(const name of ['program_followups','program_recommendations'])await client.callTool({name,arguments:{}});
  assert.deepEqual(calls,['followups','recommend']);
  const action=listed.tools.find(t=>t.name==='program_action');
  assert.equal(action.annotations.readOnlyHint,false);
  assert.match(action.description,/explicitly approved/);
  assert.match(action.description,/Tool flags and signatures do not prove consent/);
  assert.match(listed.tools.find(t=>t.name==='program_prepare_action').description,/Does not change records/);
});
test('cycle preparation names both people and the proposed date',async t=>{
  let changed=false;const client=await connect(t,createAdministrativeConnection({callBackend:async op=>op==='inspect'?{applications:[{id:'mentee',role:'mentee',answers:{name:'Alex Example'}},{id:'mentor',role:'mentor',answers:{name:'Jordan Example'}}],pairs:[{id:'pair',mentee_id:'mentee',mentor_id:'mentor'}]}:(changed=true,{saved:true})}));
  const proposal=shown(await client.callTool({name:'program_prepare_action',arguments:{operation:'correct_cycle',params:{id:'action',pairId:'pair',version:1,actualDate:'2026-05-01'}}}));
  for(const value of ['Alex Example','Jordan Example','2026-05-01'])assert.ok(JSON.stringify(proposal).includes(value));
  assert.equal(changed,false);
});
test('message preparation shows exact text, destination and current preview hash; execution does not regenerate it',async t=>{
  const calls=[],preview={applicationId:'fixture',participant:'Alex Example',subject:'Fictional introduction',body:'Exact approved text',recipient:'reviewer@example.test',status:'pending',reviewHash:'current'};
  const client=await connect(t,createAdministrativeConnection({chatActionsEnabled:true,callBackend:async(operation,params)=>{
    calls.push({operation,params});
    if(operation==='inspect')return {applications:[{id:'fixture',role:'mentee',answers:{name:'Alex Example'}}],pairs:[]};
    if(operation==='message_preview')return preview;
    return {status:'pending',emailSent:false};
  }}));
  const args={operation:'message_action',params:{id:'action',name:'message',applicationId:'fixture',version:1,subject:preview.subject,body:preview.body,reviewHash:'model-hash'}};
  const proposal=shown(await client.callTool({name:'program_prepare_action',arguments:args}));
  for(const value of ['Alex Example','Fictional introduction','Exact approved text','reviewer@example.test','current'])assert.ok(JSON.stringify(proposal).includes(value));
  assert.equal(proposal.params.reviewHash,'current');
  assert.equal(calls.filter(x=>x.operation==='message_action').length,0);
  await client.callTool({name:'program_action',arguments:{operation:proposal.operation,params:proposal.params}});
  assert.deepEqual(calls.at(-1),{operation:'message_action',params:{...args.params,reviewHash:'current'}});
  await client.callTool({name:'program_action',arguments:args});
  assert.deepEqual(calls.at(-1),args);
});
test('final-review preparation displays retained results and a fresh server preview; execution does not regenerate it',async t=>{
  const calls=[],preview={reviewHash:'fresh',effect:'Remove written feedback, preserve minimal results.',finalResults:[{missing:['progress']}]};
  const client=await connect(t,createAdministrativeConnection({chatActionsEnabled:true,callBackend:async(operation,params)=>{
    calls.push({operation,params});
    return operation==='inspect'?{applications:[{id:'fixture',role:'mentee',answers:{name:'Alex Example'}}],pairs:[]}:operation==='final_review_preview'?preview:{detailsRemoved:true};
  }}));
  const args={operation:'finish_final_review',params:{applicationId:'fixture',reviewHash:'model-hash'}};
  const proposal=shown(await client.callTool({name:'program_prepare_action',arguments:args}));
  for(const value of ['Alex Example','preserve minimal results','progress','fresh'])assert.ok(JSON.stringify(proposal).includes(value));
  assert.deepEqual(proposal.params,{applicationId:'fixture',reviewHash:'fresh'});
  assert.equal(calls.filter(c=>c.operation==='finish_final_review').length,0);
  await client.callTool({name:'program_action',arguments:{operation:proposal.operation,params:proposal.params}});
  assert.deepEqual(calls.at(-1),{operation:'finish_final_review',params:{applicationId:'fixture',reviewHash:'fresh'}});
  await client.callTool({name:'program_action',arguments:args});
  assert.deepEqual(calls.at(-1),args);
});
test('retained-result preparation clearly distinguishes removed wording from a missing classification',async t=>{
  const client=await connect(t,createAdministrativeConnection({callBackend:async op=>op==='inspect'?{applications:[{id:'fixture',role:'mentee',answers:{name:'Alex Example'}}],pairs:[]}:op==='followups'?{requests:[{id:'final',application_id:'fixture',version:4,reviewed_at:'2026-01-01',answers:{},classifications:{}}]}:{saved:true}}));
  const proposal=shown(await client.callTool({name:'program_prepare_action',arguments:{operation:'correct_classification',params:{id:'correction',requestId:'final',version:4,field:'progress',classification:'Meaningful',conditions:''}}}));
  assert.equal(proposal.currentAnswer,'Written feedback removed after final review.');
  assert.equal(proposal.currentClassification,'Missing');
});
test('recovery preparation uses the current pending item and requires stopped-work verification; execution does not replace ids',async t=>{
  const calls=[];
  const client=await connect(t,createAdministrativeConnection({chatActionsEnabled:true,callBackend:async(operation,params)=>{
    calls.push({operation,params});
    return operation==='inspect'?{applications:[],pairs:[]}:operation==='recovery_status'?{status:'pending',id:'current-pending'}:{recovery:{status:'verified'}};
  }}));
  const args={operation:'repair_recovery',params:{pendingId:'model-supplied',previousRunStopped:false}};
  assert.equal((await client.callTool({name:'program_prepare_action',arguments:args})).isError,true);
  assert.equal(calls.filter(c=>c.operation==='repair_recovery').length,0);
  const proposal=shown(await client.callTool({name:'program_prepare_action',arguments:{...args,params:{...args.params,previousRunStopped:true}}}));
  const body=JSON.stringify(proposal.recoveryPreview);
  for(const value of ['current-pending','without repeating','have stopped'])assert.ok(body.includes(value));
  assert.deepEqual(proposal.params,{pendingId:'current-pending',previousRunStopped:true});
  assert.equal(calls.filter(c=>c.operation==='repair_recovery').length,0);
  await client.callTool({name:'program_action',arguments:{operation:proposal.operation,params:proposal.params}});
  assert.deepEqual(calls.at(-1),{operation:'repair_recovery',params:{pendingId:'current-pending',previousRunStopped:true}});
  await client.callTool({name:'program_action',arguments:{...args,params:{pendingId:'model-supplied',previousRunStopped:true}}});
  assert.deepEqual(calls.at(-1),{operation:'repair_recovery',params:{pendingId:'model-supplied',previousRunStopped:true}});
});
