import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {withPrivateRecovery} from '../recovery-cycle.mjs';
import {hourlyStatus,runHourlyJob,STALE_AFTER_MS} from '../hourly-health.mjs';
import worker from '../worker.mjs';

const MIGRATIONS=['0001_applications','0002_administration','0003_followups','0004_deletion','0005_reporting_totals','0006_final_review','0007_mail_receipt','0008_recovery_state','0009_recovery_started_by'];
const NOW='2026-09-19T10:00:00.000Z';
const LATER='2026-09-19T11:00:00.000Z';
const NEXT_DAY='2026-09-20T11:00:00.000Z';

function fakeBucket() {
  const versions=[];let counter=0;
  const bucket={
    versions,
    async get(key) {
      const found=[...versions].reverse().find(version=>version.key===key);
      return found?{key,fileId:found.fileId,size:found.text.length,uploadedAt:found.uploadedAt,contentSha1:'0'.repeat(40),customMetadata:{...found.customMetadata},text:async()=>found.text}:null;
    },
    async put(key,text,options={}) {
      const version={key,fileId:'f'+String(++counter).padStart(6,'0'),text,customMetadata:{...(options.customMetadata??{})},uploadedAt:new Date().toISOString(),action:'upload'};
      versions.push(version);
      return {key,fileId:version.fileId,size:text.length,contentSha1:'0'.repeat(40),customMetadata:version.customMetadata};
    },
    async listVersions({prefix,cursor=null,limit=1000}) {
      const ordered=versions.filter(version=>version.key.startsWith(prefix)).sort((a,b)=>a.key===b.key?a.fileId.localeCompare(b.fileId):a.key.localeCompare(b.key));
      const at=cursor?ordered.findIndex(version=>version.key===cursor.startFileName&&version.fileId===cursor.startFileId):0;
      const start=at<0?ordered.length:at,page=ordered.slice(start,start+limit),next=ordered[start+limit];
      return {versions:page.map(version=>({key:version.key,fileId:version.fileId,action:version.action,uploadedAt:version.uploadedAt,size:version.text.length,customMetadata:{...version.customMetadata}})),cursor:next?{startFileName:next.key,startFileId:next.fileId}:null};
    },
    async deleteVersion({key,fileId}) {
      const index=versions.findIndex(version=>version.key===key&&version.fileId===fileId);
      if(index<0)throw new Error('No such stored version.');
      versions.splice(index,1);
      return {key,fileId,deleted:true};
    }
  };
  return bucket;
}

async function setup(t,bucket=fakeBucket()) {
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');
  for(const file of MIGRATIONS)await db.exec((await readFile(new URL('../migrations/'+file+'.sql',import.meta.url),'utf8')).replaceAll('\n',' '));
  return {DB:db,PRIVATE_RECOVERY:bucket,PRIVATE_RECOVERY_VERIFIED:'true',BACKUP_RETENTION_DAYS:'7',MODE:'operating',CHAIR_EMAIL:'chair@example.test',PROGRAM_MAILBOX:'program@example.test',PROGRAM_MAILBOX_VERIFIED:'true',REVIEW_DELIVERY_VERIFIED:'true'};
}

const schedule=()=>async()=>({changed:1,held:false,mailStatus:'synchronized',errors:[],alertFailures:[]});
function alertMailbox(sent){
  return ()=>({send:async message=>{sent.push(message);return {id:'alert',reference:message.reference,rfcMessageId:'<alert@mail.example.test>',to:message.to,sentAt:NOW};}});
}

test('a failed backup does not block participant mail',async t=>{
  const env=await setup(t);
  const real=env.PRIVATE_RECOVERY;
  const broken={...real,put:async(key,...rest)=>{if(key.startsWith('recovery/'))throw new Error('fictional storage failure');return real.put(key,...rest);}};
  let ran=false;
  const sent=[];
  const result=await runHourlyJob({...env,PRIVATE_RECOVERY:broken},NOW,{runSchedule:async()=>{ran=true;return {changed:2,held:false,mailStatus:'synchronized'};},mailboxFactory:alertMailbox(sent)});
  assert.equal(ran,true);
  assert.equal(result.fullySuccessful,false);
  assert.equal(result.recovery.status,'failed');
  assert.equal(sent.length,1);
  assert.equal(sent[0].to,'chair@example.test');
  assert.match(sent[0].subject,/hourly job needs attention/);
  assert.equal((await env.DB.prepare('SELECT status FROM recovery_state WHERE id=1').first('status')),'pending');
});

test('the hourly job repairs a pending cycle it started and records a successful run',async t=>{
  const env=await setup(t);
  const real=env.PRIVATE_RECOVERY;
  const broken={...real,put:async(key,...rest)=>{if(key.startsWith('recovery/checkpoints/'))throw new Error('fictional storage failure');return real.put(key,...rest);}};
  await assert.rejects(withPrivateRecovery({...env,PRIVATE_RECOVERY:broken},async()=>{},{startedBy:'scheduled'}),/may have saved/);
  assert.equal((await env.DB.prepare('SELECT started_by FROM recovery_state WHERE id=1').first('started_by')),'scheduled');
  let ran=false;
  const sent=[];
  const result=await runHourlyJob(env,NOW,{runSchedule:async()=>{ran=true;return {changed:1};},mailboxFactory:alertMailbox(sent)});
  assert.equal(ran,true);
  assert.equal(result.fullySuccessful,true);
  assert.equal(result.recovery.status,'verified');
  assert.equal(sent.length,0);
  assert.equal((await env.DB.prepare('SELECT status FROM recovery_state WHERE id=1').first('status')),'ready');
  assert.deepEqual(await hourlyStatus(env,NOW),{ok:true,lastSuccessfulRun:NOW,stale:false});
});

test('the hourly job does not repair a pending operator cycle and still sends mail',async t=>{
  const env=await setup(t);
  const real=env.PRIVATE_RECOVERY;
  const broken={...real,put:async(key,...rest)=>{if(key.startsWith('recovery/checkpoints/'))throw new Error('fictional storage failure');return real.put(key,...rest);}};
  await assert.rejects(withPrivateRecovery({...env,PRIVATE_RECOVERY:broken},async()=>{},{startedBy:'operator'}),/may have saved/);
  const pending=await env.DB.prepare('SELECT cycle_id,cycle_sequence FROM recovery_state WHERE id=1').first();
  let ran=false;
  const result=await runHourlyJob(env,NOW,{runSchedule:async()=>{ran=true;return {changed:1};},mailboxFactory:alertMailbox([])});
  assert.equal(ran,true);
  assert.equal(result.fullySuccessful,false);
  assert.equal(result.recovery.status,'pending');
  assert.equal(result.recovery.startedBy,'operator');
  const after=await env.DB.prepare('SELECT cycle_id,cycle_sequence,status FROM recovery_state WHERE id=1').first();
  assert.equal(after.status,'pending');
  assert.equal(after.cycle_id,pending.cycle_id);
  assert.equal(after.cycle_sequence,pending.cycle_sequence);
});

test('Chair alert is sent from outside the backup wrapper at most once a day while stuck',async t=>{
  const env=await setup(t);
  const real=env.PRIVATE_RECOVERY;
  const broken={...real,put:async()=>{throw new Error('fictional storage failure');}};
  const sent=[];
  const first=await runHourlyJob({...env,PRIVATE_RECOVERY:broken},NOW,{runSchedule:schedule(),mailboxFactory:alertMailbox(sent)});
  assert.equal(first.alert.sent,true);
  assert.equal(sent.length,1);
  const second=await runHourlyJob({...env,PRIVATE_RECOVERY:broken},LATER,{runSchedule:schedule(),mailboxFactory:alertMailbox(sent)});
  assert.equal(second.alert.sent,false);
  assert.equal(second.alert.skipped,true);
  assert.equal(sent.length,1);
  const third=await runHourlyJob({...env,PRIVATE_RECOVERY:broken},NEXT_DAY,{runSchedule:schedule(),mailboxFactory:alertMailbox(sent)});
  assert.equal(third.alert.sent,true);
  assert.equal(sent.length,2);
  assert.ok(sent.every(message=>message.to==='chair@example.test'));
});

test('a thrown mail run still alerts the Chair outside the backup wrapper',async t=>{
  const env=await setup(t);
  const sent=[];
  await assert.rejects(runHourlyJob(env,NOW,{runSchedule:async()=>{throw new Error('fictional mailbox failure');},mailboxFactory:alertMailbox(sent)}),/fictional mailbox failure/);
  assert.equal(sent.length,1);
  assert.equal((await env.DB.prepare('SELECT status FROM recovery_state WHERE id=1').first('status')),'ready');
});

test('status reports the last fully successful run and ok false when stale',async t=>{
  const env=await setup(t,{});
  env.PRIVATE_RECOVERY_VERIFIED='false';
  assert.deepEqual(await hourlyStatus(env,NOW),{ok:false,lastSuccessfulRun:null,stale:true});
  const result=await runHourlyJob(env,NOW,{runSchedule:schedule(),mailboxFactory:alertMailbox([])});
  assert.equal(result.fullySuccessful,true);
  assert.equal(result.recovery.status,'not-connected');
  assert.deepEqual(await hourlyStatus(env,NOW),{ok:true,lastSuccessfulRun:NOW,stale:false});
  const staleAt=new Date(Date.parse(NOW)+STALE_AFTER_MS+1).toISOString();
  assert.deepEqual(await hourlyStatus(env,staleAt),{ok:false,lastSuccessfulRun:NOW,stale:true});
});

test('GET /api/status is distinct from GET /api/health',async t=>{
  const env=await setup(t,{});
  env.PRIVATE_RECOVERY_VERIFIED='false';
  const health=await worker.fetch(new Request('https://review.example/api/health'),{...env,RELEASE:'test-release'});
  assert.equal(health.status,200);
  assert.deepEqual(await health.json(),{ok:true,mode:'operating',release:'test-release'});
  const stale=await worker.fetch(new Request('https://review.example/api/status'),env);
  assert.equal(stale.status,200);
  assert.deepEqual(await stale.json(),{ok:false,lastSuccessfulRun:null,stale:true});
  await runHourlyJob(env,NOW,{runSchedule:schedule(),mailboxFactory:alertMailbox([])});
  const ready=await worker.fetch(new Request('https://review.example/api/status'),env);
  assert.deepEqual(await ready.json(),{ok:true,lastSuccessfulRun:NOW,stale:false});
  const stillHealthy=await worker.fetch(new Request('https://review.example/api/health'),{...env,RELEASE:'test-release'});
  assert.deepEqual(await stillHealthy.json(),{ok:true,mode:'operating',release:'test-release'});
});

test('scheduled handler still sends mail when a previous scheduled backup is pending',async t=>{
  const env=await setup(t);
  const real=env.PRIVATE_RECOVERY;
  const broken={...real,put:async(key,...rest)=>{if(key.startsWith('recovery/cycles/'))throw new Error('fictional storage failure');return real.put(key,...rest);}};
  await assert.rejects(withPrivateRecovery({...env,PRIVATE_RECOVERY:broken},async()=>{},{startedBy:'scheduled'}),/fictional storage failure/);
  let ran=0;
  const result=await runHourlyJob(env,NOW,{runSchedule:async()=>{ran++;return {changed:0,held:false,mailStatus:'synchronized'};},mailboxFactory:alertMailbox([])});
  assert.equal(ran,1);
  assert.equal(result.fullySuccessful,true);
});
