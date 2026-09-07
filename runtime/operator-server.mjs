import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createOperatorConnection} from './operator-connection.mjs';
import {createAdministrativeConnection,remoteOperatorBackend} from './operator-tools.mjs';

export function readLaunchEnv(env={},path){
  if(!path)return env;
  try{
    const file=JSON.parse(readFileSync(path,'utf8'));
    if(!file||typeof file!=='object'||Array.isArray(file))return {};
    const next={...env};
    for(const key of ['OPERATOR_ORIGIN','OPERATOR_ID','OPERATOR_BRIDGE_SECRET','CHAT_ACTIONS_ENABLED'])if(Object.hasOwn(file,key))next[key]=file[key];
    return next;
  }catch{return {};}
}

// Prepared executable for the eventual verified connection. Registration is
// deliberately unchanged: the installed connection still runs the harmless probe.
export function createConfiguredOperator(env={},fetcher=fetch){
  if(!env.OPERATOR_ORIGIN||!env.OPERATOR_ID||!env.OPERATOR_BRIDGE_SECRET)return createOperatorConnection();
  return createAdministrativeConnection({
    callBackend:remoteOperatorBackend({origin:env.OPERATOR_ORIGIN,operator:env.OPERATOR_ID,secret:env.OPERATOR_BRIDGE_SECRET,fetcher}),
    chatActionsEnabled:env.CHAT_ACTIONS_ENABLED==='true'
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  await createConfiguredOperator(readLaunchEnv(process.env,process.argv[2])).connect(new StdioServerTransport());
}
