import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {examples} from '../fixtures.mjs';
import {recommendMatches} from '../matching.mjs';
import {createReviewAI} from '../review-ai.mjs';
import {correctRecord} from '../corrections.mjs';
import {runFollowups,receiveFeedback,getRequest,inspectFollowups} from '../followups.mjs';
import {reviewFeedback} from '../feedback.mjs';
import {programReport,previewDeletion,deleteParticipant} from '../privacy.mjs';
import {signOperatorRequest,handleOperatorRequest} from '../operator-api.mjs';

async function setup(t,{paired=true,actual='2026-01-31'}={}){
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']}));
  t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
  for(const file of ['0001_applications.sql','0002_administration.sql','0003_followups.sql','0004_deletion.sql','0005_reporting_totals.sql','0006_final_review.sql','0007_mail_receipt.sql'])await db.exec((await readFile(new URL('../migrations/'+file,import.meta.url),'utf8')).replaceAll('\n',' '));
  const ids={mentee:crypto.randomUUID(),mentor:crypto.randomUUID()};
  for(const role of ['mentee','mentor'])await db.prepare("INSERT INTO applications(id,submission_key,payload_hash,role,answers,terms_version,privacy_version,created_at,decision,readiness) VALUES(?,?,?,?,?,'test','test','2025-01-01','approved',1)").bind(ids[role],ids[role],ids[role],role,JSON.stringify(examples[role])).run();
  if(paired){
    await db.prepare("INSERT INTO cohorts(name,first_cohort) VALUES('First',1)").run();
    await db.prepare("INSERT INTO pairs(id,mentee_id,mentor_id,group_name,fit_reason,status,mentee_trained,mentor_trained,actual_date,created_at) VALUES('pair',?,?,'First','Test fit','active',1,1,?,'2025-01-01')").bind(ids.mentee,ids.mentor,actual).run();
  }
  const run=now=>runFollowups(db,{now,inboxHealthy:true,renderMessage:(r,phase,token)=>({requestId:r.id,phase,link:'https://review.example/check-in#'+token})});
  return {db,ids,run};
}
const instant='2026-05-01T12:00:00.000Z';
test('matching returns coded supporting facts and action versions without saving or approving',async t=>{
  const {db,ids}=await setup(t,{paired:false});let sent;
  const ai=createReviewAI({apiKey:'fictional-key',spendingVerified:true,fetcher:async(url,options)=>{
    sent=JSON.parse(options.body);
    return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({suggestions:[{mentee:'mentee-'+ids.mentee,mentor:'mentor-'+ids.mentor,reasons:['The distribution experience addresses delivery errors.'],gaps:[],risks:['Confirm conflicts.'],questions:['Can both meet?']}]})}]}]});
  }});
  const result=await recommendMatches(db,ai);assert.equal(result.suggestions[0].menteeVersion,1);assert.equal(result.suggestions[0].mentorId,ids.mentor);
  assert.doesNotMatch(sent.input,/Alex Example|Jordan Example|@|linkedin/);
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM pairs').first('n'),0);
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM matching_copies').first('n'),0);
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM chair_actions').first('n'),0);
  assert.equal((await recommendMatches(db,createReviewAI())).status,'pending');
});
test('matching excludes paired mentees and rejects stale recommendations',async t=>{
  const s=await setup(t);let called=false;
  assert.deepEqual((await recommendMatches(s.db,{recommend:async()=>{called=true;}})).suggestions,[]);assert.equal(called,false);
  await s.db.prepare("UPDATE pairs SET status='ended'").run();
  const result=await recommendMatches(s.db,{recommend:async()=>{await s.db.prepare('UPDATE applications SET version=version+1 WHERE id=?').bind(s.ids.mentee).run();return {status:'recommended',suggestions:[]};}});
  assert.equal(result.status,'pending');assert.match(result.reason,/changed/);
});
test('cycle correction moves only unsent requests, preserves deadlines and deduplicates retries',async t=>{
  const s=await setup(t);await s.run(instant);
  const before=(await inspectFollowups(s.db)).requests;
  const action={id:crypto.randomUUID(),pairId:'pair',version:1,actualDate:'2026-02-01'};
  await Promise.all([correctRecord(s.db,'correct_cycle',action,'chair',instant),correctRecord(s.db,'correct_cycle',action,'chair',instant)]);
  assert.equal(await s.db.prepare('SELECT actual_date FROM pairs').first('actual_date'),'2026-02-01');
  const after=(await inspectFollowups(s.db)).requests;
  for(const r of before){const current=after.find(x=>x.id===r.id);if(r.sent_at){assert.equal(current.deadline,r.deadline);assert.equal(current.scheduled_for,r.scheduled_for);}else if(r.period===6)assert.equal(current.scheduled_for,'2026-08-01T00:00:00.000Z');}
  assert.equal(await s.db.prepare('SELECT COUNT(*) n FROM chair_actions').first('n'),1);
  await assert.rejects(correctRecord(s.db,'correct_cycle',{...action,id:crypto.randomUUID()},'chair',instant),e=>e.status===409);
  await assert.rejects(correctRecord(s.db,'correct_cycle',{...action,actualDate:'2026-03-01'},'chair',instant),e=>e.status===409);
});
test('invalid cycle dates, unstarted or ended pairs cannot be corrected',async t=>{
  const {db}=await setup(t);
  for(const actualDate of ['2026-02-30','2027-01-01','2024-01-01'])await assert.rejects(correctRecord(db,'correct_cycle',{id:crypto.randomUUID(),pairId:'pair',version:1,actualDate},'chair',instant));
  await db.prepare("UPDATE pairs SET status='matched',actual_date=NULL").run();
  await assert.rejects(correctRecord(db,'correct_cycle',{id:crypto.randomUUID(),pairId:'pair',version:1,actualDate:'2026-01-01'},'chair',instant));
  await db.prepare("UPDATE pairs SET status='ended',actual_date='2026-01-01'").run();
  await assert.rejects(correctRecord(db,'correct_cycle',{id:crypto.randomUUID(),pairId:'pair',version:1,actualDate:'2026-01-02'},'chair',instant));
});
test('Chair classification correction changes results without replacing feedback or deadline',async t=>{
  const s=await setup(t,{actual:'2025-05-01'});await s.run(instant);
  const id=await s.db.prepare("SELECT id FROM requests WHERE role='mentee' AND kind='final'").first('id');
  await receiveFeedback(s.db,{id:'answer',requestId:id,answers:{progress:reviewFeedback.progress,value:reviewFeedback.value},receivedAt:instant,source:'form'});
  const r=await getRequest(s.db,id),action={id:crypto.randomUUID(),requestId:id,version:r.version,field:'progress',classification:'Some',conditions:''};
  await Promise.all([correctRecord(s.db,'correct_classification',action,'chair',instant),correctRecord(s.db,'correct_classification',action,'chair',instant)]);
  const saved=await getRequest(s.db,id);assert.deepEqual(saved.answers,r.answers);assert.equal(saved.deadline,r.deadline);assert.equal(saved.version,r.version+1);
  const report=await programReport(s.db,instant);assert.equal(report.metrics.menteeProgress.percent,0);assert.equal(report.metrics.menteeValue.percent,100);
  await assert.rejects(correctRecord(s.db,'correct_classification',{...action,id:crypto.randomUUID()},'chair',instant));
  const preview=await previewDeletion(s.db,s.ids.mentee);await deleteParticipant(s.db,{applicationId:s.ids.mentee,reviewHash:preview.reviewHash},'chair',instant);
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM chair_actions WHERE action='correct_classification'").first('n'),0);
});
test('correction cannot create missing feedback and rolls back with its receipt on storage failure',async t=>{
  const s=await setup(t);await s.run(instant);const r=(await inspectFollowups(s.db)).requests.find(r=>r.kind==='quarterly');
  await assert.rejects(correctRecord(s.db,'correct_classification',{id:crypto.randomUUID(),requestId:r.id,version:r.version,field:'value',classification:'Meaningful',conditions:''},'chair',instant));
  await s.db.exec("CREATE TRIGGER reject_correction BEFORE UPDATE ON pairs BEGIN SELECT RAISE(ABORT,'test only'); END;");
  await assert.rejects(correctRecord(s.db,'correct_cycle',{id:crypto.randomUUID(),pairId:'pair',version:1,actualDate:'2026-02-01'},'chair',instant));
  assert.equal(await s.db.prepare('SELECT COUNT(*) n FROM chair_actions').first('n'),0);
  assert.equal(await s.db.prepare('SELECT actual_date FROM pairs').first('actual_date'),'2026-01-31');
});
test('authenticated follow-up inspection excludes private link material and mutations remain gated',async t=>{
  const s=await setup(t);await s.run(instant);
  const env={MODE:'review',OPERATOR_ID:'fixture',OPERATOR_BRIDGE_SECRET:'fictional-key'};
  const call=async(operation,params={})=>handleOperatorRequest(s.db,await signOperatorRequest(operation,params,env.OPERATOR_ID,env.OPERATOR_BRIDGE_SECRET),env);
  const result=await call('followups');assert.ok(result.requests.length);assert.ok(result.jobs.length);
  assert.doesNotMatch(JSON.stringify(result),/token_hash|last_mutation|check-in#|"payload"/);
  for(const op of ['correct_cycle','correct_classification'])await assert.rejects(call(op,{}),e=>e.status===403);
});
