import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {queueChairNotifications} from '../chair-notifications.mjs';
import {deliverReviewJobs} from '../review-delivery.mjs';
async function setup(t){
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']}));t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
  for(const file of ['0001_applications','0002_administration','0003_followups','0004_deletion','0005_reporting_totals','0006_final_review'])await db.exec((await readFile(new URL('../migrations/'+file+'.sql',import.meta.url),'utf8')).replaceAll('\n',' '));
  await db.exec((await readFile(new URL('../migrations/0007_mail_receipt.sql',import.meta.url),'utf8')).replaceAll('\n',' '));
  await db.exec(`INSERT INTO applications(id,submission_key,payload_hash,role,answers,terms_version,privacy_version,created_at) VALUES('person','fixture','fixture','mentee','{"name":"Alex Example"}','test','test','2026-01-01');
    INSERT INTO jobs(id,application_id,kind,status,payload,created_at) VALUES('support','person','chair-review','captured','{"private":"Do not copy raw content"}','2026-01-01');`);
  return db;
}
test('Chair notices are deduplicated and do not copy feedback into email',async t=>{
  const db=await setup(t);await Promise.all([queueChairNotifications(db),queueChairNotifications(db)]);
  const notice=await db.prepare("SELECT * FROM jobs WHERE id='support:notice'").first();assert.equal(notice.status,'captured');assert.match(notice.payload,/Alex Example/);assert.doesNotMatch(notice.payload,/Do not copy raw content/);
  await queueChairNotifications(db,{delivery:true});assert.equal(await db.prepare("SELECT status FROM jobs WHERE id='support:notice'").first('status'),'captured');
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='chair-notification'").first('n'),1);
});
test('connected notice uses one verified review recipient and leaves the source flag open',async t=>{
  const db=await setup(t);await queueChairNotifications(db,{delivery:true});let calls=0;
  const mailbox={send:async m=>{calls++;assert.equal(m.to,'review@example.test');return {id:'provider',reference:m.reference,rfcMessageId:'<notice@mail.gmail.com>',to:m.to,sentAt:'2026-01-02T00:00:00.000Z'};},findSent:async()=>null};
  const run=()=>deliverReviewJobs(db,{enabled:true,inboxHealthy:true,recipient:'review@example.test',mailbox});await run();await run();assert.equal(calls,1);
  assert.equal(await db.prepare("SELECT status FROM jobs WHERE id='support'").first('status'),'captured');
});
test('resolved source flags cancel unsent notices without delivery',async t=>{
  const db=await setup(t);await queueChairNotifications(db,{delivery:true});await db.prepare("UPDATE jobs SET status='cancelled' WHERE id='support'").run();
  await deliverReviewJobs(db,{enabled:true,inboxHealthy:true,recipient:'review@example.test',mailbox:{send:()=>{throw new Error('Must not send');},findSent:async()=>null}});
  assert.equal(await db.prepare("SELECT status FROM jobs WHERE id='support:notice'").first('status'),'cancelled');
});
test('reviewed people and technical mailbox flags do not create routine notices',async t=>{
  const db=await setup(t);await db.prepare("UPDATE applications SET details_removed_at='2026-01-02' WHERE id='person'").run();
  await db.exec("INSERT INTO jobs(id,kind,status,payload,created_at) VALUES('mail','chair-mailbox-error','held','{}','2026-01-01');");
  assert.equal((await queueChairNotifications(db,{delivery:true})).queued,0);
});
