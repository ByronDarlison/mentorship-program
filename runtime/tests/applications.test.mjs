import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {examples} from '../fixtures.mjs';
import {saveApplication, validateApplication} from '../applications.mjs';
import worker from '../worker.mjs';
import policy from '../../website/dist/application-config.json' with {type:'json'};

const config={MODE:'review',CHAIR_EMAIL:'chair@example.test',TERMS_VERSION:policy.termsVersion,PRIVACY_VERSION:policy.privacyVersion,COPY:policy.copy};
const make=(role='mentee')=>({role,submissionKey:crypto.randomUUID(),answers:{...examples[role]},acknowledgement:true,termsVersion:config.TERMS_VERSION,privacyVersion:config.PRIVACY_VERSION});
async function database(t){
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default { fetch(){return new Response("test")} }',d1Databases:['DB']}));
  t.after(()=>mf.dispose()); const db=await mf.getD1Database('DB');
  const schema=await readFile(new URL('../migrations/0001_applications.sql',import.meta.url),'utf8');
  await db.exec(schema.replaceAll('\n',' ')); return db;
}
async function counts(db){return Promise.all(['applications','jobs','activity'].map(name=>db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).first('n')));}

test('both real save paths store one application, two captured messages and one activity event',async t=>{
  const db=await database(t);
  for(const role of ['mentee','mentor']){
    const input=make(role);const result=await saveApplication(db,input,config);
    assert.equal(result.saved,true); assert.equal(result.emailSent,false);
    const row=await db.prepare('SELECT * FROM applications WHERE id=?').bind(result.reference).first();
    assert.deepEqual(JSON.parse(row.answers),input.answers);assert.equal(row.terms_version,input.termsVersion);
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM jobs WHERE application_id=? AND status='captured'").bind(row.id).first('n'),2);
  }
  assert.deepEqual(await counts(db),[2,4,2]);
});
test('verified review delivery queues new receipts once and never promotes old captures',async t=>{
  const db=await database(t),old=make();await saveApplication(db,old,config);
  const connected={...config,PROGRAM_MAILBOX_VERIFIED:'true',REVIEW_DELIVERY_VERIFIED:'true'};
  await saveApplication(db,old,connected);
  const input=make('mentor');await Promise.all([saveApplication(db,input,connected),saveApplication(db,input,connected)]);
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='captured'").first('n'),2);
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='pending'").first('n'),2);
  const chair=JSON.parse(await db.prepare("SELECT payload FROM jobs WHERE status='pending' AND kind='chair-application'").first('payload'));
  assert.ok(chair.text.includes(examples.mentor.name));assert.match(chair.text,/mentor/);
});
test('concurrent retries and retry after losing the response produce a single complete save',async t=>{
  const db=await database(t), input=make();
  const results=await Promise.all(Array.from({length:6},()=>saveApplication(db,input,config)));
  assert.equal(new Set(results.map(r=>r.reference)).size,1);
  const retry=await saveApplication(db,input,config);assert.equal(retry.reference,results[0].reference);
  assert.deepEqual(await counts(db),[1,2,1]);
});
test('valid different payload on an existing key conflicts without modifying stored records',async t=>{
  const db=await database(t), first=make(); await saveApplication(db,first,config);
  const changed={...make('mentor'),submissionKey:first.submissionKey};
  await assert.rejects(saveApplication(db,changed,config),e=>e.status===409);
  assert.deepEqual(await counts(db),[1,2,1]);
  assert.equal(await db.prepare('SELECT role FROM applications').first('role'),'mentee');
});
test('middle-batch failure rolls back application, messages and activity together',async t=>{
  const db=await database(t);
  await db.exec("CREATE TRIGGER fail_chair BEFORE INSERT ON jobs WHEN NEW.kind='chair-application' BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  await assert.rejects(saveApplication(db,make(),config));assert.deepEqual(await counts(db),[0,0,0]);
});
test('invalid, arbitrary, extra and stale inputs never reach storage',async t=>{
  const db=await database(t);
  const cases=[{role:'__proto__'},{role:'other'},{submissionKey:'a name'},{acknowledgement:false},{termsVersion:'old'},{privacyVersion:'old'},{extra:'private'}];
  for(const patch of cases)await assert.rejects(saveApplication(db,{...make(),...patch},config));
  for(const patch of [{name:'Real Applicant'},{email:'someone@example.com'},{business:'changed'},{'linkedin-url':'https://linkedin.com/in/someone'},{extra:'private'},{challenge:''}])await assert.rejects(saveApplication(db,{...make(),answers:{...examples.mentee,...patch}},config));
  assert.throws(()=>validateApplication(make(),{...config,MODE:'live'}));
  assert.deepEqual(await counts(db),[0,0,0]);
});
test('HTTP entry validates requests and exposes neither application lookup nor stored fields',async t=>{
  const db=await database(t), env={...config,DB:db};
  const call=(body,headers={})=>worker.fetch(new Request('https://review.example/api/applications',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}),env);
  const response=await call(make());assert.equal(response.status,200);const result=await response.json();
  assert.deepEqual(Object.keys(result).sort(),['emailSent','mode','reference','saved']);
  assert.equal((await call(make(),{Origin:'https://elsewhere.example'})).status,403);
  assert.equal((await call({padding:'x'.repeat(41000)})).status,413);
  assert.equal((await worker.fetch(new Request('https://review.example/api/applications'),env)).status,405);
  assert.equal((await worker.fetch(new Request('https://review.example/api/applications/'+result.reference),env)).status,404);
  assert.deepEqual(await counts(db),[1,2,1]);
});
