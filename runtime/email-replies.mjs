import {InputError} from './applications.mjs';
import {getRequest,receiveFeedback,receiveFirstMeeting} from './followups.mjs';
import {reviewFeedback,reviewLowValue,validateFeedback} from './feedback.mjs';

// The same reference is used by the sending adapter and incoming reply lookup.
// It identifies one delivery job, not an approval or a private form credential.
export const messageReference=id=>`<eom.${btoa(id).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')}@mentorship.invalid>`;
function referenceJob(ref){
  const token=ref?.match(/^<eom\.([A-Za-z0-9_-]+)@mentorship\.invalid>$/)?.[1];
  if(!token)return null;
  try{return atob(token.replaceAll('-','+').replaceAll('_','/'));}catch{return null;}
}
async function jobForReply(db,ref){
  const value=ref?.trim();
  if(!value)return null;
  const byRfc=await db.prepare("SELECT * FROM jobs WHERE rfc_message_id=? AND kind IN ('request','reminder') AND status='sent'").bind(value).first();
  if(byRfc)return byRfc;
  const jobId=referenceJob(value);
  if(!jobId)return null;
  return db.prepare("SELECT * FROM jobs WHERE id=? AND kind IN ('request','reminder') AND status IN ('captured','sent')").bind(jobId).first();
}
const address=value=>{
  const text=value?.trim()??'',match=text.match(/^(?:[^<>]*<)?([^\s<>,;]+@[^\s<>,;]+)>?$/);
  return match?match[1].toLowerCase():null;
};
export function currentReplyText(text){
  // Conservative plain-text boundary. No attachment or HTML is sent to AI.
  const lines=text.replaceAll('\r\n','\n').split('\n'),kept=[];
  for(const [index,line] of lines.entries()){
    if(/^On\s/i.test(line)&&lines.slice(index,index+3).some(part=>/wrote:\s*$/i.test(part)))break;
    if(/^\s*>/.test(line)||/^On .+wrote:\s*$/i.test(line)||/^\s*-{2,}\s*(Original Message|Forwarded message)/i.test(line)||/^From:\s/i.test(line)||line==='-- ')break;
    kept.push(line);
  }
  return kept.join('\n').trim();
}
export function normalizeGmailMessage(message){
  const headers=new Map();
  for(const h of message.payload?.headers??[]){const key=h.name.toLowerCase();if(headers.has(key)&&['from','in-reply-to','auto-submitted'].includes(key))throw new InputError('Ambiguous message headers.');headers.set(key,h.value);}
  let body=null;
  function visit(part){
    if(part.filename)return;
    if(part.mimeType==='text/plain'&&part.body?.data){
      if(body!==null)throw new InputError('Ambiguous plain-text message.');
      const data=part.body.data;if(data.length>50000)throw new InputError('Message needs manual review.');
      body=new TextDecoder().decode(Uint8Array.from(atob(data.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0)));
    }
    for(const child of part.parts??[])visit(child);
  }
  visit(message.payload??{});
  const automated=(headers.has('auto-submitted')&&headers.get('auto-submitted').toLowerCase()!=='no')||headers.has('x-autoreply')||headers.has('x-autorespond')||/multipart\/report/i.test(message.payload?.mimeType??'')||/mailer-daemon|postmaster/i.test(headers.get('from')??'');
  const receivedAt=new Date(Number(message.internalDate)).toISOString();
  return {id:message.id,from:address(headers.get('from')),reference:headers.get('in-reply-to')?.trim(),receivedAt,
    automatic:automated,excluded:(message.labelIds??[]).some(l=>['SENT','DRAFT','SPAM','TRASH'].includes(l)),
    text:body===null?null:currentReplyText(body)};
}

export const reviewReplies=Object.freeze({
  planned:'Yes, we met as planned.',
  rescheduled:'We have moved our first meeting to 2026-10-15.',
  dateOnly:'2026-10-15',
  notHappened:'No, it did not happen. We have not chosen another date.',
  acknowledgement:'Thanks, I will respond later.',
  value:`We met 3 times. ${reviewFeedback.value} No need to contact me.`,
  support:`Please contact me. ${reviewLowValue}`
});
export function interpretReviewReply(text,request,plannedDate){
  // Demonstration fixtures only, not a claim of actual AI interpretation.
  if(request.kind==='first'){
    if(text===reviewReplies.planned)return {outcome:'happened',date:plannedDate};
    if(text===reviewReplies.rescheduled)return {outcome:'rescheduled',date:'2026-10-15'};
    if(text===reviewReplies.notHappened)return {outcome:'not-happened'};
    return {outcome:'unclear',needsChair:true};
  }
  if(text===reviewReplies.value)return {answers:{meetings:3,value:reviewFeedback.value,contact:false}};
  if(text===reviewReplies.support)return {answers:{value:reviewLowValue,contact:true},needsChair:true};
  return {answers:{},needsChair:true};
}
async function flag(db,message,request,reason){
  await db.prepare("INSERT OR IGNORE INTO jobs(id,application_id,request_id,kind,status,payload,created_at) VALUES(?,?,?,'chair-email-review','captured',?,?)")
    .bind('email:'+message.id+':review',request?.application_id??null,request?.id??null,JSON.stringify({messageId:message.id,reason}),message.receivedAt).run();
}
export async function receiveReviewEmail(db,raw,{interpret=interpretReviewReply,classify,reviewRecipient,fixturesOnly=true}={}){
  let m;
  try{m=normalizeGmailMessage(raw);}catch{
    // No raw contents or provider errors are retained in the failure notice.
    m={id:raw.id,receivedAt:new Date().toISOString()};await flag(db,m,null,'Message format needs Chair review.');return {chairReview:true};
  }
  if(!m.id||m.id.length>150)throw new InputError('Invalid mailbox message.');
  if(m.excluded||m.automatic)return {ignored:true};
  const prior=await db.prepare('SELECT result FROM received_responses WHERE id=?').bind('email:'+m.id).first();
  if(prior)return JSON.parse(prior.result);
  const job=await jobForReply(db,m.reference);
  const request=job?.request_id?await getRequest(db,job.request_id):null;
  const application=request?await db.prepare('SELECT answers FROM applications WHERE id=?').bind(request.application_id).first():null;
  const expectedSender=reviewRecipient&&job?.status==='sent'?address(reviewRecipient):application?address(JSON.parse(application.answers).email):null;
  if(!request||!application||request.superseded||expectedSender!==m.from||!m.from){await flag(db,m,null,'Could not match this sender and original request.');return {chairReview:true};}
  const pair=await db.prepare('SELECT planned_date FROM pairs WHERE id=?').bind(request.pair_id).first();
  // Only explicitly supplied invented text can leave this review boundary.
  // Unknown text is not copied to the model or records. It stays in the mailbox.
  const permitted=fixturesOnly?Object.values(reviewReplies).includes(m.text):typeof m.text==='string'&&Boolean(m.text.trim())&&m.text.length<=6000;
  let interpreted;
  try{interpreted=permitted?await interpret(m.text,request,pair?.planned_date,JSON.parse(application.answers)):null;}catch{/* Preserve genuine reply, send exception to Chair. */}
  if(!permitted||!interpreted||interpreted.needsChair)await flag(db,m,request,'Reply needs Chair review. Any missing answers remain outstanding.');
  let result;
  if(request.kind==='first'){
    const outcome=['happened','rescheduled','not-happened','unclear'].includes(interpreted?.outcome)?interpreted.outcome:'unclear';
    try{result=await receiveFirstMeeting(db,{id:'email:'+m.id,requestId:request.id,outcome,date:interpreted?.date??null,receivedAt:m.receivedAt});}
    catch(error){if(error instanceof InputError){
      // Invalid interpretation is still a genuine reply. Stop only this
      // confirmation's no-response reminders, but never invent attendance.
      try{result=await receiveFirstMeeting(db,{id:'email:'+m.id,requestId:request.id,outcome:'unclear',receivedAt:m.receivedAt});}catch(fallbackError){
        if(!(fallbackError instanceof InputError))throw fallbackError;
        await flag(db,m,request,'Meeting reply needs Chair review.');return {chairReview:true};
      }
      interpreted=null;
    }else throw error;}
  }else{
    let answers={};
    try{
      answers=validateFeedback(request,interpreted?.answers??{});
      if(fixturesOnly)for(const [field,value] of Object.entries(answers))if(!['meetings','contact'].includes(field)&&value!==reviewFeedback[field]&&!(field==='value'&&value===reviewLowValue))throw new InputError('Unsupported review answer.');
    }catch{answers={};interpreted=null;await flag(db,m,request,'Reply interpretation needs Chair review.');}
    result=await receiveFeedback(db,{id:'email:'+m.id,requestId:request.id,answers,receivedAt:m.receivedAt,source:'verified-email'},classify);
  }
  return result;
}

export async function synchronizeReviewEmail(db,messages,options){
  const failures=[];let processed=0;
  // Oldest first, using provider receipt time, not processing time.
  for(const message of [...messages].sort((a,b)=>Number(a.internalDate)-Number(b.internalDate))){
    try{await receiveReviewEmail(db,message,options);processed++;}catch{failures.push(message.id);}
  }
  return {healthy:failures.length===0,processed,failures};
}
