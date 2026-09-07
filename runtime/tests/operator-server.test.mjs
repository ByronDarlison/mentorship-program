import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createConfiguredOperator,readLaunchEnv} from '../operator-server.mjs';
async function connect(t,server){
  const client=new Client({name:'fictional-client',version:'1'},{capabilities:{}}),[a,b]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});await Promise.all([server.connect(a),client.connect(b)]);return client;
}
test('unconfigured executable exposes only the harmless probe and never contacts a backend',async t=>{
  const client=await connect(t,createConfiguredOperator({},()=>assert.fail('No backend')));
  assert.deepEqual((await client.listTools()).tools.map(x=>x.name),['connection_check']);
});
test('configured executable signs read-only calls but leaves mutations disabled without chat actions enabled',async t=>{
  let calls=0;const client=await connect(t,createConfiguredOperator({OPERATOR_ORIGIN:'https://review.example.test',OPERATOR_ID:'fictional-chair',OPERATOR_BRIDGE_SECRET:'fixture-secret'},async(url,options)=>{
    calls++;assert.equal(url.href,'https://review.example.test/api/operator');const envelope=JSON.parse(options.body);assert.equal(envelope.payload.operation,'inspect');assert.equal(envelope.payload.operator,'fictional-chair');assert.match(envelope.signature,/^[a-f0-9]{64}$/);return Response.json({applications:[],pairs:[]});
  }));
  await client.callTool({name:'program_records',arguments:{}});assert.equal(calls,1);
  const blocked=await client.callTool({name:'program_action',arguments:{operation:'administration',params:{}}});assert.equal(blocked.isError,true);assert.equal(calls,1);
});
test('exact CHAT_ACTIONS_ENABLED string true enables chat actions',async t=>{
  let calls=0;const client=await connect(t,createConfiguredOperator({OPERATOR_ORIGIN:'https://review.example.test',OPERATOR_ID:'fictional-chair',OPERATOR_BRIDGE_SECRET:'fixture-secret',CHAT_ACTIONS_ENABLED:'true'},async()=>{calls++;return Response.json({saved:true});}));
  await client.callTool({name:'program_action',arguments:{operation:'administration',params:{}}});assert.equal(calls,1);
});
test('supplied JSON overlays uppercase keys including false and ignores aliases',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'operator-'));const path=join(dir,'operator.json');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(path,JSON.stringify({OPERATOR_ORIGIN:'https://file.example.test',OPERATOR_ID:'file-chair',OPERATOR_BRIDGE_SECRET:'file-secret',CHAT_ACTIONS_ENABLED:'false',origin:'https://alias.example.test',id:'alias',secret:'alias-secret',disabled:false}));
  const env=readLaunchEnv({OPERATOR_ORIGIN:'https://env.example.test',OPERATOR_ID:'env-chair',OPERATOR_BRIDGE_SECRET:'env-secret',CHAT_ACTIONS_ENABLED:'true'},path);
  assert.equal(env.OPERATOR_ORIGIN,'https://file.example.test');assert.equal(env.OPERATOR_ID,'file-chair');assert.equal(env.OPERATOR_BRIDGE_SECRET,'file-secret');assert.equal(env.CHAT_ACTIONS_ENABLED,'false');assert.equal('origin' in env,false);
  let calls=0;const client=await connect(t,createConfiguredOperator(env,async()=>{calls++;return Response.json({saved:true});}));
  const blocked=await client.callTool({name:'program_action',arguments:{operation:'administration',params:{}}});assert.equal(blocked.isError,true);assert.equal(calls,0);
});
test('missing supplied config returns empty env so the executable stays on the probe',async t=>{
  const env={OPERATOR_ORIGIN:'https://review.example.test',OPERATOR_ID:'fictional-chair',OPERATOR_BRIDGE_SECRET:'fixture-secret',CHAT_ACTIONS_ENABLED:'true'};
  assert.deepEqual(readLaunchEnv(env,join(tmpdir(),'missing-operator-config.json')),{});
  const client=await connect(t,createConfiguredOperator(readLaunchEnv(env,join(tmpdir(),'missing-operator-config.json')),()=>assert.fail('No backend')));
  assert.deepEqual((await client.listTools()).tools.map(x=>x.name),['connection_check']);
});
test('no supplied path keeps env',()=>{
  const env={CHAT_ACTIONS_ENABLED:'true'};assert.equal(readLaunchEnv(env),env);
});
