import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {runFollowups,receiveFeedback,receiveFirstMeeting,getRequest} from '../followups.mjs';
import {reviewFeedback,reviewLowValue,summarizeResults} from '../feedback.mjs';
import worker from '../worker.mjs';
import {endRelationship} from '../lifecycle.mjs';
import {previewDeletion,deleteParticipant,programReport} from '../privacy.mjs';
import {handleOperatorRequest,signOperatorRequest} from '../operator-api.mjs';
import {foldFinishedOutcomes} from '../outcome-storage.mjs';

async function setup(t,actual='2026-01-31'){
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']}));
  t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
  for(const name of ['0001_applications.sql','0002_administration.sql','0003_followups.sql','0004_deletion.sql','0005_reporting_totals.sql','0006_final_review.sql','0007_mail_receipt.sql'])await db.exec((await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).replaceAll('\n',' '));
  for(const role of ['mentee','mentor'])await db.prepare("INSERT INTO applications(id,submission_key,payload_hash,role,answers,terms_version,privacy_version,created_at) VALUES(?,?,?,?,'{}','test','test','2026-01-01')").bind(role,role,role,role).run();
  await db.prepare("INSERT INTO cohorts(name,first_cohort) VALUES('First',1)").run();
  await db.prepare("INSERT INTO pairs(id,mentee_id,mentor_id,group_name,fit_reason,status,mentee_trained,mentor_trained,actual_date,planned_date,planned_revision,created_at) VALUES('pair','mentee','mentor','First','Fictional fit',?,1,1,?,'2026-01-31','booking-1','2026-01-01')").bind(actual?'active':'matched',actual).run();
  const renderMessage=(r,phase,token,initial)=>({phase,link:token?'https://review.example/check-in#'+token:initial?.link,requestId:r.id});
  const run=now=>runFollowups(db,{now,inboxHealthy:true,renderMessage});
  return {db,run,renderMessage};
}
const at=(day,month='05')=>`2026-${month}-${String(day).padStart(2,'0')}T12:00:00.000Z`;
async function quarterly(s){await s.run(at(1));return getRequest(s.db,await s.db.prepare("SELECT id FROM requests WHERE role='mentee' AND period=3").first('id'));}
const input=(r,patch={})=>({id:crypto.randomUUID(),requestId:r.id,answers:{value:reviewFeedback.value},receivedAt:at(2),source:'form',...patch});
test('scheduled check-ins persist once with private hashes and no actual messages',async t=>{
  const s=await setup(t);await Promise.all([s.run(at(1)),s.run(at(1))]);
  assert.equal(await s.db.prepare('SELECT COUNT(*) n FROM requests').first('n'),8);
  assert.equal(await s.db.prepare('SELECT COUNT(*) n FROM jobs').first('n'),2);
  const r=await getRequest(s.db,await s.db.prepare("SELECT id FROM requests WHERE role='mentee' AND period=3").first('id'));
  assert.equal(r.deadline,at(22));assert.equal(r.token_hash.length,64);assert.equal(r.scheduled_for,'2026-04-30T00:00:00.000Z');
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status!='captured'").first('n'),0);
});
test('partial replies stop only that participant reminders and keep the original deadline',async t=>{
  const s=await setup(t),r=await quarterly(s);
  const saved=await receiveFeedback(s.db,input(r));assert.equal(saved.complete,false);
  await s.run(at(8));await s.run(at(15));await s.run(at(22));
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE request_id=? AND kind='reminder'").bind(r.id).first('n'),0);
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE application_id='mentor' AND kind='reminder'").first('n'),2);
  const current=await getRequest(s.db,r.id);assert.equal(current.deadline,r.deadline);assert.equal(current.failure_history[0].noResponse,false);assert.deepEqual(current.failure_history[0].missing,['meetings','contact']);
  const late=await receiveFeedback(s.db,input(r,{answers:{meetings:0,contact:false},receivedAt:at(24)}));assert.equal(late.complete,true);
  assert.equal((await getRequest(s.db,r.id)).answers.value,reviewFeedback.value);
});
test('same response retry is idempotent, older delayed answers cannot overwrite newer corrections',async t=>{
  const s=await setup(t),r=await quarterly(s),message=input(r);
  const results=await Promise.all(Array.from({length:4},()=>receiveFeedback(s.db,message)));
  assert.equal(results.every(x=>x.saved),true);assert.equal(await s.db.prepare('SELECT COUNT(*) n FROM received_responses').first('n'),1);
  await receiveFeedback(s.db,input(r,{answers:{meetings:4},receivedAt:at(6)}));
  await receiveFeedback(s.db,input(r,{answers:{meetings:1},receivedAt:at(3),source:'verified-email'}));
  assert.equal((await getRequest(s.db,r.id)).answers.meetings,4);
  await assert.rejects(receiveFeedback(s.db,{...message,answers:{meetings:2}}));
});
test('mail acknowledgement is genuine receipt but no invented answer; failed AI preserves text',async t=>{
  const s=await setup(t),r=await quarterly(s);
  await receiveFeedback(s.db,input(r,{answers:{},source:'verified-email'}));
  await assert.rejects(receiveFeedback(s.db,input(r,{answers:{}})));
  await receiveFeedback(s.db,input(r),async()=>{throw new Error('provider unavailable');});
  const current=await getRequest(s.db,r.id);assert.equal(current.answers.value,reviewFeedback.value);assert.deepEqual(current.classifications,{});
  await s.run(at(8));assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE request_id=? AND kind='reminder'").bind(r.id).first('n'),0);
});
test('unhealthy inbox prevents false reminders or silence judgments',async t=>{
  const s=await setup(t);await quarterly(s);
  const result=await runFollowups(s.db,{now:at(22),inboxHealthy:false,renderMessage:s.renderMessage});assert.equal(result.held,true);
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='chair-deadline'").first('n'),0);
});
test('rescheduling cancels former confirmation work without starting cycle',async t=>{
  const s=await setup(t,null);await s.run('2026-02-01T12:00:00.000Z');
  const old=await s.db.prepare('SELECT id FROM requests').first('id');
  await s.db.prepare("UPDATE pairs SET planned_date='2026-02-10',planned_revision='booking-2',version=version+1").run();
  await s.run('2026-02-11T12:00:00.000Z');
  assert.equal((await getRequest(s.db,old)).superseded,1);assert.equal(await s.db.prepare('SELECT status FROM jobs WHERE request_id=?').bind(old).first('status'),'cancelled');
  assert.equal(await s.db.prepare('SELECT actual_date FROM pairs').first('actual_date'),null);
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM requests WHERE kind!='first'").first('n'),0);
});
test('final feedback reports four separate measures using the saved shared record',async t=>{
  const s=await setup(t,'2025-05-01');await s.run(at(1));
  const r=await getRequest(s.db,await s.db.prepare("SELECT id FROM requests WHERE role='mentee' AND kind='final'").first('id'));
  await receiveFeedback(s.db,input(r,{answers:{progress:reviewFeedback.progress}}));
  assert.equal(summarizeResults([await getRequest(s.db,r.id)],at(3)).metrics.menteeProgress.pending,1);
  await receiveFeedback(s.db,input(r,{answers:{value:reviewFeedback.value},receivedAt:at(3)}));
  const report=summarizeResults([await getRequest(s.db,r.id)],at(3));assert.equal(report.metrics.menteeProgress.percent,100);assert.equal(report.completion.complete,0);
});
test('only a clear actual first meeting starts the cycle, including a different actual date',async t=>{
  const s=await setup(t,null);await s.run('2026-02-01T12:00:00.000Z');
  const requestId=await s.db.prepare('SELECT id FROM requests').first('id');
  const base={id:crypto.randomUUID(),requestId,receivedAt:'2026-02-02T12:00:00.000Z'};
  await assert.rejects(receiveFirstMeeting(s.db,{...base,outcome:'happened',date:'2026-02-10'}));
  await receiveFirstMeeting(s.db,{...base,outcome:'unclear'});
  assert.equal(await s.db.prepare('SELECT actual_date FROM pairs').first('actual_date'),null);
  const reply={...base,id:crypto.randomUUID(),outcome:'happened',date:'2026-01-30'};
  await Promise.all([receiveFirstMeeting(s.db,reply),receiveFirstMeeting(s.db,reply)]);
  await s.run('2026-02-03T12:00:00.000Z');
  assert.equal(await s.db.prepare('SELECT actual_date FROM pairs').first('actual_date'),'2026-01-30');
  assert.equal(await s.db.prepare("SELECT scheduled_for FROM requests WHERE kind='quarterly' ORDER BY scheduled_for LIMIT 1").first('scheduled_for'),'2026-04-30T00:00:00.000Z');
});
test('a clear reschedule starts a new confirmation sequence and no meeting remains unstarted',async t=>{
  const s=await setup(t,null);await s.run('2026-02-01T12:00:00.000Z');
  const requestId=await s.db.prepare('SELECT id FROM requests').first('id');
  await receiveFirstMeeting(s.db,{id:crypto.randomUUID(),requestId,receivedAt:'2026-02-02T12:00:00.000Z',outcome:'rescheduled',date:'2026-02-10'});
  await s.run('2026-02-11T12:00:00.000Z');
  assert.equal(await s.db.prepare('SELECT COUNT(*) n FROM requests WHERE superseded=0').first('n'),1);
  const fresh=await s.db.prepare('SELECT id FROM requests WHERE superseded=0').first('id');
  await receiveFirstMeeting(s.db,{id:crypto.randomUUID(),requestId:fresh,receivedAt:'2026-02-12T12:00:00.000Z',outcome:'not-happened'});
  assert.equal(await s.db.prepare('SELECT actual_date FROM pairs').first('actual_date'),null);
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='chair-meeting-review'").first('n'),1);
});
test('private check-in HTTP reads reveal no answers and scanner visits change nothing',async t=>{
  const s=await setup(t),r=await quarterly(s);
  const payload=JSON.parse(await s.db.prepare('SELECT payload FROM jobs WHERE id=?').bind(r.id+':initial').first('payload'));
  const authorization='Bearer '+payload.link.split('#')[1];
  const call=(method,body,auth=authorization)=>worker.fetch(new Request('https://review.example/api/check-in',{method,headers:{Authorization:auth,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),{DB:s.db,MODE:'review'});
  const before=await getRequest(s.db,r.id);
  assert.deepEqual(await (await call('GET')).json(),{kind:'quarterly',role:'mentee',period:3,fields:['meetings','value','contact']});
  await call('GET');assert.equal((await getRequest(s.db,r.id)).version,before.version);
  assert.equal((await call('GET',null,'Bearer bad')).status,404);
  const submission={id:crypto.randomUUID(),answers:{value:reviewFeedback.value}};
  const first=await (await call('POST',submission)).json();assert.equal(first.saved,true);assert.equal(first.complete,false);
  assert.deepEqual(await (await call('POST',submission)).json(),first);
  const meta=await (await call('GET')).json();assert.equal(Object.hasOwn(meta,'answers'),false);assert.equal(Object.hasOwn(meta,'complete'),false);
  assert.equal((await call('POST',{id:crypto.randomUUID(),answers:{value:'Real private information'}})).status,400);
  assert.equal((await call('POST',{id:crypto.randomUUID(),answers:{}})).status,400);
  const complete=await (await call('POST',{id:crypto.randomUUID(),answers:{meetings:3,contact:false}})).json();assert.equal(complete.complete,true);
  assert.equal((await getRequest(s.db,r.id)).answers.value,reviewFeedback.value);
});
test('review form can request Chair contact and flag the supplied low-value example',async t=>{
  const s=await setup(t),r=await quarterly(s),payload=JSON.parse(await s.db.prepare('SELECT payload FROM jobs WHERE id=?').bind(r.id+':initial').first('payload'));
  const response=await worker.fetch(new Request('https://review.example/api/check-in',{method:'POST',headers:{Authorization:'Bearer '+payload.link.split('#')[1],'Content-Type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),answers:{contact:true,value:reviewLowValue,meetings:0}})}),{DB:s.db,MODE:'review'});
  assert.equal(response.status,200);assert.equal((await response.json()).complete,true);
  const alert=JSON.parse(await s.db.prepare("SELECT payload FROM jobs WHERE kind='chair-review'").first('payload'));assert.equal(alert.contact,true);assert.equal(alert.lowValue,true);
});
test('a request processing error is visible without starving unrelated reminders',async t=>{
  const s=await setup(t),r=await quarterly(s);
  const renderMessage=(request,...args)=>{if(request.id===r.id)throw new Error('Private details must not be copied');return s.renderMessage(request,...args);};
  const result=await runFollowups(s.db,{now:at(8),inboxHealthy:true,renderMessage});assert.deepEqual(result.errors,[r.id]);
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE application_id='mentor' AND kind='reminder' AND status='captured'").first('n'),1);
  const alert=await s.db.prepare("SELECT payload FROM jobs WHERE kind='chair-processing-error'").first('payload');assert.equal(alert.includes('Private details'),false);
});
test('catch-up captures only the latest due reminder and preserves the skipped reminder status',async t=>{
  const s=await setup(t),r=await quarterly(s);await s.run(at(16));
  assert.equal(await s.db.prepare('SELECT status FROM jobs WHERE id=?').bind(r.id+':reminder:7').first('status'),'cancelled');
  assert.equal(await s.db.prepare('SELECT status FROM jobs WHERE id=?').bind(r.id+':reminder:14').first('status'),'captured');
});
test('failure to store one processing alert does not starve unrelated work',async t=>{
  const s=await setup(t),r=await quarterly(s);
  await s.db.exec("CREATE TRIGGER fail_processing_alert BEFORE INSERT ON jobs WHEN NEW.kind='chair-processing-error' BEGIN SELECT RAISE(ABORT,'fixture alert failure'); END;");
  const renderMessage=(request,...args)=>{if(request.id===r.id)throw new Error('fixture failure');return s.renderMessage(request,...args);};
  const result=await runFollowups(s.db,{now:at(8),inboxHealthy:true,renderMessage});assert.deepEqual(result.alertFailures,[r.id]);
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE application_id='mentor' AND kind='reminder' AND status='captured'").first('n'),1);
});
test('a claimed meeting before the match goes to the Chair without starting old check-ins',async t=>{
  const s=await setup(t,null);await s.run(at(1,'02'));const requestId=await s.db.prepare('SELECT id FROM requests').first('id');
  const result=await receiveFirstMeeting(s.db,{id:'date-typo',requestId,outcome:'happened',date:'2019-03-04',receivedAt:at(2,'02')});assert.equal(result.chairReview,true);assert.equal(result.started,false);
  await s.run(at(2,'02'));assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM requests WHERE kind!='first'").first('n'),0);
  await assert.rejects(endRelationship(s.db,{id:'bad-end',pairId:'pair',version:1,endDate:'1912-04-15'},'test-chair',at(2,'02')));
});
test('early ending supersedes unfinished requests, preserves failure history and creates one final per role',async t=>{
  const s=await setup(t),r=await quarterly(s);await s.run(at(22));
  assert.equal((await getRequest(s.db,r.id)).failure_history.length,1);
  const action={id:crypto.randomUUID(),pairId:'pair',version:1,endDate:'2026-05-23'};
  await Promise.all([endRelationship(s.db,action,'test-chair',at(23)),endRelationship(s.db,action,'test-chair',at(23))]);
  await s.run(at(23));
  const old=await getRequest(s.db,r.id);assert.equal(old.superseded,1);assert.equal(old.failure_history.length,1);
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM requests WHERE superseded=0 AND kind='final'").first('n'),2);
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM requests WHERE superseded=0 AND kind='quarterly'").first('n'),0);
  const finals=[];for(const row of (await s.db.prepare('SELECT id FROM requests WHERE superseded=0').all()).results)finals.push(await getRequest(s.db,row.id));
  const report=summarizeResults(finals,at(24));assert.equal(report.metrics.menteeProgress.pending,1);assert.equal(report.metrics.mentorReturn.pending,1);assert.equal(report.completion.required,2);
});
async function privacy(){}
async function deletion(s,id='mentee',now=at(3)){
  const preview=await previewDeletion(s.db,id);
  return deleteParticipant(s.db,{applicationId:id,reviewHash:preview.reviewHash},'test-chair',now);
}
test('deletion preview lists only requests with missing or unclassified answers',async t=>{
  const s=await setup(t,'2025-01-31');await privacy(s);await s.run(at(1));
  const id=await s.db.prepare("SELECT id FROM requests WHERE role='mentee' AND kind='final'").first('id');
  await receiveFeedback(s.db,{id:'all-final',requestId:id,answers:{meetings:3,contact:false,value:reviewFeedback.value,progress:reviewFeedback.progress},receivedAt:at(2),source:'form'});
  assert.equal((await previewDeletion(s.db,'mentee')).unresolved.some(r=>r.requestId===id),false);
});
test('deletion preserves final results and completion without explicit identifying columns in outcome rows',async t=>{
  const s=await setup(t,'2025-05-01');await s.run(at(1));await privacy(s);
  const r=await getRequest(s.db,await s.db.prepare("SELECT id FROM requests WHERE role='mentee' AND kind='final'").first('id'));
  await receiveFeedback(s.db,input(r,{answers:{progress:reviewFeedback.progress,value:reviewFeedback.value,meetings:3,contact:false}}));
  const before=await programReport(s.db,at(3));await deletion(s);const after=await programReport(s.db,at(3));
  assert.deepEqual(after.metrics,before.metrics);assert.deepEqual(after.completion,before.completion);
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM applications WHERE id='mentee'").first('n'),0);
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM requests WHERE application_id='mentee'").first('n'),0);
  assert.equal(await s.db.prepare('SELECT mentee_id FROM pairs').first('mentee_id'),null);
  assert.equal(await s.db.prepare('SELECT COUNT(*) n FROM anonymous_outcomes').first('n'),0);
  assert.equal(await s.db.prepare("SELECT positive FROM outcome_totals WHERE metric='menteeProgress'").first('positive'),1);
  await assert.rejects(previewDeletion(s.db,'mentee'));
  assert.equal((await deleteParticipant(s.db,{applicationId:'mentee',reviewHash:'retry'},'test-chair',at(3))).alreadyDeleted,true);
  assert.equal(await s.db.prepare('SELECT COUNT(*) n FROM anonymous_outcomes').first('n'),0);
});
test('private pending results are disclosed and deletion stays disabled until chat actions are enabled',async t=>{
  const s=await setup(t);await privacy(s);await deletion(s,'mentee',at(3));
  const row=await s.db.prepare('SELECT deadline FROM anonymous_outcomes').first();
  const ledger=await s.db.prepare('SELECT deleted_at FROM deletion_ledger').first();
  assert.equal(Date.parse(row.deadline)-21*86400000,Date.parse(ledger.deleted_at));
  const env={MODE:'review',OPERATOR_ID:'fixture-chair',OPERATOR_BRIDGE_SECRET:'fictional-test-key',CHAT_ACTIONS_ENABLED:'false'};
  const envelope=await signOperatorRequest('delete_participant',{applicationId:'mentor',reviewHash:'any'},env.OPERATOR_ID,env.OPERATOR_BRIDGE_SECRET);
  await assert.rejects(handleOperatorRequest(s.db,envelope,env),error=>error.status===403&&error.message.includes('Chat actions are not enabled'));
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM applications WHERE id='mentor'").first('n'),1);
});
test('partial final deletion stays pending then fails only missing outcome at original deadline',async t=>{
  const s=await setup(t,'2025-05-01');await s.run(at(1));await privacy(s);
  const r=await getRequest(s.db,await s.db.prepare("SELECT id FROM requests WHERE role='mentee' AND kind='final'").first('id'));
  await receiveFeedback(s.db,input(r,{answers:{progress:reviewFeedback.progress}}));await deletion(s);
  let report=await programReport(s.db,at(3));assert.equal(report.metrics.menteeProgress.pending,1);assert.equal(report.metrics.menteeValue.pending,1);
  report=await programReport(s.db,at(22));assert.equal(report.metrics.menteeProgress.percent,100);assert.equal(report.metrics.menteeValue.percent,0);assert.equal(report.metrics.menteeValue.missing,1);
  await foldFinishedOutcomes(s.db,at(21));assert.equal(await s.db.prepare('SELECT COUNT(*) n FROM anonymous_outcomes').first('n'),1);
  await Promise.all([foldFinishedOutcomes(s.db,at(22)),foldFinishedOutcomes(s.db,at(22))]);
  assert.equal(await s.db.prepare('SELECT COUNT(*) n FROM anonymous_outcomes').first('n'),0);
  assert.deepEqual(await programReport(s.db,at(22)),report);
  await foldFinishedOutcomes(s.db,at(23));assert.deepEqual(await programReport(s.db,at(23)),report);
});
test('scheduled folding proceeds even when inbox is held and rolls back on failure',async t=>{
  const s=await setup(t);await deletion(s,'mentee',at(3));
  await s.db.exec("CREATE TRIGGER stop_fold BEFORE DELETE ON anonymous_outcomes BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  await assert.rejects(foldFinishedOutcomes(s.db,at(24)));
  assert.equal(await s.db.prepare('SELECT SUM(included) n FROM outcome_totals').first('n'),0);
  assert.equal(await s.db.prepare('SELECT COUNT(*) n FROM anonymous_outcomes').first('n'),1);
  await s.db.exec('DROP TRIGGER stop_fold;');
  await runFollowups(s.db,{now:at(24),inboxHealthy:false});
  assert.equal(await s.db.prepare('SELECT COUNT(*) n FROM anonymous_outcomes').first('n'),0);
  assert.equal((await programReport(s.db,at(24))).metrics.menteeValue.missing,1);
});
test('deleting before a final request uses reporting-only window and requests only survivor feedback',async t=>{
  const s=await setup(t);await quarterly(s);await privacy(s);
  await deletion(s,'mentee',at(3));await s.run(at(3));
  const anon=await s.db.prepare('SELECT * FROM anonymous_outcomes').first();assert.equal(anon.reporting_only,1);assert.equal(anon.deadline,at(24));
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE application_id='mentee'").first('n'),0);
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM requests WHERE kind='final' AND superseded=0").first('n'),1);
  assert.equal((await programReport(s.db,at(23))).metrics.menteeProgress.pending,1);
  assert.equal((await programReport(s.db,at(24))).metrics.menteeProgress.missing,1);
  await deletion(s,'mentor',at(4));assert.equal(await s.db.prepare('SELECT COUNT(*) n FROM anonymous_outcomes').first('n'),2);
  assert.equal((await programReport(s.db,at(24))).metrics.menteeProgress.included,1);
});
test('changed feedback invalidates deletion review and storage failure cannot partially erase',async t=>{
  const s=await setup(t),r=await quarterly(s);await privacy(s);
  const preview=await previewDeletion(s.db,'mentee');await receiveFeedback(s.db,input(r));
  await assert.rejects(deleteParticipant(s.db,{applicationId:'mentee',reviewHash:preview.reviewHash},'test-chair',at(3)));
  await s.db.exec("CREATE TRIGGER stop_delete BEFORE DELETE ON applications BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  await assert.rejects(deletion(s));
  assert.equal(await s.db.prepare('SELECT COUNT(*) n FROM anonymous_outcomes').first('n'),0);
  assert.equal(await s.db.prepare('SELECT COUNT(*) n FROM deletion_ledger').first('n'),0);
  assert.equal(await s.db.prepare("SELECT COUNT(*) n FROM applications WHERE id='mentee'").first('n'),1);
});
test('deletion scrubs counterpart message text, fit explanation and pair action details',async t=>{
  const s=await setup(t);await quarterly(s);await privacy(s);
  await s.db.prepare("UPDATE pairs SET fit_reason='DELETED PERSON relevant experience'").run();
  await s.db.prepare("UPDATE jobs SET payload=json_set(payload,'$.body','DELETED PERSON details') WHERE application_id='mentor'").run();
  await deletion(s);
  assert.equal(await s.db.prepare('SELECT fit_reason FROM pairs').first('fit_reason'),'');
  for(const row of (await s.db.prepare('SELECT payload FROM jobs').all()).results)assert.doesNotMatch(row.payload,/DELETED PERSON/);
});
