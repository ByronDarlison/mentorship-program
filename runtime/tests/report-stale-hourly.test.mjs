import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {reportStaleHourly,staleIssueBody} from '../scripts/report-stale-hourly.mjs';

test('opens one GitHub issue when status is stale and updates that same issue later',async()=>{
  const calls=[];
  const fetcher=async(url,init={})=>{
    calls.push({url:String(url),method:init.method??'GET',headers:init.headers,body:init.body});
    if(String(url).endsWith('/api/status'))return Response.json({ok:false,lastSuccessfulRun:'2026-09-09T13:00:48.000Z',stale:true});
    if(String(url).includes('/issues?state=all'))return Response.json(calls.some(call=>call.method==='POST'&&String(call.url).endsWith('/issues'))?[{number:41,title:'Mentorship hourly job is stale',body:staleIssueBody({ok:false,lastSuccessfulRun:'2026-09-09T13:00:48.000Z',stale:true}),url:'https://api.github.com/repos/example/issues-review/issues/41'}]:[]);
    if(String(url).endsWith('/issues')&&init.method==='POST')return Response.json({number:41});
    if(String(url).endsWith('/issues/41')&&init.method==='PATCH')return Response.json({number:41});
    throw new Error(`unexpected ${init.method??'GET'} ${url}`);
  };
  const opened=await reportStaleHourly({fetcher,statusUrl:'https://mentorship.example.invalid/api/status',repo:'example/issues-review',token:'repo-token'});
  assert.equal(opened.action,'opened');
  assert.equal(opened.number,41);
  const created=JSON.parse(calls.find(call=>call.method==='POST').body);
  assert.match(created.body,/mentorship-hourly-stale/);
  assert.match(created.body,/2026-09-09T13:00:48.000Z/);
  assert.ok(!created.body.includes('repo-token'));

  const updated=await reportStaleHourly({fetcher,statusUrl:'https://mentorship.example.invalid/api/status',repo:'example/issues-review',token:'repo-token'});
  assert.equal(updated.action,'updated');
  assert.equal(updated.number,41);
  assert.equal(calls.filter(call=>call.method==='POST').length,1);
  assert.equal(calls.filter(call=>call.method==='PATCH').length,1);
  assert.ok(calls.every(call=>!JSON.stringify(call.body??'').includes('repo-token')||call.headers.Authorization==='Bearer repo-token'));
  assert.ok(!calls.some(call=>call.url.includes('workers.dev')&&String(call.headers?.Authorization??'').includes('Bearer')));
});

test('does not open an issue when the hourly run is current',async()=>{
  const calls=[];
  const fetcher=async(url,init={})=>{
    calls.push(String(url));
    if(String(url).endsWith('/api/status'))return Response.json({ok:true,lastSuccessfulRun:'2026-09-19T10:00:00.000Z',stale:false});
    throw new Error(`unexpected ${url}`);
  };
  const result=await reportStaleHourly({fetcher,statusUrl:'https://mentorship.example.invalid/api/status',repo:'example/issues-review',token:'repo-token'});
  assert.deepEqual(result,{action:'none',status:{ok:true,lastSuccessfulRun:'2026-09-19T10:00:00.000Z',stale:false}});
  assert.deepEqual(calls,['https://mentorship.example.invalid/api/status']);
});

test('Worker source does not contain a GitHub credential or issue-opener call',async()=>{
  const worker=await readFile(new URL('../worker.mjs',import.meta.url),'utf8');
  const hourly=await readFile(new URL('../hourly-health.mjs',import.meta.url),'utf8');
  const recovery=await readFile(new URL('../recovery-cycle.mjs',import.meta.url),'utf8');
  for(const source of [worker,hourly,recovery]){
    assert.doesNotMatch(source,/GITHUB_TOKEN|api\.github\.com|report-stale-hourly/);
  }
});
