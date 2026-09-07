import {InputError,sha256} from './applications.mjs';
import {decodeRequest} from './followups.mjs';
import {addDays,feedbackStatus,outcomeFields,summarizeResults} from './feedback.mjs';
import {foldStatements,pendingContribution} from './outcome-storage.mjs';
const conflict=()=>{throw new InputError('Information changed. Review the deletion again.',409);};
const relatedRequests="application_id=? OR pair_id IN (SELECT id FROM pairs WHERE mentee_id=? OR mentor_id=?)";

async function snapshot(db,id){
  const app=await db.prepare('SELECT id,version FROM applications WHERE id=?').bind(id).first();
  if(!app)return null;
  const pairs=(await db.prepare('SELECT * FROM pairs WHERE mentee_id=? OR mentor_id=? ORDER BY id').bind(id,id).all()).results;
  const requests=(await db.prepare(`SELECT * FROM requests WHERE ${relatedRequests} ORDER BY id`).bind(id,id,id).all()).results.map(decodeRequest);
  const reviewHash=await sha256(JSON.stringify({application:[app.id,app.version],pairs:pairs.map(r=>[r.id,r.version]),requests:requests.map(r=>[r.id,r.version])}));
  return {app,pairs,requests,reviewHash};
}
export async function previewDeletion(db,id){
  const s=await snapshot(db,id);if(!s)throw new InputError('Application not found.',404);
  const own=s.requests.filter(r=>r.application_id===id&&!r.superseded);
  return {applicationId:id,reviewHash:s.reviewHash,pairIds:s.pairs.map(p=>p.id),unresolved:own.filter(r=>r.kind!=='first').map(r=>({requestId:r.id,missing:feedbackStatus(r,new Date().toISOString()).missing,unclassified:outcomeFields(r.role).filter(k=>Object.hasOwn(r.answers,k)&&!r.classifications[k])})).filter(r=>r.missing.length||r.unclassified.length),
    effect:'Delete the application and written feedback. Keep only private results needed to finish the original reporting window, then keep totals only. Pending results may still be traceable through dates. Erased feedback cannot be revisited. Provider copies require separate verification.'};
}

export async function deleteParticipant(db,action,actor,now=new Date().toISOString()){
  if(!action||Object.keys(action).some(k=>!['applicationId','reviewHash'].includes(k))||typeof action.applicationId!=='string'||typeof action.reviewHash!=='string'||typeof actor!=='string'||!actor)throw new InputError('Reviewed deletion action required.');
  const id=action.applicationId;
  if(await db.prepare('SELECT application_id FROM deletion_ledger WHERE application_id=?').bind(id).first())return {activeRecordsDeleted:true,alreadyDeleted:true,providerCopies:'not verified'};
  const s=await snapshot(db,id);if(!s||s.reviewHash!==action.reviewHash)conflict();
  const execution=crypto.randomUUID();
  const gate='EXISTS(SELECT 1 FROM deletion_ledger WHERE execution_id=?)';
  const guards=['EXISTS(SELECT 1 FROM applications WHERE id=? AND version=?)',`(SELECT COUNT(*) FROM requests WHERE ${relatedRequests})=?`];
  const bindings=[id,s.app.version,id,id,id,s.requests.length];
  for(const p of s.pairs){guards.push('EXISTS(SELECT 1 FROM pairs WHERE id=? AND version=?)');bindings.push(p.id,p.version);}
  for(const r of s.requests){guards.push('EXISTS(SELECT 1 FROM requests WHERE id=? AND version=?)');bindings.push(r.id,r.version);}
  const writes=[db.prepare(`INSERT OR IGNORE INTO deletion_ledger(application_id,deleted_at,execution_id) SELECT ?,?,? WHERE ${guards.join(' AND ')}`).bind(id,now,execution,...bindings)];
  let required=0,complete=0;
  const missed=s.requests.filter(r=>r.application_id===id).reduce((n,r)=>n+r.failure_history.filter(f=>f.type==='deadline').length,0);
  for(const p of s.pairs){
    const pairRequests=s.requests.filter(r=>r.pair_id===p.id&&!r.superseded);
    const own=pairRequests.filter(r=>r.application_id===id);
    const final=own.find(r=>r.kind==='final'&&r.sent_at);
    const role=p.mentee_id===id?'mentee':'mentor';
    const endingNow=p.status!=='ended'&&!pairRequests.some(r=>r.kind==='final'&&r.sent_at);
    const recordedEnding=own.find(r=>r.kind==='final'&&r.period===0)?.scheduled_for??now;
    const deadline=final?.deadline??addDays(p.status==='ended'?recordedEnding:now,21);
    const answered=Object.fromEntries(outcomeFields(role).filter(k=>Object.hasOwn(final?.answers??{},k)).map(k=>[k,true]));
    const classifications=Object.fromEntries(outcomeFields(role).filter(k=>final?.classifications[k]).map(k=>[k,final.classifications[k]]));
    // The fresh random ID is deliberately never recorded in the deletion ledger,
    // an action result, a log or any application/pair/request column.
    const pending={id:crypto.randomUUID(),role,deadline,reporting_only:Number(!final),answered:JSON.stringify(answered),classifications:JSON.stringify(classifications)};
    writes.push(db.prepare(`INSERT INTO anonymous_outcomes(id,role,deadline,reporting_only,answered,classifications) SELECT ?,?,?,?,?,? WHERE ${gate}`).bind(pending.id,pending.role,pending.deadline,pending.reporting_only,pending.answered,pending.classifications,execution));
    writes.push(...foldStatements(db,pending,now));
    for(const r of own){
      if(r.kind==='first'||!r.sent_at||r.reviewed_at)continue;
      const done=feedbackStatus(r,now).complete;
      if(endingNow&&(r.kind==='final'||!done))continue;
      required++;complete+=Number(done);
    }
    writes.push(db.prepare(`UPDATE pairs SET status='ended',ended_date=COALESCE(ended_date,?),fit_reason='',version=version+1 WHERE id=? AND ${gate}`).bind(now.slice(0,10),p.id,execution));
    if(endingNow){
      writes.push(db.prepare(`UPDATE requests SET superseded=1,version=version+1 WHERE pair_id=? AND superseded=0 AND (kind IN ('first','final') OR sent_at IS NULL OR json_type(answers,'$.meetings') IS NULL OR json_type(answers,'$.value') IS NULL OR json_type(answers,'$.contact') IS NULL) AND ${gate}`).bind(p.id,execution));
      const otherRole=role==='mentee'?'mentor':'mentee',other=p[otherRole+'_id'];
      if(other)writes.push(db.prepare(`INSERT OR IGNORE INTO requests(id,pair_id,application_id,role,kind,period,scheduled_for) SELECT ?,?,?,?,'final',0,? WHERE ${gate}`).bind(crypto.randomUUID(),p.id,other,otherRole,now,execution));
    }
  }
  // Counterpart-side delivery copies can also mention the erased person. Keep
  // only the survivor's opaque request link for continuity; remove message text
  // and non-template detail. No revised personal message is sent automatically.
  for(const r of s.requests.filter(r=>r.application_id!==id)){
    const jobs=(await db.prepare('SELECT id,payload,status FROM jobs WHERE request_id=?').bind(r.id).all()).results;
    for(const job of jobs){
      const payload=JSON.parse(job.payload),safe={requestId:r.id,needsTemplate:true};
      try{const url=new URL(payload.link);const token=url.hash.slice(1);if(url.pathname==='/check-in'&&!url.search&&await sha256(token)===r.token_hash)safe.link=payload.link;}catch{/* Never preserve an unverified link. */}
      writes.push(db.prepare(`UPDATE jobs SET payload=?,status=CASE WHEN status IN ('pending','sending') THEN 'held' ELSE status END WHERE id=? AND ${gate}`).bind(JSON.stringify(safe),job.id,execution));
    }
  }
  writes.push(db.prepare(`UPDATE anonymous_completion SET required=required+?,complete=complete+?,missed_deadlines=missed_deadlines+? WHERE id=1 AND ${gate}`).bind(required,complete,missed,execution));
  writes.push(db.prepare(`UPDATE jobs SET status='cancelled' WHERE kind IN ('request','reminder','chair-deadline') AND status IN ('pending','captured') AND request_id IN (SELECT id FROM requests WHERE superseded=1) AND ${gate}`).bind(execution));
  const subjects=[id,...s.pairs.map(p=>p.id)],placeholders=subjects.map(()=>'?').join(',');
  writes.push(db.prepare(`DELETE FROM chair_actions WHERE EXISTS(SELECT 1 FROM json_each(subjects) WHERE value IN (${placeholders})) AND ${gate}`).bind(...subjects,execution));
  writes.push(db.prepare(`DELETE FROM activity WHERE subject_id IN (${placeholders}) AND ${gate}`).bind(...subjects,execution));
  writes.push(db.prepare(`DELETE FROM requests WHERE application_id=? AND ${gate}`).bind(id,execution));
  writes.push(db.prepare(`DELETE FROM applications WHERE id=? AND ${gate}`).bind(id,execution));
  writes.push(db.prepare('SELECT execution_id FROM deletion_ledger WHERE application_id=?').bind(id));
  const saved=(await db.batch(writes)).at(-1).results[0];if(!saved)conflict();
  return {activeRecordsDeleted:true,alreadyDeleted:saved.execution_id!==execution,providerCopies:'not verified'};
}

export async function programReport(db,now=new Date().toISOString()){
  const snapshot=await db.batch(['SELECT * FROM requests','SELECT * FROM anonymous_outcomes','SELECT * FROM outcome_totals','SELECT required,complete,missed_deadlines FROM anonymous_completion WHERE id=1'].map(sql=>db.prepare(sql)));
  const requests=snapshot[0].results.map(decodeRequest),pending=snapshot[1].results.map(r=>pendingContribution(r,now));
  const report=summarizeResults(requests,now,pending),completion=snapshot[3].results[0];
  for(const row of snapshot[2].results){
    const metric=report.metrics[row.metric];
    for(const field of ['included','positive','missing','interpretationPending'])metric[field]+=row[field];
    metric.percent=metric.included?100*metric.positive/metric.included:null;
  }
  report.completion.required+=completion.required;report.completion.complete+=completion.complete;
  report.recordedMissedDeadlines=completion.missed_deadlines+requests.reduce((n,r)=>n+r.failure_history.filter(f=>f.type==='deadline').length,0);
  return report;
}
