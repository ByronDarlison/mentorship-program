import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {exportSnapshot,importSnapshot,validateRestore,writePrivateBackup,readPrivateBackup,exportPrivacyCheckpoint,replayDeletions} from '../recovery.mjs';
import {previewDeletion,deleteParticipant,programReport} from '../privacy.mjs';
import {runFollowups,getRequest,receiveFeedback} from '../followups.mjs';
import {messageRenderer} from '../templates.mjs';
import {reviewFeedback} from '../feedback.mjs';
import {foldFinishedOutcomes} from '../outcome-storage.mjs';
async function setup(t){
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']}));
  t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
  for(const name of ['0001_applications','0002_administration','0003_followups','0004_deletion','0005_reporting_totals','0006_final_review','0007_mail_receipt','0008_recovery_state'])await db.exec((await readFile(new URL('../migrations/'+name+'.sql',import.meta.url),'utf8')).replaceAll('\n',' '));return db;
}
test('restore accepts backups taken before rfc_message_id existed',async t=>{
  const a=await setup(t),b=await setup(t);
  await a.prepare("INSERT INTO applications(id,submission_key,payload_hash,role,answers,terms_version,privacy_version,created_at) VALUES('fictional','fixture','hash','mentee','{}','test','test','2026-01-01')").run();
  await a.prepare("INSERT INTO jobs(id,kind,status,payload,created_at) VALUES('mail','application-receipt','captured','{}','2026-01-01')").run();
  const snapshot=await exportSnapshot(a);for(const job of snapshot.tables.jobs)delete job.rfc_message_id;
  const checkpoint=await exportPrivacyCheckpoint(a);
  await importSnapshot(b,snapshot,{latestPrivacyCheckpoint:checkpoint,standby:true});
  assert.equal(await b.prepare("SELECT rfc_message_id FROM jobs WHERE id='mail'").first('rfc_message_id'),null);
});
test('versioned snapshot transfers into a fresh standby and never merges or overwrites',async t=>{
  const a=await setup(t),b=await setup(t);
  await a.prepare("INSERT INTO applications(id,submission_key,payload_hash,role,answers,terms_version,privacy_version,created_at) VALUES('fictional','fixture','hash','mentee','{}','test','test','2026-01-01')").run();
  const snapshot=await exportSnapshot(a);
  await assert.rejects(importSnapshot(b,snapshot,{latestDeletionLedger:[]}));
  const checkpoint=await exportPrivacyCheckpoint(a);
  const result=await importSnapshot(b,snapshot,{latestPrivacyCheckpoint:checkpoint,standby:true});assert.equal(result.counts.applications,1);
  assert.deepEqual((await exportSnapshot(b)).tables,snapshot.tables);
  await assert.rejects(importSnapshot(b,snapshot,{latestPrivacyCheckpoint:checkpoint,standby:true}));
});
test('an older backup cannot resurrect a deleted person; unknown ledger also blocks restore',async t=>{
  const db=await setup(t),snapshot=await exportSnapshot(db);
  assert.throws(()=>validateRestore(snapshot));
  assert.throws(()=>validateRestore(snapshot,[{application_id:'deleted',deleted_at:'2026-01-01'}]));
  snapshot.tables.deletion_ledger.push({application_id:'deleted',deleted_at:'2026-01-01',actor:'fixture-chair',execution_id:'fixture-action',action_hash:'hash'});
  assert.equal(validateRestore(snapshot,snapshot.tables.deletion_ledger),true);
  snapshot.tables.pairs.push({id:'fake',mentee_id:'deleted'});assert.throws(()=>validateRestore(snapshot,snapshot.tables.deletion_ledger));
});
test('backup readback verifies exact bytes and an incomplete upload does not claim success',async t=>{
  const snapshot=await exportSnapshot(await setup(t));let stored;
  const bucket={put:async(key,text)=>{stored=text;},get:async()=>({text:async()=>stored})};
  const saved=await writePrivateBackup(bucket,snapshot);assert.equal(saved.sha256.length,64);assert.deepEqual(await readPrivateBackup(bucket,saved.key,saved.sha256),snapshot);
  bucket.get=async()=>({text:async()=>'damaged'});await assert.rejects(writePrivateBackup(bucket,snapshot));
  await assert.rejects(readPrivateBackup(bucket,saved.key,saved.sha256));
});
test('restore rejects deleted extracts and history plus dangling request references before import',async t=>{
  const db=await setup(t),base=await exportSnapshot(db);
  base.tables.deletion_ledger.push({application_id:'deleted',deleted_at:'2026-01-01',actor:'fixture',execution_id:'fixture',action_hash:'fixture'});
  for(const [table,row] of [['matching_copies',{application_id:'deleted'}],['activity',{subject_id:'deleted'}],['chair_actions',{subjects:'["deleted"]'}]]){
    const snapshot=structuredClone(base);snapshot.tables[table].push(row);assert.throws(()=>validateRestore(snapshot,base.tables.deletion_ledger),/deleted/);
  }
  const snapshot=structuredClone(base);snapshot.tables.jobs.push({application_id:null,request_id:'missing'});assert.throws(()=>validateRestore(snapshot,base.tables.deletion_ledger),/missing.*reference/);
  for(const name of [null,'',7]){
    const broken=structuredClone(base);broken.tables.cohorts.push({name,first_cohort:1});assert.throws(()=>validateRestore(broken,base.tables.deletion_ledger),error=>error.status===400&&error.message.includes('invalid group name'));
  }
});
test('deletion replay preserves unrelated work when one mentor has two pairs',async t=>{
  const a=await setup(t),b=await setup(t),now='2026-05-03T12:00:00.000Z';
  for(const id of ['first','second','mentor'])await a.prepare("INSERT INTO applications(id,submission_key,payload_hash,role,answers,terms_version,privacy_version,created_at) VALUES(?,?,?,?,'{}','test','test','2026-01-01')").bind(id,id,id,id==='mentor'?'mentor':'mentee').run();
  await a.prepare("INSERT INTO cohorts(name,first_cohort) VALUES('First',1)").run();
  for(const id of ['first','second'])await a.prepare("INSERT INTO pairs(id,mentee_id,mentor_id,group_name,fit_reason,status,mentee_trained,mentor_trained,actual_date,created_at) VALUES(?,?,'mentor','First','Fictional fit','active',1,1,'2026-01-01','2026-01-01')").bind('pair-'+id,id).run();
  await runFollowups(a,{now,inboxHealthy:true,renderMessage:messageRenderer('https://review.example')});
  const older=await exportSnapshot(a),unchangedJobs=older.tables.jobs.filter(j=>older.tables.requests.some(r=>r.id===j.request_id&&r.pair_id==='pair-second'));
  const preview=await previewDeletion(a,'first');await deleteParticipant(a,{applicationId:'first',reviewHash:preview.reviewHash},'fixture-chair',now);
  // New work for the unaffected pair after the historical backup must not be
  // grafted into that backup without its request. Existing work must survive.
  await runFollowups(a,{now:'2026-07-03T12:00:00.000Z',inboxHealthy:true,renderMessage:messageRenderer('https://review.example')});
  const checkpoint=await exportPrivacyCheckpoint(a),prepared=replayDeletions(older,checkpoint);
  await importSnapshot(b,prepared,{latestPrivacyCheckpoint:checkpoint,standby:true});
  for(const job of unchangedJobs)assert.deepEqual(await b.prepare('SELECT * FROM jobs WHERE id=?').bind(job.id).first(),job);
  assert.equal(await b.prepare("SELECT COUNT(*) n FROM applications WHERE id='first'").first('n'),0);
  assert.equal(await b.prepare("SELECT COUNT(*) n FROM pairs WHERE id='pair-second' AND status='active'").first('n'),1);
});
test('older backup replay preserves anonymous totals and surviving outstanding reply links without resurrection',async t=>{
  const a=await setup(t),b=await setup(t),now='2026-05-03T12:00:00.000Z';
  for(const role of ['mentee','mentor'])await a.prepare("INSERT INTO applications(id,submission_key,payload_hash,role,answers,terms_version,privacy_version,created_at) VALUES(?,?,?,?,'{}','test','test','2026-01-01')").bind(role,role,role,role).run();
  await a.prepare("INSERT INTO cohorts(name,first_cohort) VALUES('First',1)").run();
  await a.prepare("INSERT INTO pairs(id,mentee_id,mentor_id,group_name,fit_reason,status,mentee_trained,mentor_trained,actual_date,created_at) VALUES('pair','mentee','mentor','First','Fictional fit','active',1,1,'2026-01-01','2026-01-01')").run();
  const older=await exportSnapshot(a),preview=await previewDeletion(a,'mentee');
  await deleteParticipant(a,{applicationId:'mentee',reviewHash:preview.reviewHash},'fixture-chair',now);
  await runFollowups(a,{now,inboxHealthy:true,renderMessage:messageRenderer('https://review.example')});
  const checkpoint=await exportPrivacyCheckpoint(a),prepared=replayDeletions(older,checkpoint);
  await importSnapshot(b,prepared,{latestPrivacyCheckpoint:checkpoint,standby:true});
  assert.deepEqual(await programReport(b,now),await programReport(a,now));
  assert.equal(await b.prepare("SELECT COUNT(*) n FROM applications WHERE id='mentee'").first('n'),0);
  const requestId=await b.prepare("SELECT id FROM requests WHERE application_id='mentor' AND superseded=0").first('id');
  const original=await getRequest(a,requestId),restored=await getRequest(b,requestId);assert.equal(restored.token_hash,original.token_hash);assert.equal(restored.deadline,original.deadline);
  await receiveFeedback(b,{id:'late-reply',requestId,source:'verified-email',receivedAt:'2026-05-04T12:00:00.000Z',answers:{value:reviewFeedback.value,returnInterest:reviewFeedback.returnInterest}});
  assert.equal((await programReport(b,now)).metrics.mentorReturn.positive,1);
  assert.deepEqual(replayDeletions(prepared,checkpoint).tables,prepared.tables);
});
test('current checkpoint replaces old pending rows with settled totals even without another deletion',async t=>{
  const a=await setup(t),b=await setup(t);
  await a.prepare("INSERT INTO anonymous_outcomes(id,role,deadline,reporting_only,answered,classifications) VALUES('pending','mentee','2026-05-24T12:00:00.000Z',1,'{}','{}')").run();
  const older=await exportSnapshot(a);
  await foldFinishedOutcomes(a,'2026-05-24T12:00:00.000Z');
  const checkpoint=await exportPrivacyCheckpoint(a);checkpoint.createdAt=new Date(Date.parse(older.createdAt)+1).toISOString();
  const prepared=replayDeletions(older,checkpoint);
  assert.equal(prepared.tables.anonymous_outcomes.length,0);
  await importSnapshot(b,prepared,{latestPrivacyCheckpoint:checkpoint,standby:true});
  assert.deepEqual(await programReport(b,'2026-05-24T12:00:00.000Z'),await programReport(a,'2026-05-24T12:00:00.000Z'));
  await foldFinishedOutcomes(b,'2026-06-01T00:00:00.000Z');
  assert.equal((await programReport(b,'2026-06-01T00:00:00.000Z')).metrics.menteeProgress.included,1);
  const corrupt=structuredClone(prepared);corrupt.tables.outcome_totals[0].positive=99;
  assert.throws(()=>validateRestore(corrupt,checkpoint.ledger),/Invalid outcome totals/);
  corrupt.tables.outcome_totals[0]={metric:'menteeProgress',included:1,positive:1,missing:1,interpretationPending:0};
  assert.throws(()=>validateRestore(corrupt,checkpoint.ledger),/Invalid outcome totals/);
});
