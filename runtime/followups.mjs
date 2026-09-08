import {InputError,sha256} from './applications.mjs';
import {foldFinishedOutcomes} from './outcome-storage.mjs';
import {checkInHistory} from './check-in-history.mjs';
import {addDays,addMonths,validateFeedback,feedbackStatus,classifyReview,validateInterpretation} from './feedback.mjs';
const jsonColumns=['answers','answer_times','classifications','conditions','failure_history'];
export function decodeRequest(row){if(!row)return null;return {...row,...Object.fromEntries(jsonColumns.map(k=>[k,JSON.parse(row[k])]))};}
export async function getRequest(db,id){return decodeRequest(await db.prepare('SELECT * FROM requests WHERE id=?').bind(id).first());}
export async function inspectFollowups(db,now=new Date().toISOString()){
  const [requests,jobs]=await db.batch([
    db.prepare('SELECT * FROM requests ORDER BY scheduled_for,id'),
    db.prepare('SELECT id,application_id,request_id,kind,status,created_at,sent_at FROM jobs ORDER BY created_at,id')
  ]);
  return {requests:requests.results.map(row=>{
    const {token_hash,last_mutation,...r}=decodeRequest(row);
    return {...r,...(r.kind==='first'||r.reviewed_at?{}:{completion:feedbackStatus(r,now)}),...(r.reviewed_at?{wordingRemoved:true}:{})};
  }),jobs:jobs.results};
}
const conflict=()=>{throw new InputError('The record changed. Please try again.',409);};

// A request mutation and its generated work commit together. The nonce prevents
// a losing concurrent writer from creating jobs against someone else's update.
async function saveRequest(db,old,next,extras=[],responseId=null,pairVersion=null){
  const nonce=crypto.randomUUID(),gate='EXISTS(SELECT 1 FROM requests WHERE id=? AND last_mutation=?)';
  const columns=[...jsonColumns,'sent_at','deadline','replied_at','superseded','token_hash'];
  const result=await db.batch([
    db.prepare(`UPDATE requests SET ${columns.map(k=>k+'=?').join(',')},version=version+1,last_mutation=? WHERE id=? AND version=? AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM received_responses WHERE id=?)) AND (? IS NULL OR EXISTS(SELECT 1 FROM pairs WHERE id=? AND version=?))`)
      .bind(...columns.map(k=>jsonColumns.includes(k)?JSON.stringify(next[k]):next[k]??null),nonce,old.id,old.version,responseId,responseId,pairVersion,old.pair_id,pairVersion),
    ...extras.map(f=>f(gate,[old.id,nonce])),
    db.prepare('SELECT last_mutation FROM requests WHERE id=?').bind(old.id)
  ]);
  return result.at(-1).results[0]?.last_mutation===nonce;
}
const queue=(db,id,request,kind,payload,now,status='captured')=>(gate,args)=>db.prepare(`INSERT OR IGNORE INTO jobs(id,application_id,kind,status,payload,created_at,request_id) SELECT ?,?,?,?,?,?,? WHERE ${gate}`)
  .bind(id,request.application_id,kind,status,JSON.stringify(payload),now,request.id,...args);

export async function scheduleRequests(db,now){
  await db.batch([
    db.prepare("UPDATE requests SET superseded=1,version=version+1 WHERE kind='first' AND superseded=0 AND EXISTS(SELECT 1 FROM pairs p WHERE p.id=requests.pair_id AND (p.status='ended' OR p.mentee_trained=0 OR p.mentor_trained=0 OR p.planned_revision IS NULL OR p.planned_revision!=requests.booking_revision))"),
    db.prepare("UPDATE jobs SET status='cancelled' WHERE kind IN ('request','reminder','chair-deadline') AND status IN ('pending','captured') AND request_id IN (SELECT id FROM requests WHERE superseded=1)")
  ]);
  const pairs=(await db.prepare("SELECT * FROM pairs WHERE status!='ended'").all()).results;
  for(const p of pairs){
    if(!p.actual_date&&p.mentee_trained&&p.mentor_trained&&p.planned_date&&p.planned_revision){
      await db.batch([
        db.prepare("UPDATE requests SET superseded=1,version=version+1 WHERE pair_id=? AND kind='first' AND booking_revision!=? AND superseded=0 AND EXISTS(SELECT 1 FROM pairs WHERE id=? AND version=?)").bind(p.id,p.planned_revision,p.id,p.version),
        db.prepare("UPDATE jobs SET status='cancelled' WHERE kind IN ('request','reminder','chair-deadline') AND request_id IN (SELECT id FROM requests WHERE pair_id=? AND superseded=1) AND status IN ('pending','captured')").bind(p.id),
        db.prepare("INSERT OR IGNORE INTO requests(id,pair_id,application_id,role,kind,booking_revision,scheduled_for) SELECT ?,?,?,'mentee','first',?,? WHERE EXISTS(SELECT 1 FROM pairs WHERE id=? AND version=?)")
          .bind(crypto.randomUUID(),p.id,p.mentee_id,p.planned_revision,addDays(p.planned_date+'T00:00:00Z',1),p.id,p.version)
      ]);
    }else if(p.actual_date){
      const writes=[];for(const month of [3,6,9,12])for(const role of ['mentee','mentor']){
        writes.push(db.prepare('INSERT OR IGNORE INTO requests(id,pair_id,application_id,role,kind,period,scheduled_for) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM pairs WHERE id=? AND version=?)')
          .bind(crypto.randomUUID(),p.id,p[role+'_id'],role,month===12?'final':'quarterly',month,addMonths(p.actual_date,month)+'T00:00:00.000Z',p.id,p.version));
      }await db.batch(writes);
    }
  }
}

// Review sends are durable captured messages, never network calls. The caller
// must synchronize incoming replies first. An unhealthy inbox blocks deadlines.
export async function runFollowups(db,{now=new Date().toISOString(),inboxHealthy=false,mode='review',renderMessage,delivery=false}={}){
  if(!['review','operating'].includes(mode))throw new InputError('Sending is not enabled.',403);
  await foldFinishedOutcomes(db,now);
  if(!inboxHealthy)return {held:true,reason:'Incoming replies must be synchronized first.'};
  if(typeof renderMessage!=='function')throw new Error('Canonical message renderer required.');
  await scheduleRequests(db,now);
  const rows=(await db.prepare('SELECT * FROM requests WHERE superseded=0 AND scheduled_for<=?').bind(now).all()).results;
  let changed=0;const errors=[],alertFailures=[];
  for(const row of rows){
    try{
    const r=decodeRequest(row),next=structuredClone(r),jobs=[];
    if(r.reviewed_at)continue;
    if(delivery&&await db.prepare("SELECT id FROM jobs WHERE id=? AND status='captured'").bind(r.id+':initial').first())continue;
    if(!r.sent_at){
      if(await db.prepare('SELECT id FROM jobs WHERE id=?').bind(r.id+':initial').first())continue;
      next.sent_at=delivery?null:now;next.deadline=delivery?null:addDays(now,21);next.token_hash=null;
      let messageRequest=r;
      if([6,9,12].includes(r.period))messageRequest={...r,history:await checkInHistory(db,r)};
      if(r.kind==='first'){
        const context=await db.prepare('SELECT p.planned_date,a.answers FROM pairs p JOIN applications a ON a.id=p.mentor_id WHERE p.id=?').bind(r.pair_id).first();
        messageRequest={...r,mentor_name:context?JSON.parse(context.answers).name:null,first_meeting_date:context?.planned_date};
      }
      jobs.push(queue(db,r.id+':initial',r,'request',renderMessage(messageRequest,'initial',null),now,delivery?'pending':'captured'));
    }else if(!r.replied_at){
      const latest=Date.parse(now)>=Date.parse(addDays(r.sent_at,14))?14:7;
      for(const day of [latest])if(Date.parse(now)>=Date.parse(addDays(r.sent_at,day))&&Date.parse(now)<Date.parse(r.deadline)){
        // Retain the original meeting context for first-meeting reminders.
        const initial=await db.prepare('SELECT payload FROM jobs WHERE id=?').bind(r.id+':initial').first('payload');
        const original=JSON.parse(initial??'{}');
        if([6,9,12].includes(r.period)&&!original.history)original.history=await checkInHistory(db,r);
        if(r.kind==='first'&&(!original.mentorName||!original.meetingDate)){
          const context=await db.prepare('SELECT p.planned_date,a.answers FROM pairs p JOIN applications a ON a.id=p.mentor_id WHERE p.id=?').bind(r.pair_id).first();
          original.mentorName=context?JSON.parse(context.answers).name:null;original.meetingDate=context?.planned_date;
        }
        jobs.push(queue(db,r.id+':reminder:'+day,r,'reminder',renderMessage(r,'reminder-'+day,null,original),now,delivery?'pending':'captured'));
        if(day===14)jobs.push((gate,args)=>db.prepare(`INSERT OR IGNORE INTO jobs(id,application_id,kind,status,payload,created_at,request_id) SELECT ?,?,'reminder','cancelled',?,?,? WHERE ${gate}`).bind(r.id+':reminder:7',r.application_id,JSON.stringify({requestId:r.id,reason:'Superseded by the later due reminder.'}),now,r.id,...args));
      }
    }
    if(r.deadline&&Date.parse(now)>=Date.parse(r.deadline)){
      const status=r.kind==='first'?{complete:Boolean(r.replied_at),missing:[],noResponseFailure:!r.replied_at,missingOutcomes:[]}:feedbackStatus(r,now);
      if(!status.complete&&!r.failure_history.some(f=>f.type==='deadline')){
        next.failure_history.push({type:'deadline',at:r.deadline,noResponse:status.noResponseFailure,missing:status.missing,missingOutcomes:status.missingOutcomes});
        jobs.push(queue(db,r.id+':deadline',r,'chair-deadline',{requestId:r.id,noResponse:status.noResponseFailure,missing:status.missing},now));
      }
    }
    if(jobs.length&&await saveRequest(db,r,next,jobs))changed++;
    }catch{
      errors.push(row.id);
      // No raw provider error or participant text in the alert. One damaged
      // request must not prevent unrelated participants' follow-up.
      try{await db.prepare("INSERT OR IGNORE INTO jobs(id,application_id,kind,status,payload,created_at,request_id) SELECT ?,?,'chair-processing-error','captured',?,?,? WHERE EXISTS(SELECT 1 FROM requests WHERE id=? AND superseded=0)")
        .bind(row.id+':processing-error',row.application_id,JSON.stringify({requestId:row.id,reason:'Request processing failed; review required.'}),now,row.id,row.id).run();
      }catch{alertFailures.push(row.id);}
    }
  }
  return {held:false,changed,errors,alertFailures};
}

export async function receiveFeedback(db,{id,requestId,answers,receivedAt,source},classify=classifyReview){
  if(typeof id!=='string'||!id||id.length>200||!['form','verified-email'].includes(source)||!Number.isFinite(Date.parse(receivedAt)))throw new InputError('Invalid response.');
  const hash=await sha256(JSON.stringify({requestId,answers:Object.fromEntries(Object.entries(answers??{}).sort(([a],[b])=>a.localeCompare(b))),...(source==='form'?{}:{receivedAt}),source}));
  for(let attempt=0;attempt<8;attempt++){
    const prior=await db.prepare('SELECT * FROM received_responses WHERE id=?').bind(id).first();
    if(prior){if(prior.payload_hash!==hash)conflict();return JSON.parse(prior.result);}
    const r=await getRequest(db,requestId);
    if(!r||r.kind==='first'||!r.sent_at||r.superseded||r.reviewed_at)throw new InputError('This check-in is unavailable.',404);
    const patch=validateFeedback(r,answers);
    const person=await db.prepare('SELECT answers FROM applications WHERE id=?').bind(r.application_id).first();
    const identity=person?JSON.parse(person.answers):{};
    if(source==='form'&&!Object.keys(patch).length)throw new InputError('Enter at least one answer before saving.');
    const next=structuredClone(r);
    if(!next.replied_at||Date.parse(receivedAt)<Date.parse(next.replied_at))next.replied_at=receivedAt;
    for(const [field,value] of Object.entries(patch)){
      if(next.answer_times[field]&&Date.parse(receivedAt)<Date.parse(next.answer_times[field]))continue;
      next.answers[field]=value;next.answer_times[field]=receivedAt;
      if(!['meetings','contact','recommendations'].includes(field)){
        delete next.classifications[field];delete next.conditions[field];
        let interpretation;try{interpretation=validateInterpretation(field,await classify(field,value,identity));}catch{/* Keep answer, interpretation pending. */}
        if(interpretation){next.classifications[field]=interpretation.classification;next.conditions[field]=interpretation.conditions;}
      }
    }
    const status=feedbackStatus(next,receivedAt),result={saved:true,complete:status.complete,missing:status.missing};
    const extras=[(gate,args)=>db.prepare(`INSERT OR IGNORE INTO received_responses(id,request_id,payload_hash,received_at,result) SELECT ?,?,?,?,? WHERE ${gate}`).bind(id,requestId,hash,receivedAt,JSON.stringify(result),...args)];
    const interpretationPending=Object.keys(next.answers).some(k=>!['meetings','contact','recommendations'].includes(k)&&!next.classifications[k]);
    if(next.answers.contact===true||next.classifications.value==='Little or none'||Object.values(next.classifications).includes('Unclear')||interpretationPending||Object.hasOwn(patch,'recommendations')){
      extras.push(queue(db,id+':chair-review',r,'chair-review',{requestId:r.id,contact:next.answers.contact===true,lowValue:next.classifications.value==='Little or none',unclear:Object.values(next.classifications).includes('Unclear'),interpretationPending},receivedAt));
    }
    if(await saveRequest(db,r,next,extras,id))return result;
  }
  conflict();
}

export async function receiveFirstMeeting(db,{id,requestId,outcome,date=null,receivedAt}){
  if(typeof id!=='string'||!id||id.length>200||!['happened','rescheduled','not-happened','unclear'].includes(outcome)||!Number.isFinite(Date.parse(receivedAt)))throw new InputError('Invalid first-meeting reply.');
  if(['happened','rescheduled'].includes(outcome)){
    if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new InputError('A clear date is required.');
    if(outcome==='happened'&&date>receivedAt.slice(0,10))throw new InputError('A future booking cannot confirm attendance.');
  }
  const hash=await sha256(JSON.stringify({requestId,outcome,date,receivedAt}));
  for(let attempt=0;attempt<8;attempt++){
    const prior=await db.prepare('SELECT * FROM received_responses WHERE id=?').bind(id).first();
    if(prior){if(prior.payload_hash!==hash)conflict();return JSON.parse(prior.result);}
    const r=await getRequest(db,requestId),p=r?await db.prepare('SELECT * FROM pairs WHERE id=?').bind(r.pair_id).first():null;
    if(!r||r.kind!=='first'||!r.sent_at||r.superseded||!p||p.status==='ended'||p.actual_date||p.planned_revision!==r.booking_revision)throw new InputError('This meeting confirmation needs Chair review.',409);
    if(outcome==='happened'&&(!p.mentee_trained||!p.mentor_trained))throw new InputError('Training is not complete.',409);
    const implausible=['happened','rescheduled'].includes(outcome)&&(date<p.created_at.slice(0,10)||(outcome==='rescheduled'&&date<receivedAt.slice(0,10)));
    const effectiveOutcome=implausible?'unclear':outcome;
    const next=structuredClone(r);next.replied_at=receivedAt;
    const result={saved:true,started:effectiveOutcome==='happened',actualDate:effectiveOutcome==='happened'?date:null,chairReview:['unclear','not-happened'].includes(effectiveOutcome)};
    const extras=[(gate,args)=>db.prepare(`INSERT OR IGNORE INTO received_responses(id,request_id,payload_hash,received_at,result) SELECT ?,?,?,?,? WHERE ${gate}`).bind(id,requestId,hash,receivedAt,JSON.stringify(result),...args)];
    if(effectiveOutcome==='happened')extras.push((gate,args)=>db.prepare(`UPDATE pairs SET actual_date=?,status='active',version=version+1 WHERE id=? AND ${gate}`).bind(date,p.id,...args));
    if(effectiveOutcome==='rescheduled'){
      next.superseded=1;
      extras.push((gate,args)=>db.prepare(`UPDATE pairs SET planned_date=?,planned_revision=?,version=version+1 WHERE id=? AND ${gate}`).bind(date,id,p.id,...args));
      extras.push((gate,args)=>db.prepare(`UPDATE jobs SET status='cancelled' WHERE kind IN ('request','reminder','chair-deadline') AND request_id=? AND status IN ('captured','pending') AND ${gate}`).bind(r.id,...args));
    }
    if(result.chairReview)extras.push(queue(db,id+':chair-review',r,'chair-meeting-review',{requestId:r.id,outcome:effectiveOutcome,...(implausible?{reportedDate:date,reason:'Reported date needs review against the match and reply dates.'}:{})},receivedAt));
    if(await saveRequest(db,r,next,extras,id,p.version))return result;
  }
  conflict();
}
