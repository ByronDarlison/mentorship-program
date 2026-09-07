import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {examples} from '../fixtures.mjs';
import {saveApplication} from '../applications.mjs';
import {deliverReviewJobs} from '../review-delivery.mjs';
import {runFollowups,getRequest} from '../followups.mjs';
import {saveReviewCheckIn} from '../check-in-api.mjs';
import {createReviewAI} from '../review-ai.mjs';
import {codedMatchingFacts} from '../administration.mjs';
import {sanitizeForProvider} from '../identifiers.mjs';
import {reserveAIAllowance,maximumCharge,MONTHLY_CAP_MICRO_USD} from '../ai-budget.mjs';
import {currentReplyText,receiveReviewEmail} from '../email-replies.mjs';
import {previewMessageAction,executeMessageAction} from '../message-actions.mjs';
const now='2026-09-07T12:00:00.000Z';
const config={MODE:'operating',PROGRAM_MAILBOX_VERIFIED:'true',REVIEW_DELIVERY_VERIFIED:'true',CHAIR_EMAIL:'chair@example.test',TERMS_VERSION:'policy',PRIVACY_VERSION:'policy',COPY:{receiptSubject:'Application received',receiptBody:'Thank you for applying.'}};
async function setup(t){
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']}));
  t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
  const directory=new URL('../migrations/',import.meta.url);
  for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql')).sort())await db.exec((await readFile(new URL(name,directory),'utf8')).replaceAll('\n',' '));
  return db;
}
async function apply(db,role='mentee'){
  const answers={...examples[role],name:role==='mentee'?'Taylor Sample':'Morgan Sample',email:role+'@example.test','linkedin-url':''};
  const result=await saveApplication(db,{role,submissionKey:crypto.randomUUID(),answers,acknowledgement:true,termsVersion:'policy',privacyVersion:'policy'},config);
  return {...result,answers};
}
const receipt=m=>({id:crypto.randomUUID(),sentAt:now,reference:m.reference,rfcMessageId:m.reference.replace('@mentorship.invalid>','@mail.example.test>'),to:m.to});
test('operating accepts non-fixture applications and routes receipts separately from Chair notices',async t=>{
  const db=await setup(t);const people=[await apply(db),await apply(db,'mentor')],sent=[];
  const mailbox={send:async m=>{sent.push(m);return receipt(m);},findSent:async()=>null};
  const options={mode:'operating',enabled:true,inboxHealthy:true,chairEmail:config.CHAIR_EMAIL,recipient:'must-not-override@example.test',mailbox};
  await deliverReviewJobs(db,options);await deliverReviewJobs(db,options);
  assert.equal(sent.length,4);assert.equal(sent.filter(m=>m.to===config.CHAIR_EMAIL).length,2);
  for(const person of people){assert.equal(person.mode,'operating');assert.ok(sent.some(m=>m.to===person.answers.email));}
  assert.ok(sent.every(m=>m.to!=='must-not-override@example.test'));
});
test('a discretionary message remains bound to the exact approved address',async t=>{
  const db=await setup(t),person=await apply(db);
  const action={id:crypto.randomUUID(),name:'message',applicationId:person.reference,version:1,subject:'Checking in',body:'A synthetic approved message.'};
  const preview=await previewMessageAction(db,action,config);
  const result=await executeMessageAction(db,{...action,reviewHash:preview.reviewHash},'chair',config);
  const payload=JSON.parse(await db.prepare('SELECT payload FROM jobs WHERE id=?').bind(result.jobId).first('payload'));
  assert.equal(payload.to,person.answers.email);
  await db.prepare('UPDATE applications SET answers=? WHERE id=?').bind(JSON.stringify({...person.answers,email:'changed@example.test'}),person.reference).run();
  const sent=[];await deliverReviewJobs(db,{mode:'operating',enabled:true,inboxHealthy:true,chairEmail:config.CHAIR_EMAIL,mailbox:{send:async m=>{sent.push(m);return receipt(m);},findSent:async()=>null}});
  assert.ok(!sent.some(m=>m.subject===action.subject));
  assert.equal(await db.prepare('SELECT status FROM jobs WHERE id=?').bind(result.jobId+':delivery-error').first('status'),'held');
});
test('monthly AI allowance is atomic, bounded, durable across failures and separate per month',async t=>{
  const db=await setup(t),bytes=64000,charge=maximumCharge(bytes),id='system:ai-budget:2026-09';
  await reserveAIAllowance(db,bytes,now);
  assert.equal(await reserveAIAllowance(db,bytes,now),true,'a second call must work with D1 numeric bindings');
  await db.prepare('UPDATE jobs SET payload=? WHERE id=?').bind('{"month":"2026-09","reservedMicroUsd":10096.0}',id).run();
  assert.equal(await reserveAIAllowance(db,bytes,now),true,'whole-number JSON real from a prior D1 write remains valid');
  assert.equal(await db.prepare("SELECT json_type(payload,'$.reservedMicroUsd') AS type FROM jobs WHERE id=?").bind(id).first('type'),'integer');
  await db.prepare('UPDATE jobs SET payload=? WHERE id=?').bind('{"month":"2026-09","reservedMicroUsd":10096.5}',id).run();
  assert.equal(await reserveAIAllowance(db,bytes,now),false,'fractional ledger corruption remains refused');
  await db.prepare('UPDATE jobs SET payload=? WHERE id=?').bind(JSON.stringify({month:'2026-09',reservedMicroUsd:MONTHLY_CAP_MICRO_USD-charge}),id).run();
  const results=await Promise.all(Array.from({length:8},()=>reserveAIAllowance(db,bytes,now)));
  assert.equal(results.filter(Boolean).length,1);
  assert.equal(await reserveAIAllowance(db,0,now),false);
  assert.equal(await reserveAIAllowance(db,bytes,'2026-10-01T00:00:00Z'),true);
  assert.equal(await reserveAIAllowance(db,64001,now),false);
  await db.prepare('UPDATE jobs SET payload=? WHERE id=?').bind(JSON.stringify({month:'2026-09',reservedMicroUsd:-1}),id).run();
  assert.equal(await reserveAIAllowance(db,bytes,now),false);
});
test('routine AI removes known identifiers and refuses residual contact details without a provider call',async t=>{
  const db=await setup(t),sent=[],identity={name:'Taylor Sample',email:'taylor@example.test','linkedin-url':'https://linkedin.com/in/taylor-sample'};
  const ai=createReviewAI({db,fixturesOnly:false,spendingVerified:true,apiKey:'synthetic-key',fetcher:async(_url,init)=>{sent.push(JSON.parse(init.body));return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({classification:'Meaningful',conditions:''})}]}]});}});
  assert.equal((await ai.classify('value','Taylor Sample gained a useful new perspective.',identity)).classification,'Meaningful');
  assert.equal(sent.length,1);assert.doesNotMatch(sent[0].input,/Taylor|Sample|taylor@example/);
  assert.equal(sent[0].store,false);assert.equal(sent[0].service_tier,'default');
  for(const text of ['Call 555-1234','Call me at 5551234','See linkedin.com/in/someone','See example.com/path','Email other@example.test','Call 416 555 0134']){
    assert.equal(sanitizeForProvider(text,identity).refused,true);
    assert.equal((await ai.classify('value',text,identity)).status,'pending');
  }
  assert.equal(sent.length,1);
  assert.equal(sanitizeForProvider('We met on 2026-09-07.',identity).text,'We met on 2026-09-07.');
  assert.equal(sanitizeForProvider('Annual revenue is $1,000,000.',identity).refused,undefined);
  assert.equal(currentReplyText('No\n\nOn Mon, Sep 7, someone <\nsender@example.test> wrote:\n> old content'),'No');
});
test('real coded matching facts omit direct fields and reject contact details in business prose',()=>{
  const record={id:crypto.randomUUID(),role:'mentee',decision:'approved',answers:{...examples.mentee,name:'Taylor Sample',email:'taylor@example.test',business:'Taylor runs a small distribution business.','linkedin-url':''}};
  const facts=codedMatchingFacts([record],{fixturesOnly:false});
  assert.doesNotMatch(JSON.stringify(facts),/Taylor|taylor@example|linkedin-url/);
  assert.throws(()=>codedMatchingFacts([{...record,answers:{...record.answers,challenge:'See linkedin.com/in/other'}}],{fixturesOnly:false}));
  assert.throws(()=>codedMatchingFacts([record]));
});
test('operating check-ins save ordinary text, invoke the classifier, and preserve deadlines',async t=>{
  const db=await setup(t),mentee=await apply(db),mentor=await apply(db,'mentor');
  await db.prepare("INSERT INTO cohorts(name,first_cohort) VALUES('Test',1)").run();
  await db.prepare("INSERT INTO pairs(id,mentee_id,mentor_id,group_name,fit_reason,status,mentee_trained,mentor_trained,actual_date,created_at) VALUES('pair',?,?,'Test','Synthetic fit','active',1,1,'2026-06-01','2026-05-01')").bind(mentee.reference,mentor.reference).run();
  await runFollowups(db,{mode:'operating',inboxHealthy:true,now,renderMessage:()=>({subject:'Check-in',body:'How is it going?'})});
  const row=await db.prepare("SELECT id FROM requests WHERE role='mentee' AND period=3").first();
  const request=await getRequest(db,row.id),text='The conversation helped me solve a difficult hiring decision.';
  let calls=0;
  const result=await saveReviewCheckIn(db,request,{id:crypto.randomUUID(),answers:{meetings:3,value:text,contact:false}},now,{mode:'operating',classify:async(field,answer,identity)=>{calls++;assert.equal(answer,text);assert.equal(identity.name,mentee.answers.name);return {status:'classified',classification:'Meaningful',conditions:''};}});
  assert.equal(result.saved,true);assert.equal(calls,1);
  const saved=await getRequest(db,row.id);assert.equal(saved.answers.value,text);assert.equal(saved.deadline,request.deadline);
  await assert.rejects(saveReviewCheckIn(db,saved,{id:crypto.randomUUID(),answers:{value:text}},now));
});
