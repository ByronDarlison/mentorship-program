import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {saveApplication} from '../applications.mjs';
import {examples} from '../fixtures.mjs';
import {executeChairAction,inspectProgram,codedMatchingFacts} from '../administration.mjs';
import policy from '../../website/dist/application-config.json' with {type:'json'};

async function setup(t){
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']}));
  t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
  for(const name of ['0001_applications.sql','0002_administration.sql'])await db.exec((await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).replaceAll('\n',' '));
  const ids={};for(const role of ['mentee','mentor'])ids[role]=(await saveApplication(db,{role,submissionKey:crypto.randomUUID(),answers:examples[role],acknowledgement:true,termsVersion:policy.termsVersion,privacyVersion:policy.privacyVersion},{MODE:'review',TERMS_VERSION:policy.termsVersion,PRIVACY_VERSION:policy.privacyVersion,COPY:policy.copy,CHAIR_EMAIL:'chair@example.test'})).reference;
  const run=(name,fields)=>executeChairAction(db,{id:crypto.randomUUID(),name,...fields},'test-chair');
  return {db,ids,run};
}
const decision=(id,version=1)=>({applicationId:id,version,decision:'approved',readiness:true});
async function matched(t){
  const s=await setup(t);for(const id of Object.values(s.ids))await s.run('participant_decision',decision(id));
  s.match={menteeId:s.ids.mentee,mentorId:s.ids.mentor,menteeVersion:2,mentorVersion:2,group:'First group',conflictsChecked:true,fitReason:'Relevant distribution and delegation experience.'};
  s.pair=await s.run('approve_match',s.match);return s;
}
test('decisions require readiness and exact version; retries save only once',async t=>{
  const {db,ids,run}=await setup(t);
  await assert.rejects(run('participant_decision',{...decision(ids.mentee),readiness:false}));
  const action={id:crypto.randomUUID(),name:'participant_decision',...decision(ids.mentee)};
  const results=await Promise.all(Array.from({length:5},()=>executeChairAction(db,action,'test-chair')));
  assert.equal(results.every(r=>r.version===2),true);
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM chair_actions').first('n'),1);
  await assert.rejects(run('participant_decision',decision(ids.mentee)));
  await assert.rejects(executeChairAction(db,{...action,decision:'declined'},'test-chair'));
  await assert.rejects(executeChairAction(db,action,'another-chair'));
  assert.deepEqual(await executeChairAction(db,Object.fromEntries(Object.entries(action).reverse()),'test-chair'),results[0]);
  await assert.rejects(run('participant_decision',{...decision(ids.mentor),approved:true}));
});
test('matching preserves final pair and removes temporary copies; no implicit cycle start',async t=>{
  const {db,ids,run}=await setup(t);
  const match={menteeId:ids.mentee,mentorId:ids.mentor,menteeVersion:1,mentorVersion:1,group:'First group',conflictsChecked:true,fitReason:'Distribution experience.'};
  await assert.rejects(run('approve_match',match));
  for(const id of Object.values(ids)){
    await run('participant_decision',decision(id));
    await db.prepare('INSERT INTO matching_copies VALUES(?,?,?)').bind(crypto.randomUUID(),id,'{}').run();
  }
  await assert.rejects(run('approve_match',{...match,menteeVersion:2,mentorVersion:2,conflictsChecked:false}));
  const pair=await run('approve_match',{...match,menteeVersion:2,mentorVersion:2});
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM matching_copies').first('n'),0);
  const saved=await db.prepare('SELECT * FROM pairs WHERE id=?').bind(pair.pairId).first();
  assert.equal(saved.actual_date,null);assert.equal(saved.fit_reason,match.fitReason);
  await assert.rejects(run('participant_decision',decision(ids.mentee,3)));
  await assert.rejects(run('retention_choice',{applicationId:ids.mentee,version:3,choice:'delete-requested'}));
  await assert.rejects(run('approve_match',{...match,menteeVersion:3,mentorVersion:3}));
});
test('attendance is required and booking does not start a cycle',async t=>{
  const {db,run,pair}=await matched(t);
  await assert.rejects(run('planned_meeting',{pairId:pair.pairId,version:1,date:'2026-10-01'}));
  await run('training',{pairId:pair.pairId,version:1,menteeAttended:true,mentorAttended:false});
  await assert.rejects(run('planned_meeting',{pairId:pair.pairId,version:2,date:'2026-10-01'}));
  await run('training',{pairId:pair.pairId,version:2,menteeAttended:true,mentorAttended:true});
  for(const date of ['2026-02-30','2026-99-99','next Monday'])await assert.rejects(run('planned_meeting',{pairId:pair.pairId,version:3,date}));
  await run('planned_meeting',{pairId:pair.pairId,version:3,date:'2026-10-01'});
  await run('planned_meeting',{pairId:pair.pairId,version:4,date:'2026-10-08'});
  const saved=await db.prepare('SELECT * FROM pairs').first();assert.equal(saved.actual_date,null);assert.equal(saved.planned_date,'2026-10-08');assert.equal(saved.status,'matched');
});
test('unmatched retention never deletes or expires silently',async t=>{
  const {db,run,ids}=await setup(t);
  await run('retention_choice',{applicationId:ids.mentee,version:1,choice:'keep'});
  const result=await run('retention_choice',{applicationId:ids.mentee,version:2,choice:'delete-requested'});
  assert.equal(result.deleted,false);assert.equal(await db.prepare('SELECT COUNT(*) n FROM applications').first('n'),2);
});
test('action receipt and domain writes roll back together on storage failure',async t=>{
  const {db,run,ids}=await setup(t);
  await db.exec("CREATE TRIGGER fail_decision BEFORE UPDATE ON applications BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  await assert.rejects(run('participant_decision',decision(ids.mentee)));
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM chair_actions').first('n'),0);
  assert.equal(await db.prepare('SELECT decision FROM applications WHERE id=?').bind(ids.mentee).first('decision'),'waiting');
});
test('matching inputs exclude direct identifiers and contain only supplied application facts',async t=>{
  const {db,run,ids}=await setup(t);for(const id of Object.values(ids))await run('participant_decision',decision(id));
  const records=(await inspectProgram(db)).applications;
  const facts=codedMatchingFacts(records),text=JSON.stringify(facts);
  assert.equal(facts.length,2);assert.doesNotMatch(text,/Alex Example|Jordan Example|@|linkedin|"name"|"email"/);
  assert.match(text,/Delivery errors|distribution/);
  assert.equal(codedMatchingFacts(records.slice(1))[0].code,facts[1].code);
  for(const value of ['Contact ALEX EXAMPLE','416-555-0134','linkedin.com/in/alex-example','someone@example.test']){
    records[0].answers['additional-information']=value;assert.throws(()=>codedMatchingFacts(records));
  }
});
test('cohort identity is case-insensitive and the first group remains capped at ten',async t=>{
  const {db,run,ids}=await setup(t);await run('participant_decision',decision(ids.mentor));
  for(let i=0;i<11;i++){
    const id=crypto.randomUUID();
    await db.prepare("INSERT INTO applications(id,submission_key,payload_hash,role,answers,terms_version,privacy_version,created_at,decision,readiness) SELECT ?,?,payload_hash,role,answers,terms_version,privacy_version,created_at,'approved',1 FROM applications WHERE id=?").bind(id,id,ids.mentee).run();
    const fields={menteeId:id,mentorId:ids.mentor,menteeVersion:1,mentorVersion:2+i,group:i%2?'FIRST GROUP':'First group',conflictsChecked:true,fitReason:'Relevant experience.'};
    if(i<10)await run('approve_match',fields);else await assert.rejects(run('approve_match',fields));
  }
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM cohorts').first('n'),1);
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM pairs').first('n'),10);
});
test('training correction clears the booking, while a past booking does not invent a start',async t=>{
  const {db,run,pair}=await matched(t);
  await run('training',{pairId:pair.pairId,version:1,menteeAttended:true,mentorAttended:true});
  await run('planned_meeting',{pairId:pair.pairId,version:2,date:'2026-01-01'});
  assert.equal(await db.prepare('SELECT actual_date FROM pairs').first('actual_date'),null);
  await run('training',{pairId:pair.pairId,version:3,menteeAttended:false,mentorAttended:false});
  const saved=await db.prepare('SELECT * FROM pairs').first();assert.equal(saved.planned_date,null);assert.equal(saved.planned_revision,null);
});
