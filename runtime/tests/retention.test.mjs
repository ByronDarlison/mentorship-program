import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {previewFinalReview,finishFinalReview} from '../retention.mjs';
import {getRequest,receiveFeedback,runFollowups} from '../followups.mjs';
import {programReport,previewDeletion,deleteParticipant} from '../privacy.mjs';
import {correctRecord} from '../corrections.mjs';
import {exportSnapshot,exportPrivacyCheckpoint,replayDeletions,importSnapshot} from '../recovery.mjs';
import {signOperatorRequest,handleOperatorRequest} from '../operator-api.mjs';
const now='2026-06-01T12:00:00.000Z';
async function setup(t,{seed=true}={}){
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']}));t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
  for(const file of ['0001_applications.sql','0002_administration.sql','0003_followups.sql','0004_deletion.sql','0005_reporting_totals.sql','0006_final_review.sql','0007_mail_receipt.sql'])await db.exec((await readFile(new URL('../migrations/'+file,import.meta.url),'utf8')).replaceAll('\n',' '));
  if(!seed)return db;
  for(const role of ['mentee','mentor'])await db.prepare("INSERT INTO applications(id,submission_key,payload_hash,role,answers,terms_version,privacy_version,created_at,decision,readiness) VALUES(?,?,?,?,?,'test','test','2025-01-01','approved',1)").bind(role,role,role,role,JSON.stringify({name:role+' Example',email:role+'@example.test','linkedin-url':'https://linkedin.com/in/fictional',business:'Fictional application detail'})).run();
  await db.exec("INSERT INTO cohorts(name,first_cohort) VALUES('First',1); INSERT INTO pairs(id,mentee_id,mentor_id,group_name,fit_reason,status,mentee_trained,mentor_trained,actual_date,created_at) VALUES('pair','mentee','mentor','First','Fictional fit details','active',1,1,'2025-05-01','2025-01-01');");
  for(const role of ['mentee','mentor'])for(const [kind,period] of [['quarterly',3],['final',12]]){
    const answers={meetings:3,value:'Written fictional value',contact:false,...(kind==='final'?{[role==='mentee'?'progress':'returnInterest']:'Written fictional outcome'}:{})};
    const classifications={value:'Meaningful',...(kind==='final'?{[role==='mentee'?'progress':'returnInterest']:role==='mentee'?'Meaningful':'Interested'}:{})};
    await db.prepare("INSERT INTO requests(id,pair_id,application_id,role,kind,period,scheduled_for,sent_at,deadline,replied_at,answers,classifications,token_hash) VALUES(?,'pair',?,?,?,?,?,?,?,?,?,?,?)").bind(role+kind,role,role,kind,period,'2026-05-01', '2026-05-01','2026-05-22','2026-05-02',JSON.stringify(answers),JSON.stringify(classifications),role+kind+'token').run();
    await db.prepare("INSERT INTO jobs(id,application_id,request_id,kind,status,payload,created_at) VALUES(?,?,?,'request','captured',?,'2026-05-01')").bind(role+kind+'job',role,role+kind,JSON.stringify({body:'Written fictional email copy'})).run();
  }
  return db;
}
async function finish(db,id='mentee'){const p=await previewFinalReview(db,id,now);return finishFinalReview(db,{applicationId:id,reviewHash:p.reviewHash},'chair',now);}
test('final review removes detail but preserves outcomes, completion, name and counterpart feedback',async t=>{
  const db=await setup(t),before=await programReport(db,now);
  await finish(db);assert.deepEqual(await programReport(db,now),before);
  const app=await db.prepare("SELECT * FROM applications WHERE id='mentee'").first();assert.deepEqual(JSON.parse(app.answers),{name:'mentee Example'});assert.equal(app.details_removed_at,now);
  const r=await getRequest(db,'menteefinal');assert.deepEqual(r.answers,{progress:true,value:true,contact:false});assert.equal(r.token_hash,null);assert.equal(r.reviewed_at,now);
  assert.equal(await getRequest(db,'menteequarterly'),null);assert.match((await getRequest(db,'mentorfinal')).answers.value,/Written fictional/);
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM jobs WHERE application_id='mentee'").first('n'),0);
  assert.equal((await finish(db)).alreadyReviewed,true);assert.deepEqual(await programReport(db,now),before);
});
test('cleanup refuses another active relationship, a pending final window, unclassified feedback or uncertain delivery',async t=>{
  const db=await setup(t);
  await db.prepare("UPDATE requests SET answers='{}',classifications='{}',deadline='2026-06-22' WHERE id='menteefinal'").run();await assert.rejects(previewFinalReview(db,'mentee',now));
  await db.prepare("UPDATE requests SET answers='{\"progress\":\"text\",\"value\":\"text\"}',deadline='2026-05-22' WHERE id='menteefinal'").run();await assert.rejects(previewFinalReview(db,'mentee',now));
  await db.prepare("UPDATE requests SET classifications='{\"progress\":\"Unclear\",\"value\":\"Meaningful\"}' WHERE id='menteefinal'").run();
  await db.prepare("UPDATE jobs SET status='sending' WHERE id='menteefinaljob'").run();await assert.rejects(finish(db));
  await db.prepare("UPDATE jobs SET status='captured' WHERE id='menteefinaljob'").run();
  await db.exec("INSERT INTO pairs(id,mentee_id,mentor_id,group_name,fit_reason,status,created_at) VALUES('other','mentor','mentee','First','Test','matched','2026-01-01');");
  await assert.rejects(previewFinalReview(db,'mentee',now));
});
test('stale cleanup and storage failure cannot erase application details',async t=>{
  const db=await setup(t),p=await previewFinalReview(db,'mentee',now);
  await db.prepare("UPDATE requests SET version=version+1 WHERE id='menteefinal'").run();
  await assert.rejects(finishFinalReview(db,{applicationId:'mentee',reviewHash:p.reviewHash},'chair',now));
  await db.exec("CREATE TRIGGER fail_retention BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT,'test only'); END;");
  await assert.rejects(finish(db));assert.equal(await db.prepare("SELECT details_removed_at FROM applications WHERE id='mentee'").first('details_removed_at'),null);
  assert.match((await getRequest(db,'menteefinal')).answers.value,/Written fictional/);
});
test('retained missing results can be corrected by the Chair without keeping new wording or duplicating totals',async t=>{
  const db=await setup(t);await db.prepare("UPDATE requests SET answers='{\"value\":\"Written fictional value\"}',classifications='{\"value\":\"Meaningful\"}' WHERE id='menteefinal'").run();
  await finish(db);assert.equal((await programReport(db,now)).metrics.menteeProgress.missing,1);
  const r=await getRequest(db,'menteefinal');
  await correctRecord(db,'correct_classification',{id:crypto.randomUUID(),requestId:r.id,version:r.version,field:'progress',classification:'Meaningful',conditions:''},'chair',now);
  const report=await programReport(db,now);assert.equal(report.metrics.menteeProgress.included,1);assert.equal(report.metrics.menteeProgress.positive,1);assert.equal(report.metrics.menteeProgress.missing,0);
  await assert.rejects(receiveFeedback(db,{id:'late',requestId:r.id,answers:{value:'New wording must not persist'},receivedAt:now,source:'verified-email'}));
  await runFollowups(db,{now:'2026-07-01',inboxHealthy:true,renderMessage:()=>{throw new Error('Reviewed participant must receive no follow-up');}});
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM jobs WHERE application_id='mentee'").first('n'),0);
});
test('deleting the retained personal record preserves the same totals and does not double-count completion',async t=>{
  const db=await setup(t);await finish(db);const before=await programReport(db,now),p=await previewDeletion(db,'mentee');
  await deleteParticipant(db,{applicationId:'mentee',reviewHash:p.reviewHash},'chair',now);
  const after=await programReport(db,now);assert.deepEqual(after.metrics,before.metrics);assert.deepEqual(after.completion,before.completion);
});
test('restoring an older backup applies the current completion cleanup without restoring detailed information',async t=>{
  const db=await setup(t),old=await exportSnapshot(db);await finish(db);
  const current=await exportPrivacyCheckpoint(db),replayed=replayDeletions(old,current),destination=await setup(t,{seed:false});
  await importSnapshot(destination,replayed,{latestPrivacyCheckpoint:current,standby:true});
  assert.deepEqual(JSON.parse(await destination.prepare("SELECT answers FROM applications WHERE id='mentee'").first('answers')),{name:'mentee Example'});
  assert.equal(await getRequest(destination,'menteequarterly'),null);
  assert.deepEqual(await programReport(destination,now),await programReport(db,now));
});
test('final-review preview is read-only and authenticated cleanup stays disabled until native confirmation is qualified',async t=>{
  const db=await setup(t),env={MODE:'review',OPERATOR_ID:'fixture-chair',OPERATOR_BRIDGE_SECRET:'fictional-secret'};
  const call=async(op,params)=>handleOperatorRequest(db,await signOperatorRequest(op,params,env.OPERATOR_ID,env.OPERATOR_BRIDGE_SECRET),env);
  const preview=await call('final_review_preview',{applicationId:'mentee'});assert.match(preview.effect,/not full personal-record deletion/);
  await assert.rejects(call('finish_final_review',{applicationId:'mentee',reviewHash:preview.reviewHash}),e=>e.status===403);
  assert.equal(await db.prepare("SELECT details_removed_at FROM applications WHERE id='mentee'").first('details_removed_at'),null);
});
test('restoring after both reviews and a later missing-result correction preserves exact totals',async t=>{
  const db=await setup(t);
  await db.prepare("UPDATE requests SET answers='{}',classifications='{}' WHERE id='menteefinal'").run();
  const old=await exportSnapshot(db);await finish(db);await finish(db,'mentor');
  const r=await getRequest(db,'menteefinal');
  await correctRecord(db,'correct_classification',{id:crypto.randomUUID(),requestId:r.id,version:r.version,field:'progress',classification:'Some',conditions:''},'chair',now);
  const current=await exportPrivacyCheckpoint(db),destination=await setup(t,{seed:false});
  await importSnapshot(destination,replayDeletions(old,current),{latestPrivacyCheckpoint:current,standby:true});
  assert.deepEqual(await programReport(destination,now),await programReport(db,now));
  assert.deepEqual((await exportSnapshot(destination)).tables,(await exportSnapshot(db)).tables);
});
test('final review preserves submission identity and counterpart correction receipts and records an end date',async t=>{
  const db=await setup(t),r=await getRequest(db,'mentorfinal'),id=crypto.randomUUID();
  await correctRecord(db,'correct_classification',{id,requestId:r.id,version:r.version,field:'value',classification:'Some',conditions:''},'chair',now);
  const old=await exportSnapshot(db);await finish(db);
  assert.equal(await db.prepare("SELECT payload_hash FROM applications WHERE id='mentee'").first('payload_hash'),'mentee');
  assert.equal(await db.prepare("SELECT ended_date FROM pairs WHERE id='pair'").first('ended_date'),'2026-06-01');
  assert.ok(await db.prepare('SELECT id FROM chair_actions WHERE id=?').bind(id).first());
  const destination=await setup(t,{seed:false}),checkpoint=await exportPrivacyCheckpoint(db);
  await assert.rejects(importSnapshot(destination,old,{latestDeletionLedger:[],standby:true}),/checkpoint/);
  await importSnapshot(destination,old,{latestPrivacyCheckpoint:checkpoint,standby:true});
  assert.ok(await destination.prepare('SELECT id FROM chair_actions WHERE id=?').bind(id).first());
  assert.equal(await destination.prepare("SELECT details_removed_at FROM applications WHERE id='mentee'").first('details_removed_at'),now);
});
test('uncertain Chair notification blocks final-review cleanup',async t=>{
  const db=await setup(t);await db.exec("INSERT INTO jobs(id,application_id,kind,status,payload,created_at) VALUES('notice','mentee','chair-notification','held','{}','2026-05-01');");
  await assert.rejects(finish(db),/uncertain delivery/);
});
