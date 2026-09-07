import {InputError,sha256} from './applications.mjs';
import {decodeRequest} from './followups.mjs';
import {feedbackStatus,finalContribution,outcomeFields} from './feedback.mjs';

const conflict=()=>{throw new InputError('Records changed. Review the completion cleanup again.',409);};
async function snapshot(db,id){
  const app=await db.prepare('SELECT * FROM applications WHERE id=?').bind(id??'').first();
  if(!app)throw new InputError('Participant not found.',404);
  const results=await db.batch([
    db.prepare('SELECT * FROM pairs WHERE mentee_id=? OR mentor_id=? ORDER BY id').bind(id,id),
    db.prepare('SELECT * FROM requests WHERE application_id=? ORDER BY id').bind(id),
    db.prepare('SELECT id,kind,status FROM jobs WHERE application_id=? ORDER BY id').bind(id)
  ]);
  const pairs=results[0].results,requests=results[1].results.map(decodeRequest),jobs=results[2].results;
  return {app,pairs,requests,jobs,reviewHash:await sha256(JSON.stringify({app:[app.id,app.version],pairs:pairs.map(p=>[p.id,p.version]),requests:requests.map(r=>[r.id,r.version]),jobs}))};
}
function finalRecords(s,now){
  if(!s.pairs.length)throw new InputError('Unmatched applications have no automatic completion cleanup. Use the agreed keep or delete decision.');
  return s.pairs.map(p=>{
    const final=s.requests.find(r=>r.pair_id===p.id&&r.kind==='final'&&!r.superseded&&r.sent_at);
    if(!final||finalContribution(final,now).pending)throw new InputError('Keep information while another relationship or its final response window is still open.',409);
    if(outcomeFields(final.role).some(k=>Object.hasOwn(final.answers,k)&&!final.classifications[k]))throw new InputError('Review unclassified final answers before deleting their wording.',409);
    return final;
  });
}
export async function previewFinalReview(db,applicationId,now=new Date().toISOString()){
  const s=await snapshot(db,applicationId);
  if(s.app.details_removed_at)return {applicationId,alreadyReviewed:true,reviewHash:s.reviewHash};
  const finals=finalRecords(s,now);
  return {applicationId,reviewHash:s.reviewHash,name:JSON.parse(s.app.answers).name,role:s.app.role,
    finalResults:finals.map(r=>({requestId:r.id,pairId:r.pair_id,classifications:r.classifications,missing:outcomeFields(r.role).filter(k=>!Object.hasOwn(r.answers,k))})),
    effect:'Remove the detailed application, LinkedIn link, written feedback and associated local copies. Keep the name, participation dates, final classifications or missing-answer status, and recorded contact preference. This is not full personal-record deletion. Provider copies and recovery checkpoints require separate verification.'};
}
export async function finishFinalReview(db,action,actor,now=new Date().toISOString()){
  if(!actor||!action||Object.keys(action).some(k=>!['applicationId','reviewHash'].includes(k))||typeof action.applicationId!=='string'||typeof action.reviewHash!=='string')throw new InputError('Reviewed completion cleanup required.');
  const s=await snapshot(db,action.applicationId);
  if(s.app.details_removed_at)return {detailsRemoved:true,alreadyReviewed:true,providerCopies:'not verified'};
  if(s.reviewHash!==action.reviewHash)conflict();
  const finals=finalRecords(s,now),id=s.app.id;
  if(s.jobs.some(j=>['sending','held'].includes(j.status)&&['request','reminder','application-receipt','chair-application','chair-approved-message','chair-notification','chair-delivery-error'].includes(j.kind)))throw new InputError('Resolve uncertain delivery before completion cleanup.',409);
  const guards=['version=?','details_removed_at IS NULL','(SELECT COUNT(*) FROM pairs WHERE mentee_id=? OR mentor_id=?)=?','(SELECT COUNT(*) FROM requests WHERE application_id=?)=?','(SELECT COUNT(*) FROM jobs WHERE application_id=?)=?'];
  const args=[s.app.version,id,id,s.pairs.length,id,s.requests.length,id,s.jobs.length];
  for(const p of s.pairs){guards.push('EXISTS(SELECT 1 FROM pairs WHERE id=? AND version=?)');args.push(p.id,p.version);}
  for(const r of s.requests){guards.push('EXISTS(SELECT 1 FROM requests WHERE id=? AND version=?)');args.push(r.id,r.version);}
  for(const j of s.jobs){guards.push('EXISTS(SELECT 1 FROM jobs WHERE id=? AND status=?)');args.push(j.id,j.status);}
  // The winning application revision gates every write in the same transaction.
  const marker=crypto.randomUUID(),gate='EXISTS(SELECT 1 FROM applications WHERE id=? AND retention_execution=?)';
  const gateArgs=[id,marker];
  const original=JSON.parse(s.app.answers),retained={name:original.name};
  const writes=[db.prepare(`UPDATE applications SET answers=?,retention_execution=?,terms_version='',privacy_version='',readiness=0,details_removed_at=?,version=version+1 WHERE id=? AND ${guards.join(' AND ')}`)
    .bind(JSON.stringify(retained),marker,now,id,...args)];
  let required=0,complete=0,missed=0;
  for(const r of s.requests){
    if(!r.reviewed_at&&r.sent_at&&!r.superseded&&r.kind!=='first'){required++;complete+=Number(feedbackStatus(r,now).complete);}
    if(!r.reviewed_at)missed+=r.failure_history.filter(f=>f.type==='deadline').length;
    if(!finals.some(f=>f.id===r.id)){
      writes.push(db.prepare(`DELETE FROM requests WHERE id=? AND ${gate}`).bind(r.id,...gateArgs));continue;
    }
    const answers=Object.fromEntries(outcomeFields(r.role).filter(k=>Object.hasOwn(r.answers,k)).map(k=>[k,true]));
    if(Object.hasOwn(r.answers,'contact'))answers.contact=r.answers.contact;
    writes.push(db.prepare(`UPDATE requests SET answers=?,answer_times='{}',conditions='{}',failure_history='[]',token_hash=NULL,last_mutation=NULL,booking_revision=NULL,reviewed_at=?,version=version+1 WHERE id=? AND ${gate}`).bind(JSON.stringify(answers),now,r.id,...gateArgs));
    writes.push(db.prepare(`DELETE FROM received_responses WHERE request_id=? AND ${gate}`).bind(r.id,...gateArgs));
  }
  writes.push(db.prepare(`UPDATE anonymous_completion SET required=required+?,complete=complete+?,missed_deadlines=missed_deadlines+? WHERE id=1 AND ${gate}`).bind(required,complete,missed,...gateArgs));
  for(const p of s.pairs)writes.push(db.prepare(`UPDATE pairs SET status='ended',ended_date=COALESCE(ended_date,?),fit_reason='',planned_revision=NULL,version=version+1 WHERE id=? AND ${gate}`).bind(now.slice(0,10),p.id,...gateArgs));
  const subjects=[id,...s.pairs.map(p=>p.id)],placeholders=subjects.map(()=>'?').join(',');
  writes.push(db.prepare(`DELETE FROM chair_actions WHERE EXISTS(SELECT 1 FROM json_each(subjects) WHERE value IN (${placeholders})) AND NOT(action='correct_classification' AND EXISTS(SELECT 1 FROM requests WHERE id=json_extract(chair_actions.result,'$.requestId') AND application_id!=?)) AND ${gate}`).bind(...subjects,id,...gateArgs));
  writes.push(db.prepare(`DELETE FROM activity WHERE subject_id IN (${placeholders}) AND ${gate}`).bind(...subjects,...gateArgs));
  writes.push(db.prepare(`DELETE FROM matching_copies WHERE application_id=? AND ${gate}`).bind(id,...gateArgs));
  writes.push(db.prepare(`DELETE FROM jobs WHERE application_id=? AND ${gate}`).bind(id,...gateArgs));
  writes.push(db.prepare('SELECT retention_execution FROM applications WHERE id=?').bind(id));
  const saved=(await db.batch(writes)).at(-1).results[0];if(saved?.retention_execution!==marker)conflict();
  return {detailsRemoved:true,alreadyReviewed:false,providerCopies:'not verified'};
}
