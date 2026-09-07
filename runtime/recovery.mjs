import {InputError,sha256} from './applications.mjs';

// Participant and program records only. Recovery coordination state lives in
// recovery_state and is deliberately absent here: a snapshot must never carry
// the sequence that decides whether that snapshot may be written or restored.
const tables=['applications','cohorts','pairs','requests','jobs','activity','chair_actions','matching_copies','received_responses','anonymous_outcomes','anonymous_completion','outcome_totals','deletion_ledger'];
export async function exportSnapshot(db){
  const results=await db.batch(tables.map(name=>db.prepare(`SELECT * FROM ${name}`)));
  return {format:'eo-mentorship',version:6,createdAt:new Date().toISOString(),tables:Object.fromEntries(tables.map((name,i)=>[name,results[i].results]))};
}
export function validateRestore(snapshot,latestDeletionLedger){
  if(snapshot?.format!=='eo-mentorship'||snapshot.version!==6||!snapshot.tables||Object.keys(snapshot.tables).length!==tables.length||tables.some(t=>!Array.isArray(snapshot.tables[t])))throw new InputError('Unsupported or incomplete backup. Use a backup from the installed schema version.');
  const completion=snapshot.tables.anonymous_completion;
  if(completion.length!==1||completion[0].id!==1||!['required','complete','missed_deadlines'].every(k=>Number.isSafeInteger(completion[0][k])&&completion[0][k]>=0)||completion[0].complete>completion[0].required)throw new InputError('Invalid anonymous completion totals.');
  const totals=snapshot.tables.outcome_totals;
  if(totals.length!==4||new Set(totals.map(r=>r.metric)).size!==4||totals.some(r=>!['menteeProgress','menteeValue','mentorValue','mentorReturn'].includes(r.metric)||!['included','positive','missing','interpretationPending'].every(k=>Number.isSafeInteger(r[k])&&r[k]>=0)||r.positive+r.missing+r.interpretationPending>r.included))throw new InputError('Invalid outcome totals.');
  if(!Array.isArray(latestDeletionLedger))throw new InputError('Obtain the current deletion ledger before restoring.');
  for(const entry of latestDeletionLedger){
    const saved=snapshot.tables.deletion_ledger.find(x=>x.application_id===entry.application_id);
    if(!saved||saved.deleted_at!==entry.deleted_at||snapshot.tables.applications.some(x=>x.id===entry.application_id))throw new InputError('This backup predates a deletion. Use a verified post-deletion backup.');
  }
  for(const entry of snapshot.tables.deletion_ledger){
    if(snapshot.tables.applications.some(x=>x.id===entry.application_id)||snapshot.tables.requests.some(x=>x.application_id===entry.application_id)||snapshot.tables.jobs.some(x=>x.application_id===entry.application_id)||snapshot.tables.pairs.some(x=>x.mentee_id===entry.application_id||x.mentor_id===entry.application_id))throw new InputError('Backup would restore deleted information.');
    if(snapshot.tables.matching_copies.some(x=>x.application_id===entry.application_id)||snapshot.tables.activity.some(x=>x.subject_id===entry.application_id)||snapshot.tables.chair_actions.some(x=>{
      let subjects;try{subjects=JSON.parse(x.subjects);}catch{throw new InputError('Invalid approval history in backup.');}
      if(!Array.isArray(subjects))throw new InputError('Invalid approval history in backup.');
      return subjects.includes(entry.application_id);
    }))throw new InputError('Backup would restore deleted extracts or history.');
  }
  const t=snapshot.tables;
  const reviewed=new Set(t.applications.filter(a=>a.details_removed_at).map(a=>a.id));
  if(t.applications.some(a=>reviewed.has(a.id)&&Object.keys(JSON.parse(a.answers)).some(k=>k!=='name'))||t.requests.some(r=>reviewed.has(r.application_id)&&(!r.reviewed_at||r.kind!=='final'||Object.entries(JSON.parse(r.answers)).some(([k,v])=>!['progress','value','returnInterest','contact'].includes(k)||typeof v!=='boolean')||r.token_hash||r.conditions!=='{}'||r.answer_times!=='{}'))||t.jobs.some(j=>reviewed.has(j.application_id))||t.matching_copies.some(r=>reviewed.has(r.application_id)))throw new InputError('Backup would restore details removed after final review.');
  if(t.cohorts.some(r=>!r||typeof r.name!=='string'||!r.name.trim()))throw new InputError('Backup contains an invalid group name.');
  const applications=new Set(t.applications.map(r=>r.id)),pairs=new Set(t.pairs.map(r=>r.id)),requests=new Set(t.requests.map(r=>r.id)),groups=new Set(t.cohorts.map(r=>r.name.toLowerCase()));
  if(t.pairs.some(r=>!groups.has(r.group_name?.toLowerCase())||[r.mentee_id,r.mentor_id].some(id=>id!==null&&!applications.has(id)))||t.requests.some(r=>!pairs.has(r.pair_id)||!applications.has(r.application_id))||t.jobs.some(r=>(r.application_id!==null&&!applications.has(r.application_id))||(r.request_id!==null&&!requests.has(r.request_id)))||t.matching_copies.some(r=>!applications.has(r.application_id))||t.received_responses.some(r=>!requests.has(r.request_id)))throw new InputError('Backup contains a missing application, pair, group or request reference. Obtain a complete verified backup.');
  return true;
}
export async function exportPrivacyCheckpoint(db,snapshot){
  snapshot??=await exportSnapshot(db);
  const reviewedApplications=snapshot.tables.applications.filter(a=>a.details_removed_at);
  const reviewedIds=new Set(reviewedApplications.map(a=>a.id));
  const pairs=snapshot.tables.pairs.filter(p=>p.mentee_id===null||p.mentor_id===null||reviewedIds.has(p.mentee_id)||reviewedIds.has(p.mentor_id));
  const pairIds=new Set(pairs.map(p=>p.id)),survivors=new Set(pairs.flatMap(p=>[p.mentee_id,p.mentor_id]).filter(Boolean));
  const requests=snapshot.tables.requests.filter(r=>pairIds.has(r.pair_id)),requestIds=new Set(requests.map(r=>r.id));
  // These are the survivor's operational records, not a deleted-person lookup.
  // Pending results are private and potentially traceable until folded into totals.
  return {format:'eo-mentorship-privacy',version:6,createdAt:snapshot.createdAt,ledger:snapshot.tables.deletion_ledger,reviewedApplications,
    totals:snapshot.tables.outcome_totals,outcomes:snapshot.tables.anonymous_outcomes,completion:snapshot.tables.anonymous_completion,pairs,requests,
    jobs:snapshot.tables.jobs.filter(j=>requestIds.has(j.request_id)||(j.request_id===null&&survivors.has(j.application_id))),
    corrections:snapshot.tables.chair_actions.filter(a=>a.action==='correct_classification'&&requestIds.has(JSON.parse(a.result).requestId)),
    responses:snapshot.tables.received_responses.filter(r=>requestIds.has(r.request_id))};
}
export function replayDeletions(snapshot,checkpoint){
  if(checkpoint?.format!=='eo-mentorship-privacy'||checkpoint.version!==6||!['ledger','outcomes','totals','completion','pairs','requests','jobs','responses','reviewedApplications','corrections'].every(k=>Array.isArray(checkpoint[k])))throw new InputError('A current private recovery checkpoint is required.');
  validateRestore(snapshot,snapshot.tables?.deletion_ledger);
  const deleted=new Set(checkpoint.ledger.map(r=>r.application_id));
  const reviewed=new Set(checkpoint.reviewedApplications.map(r=>r.id));
  const missing=checkpoint.ledger.some(r=>!snapshot.tables.deletion_ledger.some(x=>x.application_id===r.application_id&&x.deleted_at===r.deleted_at));
  const missingReview=checkpoint.reviewedApplications.some(r=>!snapshot.tables.applications.some(a=>a.id===r.id&&a.details_removed_at===r.details_removed_at&&a.version>=r.version));
  if(!missing&&!missingReview&&Date.parse(checkpoint.createdAt)<Date.parse(snapshot.createdAt)){validateRestore(snapshot,checkpoint.ledger);return structuredClone(snapshot);}
  if(Date.parse(checkpoint.createdAt)<Date.parse(snapshot.createdAt))throw new InputError('Recovery checkpoint is older than the backup.');
  if(checkpoint.reviewedApplications.some(a=>!a.details_removed_at||deleted.has(a.id))||checkpoint.pairs.some(p=>p.status!=='ended'||deleted.has(p.mentee_id)||deleted.has(p.mentor_id))||checkpoint.requests.some(r=>deleted.has(r.application_id))||checkpoint.jobs.some(r=>deleted.has(r.application_id)))throw new InputError('Recovery checkpoint contains erased records.');
  const result=structuredClone(snapshot),t=result.tables;
  const pairIds=new Set(checkpoint.pairs.map(p=>p.id)),survivors=new Set(checkpoint.pairs.flatMap(p=>[p.mentee_id,p.mentor_id]).filter(Boolean));
  const removed=new Set([...deleted,...reviewed]);
  const oldRequestIds=new Set(t.requests.filter(r=>removed.has(r.application_id)||pairIds.has(r.pair_id)).map(r=>r.id));
  t.applications=[...t.applications.filter(r=>!removed.has(r.id)),...structuredClone(checkpoint.reviewedApplications)];
  t.pairs=[...t.pairs.filter(r=>!pairIds.has(r.id)),...structuredClone(checkpoint.pairs)];
  t.requests=[...t.requests.filter(r=>!oldRequestIds.has(r.id)),...structuredClone(checkpoint.requests)];
  t.jobs=[...t.jobs.filter(r=>!deleted.has(r.application_id)&&!(r.request_id===null&&survivors.has(r.application_id))&&!oldRequestIds.has(r.request_id)),...structuredClone(checkpoint.jobs)];
  t.received_responses=[...t.received_responses.filter(r=>!oldRequestIds.has(r.request_id)),...structuredClone(checkpoint.responses)];
  t.matching_copies=t.matching_copies.filter(r=>!removed.has(r.application_id));
  t.activity=t.activity.filter(r=>!removed.has(r.subject_id)&&!pairIds.has(r.subject_id));
  t.chair_actions=[...t.chair_actions.filter(r=>!JSON.parse(r.subjects).some(id=>removed.has(id)||pairIds.has(id))),...structuredClone(checkpoint.corrections)];
  t.outcome_totals=structuredClone(checkpoint.totals);t.anonymous_outcomes=structuredClone(checkpoint.outcomes);t.anonymous_completion=structuredClone(checkpoint.completion);t.deletion_ledger=structuredClone(checkpoint.ledger);
  validateRestore(result,checkpoint.ledger);return result;
}
export async function importSnapshot(db,snapshot,{latestPrivacyCheckpoint,standby=false}={}){
  if(!standby)throw new InputError('Restore only into a stopped, empty standby installation.');
  snapshot=replayDeletions(snapshot,latestPrivacyCheckpoint);
  // Never merge two installations or overwrite user work. The fresh migration's
  // single all-zero completion row is the only allowed pre-existing record.
  const counts=await db.batch(tables.map(name=>db.prepare(`SELECT COUNT(*) n FROM ${name}`)));
  for(let i=0;i<tables.length;i++)if(counts[i].results[0].n>(tables[i]==='anonymous_completion'?1:tables[i]==='outcome_totals'?4:0))throw new InputError('Destination is not empty.');
  const completion=await db.prepare('SELECT * FROM anonymous_completion WHERE id=1').first();
  if(completion&&(completion.required||completion.complete||completion.missed_deadlines))throw new InputError('Destination already contains results.');
  const totals=await db.prepare('SELECT * FROM outcome_totals').all();
  if(totals.results.some(r=>r.included||r.positive||r.missing||r.interpretationPending))throw new InputError('Destination already contains results.');
  // CHECK(id=1) acts as an atomic assertion: an occupied destination attempts
  // the forbidden id=2 and aborts the whole batch before any import writes.
  const occupied=tables.filter(t=>!['anonymous_completion','outcome_totals'].includes(t)).map(t=>`(SELECT COUNT(*) FROM ${t})`).join('+')+"+(SELECT COUNT(*) FROM anonymous_completion WHERE required!=0 OR complete!=0 OR missed_deadlines!=0)+(SELECT COUNT(*) FROM outcome_totals WHERE included!=0 OR positive!=0 OR missing!=0 OR interpretationPending!=0)";
  const writes=[db.prepare(`INSERT INTO anonymous_completion(id,required,complete,missed_deadlines) SELECT 2,0,0,0 WHERE (${occupied})>0`),db.prepare('DELETE FROM anonymous_completion WHERE id=1'),db.prepare('DELETE FROM outcome_totals')];
  for(const name of tables){
    const columns=(await db.prepare(`PRAGMA table_info(${name})`).all()).results.map(c=>c.name);
    for(const row of snapshot.tables[name]){
      const record=name==='jobs'&&row&&!Object.hasOwn(row,'rfc_message_id')?{...row,rfc_message_id:null}:row;
      if(!record||Object.keys(record).length!==columns.length||columns.some(c=>!Object.hasOwn(record,c)))throw new InputError('Backup columns do not match the installed schema.');
      writes.push(db.prepare(`INSERT INTO ${name}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(c=>record[c])));
    }
  }
  await db.batch(writes);
  const restored=await exportSnapshot(db);
  return {restored:true,mode:'standby',counts:Object.fromEntries(tables.map(name=>[name,restored.tables[name].length]))};
}
export async function writePrivateBackup(bucket,snapshot,key){
  const text=JSON.stringify(snapshot),digest=await sha256(text);
  // The storage adapter fixes the JSON content type, so only the verified
  // checksum travels as object metadata.
  key??='snapshots/'+snapshot.createdAt.replaceAll(':','-')+'-'+crypto.randomUUID()+'.json';
  await bucket.put(key,text,{customMetadata:{sha256:digest}});
  const check=await bucket.get(key);if(!check||await sha256(await check.text())!==digest)throw new Error('Private backup readback failed.');
  return {key,sha256:digest};
}
export async function readPrivateBackup(bucket,key,expectedSHA256){
  if(!/^[a-f0-9]{64}$/.test(expectedSHA256??''))throw new InputError('The verified backup checksum is required.');
  const object=await bucket.get(key);if(!object)throw new InputError('Backup not found.');
  const text=await object.text();if(await sha256(text)!==expectedSHA256)throw new InputError('Backup checksum mismatch.');
  const snapshot=JSON.parse(text);validateRestore(snapshot,snapshot.tables.deletion_ledger);return snapshot;
}
