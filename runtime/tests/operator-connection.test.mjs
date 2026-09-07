import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ElicitRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createOperatorConnection} from '../operator-connection.mjs';

test('connection has only a harmless native probe and cannot accept model-supplied approval',async t=>{
  const server=createOperatorConnection();
  const client=new Client({name:'test-client',version:'1'},{capabilities:{elicitation:{form:{}}}});
  const [a,b]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});
  await Promise.all([server.connect(a),client.connect(b)]);
  const tools=await client.listTools();assert.deepEqual(tools.tools.map(x=>x.name),['connection_check']);
  for(const [reply,outcome] of [
    [{action:'decline'},'decline'],[{action:'cancel'},'cancel'],
    [{action:'accept',content:{confirm:false}},'not-confirmed'],
    [{action:'accept',content:{confirm:true}},'accepted']
  ]) {
    client.setRequestHandler(ElicitRequestSchema,async request=>{
      assert.equal(request.params.mode,'form');
      assert.match(request.params.message,/No records will change/);
      return reply;
    });
    const result=await client.callTool({name:'connection_check',arguments:{approved:true}});
    assert.deepEqual(JSON.parse(result.content[0].text),{outcome,recordsChanged:false,messagesSent:false,administrationEnabled:false});
  }
});

test('client without elicitation support never qualifies',async t=>{
  const server=createOperatorConnection(), client=new Client({name:'unsupported',version:'1'},{capabilities:{}});
  const [a,b]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});
  await Promise.all([server.connect(a),client.connect(b)]);
  const result=await client.callTool({name:'connection_check',arguments:{}});
  assert.equal(JSON.parse(result.content[0].text).outcome,'unavailable');
});
