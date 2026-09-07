import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {pathToFileURL} from 'node:url';

// This first connection exposes no database, email or administrative actions.
// Client capability support is not proof that a person actually answered.
export function createOperatorConnection() {
  const server=new McpServer({name:'chapter-mentorship',version:'0.1.0'});
  server.registerTool('connection_check',{
    description:'Check the native human-confirmation connection. Changes no records and sends no messages. Not a participant or match approval.',
    inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },async()=>{
    let outcome='unavailable';
    try {
      const reply=await server.server.elicitInput({
        mode:'form',
        message:'I recommend this harmless connection test before enabling program changes. Confirm the test for fictional Alex Example? No records will change and no messages will be sent.',
        requestedSchema:{type:'object',properties:{confirm:{type:'boolean',title:'Confirm this connection test'}},required:['confirm']}
      },{timeout:120000});
      outcome=reply.action==='accept' && reply.content?.confirm===true?'accepted':reply.action==='accept'?'not-confirmed':reply.action;
    } catch { /* Unsupported, timeout and disconnected clients never qualify. */ }
    return {content:[{type:'text',text:JSON.stringify({outcome,recordsChanged:false,messagesSent:false,administrationEnabled:false})}]};
  });
  return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  await createOperatorConnection().connect(new StdioServerTransport());
}
