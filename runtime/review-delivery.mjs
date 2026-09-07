import {InputError} from './applications.mjs';
import {addDays} from './feedback.mjs';
import {messageReference} from './email-replies.mjs';

// Review delivery has one explicitly selected test recipient. Captured
// demonstrations are never promoted to pending mail or sent retrospectively.
const supported=new Set(['application-receipt','chair-application','request','reminder','chair-approved-message','chair-notification']);
const email=value=>typeof value==='string'&&/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value);
export function deliveryMessage(job,recipient){
  const payload=JSON.parse(job.payload),subject=payload.subject,body=payload.body??payload.text;
  const to=recipient??payload.to;
  if(!email(to)||!supported.has(job.kind))throw new InputError('Message needs a valid recipient and supported template.');
  if(typeof subject!=='string'||!subject.trim()||subject.length>250||/[\r\n]/.test(subject)||typeof body!=='string'||!body.trim()||body.length>20000)throw new InputError('Review message is incomplete.');
  return {to,subject,body,reference:messageReference(job.id)};
}
function receiptValid(receipt,message){
  return typeof receipt?.id==='string'&&receipt.id.length>0&&receipt.id.length<=200&&
    receipt.reference===message.reference&&typeof receipt.rfcMessageId==='string'&&receipt.rfcMessageId.length>2&&receipt.rfcMessageId.length<=300&&
    /^<[^<>\s]+@[^<>\s]+>$/.test(receipt.rfcMessageId)&&receipt.to?.toLowerCase()===message.to.toLowerCase()&&
    typeof receipt.sentAt==='string'&&Number.isFinite(Date.parse(receipt.sentAt));
}
async function recordDelivery(db,job,receipt){
  const sentAt=new Date(receipt.sentAt).toISOString();
  const writes=[db.prepare("UPDATE jobs SET status='sent',sent_at=?,provider_id=?,rfc_message_id=? WHERE id=? AND status IN ('sending','held')")
    .bind(sentAt,receipt.id,receipt.rfcMessageId,job.id),db.prepare("UPDATE jobs SET status='cancelled' WHERE id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='sent')").bind(job.id+':delivery-error',job.id)];
  if(job.kind==='request'&&job.request_id)writes.push(db.prepare("UPDATE requests SET sent_at=?,deadline=?,version=version+1 WHERE id=? AND sent_at IS NULL AND superseded=0 AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='sent' AND provider_id=?)")
    .bind(sentAt,addDays(sentAt,21),job.request_id,job.id,receipt.id));
  await db.batch(writes);
}
export async function deliverReviewJobs(db,{enabled=false,inboxHealthy=false,recipient,mailbox,reconcileOnly=false,mode='review',chairEmail}={}){
  if(!enabled)return {enabled:false,sent:0,held:[]};
  if(!['review','operating'].includes(mode)||(mode==='review'?!email(recipient):!email(chairEmail))||typeof mailbox?.send!=='function'||typeof mailbox?.findSent!=='function')throw new InputError('Configure verified delivery before enabling it.');
  if(!inboxHealthy)return {enabled:true,sent:0,held:[],paused:true};
  const rows=(await db.prepare("SELECT * FROM jobs WHERE status IN ('pending','sending','held') ORDER BY created_at,id").all()).results;
  const held=[],alertFailures=[];let sent=0;
  for(const job of rows){
    // Chair flags are work items, not outgoing participant messages.
    if(!supported.has(job.kind))continue;
    if(reconcileOnly&&job.status==='pending')continue;
    let claimed=false;
    try{
      let to=recipient;
      if(mode==='operating'){
        if(['chair-application','chair-notification'].includes(job.kind))to=chairEmail;
        else {
          const person=await db.prepare('SELECT answers,retention,details_removed_at FROM applications WHERE id=?').bind(job.application_id).first();
          if(!person||person.retention==='delete-requested'||person.details_removed_at)throw new InputError('The recipient is no longer available.');
          to=JSON.parse(person.answers).email;
          if(job.kind==='chair-approved-message'&&JSON.parse(job.payload).to!==to)throw new InputError('The approved recipient changed. Review a new message.');
        }
      }
      const message=deliveryMessage(job,to);
      if(job.kind==='chair-notification'&&job.status==='pending'){
        const flag=await db.prepare('SELECT status FROM jobs WHERE id=?').bind(JSON.parse(job.payload).flagId??'').first();
        if(!flag||flag.status==='cancelled'){
          await db.prepare("UPDATE jobs SET status='cancelled' WHERE id=? AND status='pending'").bind(job.id).run();continue;
        }
      }
      if(job.request_id&&['request','reminder'].includes(job.kind)){
        const request=await db.prepare('SELECT superseded,replied_at FROM requests WHERE id=?').bind(job.request_id).first();
        if((!request||request.superseded||(job.kind==='reminder'&&request.replied_at))&&job.status==='pending'){
          await db.prepare("UPDATE jobs SET status='cancelled' WHERE id=? AND status='pending'").bind(job.id).run();continue;
        }
      }
      if(job.status!=='pending'){
        // A missing search result is not proof that the send failed. Never
        // retry an uncertain delivery automatically, including after restart.
        const found=await mailbox.findSent(message);
        if(receiptValid(found,message)){await recordDelivery(db,job,found);sent++;}
        else {await db.prepare("UPDATE jobs SET status='held' WHERE id=? AND status='sending'").bind(job.id).run();held.push(job.id);}
        continue;
      }
      claimed=await db.prepare("UPDATE jobs SET status='sending' WHERE id=? AND status='pending' RETURNING id").bind(job.id).first();
      if(!claimed)continue;
      const receipt=await mailbox.send(message);
      if(!receiptValid(receipt,message))throw new Error('Delivery not confirmed.');
      await recordDelivery(db,job,receipt);sent++;
    }catch{
      // Keep only safe status. Provider errors may contain message or account data.
      if(claimed||job.status!=='pending')await db.prepare("UPDATE jobs SET status='held' WHERE id=? AND status='sending'").bind(job.id).run();
      // A validation/read failure before claiming cannot have sent anything.
      // Leave that job pending so an ordinary repair can resume it. Record a
      // separate visible flag without storing provider errors or message text.
      try{
        const category=claimed||job.status!=='pending'?'uncertain-send':'pending-repair';
        await db.prepare("INSERT INTO jobs(id,application_id,request_id,kind,status,payload,created_at) VALUES(?,?,?,'chair-delivery-error','held',?,?) ON CONFLICT(id) DO UPDATE SET status='held',payload=excluded.payload")
          .bind(job.id+':delivery-error',job.application_id,job.request_id,JSON.stringify({jobId:job.id,category}),new Date().toISOString()).run();
      }catch{alertFailures.push(job.id);}
      held.push(job.id);
    }
  }
  return {enabled:true,sent,held,alertFailures};
}
