import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {previewMessageAction,executeMessageAction} from '../message-actions.mjs';
import {signOperatorRequest,handleOperatorRequest} from '../operator-api.mjs';
async function setup(t){
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB']}));t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
  for(const file of ['0001_applications.sql','0002_administration.sql','0003_followups.sql','0004_deletion.sql','0005_reporting_totals.sql','0006_final_review.sql','0007_mail_receipt.sql'])await db.exec((await readFile(new URL('../migrations/'+file,import.meta.url),'utf8')).replaceAll('\n',' '));
  await db.prepare("INSERT INTO applications(id,submission_key,payload_hash,role,answers,terms_version,privacy_version,created_at) VALUES('fictional','fictional','fictional','mentee',?,'test','test','2026-01-01')").bind(JSON.stringify({name:'Alex Example',email:'alex@example.test'})).run();return db;
}
const message=()=>({id:crypto.randomUUID(),name:'message',applicationId:'fictional',version:1,subject:'A fictional introduction',body:'Please meet to discuss the fictional program.'});
const connected={PROGRAM_MAILBOX_VERIFIED:'true',REVIEW_DELIVERY_VERIFIED:'true',REVIEW_RECIPIENT:'reviewer@example.test'};
async function reviewed(db,action,env={}){return {...action,reviewHash:(await previewMessageAction(db,action,env)).reviewHash};}
test('one confirmed message creates one captured job with no external effect, even on concurrent retry',async t=>{
  const db=await setup(t),action=await reviewed(db,message());
  const results=await Promise.all([executeMessageAction(db,action,'chair',{}),executeMessageAction(db,action,'chair',{})]);
  assert.deepEqual(results[0],results[1]);assert.equal(results[0].emailSent,false);assert.equal(results[0].status,'captured');
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM jobs').first('n'),1);
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM chair_actions').first('n'),1);
  await assert.rejects(executeMessageAction(db,{...action,body:'Changed'},'chair',{}));
});
test('message preview names the person and actual review destination and rejects changed settings or records',async t=>{
  const db=await setup(t),raw=message(),preview=await previewMessageAction(db,raw,connected),action={...raw,reviewHash:preview.reviewHash};
  assert.equal(preview.participant,'Alex Example');assert.equal(preview.recipient,connected.REVIEW_RECIPIENT);assert.equal(preview.subject,raw.subject);assert.equal(preview.body,raw.body);
  await assert.rejects(executeMessageAction(db,action,'chair',{...connected,REVIEW_RECIPIENT:'changed@example.test'}));
  await db.prepare("UPDATE applications SET version=2").run();await assert.rejects(executeMessageAction(db,action,'chair',connected));
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM jobs').first('n'),0);
});
test('verified review messages queue once but no supplied recipient or extra fields are allowed',async t=>{
  const db=await setup(t),raw=message();
  await assert.rejects(previewMessageAction(db,{...raw,to:'someone@example.test'},connected));
  await assert.rejects(previewMessageAction(db,{...raw,subject:'Test\nBcc: x'},connected));
  const saved=await executeMessageAction(db,await reviewed(db,raw,connected),'chair',connected);assert.equal(saved.status,'pending');assert.equal(saved.recipient,connected.REVIEW_RECIPIENT);
});
test('resolving a flag preserves answers and delivery records, rejects stale content, and deduplicates',async t=>{
  const db=await setup(t);await db.exec("INSERT INTO jobs(id,application_id,kind,status,payload,created_at) VALUES('flag','fictional','chair-review','captured','{\"contact\":true}','2026-01-01');");
  const raw={id:crypto.randomUUID(),name:'resolve_flag',jobId:'flag'},stale=await reviewed(db,raw);
  await db.prepare("UPDATE jobs SET payload='{\"contact\":false}' WHERE id='flag'").run();await assert.rejects(executeMessageAction(db,stale,'chair',{}));
  const action=await reviewed(db,raw);await executeMessageAction(db,action,'chair',{});await executeMessageAction(db,action,'chair',{});
  assert.equal(await db.prepare("SELECT status FROM jobs WHERE id='flag'").first('status'),'cancelled');assert.equal(await db.prepare('SELECT COUNT(*) n FROM chair_actions').first('n'),1);
  await db.exec("INSERT INTO jobs(id,kind,status,payload,created_at) VALUES('uncertain','request','held','{}','2026-01-01');");
  await assert.rejects(previewMessageAction(db,{...raw,jobId:'uncertain'},{}));
});
test('storage failure rolls back the approved action and its message',async t=>{
  const db=await setup(t),action=await reviewed(db,message());
  await db.exec("CREATE TRIGGER reject_message BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'test only'); END;");
  await assert.rejects(executeMessageAction(db,action,'chair',{}));assert.equal(await db.prepare('SELECT COUNT(*) n FROM chair_actions').first('n'),0);
});
test('message preview is authenticated and consequential execution stays disabled',async t=>{
  const db=await setup(t),env={MODE:'review',OPERATOR_ID:'fixture',OPERATOR_BRIDGE_SECRET:'fictional'},params=message();
  const call=async op=>handleOperatorRequest(db,await signOperatorRequest(op,params,env.OPERATOR_ID,env.OPERATOR_BRIDGE_SECRET),env);
  assert.equal((await call('message_preview')).participant,'Alex Example');await assert.rejects(call('message_action'),e=>e.status===403);
});
test('a completed minimal record cannot accumulate a new message or bypass cleanup with an old preview',async t=>{
  const db=await setup(t),raw=message(),action=await reviewed(db,raw,connected);
  await db.prepare("UPDATE applications SET details_removed_at='2026-06-01',version=2").run();
  await assert.rejects(executeMessageAction(db,action,'chair',connected));
  await assert.rejects(previewMessageAction(db,{...raw,version:2},connected));
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM jobs').first('n'),0);
});
