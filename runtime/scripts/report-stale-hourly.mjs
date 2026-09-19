// Reads the public hourly status route and opens or updates one GitHub issue
// when it is stale. Runs outside the Worker so no GitHub credential is stored
// there. Issues Review is the audience for the issue.
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';

const DEFAULT_TITLE='Mentorship hourly job is stale';
const MARKER='<!-- mentorship-hourly-stale -->';

function requireEnv(name,override){
  const value=override??process.env[name];
  if(typeof value!=='string'||!value.trim())throw new Error(`Set ${name}.`);
  return value.trim();
}

async function readJson(response,label){
  if(!response.ok)throw new Error(`${label} failed.`);
  return response.json();
}

export function staleIssueBody(status){
  const last=status.lastSuccessfulRun??'none recorded';
  return [MARKER,'The Mentorship hourly status route reports a stale last fully successful run.','',`Last fully successful run: ${last}`,`ok: ${status.ok===true?'true':'false'}`,`stale: ${status.stale===true?'true':'false'}`,'','No personal data. Repair recovery if it is pending and no other operation is running.'].join('\n');
}

export async function reportStaleHourly({
  fetcher=fetch,
  statusUrl,
  repo,
  token,
  title=DEFAULT_TITLE
}={}){
  const url=requireEnv('MENTORSHIP_STATUS_URL',statusUrl);
  const repository=requireEnv('STALE_ISSUE_REPO',repo);
  const auth=requireEnv('GITHUB_TOKEN',token);
  const status=await readJson(await fetcher(url,{headers:{Accept:'application/json'}}),'Status route');
  if(status?.ok===true&&status.stale!==true)return {action:'none',status};
  const headers={Authorization:`Bearer ${auth}`,'Accept':'application/vnd.github+json','User-Agent':'mentorship-stale-hourly','Content-Type':'application/json'};
  const listed=await readJson(await fetcher(`https://api.github.com/repos/${repository}/issues?state=all&per_page=100`,{headers}),'GitHub issue list');
  const existing=(Array.isArray(listed)?listed:[]).find(issue=>!issue.pull_request&&(issue.title===title||String(issue.body??'').includes(MARKER)));
  const body=staleIssueBody(status);
  if(!existing){
    const created=await readJson(await fetcher(`https://api.github.com/repos/${repository}/issues`,{method:'POST',headers,body:JSON.stringify({title,body})}),'GitHub issue create');
    return {action:'opened',number:created.number,status};
  }
  const updated=await readJson(await fetcher(existing.url,{method:'PATCH',headers,body:JSON.stringify({body,state:'open',title})}),'GitHub issue update');
  return {action:'updated',number:updated.number??existing.number,status};
}

function launchedFromCli(){
  const entry=process.argv[1];
  if(typeof entry!=='string'||!entry)return false;
  try { return pathToFileURL(realpathSync(entry)).href===import.meta.url; }
  catch { return entry.endsWith('report-stale-hourly.mjs'); }
}

if(launchedFromCli()){
  reportStaleHourly().then(result=>{
    console.log(JSON.stringify(result));
  }).catch(error=>{
    console.error(error.message);
    process.exitCode=1;
  });
}
