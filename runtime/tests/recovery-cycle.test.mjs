import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {withPrivateRecovery,readCurrentRecovery,repairPrivateRecovery,pruneExpiredRecovery,inspectRecovery,seedRecoveryState,recoveryStorage} from '../recovery-cycle.mjs';
import {importSnapshot} from '../recovery.mjs';
import {handleOperatorRequest,signOperatorRequest} from '../operator-api.mjs';

const MIGRATIONS=['0001_applications','0002_administration','0003_followups','0004_deletion','0005_reporting_totals','0006_final_review','0007_mail_receipt','0008_recovery_state'];
const BEGIN_1='recovery/cycles/0000000001-begin.json';
const DONE_1='recovery/cycles/0000000001-done.json';
const BEGIN_2='recovery/cycles/0000000002-begin.json';
const DONE_2='recovery/cycles/0000000002-done.json';
const BEGIN_3='recovery/cycles/0000000003-begin.json';
const DONE_3='recovery/cycles/0000000003-done.json';

// Versioned in-memory stand-in for the Backblaze adapter. It is deliberately not
// conditional: nothing here can compare and set, which is why the sequence lives
// in D1. Real Miniflare D1 provides the compare-and-set under test.
function fakeBucket() {
  const versions=[];let counter=0;
  const bucket={
    versions,clock:()=>new Date().toISOString(),deletions:[],
    async get(key) {
      const found=[...versions].reverse().find(version=>version.key===key);
      return found?{key,fileId:found.fileId,size:found.text.length,uploadedAt:found.uploadedAt,contentSha1:'0'.repeat(40),customMetadata:{...found.customMetadata},text:async()=>found.text}:null;
    },
    async put(key,text,options={}) {
      const version={key,fileId:'f'+String(++counter).padStart(6,'0'),text,customMetadata:{...(options.customMetadata??{})},uploadedAt:bucket.clock(),action:'upload'};
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
      versions.splice(index,1);bucket.deletions.push({key,fileId});
      return {key,fileId,deleted:true};
    }
  };
  return bucket;
}
const keysIn=bucket=>bucket.versions.map(version=>version.key).sort();
test('operating backups are isolated from review objects and restore through their namespace',async t=>{
  const bucket=fakeBucket();
  const review=await setup(t,bucket);
  await withPrivateRecovery(review,async()=>{});
  const original=keysIn(bucket);
  const operating={...await setup(t,bucket),BACKUP_NAMESPACE:'operating-v1'};
  await withPrivateRecovery(operating,async()=>{});
  const storage=recoveryStorage(operating);
  assert.equal((await readCurrentRecovery(storage)).manifest.sequence,1);
  assert.ok(keysIn(bucket).some(key=>key.startsWith('recovery/operating-v1/snapshots/')));
  await pruneExpiredRecovery(storage,{retentionDays:1,now:'2099-01-01T00:00:00Z'});
  assert.deepEqual(keysIn(bucket),original,'expiry cannot delete the review installation');
  assert.equal((await readCurrentRecovery(bucket)).manifest.sequence,1);
});
const readState=db=>db.prepare('SELECT * FROM recovery_state WHERE id=1').first();

async function setup(t,bucket=fakeBucket()) {
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');
  for(const file of MIGRATIONS)await db.exec((await readFile(new URL('../migrations/'+file+'.sql',import.meta.url),'utf8')).replaceAll('\n',' '));
  return {DB:db,PRIVATE_RECOVERY:bucket,PRIVATE_RECOVERY_VERIFIED:'true',BACKUP_RETENTION_DAYS:'7'};
}

test('disconnected recovery does not contact storage or claim a backup',async()=>{
  assert.deepEqual(await withPrivateRecovery({},async()=>({saved:true})),{value:{saved:true},recovery:{status:'not-connected'}});
  assert.deepEqual(await inspectRecovery({}),{status:'not-connected'});
  assert.deepEqual(await inspectRecovery({PRIVATE_RECOVERY_VERIFIED:'true'}),{status:'not-connected'});
});

test('a completed cycle writes immutable markers, advances the sequence and excludes coordination state',async t=>{
  const env=await setup(t);
  assert.deepEqual(await inspectRecovery(env),{status:'not-started'});
  const first=await withPrivateRecovery(env,async()=>{await env.DB.prepare("INSERT INTO cohorts(name,first_cohort) VALUES('Fictional',1)").run();return {saved:true};});
  assert.equal(first.recovery.status,'verified');assert.equal(first.recovery.sequence,1);assert.equal(first.recovery.expiry,'complete');
  assert.deepEqual(keysIn(env.PRIVATE_RECOVERY).filter(key=>key.startsWith('recovery/cycles/')),[BEGIN_1,DONE_1]);

  const state=await readState(env.DB);
  assert.equal(state.status,'ready');assert.equal(state.cycle_sequence,1);assert.equal(state.cycle_id,first.recovery.id);assert.equal(state.expiry,'complete');
  assert.deepEqual(await inspectRecovery(env),{status:'ready',id:first.recovery.id,sequence:1,at:state.created_at,expiry:'complete'});

  const saved=await readCurrentRecovery(env.PRIVATE_RECOVERY);
  assert.equal(saved.snapshot.tables.cohorts[0].name,'Fictional');assert.equal(saved.snapshot.version,6);
  assert.equal(saved.snapshot.tables.recovery_state,undefined,'coordination state is not a domain record');
  assert.equal(saved.manifest.cycleId,first.recovery.id);assert.equal(saved.manifest.sequence,1);assert.equal(saved.checkpoint.version,6);

  const second=await withPrivateRecovery(env,async()=>({saved:true}));
  assert.equal(second.recovery.sequence,2);
  assert.deepEqual(keysIn(env.PRIVATE_RECOVERY).filter(key=>key.startsWith('recovery/cycles/')),[BEGIN_1,DONE_1,BEGIN_2,DONE_2].sort());
  assert.equal(env.PRIVATE_RECOVERY.versions.filter(version=>version.key===DONE_1).length,1,'a completed cycle is never rewritten');
  assert.equal((await readCurrentRecovery(env.PRIVATE_RECOVERY)).manifest.sequence,2);
});

test('an interrupted cycle blocks storage-only restore and never falls back to the older completed cycle',async t=>{
  const env=await setup(t);
  await withPrivateRecovery(env,async()=>{await env.DB.prepare("INSERT INTO cohorts(name,first_cohort) VALUES('Before failure',1)").run();});
  const real=env.PRIVATE_RECOVERY;
  const broken={...real,put:async(key,...rest)=>{if(key.startsWith('recovery/checkpoints/'))throw new Error('fictional storage failure');return real.put(key,...rest);}};
  await assert.rejects(withPrivateRecovery({...env,PRIVATE_RECOVERY:broken},async()=>{await env.DB.prepare("INSERT INTO cohorts(name,first_cohort) VALUES('Saved before failure',1)").run();}),/may have saved/);
  assert.ok(keysIn(real).includes(BEGIN_2)&&!keysIn(real).includes(DONE_2));
  await assert.rejects(readCurrentRecovery(real),/did not complete/);

  let acted=false;
  await assert.rejects(withPrivateRecovery(env,async()=>{acted=true;}),/needs attention/);
  assert.equal(acted,false);
  // No elapsed time releases a pending claim: an old start is still pending.
  await env.DB.prepare("UPDATE recovery_state SET started_at='2020-01-01T00:00:00.000Z' WHERE id=1").run();
  await assert.rejects(withPrivateRecovery(env,async()=>{acted=true;}),/needs attention/);
  assert.equal(acted,false);
  assert.equal((await readState(env.DB)).status,'pending');
});

test('repair opens a new cycle backing the current database without repeating the prior action',async t=>{
  const env=await setup(t);
  await withPrivateRecovery(env,async()=>{});
  const real=env.PRIVATE_RECOVERY;
  const broken={...real,put:async(key,...rest)=>{if(key.startsWith('recovery/checkpoints/'))throw new Error('fictional storage failure');return real.put(key,...rest);}};
  await assert.rejects(withPrivateRecovery({...env,PRIVATE_RECOVERY:broken},async()=>{await env.DB.prepare("INSERT INTO cohorts(name,first_cohort) VALUES('Saved before failure',1)").run();}),/may have saved/);
  const pending=await readState(env.DB);
  const interrupted=real.versions.find(version=>version.key===BEGIN_2).fileId;

  await assert.rejects(withPrivateRecovery(env,async()=>{},{repairPendingId:'wrong'}),/pending recovery item changed/);
  await assert.rejects(repairPrivateRecovery(env,{pendingId:pending.cycle_id,previousRunStopped:false}),/stopped/);
  await assert.rejects(repairPrivateRecovery(env,{pendingId:pending.cycle_id,previousRunStopped:true,extra:1}),/stopped/);
  const repaired=await repairPrivateRecovery(env,{pendingId:pending.cycle_id,previousRunStopped:true});
  assert.deepEqual(repaired.value,{repaired:true,repeatedAction:false});
  assert.equal(repaired.recovery.sequence,3,'the repair opens the next cycle');
  assert.equal(real.versions.find(version=>version.key===BEGIN_2).fileId,interrupted,'the interrupted cycle is left exactly as it was');
  assert.equal(keysIn(real).includes(DONE_2),false,'the unknown outcome stays visible');
  assert.ok(keysIn(real).includes(BEGIN_3)&&keysIn(real).includes(DONE_3));

  const restored=await readCurrentRecovery(real);
  assert.deepEqual(restored.snapshot.tables.cohorts.map(row=>row.name),['Saved before failure']);
  assert.equal(restored.manifest.sequence,3);
  await assert.rejects(repairPrivateRecovery(env,{pendingId:pending.cycle_id,previousRunStopped:true}),/changed/);
});

test('a failed start marker leaves the protected operation unrun and is repairable',async t=>{
  const env=await setup(t),real=env.PRIVATE_RECOVERY;
  const broken={...real,put:async(key,...rest)=>{if(key.startsWith('recovery/cycles/'))throw new Error('fictional storage failure');return real.put(key,...rest);}};
  let acted=false;
  await assert.rejects(withPrivateRecovery({...env,PRIVATE_RECOVERY:broken},async()=>{acted=true;}),/fictional storage failure/);
  assert.equal(acted,false,'no protected change runs before its start marker is stored');
  assert.deepEqual(keysIn(real),[]);
  const pending=await readState(env.DB);
  assert.equal(pending.status,'pending');assert.equal(pending.cycle_sequence,1);

  const repaired=await repairPrivateRecovery(env,{pendingId:pending.cycle_id,previousRunStopped:true});
  assert.equal(repaired.recovery.sequence,2);
  assert.deepEqual(keysIn(real).filter(key=>key.startsWith('recovery/cycles/')),[BEGIN_2,DONE_2]);
  assert.equal((await readCurrentRecovery(real)).manifest.sequence,2);
});

test('a stored done marker whose database completion was lost is repaired without repeating the action',async t=>{
  const env=await setup(t),real=env.PRIVATE_RECOVERY;
  // The copy is written and verified, then the database confirmation is lost.
  const stalled={
    prepare:sql=>sql.includes("SET status='ready'")?{bind:()=>({first:async()=>{throw new Error('fictional database failure');}})}:env.DB.prepare(sql),
    batch:statements=>env.DB.batch(statements)
  };
  await assert.rejects(withPrivateRecovery({...env,DB:stalled},async()=>{await env.DB.prepare("INSERT INTO cohorts(name,first_cohort) VALUES('Saved',1)").run();}),/may have saved/);
  assert.deepEqual(keysIn(real).filter(key=>key.startsWith('recovery/cycles/')),[BEGIN_1,DONE_1]);
  const pending=await readState(env.DB);
  assert.equal(pending.status,'pending');
  // Storage genuinely completed this cycle, so the storage-only reader is right
  // to serve it. The unconfirmed database record is what blocks ordinary work.
  const stored=await readCurrentRecovery(real);
  assert.equal(stored.manifest.sequence,1);
  assert.deepEqual(stored.snapshot.tables.cohorts.map(row=>row.name),['Saved']);
  let acted=false;
  await assert.rejects(withPrivateRecovery(env,async()=>{acted=true;}),/before another protected operation/);
  assert.equal(acted,false);

  const repaired=await repairPrivateRecovery(env,{pendingId:pending.cycle_id,previousRunStopped:true});
  assert.equal(repaired.recovery.sequence,2);
  assert.deepEqual((await env.DB.prepare('SELECT name FROM cohorts').all()).results.map(row=>row.name),['Saved'],'the interrupted action is not repeated');
  assert.equal((await readCurrentRecovery(real)).manifest.sequence,2);
});

test('two concurrent repairs claim only one new cycle',async t=>{
  const env=await setup(t),real=env.PRIVATE_RECOVERY;
  const broken={...real,put:async(key,...rest)=>{if(key.startsWith('recovery/checkpoints/'))throw new Error('fictional storage failure');return real.put(key,...rest);}};
  await assert.rejects(withPrivateRecovery({...env,PRIVATE_RECOVERY:broken},async()=>{}),/may have saved/);
  const pending=await readState(env.DB);
  const results=await Promise.allSettled([1,2].map(()=>repairPrivateRecovery(env,{pendingId:pending.cycle_id,previousRunStopped:true})));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.match(results.find(result=>result.status==='rejected').reason.message,/Recovery state changed|pending recovery item changed/);
  assert.equal((await readState(env.DB)).cycle_sequence,2);
  assert.deepEqual(keysIn(real).filter(key=>key.startsWith('recovery/cycles/')),[BEGIN_1,BEGIN_2,DONE_2]);
});

test('a retried identical marker version is accepted and a conflicting one is refused',async t=>{
  const env=await setup(t),bucket=env.PRIVATE_RECOVERY;
  await withPrivateRecovery(env,async()=>{});
  const original=bucket.versions.find(version=>version.key===DONE_1);
  // An adapter retry after a transient upload error stores the same bytes twice.
  await bucket.put(DONE_1,original.text,{customMetadata:{...original.customMetadata}});
  assert.equal(bucket.versions.filter(version=>version.key===DONE_1).length,2);
  assert.equal((await readCurrentRecovery(bucket)).manifest.sequence,1);
  assert.equal((await withPrivateRecovery(env,async()=>({saved:true}))).recovery.sequence,2);

  await bucket.put(DONE_1,original.text+' ',{customMetadata:{sha256:'b'.repeat(64)}});
  await assert.rejects(readCurrentRecovery(bucket),/conflicting versions/);
  await assert.rejects(withPrivateRecovery(env,async()=>{}),/conflicting versions/);
});

test('the single-row compare-and-set permits only one protected action',async t=>{
  const env=await setup(t);
  let called=0;
  const results=await Promise.allSettled([1,2].map(()=>withPrivateRecovery(env,async()=>{called++;await new Promise(resolve=>setTimeout(resolve,5));})));
  assert.equal(called,1);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.match(results.find(result=>result.status==='rejected').reason.message,/Recovery state changed|needs attention/);
  assert.equal((await readState(env.DB)).cycle_sequence,1);
  assert.deepEqual(keysIn(env.PRIVATE_RECOVERY).filter(key=>key.startsWith('recovery/cycles/')),[BEGIN_1,DONE_1]);
});

test('a new or empty database refuses protected work until a verified restore seeds the sequence',async t=>{
  const shared=fakeBucket();
  const source=await setup(t,shared);
  // The source cycle completes but its expiry sweep fails, so no expiry result
  // travels with the copy.
  const expiryFails={...shared,listVersions:async options=>{if(options.prefix==='snapshots/')throw new Error('fictional expiry permissions failure');return shared.listVersions(options);}};
  const first=await withPrivateRecovery({...source,PRIVATE_RECOVERY:expiryFails},async()=>{await source.DB.prepare("INSERT INTO cohorts(name,first_cohort) VALUES('Original',1)").run();});
  assert.equal(first.recovery.expiry,'failed');
  assert.equal((await readState(source.DB)).expiry,'failed');
  const replacement=await setup(t,shared);
  let acted=false;
  await assert.rejects(withPrivateRecovery(replacement,async()=>{acted=true;}),/verified restore/);
  assert.equal(acted,false);

  const {snapshot,checkpoint,manifest}=await readCurrentRecovery(shared);
  await importSnapshot(replacement.DB,snapshot,{latestPrivacyCheckpoint:checkpoint,standby:true});
  assert.deepEqual((await replacement.DB.prepare('SELECT name FROM cohorts').all()).results.map(row=>row.name),['Original']);
  await assert.rejects(seedRecoveryState(replacement.DB,{...manifest,sequence:0}),/verified completed cycle/);
  assert.deepEqual(await seedRecoveryState(replacement.DB,manifest),{sequence:1,cycleId:manifest.cycleId});
  await assert.rejects(seedRecoveryState(replacement.DB,manifest),/new, empty installation/);
  assert.equal((await readState(replacement.DB)).expiry,'pending','a seeded destination claims no expiry it did not perform');

  const next=await withPrivateRecovery(replacement,async()=>({saved:true}));
  assert.equal(next.recovery.sequence,2);
  assert.equal((await readState(replacement.DB)).expiry,'complete','the destination earns its own expiry result');
  const current=await readCurrentRecovery(shared);
  assert.equal(current.manifest.sequence,2);
  assert.deepEqual(current.snapshot.tables.cohorts.map(row=>row.name),['Original'],'the restored record survives the next cycle');
});

test('an operation error still completes the cycle and propagates the original error',async t=>{
  const env=await setup(t);
  await assert.rejects(withPrivateRecovery(env,async()=>{await env.DB.prepare("INSERT INTO cohorts(name,first_cohort) VALUES('Saved',1)").run();throw new Error('Lost operation acknowledgement');}),/Lost operation acknowledgement/);
  assert.equal((await readState(env.DB)).status,'ready');
  assert.equal((await readCurrentRecovery(env.PRIVATE_RECOVERY)).snapshot.tables.cohorts[0].name,'Saved');
});

test('expiry removes exact expired versions, protects the current cycle and never invalidates the backup',async t=>{
  const env=await setup(t),bucket=env.PRIVATE_RECOVERY;
  bucket.clock=()=>'2020-01-01T00:00:00.000Z';
  await withPrivateRecovery(env,async()=>{});
  const expiredVersions=bucket.versions.map(version=>({key:version.key,fileId:version.fileId}));
  bucket.clock=()=>new Date().toISOString();
  const second=await withPrivateRecovery(env,async()=>({saved:true}));
  assert.equal(second.recovery.expiry,'complete');
  assert.deepEqual(bucket.deletions.sort((a,b)=>a.key.localeCompare(b.key)),expiredVersions.sort((a,b)=>a.key.localeCompare(b.key)));
  const remaining=keysIn(bucket);
  assert.deepEqual(remaining.filter(key=>key.startsWith('recovery/cycles/')),[BEGIN_2,DONE_2]);
  assert.equal(remaining.length,4,'only the current cycle and its verified copies remain');
  assert.equal((await readCurrentRecovery(bucket)).manifest.sequence,2);

  const failing={...bucket,listVersions:async options=>{if(options.prefix==='snapshots/')throw new Error('fictional expiry permissions failure');return bucket.listVersions(options);}};
  const third=await withPrivateRecovery({...env,PRIVATE_RECOVERY:failing},async()=>({saved:true}));
  assert.equal(third.recovery.status,'verified');assert.equal(third.recovery.expiry,'failed');
  assert.equal((await readState(env.DB)).expiry,'failed');
  assert.equal((await readCurrentRecovery(bucket)).manifest.sequence,3,'a housekeeping failure does not block the verified copy');
  const fourth=await withPrivateRecovery(env,async()=>({saved:true}));
  assert.equal(fourth.recovery.status,'verified');
});

test('expiry requires an explicit approved retention period',async()=>{
  const bucket=fakeBucket();
  for(const retentionDays of [undefined,0,-1,1.5])await assert.rejects(pruneExpiredRecovery(bucket,{retentionDays,now:'2026-06-01',keep:[]}),/retention/);
  await assert.rejects(pruneExpiredRecovery(bucket,{retentionDays:7,now:'not a date',keep:[]}),/retention/);
  const env={PRIVATE_RECOVERY:bucket,PRIVATE_RECOVERY_VERIFIED:'true',DB:{prepare(){throw new Error('unused');}}};
  await assert.rejects(withPrivateRecovery(env,async()=>{}),/retention/);
});

test('seven-day expiry removes a version exactly at the boundary and keeps the next millisecond',async()=>{
  const bucket=fakeBucket(),metadata={customMetadata:{sha256:'a'.repeat(64)}};
  bucket.clock=()=>'2026-06-01T00:00:00.000Z';
  await bucket.put('snapshots/0000000001-exact.json','{}',metadata);
  bucket.clock=()=>'2026-06-01T00:00:00.001Z';
  await bucket.put('snapshots/0000000002-inside.json','{}',metadata);
  const result=await pruneExpiredRecovery(bucket,{retentionDays:7,now:'2026-06-08T00:00:00.000Z',keep:[]});
  assert.equal(result.removed,1);
  assert.deepEqual(bucket.deletions.map(entry=>entry.key),['snapshots/0000000001-exact.json']);
  assert.deepEqual(keysIn(bucket),['snapshots/0000000002-inside.json']);
});

test('corrupted or contradictory recovery objects are refused',async t=>{
  const env=await setup(t),bucket=env.PRIVATE_RECOVERY;
  await withPrivateRecovery(env,async()=>{});
  const manifest=await readCurrentRecovery(bucket);
  await bucket.put(manifest.manifest.checkpoint.key,'damaged');
  await assert.rejects(readCurrentRecovery(bucket),/damaged/);
  await bucket.put(DONE_1,'{"format":"eo-mentorship-cycle"}');
  await assert.rejects(readCurrentRecovery(bucket),/verified checksum/);
  const stray=fakeBucket();
  await stray.put('recovery/cycles/notes.json','{}',{customMetadata:{sha256:'a'.repeat(64)}});
  await assert.rejects(readCurrentRecovery(stray),/unexpected cycle object/);
  await assert.rejects(readCurrentRecovery(fakeBucket()),/No completed recovery cycle/);
});


test('recovery repair remains authenticated and disabled until chat actions are enabled',async t=>{
  const env={...await setup(t),MODE:'review',OPERATOR_ID:'fictional',OPERATOR_BRIDGE_SECRET:'fixture-secret'};
  const call=async(operation,params={})=>handleOperatorRequest(env.DB,await signOperatorRequest(operation,params,env.OPERATOR_ID,env.OPERATOR_BRIDGE_SECRET),env);
  assert.deepEqual(await call('recovery_status'),{status:'not-started'});
  await assert.rejects(call('repair_recovery',{pendingId:'fake',previousRunStopped:true}),e=>e.status===403);
});
