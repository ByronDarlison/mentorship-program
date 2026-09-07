import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {deliverReviewJobs} from '../review-delivery.mjs';
import {createProgramMailbox,encodeSubject,rfc5322Date,messageReferenceHeader} from '../program-mailbox.mjs';
import {runFollowups,getRequest} from '../followups.mjs';
import {runReviewSchedule} from '../review-schedule.mjs';
import {reviewReplies,messageReference} from '../email-replies.mjs';
import {previewMessageAction,executeMessageAction} from '../message-actions.mjs';
const recipient='reviewer@example.test',sentAt='2026-05-01T12:00:00.000Z';
async function setup(t,status='pending'){
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']}));t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
  for(const file of ['0001_applications.sql','0002_administration.sql','0003_followups.sql','0004_deletion.sql','0005_reporting_totals.sql','0006_final_review.sql'])await db.exec((await readFile(new URL('../migrations/'+file,import.meta.url),'utf8')).replaceAll('\n',' '));
  await db.exec((await readFile(new URL('../migrations/0007_mail_receipt.sql',import.meta.url),'utf8')).replaceAll('\n',' '));
  await db.prepare("INSERT INTO jobs(id,kind,status,payload,created_at) VALUES('message','application-receipt',?,?,'2026-05-01')").bind(status,JSON.stringify({to:'not-a-reviewer@example.test',subject:'Fictional receipt',text:'Fictional body'})).run();return db;
}
const receipt=m=>({id:'provider-id',sentAt,reference:m.reference,rfcMessageId:m.reference.replace('@mentorship.invalid>','@mail.gmail.com>'),to:m.to});
test('long UTF-8 subjects preserve characters and fit MIME header limits',()=>{
  for(const subject of ['A'.repeat(250),'é'.repeat(250),'🙂'.repeat(100),'A useful mentorship check-in']){
    const encoded=encodeSubject(subject),words=encoded.split('\r\n ');
    assert.ok(words.every(word=>word.length<=75));assert.ok(('Subject: '+encoded).split('\r\n').every(line=>line.length<=76));
    assert.equal(words.map(word=>Buffer.from(word.slice(10,-2),'base64').toString()).join(''),subject);
  }
  for(const subject of ['', 'A\nB','A'.repeat(251)])assert.throws(()=>encodeSubject(subject));
});
test('outgoing Date uses RFC 5322 UTC',()=>{
  assert.equal(rfc5322Date(new Date('2026-09-07T14:34:00.000Z')),'Mon, 07 Sep 2026 14:34:00 +0000');
});
test('disabled delivery and captured messages never contact a provider',async t=>{
  const db=await setup(t,'captured');let calls=0;const mailbox={send:async()=>{calls++;},findSent:async()=>{calls++;}};
  await deliverReviewJobs(db,{mailbox});await deliverReviewJobs(db,{enabled:true,inboxHealthy:true,recipient,mailbox});assert.equal(calls,0);
});
test('concurrent delivery sends once and only to the configured fictional-review recipient',async t=>{
  const db=await setup(t);let calls=0;const mailbox={send:async m=>{calls++;assert.equal(m.to,recipient);return receipt(m);},findSent:async()=>null};
  const options={enabled:true,inboxHealthy:true,recipient,mailbox};await Promise.all([deliverReviewJobs(db,options),deliverReviewJobs(db,options)]);await deliverReviewJobs(db,options);
  assert.equal(calls,1);assert.equal(await db.prepare("SELECT status FROM jobs WHERE id='message'").first('status'),'sent');
  assert.equal(await db.prepare("SELECT rfc_message_id FROM jobs WHERE id='message'").first('rfc_message_id'),messageReference('message').replace('@mentorship.invalid>','@mail.gmail.com>'));
});
test('uncertain sends are held and only provider evidence can settle them, never a blind retry',async t=>{
  const db=await setup(t);let calls=0,found;
  const mailbox={send:async m=>{calls++;found=receipt(m);throw new Error('lost response');},findSent:async()=>null};
  const options={enabled:true,inboxHealthy:true,recipient,mailbox};assert.deepEqual((await deliverReviewJobs(db,options)).held,['message']);
  await deliverReviewJobs(db,options);assert.equal(calls,1);assert.equal(await db.prepare('SELECT status FROM jobs').first('status'),'held');
  mailbox.findSent=async()=>found;await deliverReviewJobs(db,options);assert.equal(calls,1);assert.equal(await db.prepare('SELECT status FROM jobs').first('status'),'sent');
});
test('an unhealthy inbox pauses delivery and malformed payloads do not send',async t=>{
  const db=await setup(t);let calls=0;const mailbox={send:async()=>{calls++;},findSent:async()=>null};
  assert.equal((await deliverReviewJobs(db,{enabled:true,recipient,mailbox})).paused,true);
  await db.prepare("UPDATE jobs SET payload=?").bind(JSON.stringify({subject:'Invalid\nBcc: other@example.test',body:'x'})).run();
  assert.deepEqual((await deliverReviewJobs(db,{enabled:true,inboxHealthy:true,recipient,mailbox})).held,['message']);assert.equal(calls,0);
  assert.equal(await db.prepare("SELECT status FROM jobs WHERE id='message'").first('status'),'pending');
  assert.equal(await db.prepare("SELECT status FROM jobs WHERE id='message:delivery-error'").first('status'),'held');
  await db.prepare("UPDATE jobs SET payload=? WHERE id='message'").bind(JSON.stringify({subject:'Repaired',body:'Fictional body'})).run();
  mailbox.send=async m=>{calls++;return receipt(m);};
  await deliverReviewJobs(db,{enabled:true,inboxHealthy:true,recipient,mailbox});
  assert.equal(calls,1);assert.equal(await db.prepare("SELECT status FROM jobs WHERE id='message:delivery-error'").first('status'),'cancelled');
});
test('database failure after provider acceptance can be reconciled without a second send',async t=>{
  const db=await setup(t);let calls=0,found;const mailbox={send:async m=>{calls++;found=receipt(m);return found;},findSent:async()=>found};
  await db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON jobs WHEN NEW.status='sent' BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  const options={enabled:true,inboxHealthy:true,recipient,mailbox};await deliverReviewJobs(db,options);assert.equal(await db.prepare('SELECT status FROM jobs').first('status'),'held');
  await db.exec('DROP TRIGGER fail_receipt;');await deliverReviewJobs(db,options);assert.equal(calls,1);assert.equal(await db.prepare('SELECT status FROM jobs').first('status'),'sent');
});
test('a continuing failure reopens a resolved flag and distinguishes safe repair from an uncertain send',async t=>{
  const db=await setup(t);await db.prepare("UPDATE jobs SET payload='{}' WHERE id='message'").run();
  let sends=0;const options={enabled:true,inboxHealthy:true,recipient,mailbox:{send:async()=>{sends++;throw new Error('not confirmed');},findSent:async()=>null}};
  await deliverReviewJobs(db,options);
  assert.equal(JSON.parse(await db.prepare("SELECT payload FROM jobs WHERE id='message:delivery-error'").first('payload')).category,'pending-repair');
  const raw={id:crypto.randomUUID(),name:'resolve_flag',jobId:'message:delivery-error'},p=await previewMessageAction(db,raw,{});
  await executeMessageAction(db,{...raw,reviewHash:p.reviewHash},'chair',{});
  await deliverReviewJobs(db,options);assert.equal(await db.prepare("SELECT status FROM jobs WHERE id='message:delivery-error'").first('status'),'held');assert.equal(sends,0);
  await db.prepare("UPDATE jobs SET payload=? WHERE id='message'").bind(JSON.stringify({subject:'Repaired',body:'Fictional'})).run();
  await deliverReviewJobs(db,options);assert.equal(sends,1);
  assert.equal(JSON.parse(await db.prepare("SELECT payload FROM jobs WHERE id='message:delivery-error'").first('payload')).category,'uncertain-send');
  await deliverReviewJobs(db,options);assert.equal(sends,1);
});
test('an unavailable error-flag save is reported and does not abandon unrelated valid delivery',async t=>{
  const db=await setup(t);await db.prepare("UPDATE jobs SET payload='{}' WHERE id='message'").run();
  await db.prepare("INSERT INTO jobs(id,kind,status,payload,created_at) VALUES('second','application-receipt','pending',?,'2026-05-02')").bind(JSON.stringify({subject:'Fictional',body:'Fictional'})).run();
  await db.exec("CREATE TRIGGER reject_delivery_flag BEFORE INSERT ON jobs WHEN NEW.kind='chair-delivery-error' BEGIN SELECT RAISE(ABORT,'test only'); END;");
  const result=await deliverReviewJobs(db,{enabled:true,inboxHealthy:true,recipient,mailbox:{send:async m=>receipt(m),findSent:async()=>null}});
  assert.deepEqual(result.alertFailures,['message']);assert.equal(result.sent,1);assert.equal(await db.prepare("SELECT status FROM jobs WHERE id='second'").first('status'),'sent');
});
test('Gmail sender is disabled by default and checks the saved reference and recipient',async()=>{
  let sent,calls=0;const urls=[];const generated='<generated-eom@mail.gmail.com>';
  const message={to:recipient,subject:'Fictional check-in',body:'A fictional café conversation.',reference:messageReference('test')};
  const headersFor=(id,reference,rfc)=>({id,internalDate:String(Date.parse(sentAt)),labelIds:['SENT'],payload:{headers:[{name:'Message-ID',value:rfc},{name:'To',value:recipient},{name:'From',value:'Example Chapter Mentorship <program@example.test>'},{name:messageReferenceHeader,value:reference}]}});
  const config={mailbox:'program@example.test',chairEmail:'chair@example.test',clientId:'fake',clientSecret:'fake',refreshToken:'fake',connectionVerified:true,reviewRecipient:recipient,fetcher:async(url,options)=>{
    calls++;urls.push(url);if(url.includes('oauth2'))return Response.json({access_token:'fake'});
    if(url.endsWith('/profile'))return Response.json({emailAddress:'program@example.test'});
    if(url.endsWith('/messages/send')){sent=JSON.parse(options.body);return Response.json({id:'sent'});}
    if(url.includes('/messages?'))return Response.json({messages:[{id:'other'},{id:'sent'}]});
    if(url.includes('/messages/other?'))return Response.json(headersFor('other',messageReference('other'),'<other@mail.gmail.com>'));
    return Response.json(headersFor('sent',message.reference,generated));
  }};
  await assert.rejects(createProgramMailbox(config).send(message));assert.equal(calls,0);
  const mailbox=createProgramMailbox({...config,deliveryVerified:true});await assert.rejects(mailbox.send({...message,to:'someone-else@example.test'}));assert.equal(calls,0);
  const result=await mailbox.send(message);assert.equal(result.id,'sent');assert.equal(result.reference,message.reference);assert.equal(result.rfcMessageId,generated);
  const found=await mailbox.findSent(message);assert.equal(found.id,'sent');assert.equal(found.rfcMessageId,generated);
  assert.equal(urls.some(url=>url.includes('rfc822msgid')),false);
  assert.equal(urls.some(url=>url.includes('/messages?')&&url.includes('in%3Asent')),true);
  const mime=Buffer.from(sent.raw,'base64url').toString(),head=mime.split('\r\n\r\n')[0];
  assert.match(head,/To: reviewer@example.test/);assert.match(head,/^Date: [A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/m);
  assert.ok(head.includes(`Message-ID: ${message.reference}`));assert.ok(head.includes(`${messageReferenceHeader}: ${message.reference}`));
  assert.equal(Buffer.from(mime.split('\r\n\r\n')[1],'base64').toString(),message.body);
});
test('Gmail receipt fails without the internal header, and duplicate header matches are not unique',async()=>{
  const message={to:recipient,subject:'Fictional check-in',body:'Fictional body',reference:messageReference('test')};
  const gmail={id:'sent',internalDate:String(Date.parse(sentAt)),labelIds:['SENT'],payload:{headers:[{name:'Message-ID',value:message.reference},{name:'To',value:recipient},{name:'From',value:'Example Chapter Mentorship <program@example.test>'}]}};
  const config={mailbox:'program@example.test',chairEmail:'chair@example.test',clientId:'fake',clientSecret:'fake',refreshToken:'fake',connectionVerified:true,deliveryVerified:true,reviewRecipient:recipient,fetcher:async url=>{
    if(url.includes('oauth2'))return Response.json({access_token:'fake'});
    if(url.endsWith('/profile'))return Response.json({emailAddress:'program@example.test'});
    if(url.endsWith('/messages/send'))return Response.json({id:'sent'});
    return Response.json(gmail);
  }};
  await assert.rejects(createProgramMailbox(config).send(message));
  const matching={id:'sent',internalDate:String(Date.parse(sentAt)),labelIds:['SENT'],payload:{headers:[{name:'Message-ID',value:'<a@mail.gmail.com>'},{name:'To',value:recipient},{name:'From',value:'Example Chapter Mentorship <program@example.test>'},{name:messageReferenceHeader,value:message.reference}]}};
  const mailbox=createProgramMailbox({...config,fetcher:async url=>{
    if(url.includes('oauth2'))return Response.json({access_token:'fake'});
    if(url.endsWith('/profile'))return Response.json({emailAddress:'program@example.test'});
    if(url.includes('/messages?'))return Response.json({messages:[{id:'one'},{id:'two'}]});
    return Response.json({...matching,id:url.includes('/one?')?'one':'two'});
  }});
  assert.equal(await mailbox.findSent(message),null);
});
async function pair(db){
  for(const role of ['mentee','mentor'])await db.prepare("INSERT INTO applications(id,submission_key,payload_hash,role,answers,terms_version,privacy_version,created_at) VALUES(?,?,?,?,?,'test','test','2026-01-01')").bind(role,role,role,role,JSON.stringify({email:role+'@example.test'})).run();
  await db.exec("INSERT INTO cohorts(name,first_cohort) VALUES('First',1); INSERT INTO pairs(id,mentee_id,mentor_id,group_name,fit_reason,status,mentee_trained,mentor_trained,actual_date,created_at) VALUES('pair','mentee','mentor','First','Test','active',1,1,'2026-01-01','2026-01-01');");
}
test('initial deadline starts at confirmed sending, repeated scheduling preserves the same private link',async t=>{
  const db=await setup(t,'captured');await pair(db);
  const options={inboxHealthy:true,delivery:true,now:'2026-04-01T12:00:00.000Z',renderMessage:(r,phase,token)=>({subject:'Test',body:'Test',link:token})};
  await runFollowups(db,options);const id=await db.prepare("SELECT id FROM requests WHERE role='mentee' AND period=3").first('id');
  const before=await getRequest(db,id);assert.equal(before.sent_at,null);assert.equal(before.deadline,null);
  const original=await db.prepare('SELECT payload FROM jobs WHERE request_id=?').bind(id).first('payload');
  await runFollowups(db,{...options,now:'2026-04-10T12:00:00.000Z'});assert.equal((await getRequest(db,id)).token_hash,before.token_hash);assert.equal(await db.prepare('SELECT payload FROM jobs WHERE request_id=?').bind(id).first('payload'),original);
  await deliverReviewJobs(db,{enabled:true,inboxHealthy:true,recipient,mailbox:{send:async m=>receipt(m),findSent:async()=>null}});
  const after=await getRequest(db,id);assert.equal(after.sent_at,sentAt);assert.equal(after.deadline,'2026-05-22T12:00:00.000Z');
});
test('actual review sender replies update only the referenced request before reminder processing',async t=>{
  const db=await setup(t,'captured');await pair(db);let messages=[],sent=0;
  const mailbox={readMessages:async()=>messages,send:async m=>{sent++;return receipt(m);},findSent:async()=>null};
  const env={DB:db,MODE:'review',SITE_ORIGIN:'https://review.example',PROGRAM_MAILBOX_VERIFIED:'true',REVIEW_DELIVERY_VERIFIED:'true',REVIEW_RECIPIENT:recipient};
  await runReviewSchedule(env,sentAt,{mailboxFactory:()=>mailbox});assert.equal(sent,2);
  const id=await db.prepare("SELECT id FROM requests WHERE role='mentee' AND period=3").first('id');
  messages=[{id:'reply',internalDate:String(Date.parse('2026-05-02T12:00:00.000Z')),labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:recipient},{name:'In-Reply-To',value:messageReference(id+':initial')}],body:{data:Buffer.from(reviewReplies.value).toString('base64url')}}}];
  await runReviewSchedule(env,'2026-05-08T12:00:00.000Z',{mailboxFactory:()=>mailbox});assert.equal((await getRequest(db,id)).answers.meetings,3);assert.equal(sent,3);
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='reminder' AND application_id='mentee'").first('n'),0);
});
test('enabling delivery never mails reminders for earlier capture-only demonstrations',async t=>{
  const db=await setup(t,'captured');await pair(db);
  const options={inboxHealthy:true,now:sentAt,renderMessage:()=>({subject:'Test',body:'Test'})};
  await runFollowups(db,options);await runFollowups(db,{...options,delivery:true,now:'2026-05-15T12:00:00.000Z'});
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='pending'").first('n'),0);
});
