import {InputError,sha256} from './applications.mjs';
import {deliveryMessage} from './review-delivery.mjs';

const fail=message=>{throw new InputError(message,409);};
const flagKinds=new Set(['chair-review','chair-meeting-review','chair-processing-error','chair-deadline','chair-mailbox-error','chair-email-review','chair-delivery-error']);
const hash=value=>sha256(JSON.stringify(value));
async function proposal(db,action,env){
  if(action.name==='message'){
    if(Object.keys(action).some(k=>!['id','name','applicationId','version','subject','body','reviewHash'].includes(k)))fail('Unexpected message field.');
    const person=await db.prepare('SELECT * FROM applications WHERE id=?').bind(action.applicationId??'').first();
    if(!person||person.version!==action.version||person.retention==='delete-requested'||person.details_removed_at)fail('Review the current participant before preparing a message. Completed minimal records cannot receive new message copies.');
    const enabled=env.PROGRAM_MAILBOX_VERIFIED==='true'&&env.REVIEW_DELIVERY_VERIFIED==='true';
    const recipient=enabled?(env.MODE==='operating'?JSON.parse(person.answers).email:env.REVIEW_RECIPIENT):'capture-only@example.test';
    const message=deliveryMessage({id:action.id,kind:'chair-approved-message',payload:JSON.stringify({subject:action.subject,body:action.body})},recipient);
    return {name:action.name,applicationId:person.id,version:person.version,participant:JSON.parse(person.answers).name,role:person.role,subject:message.subject,body:message.body,recipient:enabled?recipient:null,status:enabled?'pending':'captured'};
  }
  if(action.name==='resolve_flag'){
    if(Object.keys(action).some(k=>!['id','name','jobId','reviewHash'].includes(k)))fail('Unexpected resolution field.');
    const job=await db.prepare('SELECT * FROM jobs WHERE id=?').bind(action.jobId??'').first();
    if(!job||!flagKinds.has(job.kind)||!['captured','held','pending'].includes(job.status))fail('Choose an unresolved Chair flag. An uncertain outgoing send cannot be cleared or retried here.');
    return {name:action.name,jobId:job.id,applicationId:job.application_id,kind:job.kind,status:job.status,details:JSON.parse(job.payload)};
  }
  fail('Choose a message or a handled follow-up flag.');
}
export async function previewMessageAction(db,action,env){
  if(!action||typeof action.id!=='string'||!action.id||action.id.length>200)fail('Action ID required.');
  const preview=await proposal(db,action,env);
  return {...preview,reviewHash:await hash(preview)};
}
export async function executeMessageAction(db,action,actor,env,now=new Date().toISOString()){
  if(!actor||!action||typeof action.reviewHash!=='string')fail('Review this action before confirming.');
  const payloadHash=await hash(Object.fromEntries(Object.entries(action).sort(([a],[b])=>a.localeCompare(b))));
  const prior=await db.prepare('SELECT * FROM chair_actions WHERE id=?').bind(action.id??'').first();
  if(prior){if(prior.actor!==actor||prior.payload_hash!==payloadHash)fail('Action ID already used.');return JSON.parse(prior.result);}
  const p=await previewMessageAction(db,action,env);
  if(p.reviewHash!==action.reviewHash)fail('The proposed message or flag changed. Review it again.');
  const execution=crypto.randomUUID(),gate='EXISTS(SELECT 1 FROM chair_actions WHERE execution_id=?)';
  let guard,bindings,result,write,subjects=[p.applicationId].filter(Boolean);
  if(p.name==='message'){
    const jobId=action.id+':message';subjects.push(jobId);
    guard="EXISTS(SELECT 1 FROM applications WHERE id=? AND version=? AND retention!='delete-requested' AND details_removed_at IS NULL)";bindings=[p.applicationId,p.version];
    result={jobId,status:p.status,recipient:p.recipient,emailSent:false};
    write=db.prepare(`INSERT INTO jobs(id,application_id,kind,status,payload,created_at) SELECT ?,?,'chair-approved-message',?,?,? WHERE ${gate}`).bind(jobId,p.applicationId,p.status,JSON.stringify({to:p.recipient,subject:p.subject,body:p.body}),now,execution);
  }else{
    const current=await db.prepare('SELECT * FROM jobs WHERE id=?').bind(p.jobId).first();
    if(!current)fail('Flag no longer exists. Review the current records.');
    subjects.push(p.jobId);
    guard='EXISTS(SELECT 1 FROM jobs WHERE id=? AND status=? AND payload=?)';bindings=[p.jobId,p.status,current.payload];
    // If content changed between the preview read and this read, do not let
    // the newer value become the transaction guard for an older approval.
    if(await hash(JSON.parse(current.payload))!==await hash(p.details))fail('Flag changed. Review it again.');
    result={jobId:p.jobId,resolved:true};
    write=db.prepare(`UPDATE jobs SET status='cancelled' WHERE id=? AND ${gate}`).bind(p.jobId,execution);
  }
  const saved=await db.batch([
    db.prepare(`INSERT OR IGNORE INTO chair_actions(id,payload_hash,execution_id,actor,action,subjects,result,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`).bind(action.id,payloadHash,execution,actor,p.name,JSON.stringify(subjects),JSON.stringify(result),now,...bindings),
    write,db.prepare('SELECT payload_hash,actor,result FROM chair_actions WHERE id=?').bind(action.id)
  ]);
  const receipt=saved.at(-1).results[0];
  if(!receipt||receipt.actor!==actor||receipt.payload_hash!==payloadHash)fail('Record changed. Review this action again.');
  return JSON.parse(receipt.result);
}
