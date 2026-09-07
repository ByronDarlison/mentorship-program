import {InputError,sha256} from './applications.mjs';
import {addMonths,validateInterpretation,requestFields} from './feedback.mjs';
import {getRequest} from './followups.mjs';

// These are Chair corrections, never automatic interpretations of email.
// The existing native-confirmation route owns authentication and confirmation.
export async function correctRecord(db,operation,action,actor,now=new Date().toISOString()){
  const keys=operation==='correct_cycle'?['id','pairId','version','actualDate']:operation==='correct_classification'?['id','requestId','version','field','classification','conditions']:[];
  if(!keys.length||!action||typeof action.id!=='string'||!action.id||!actor||!Number.isSafeInteger(action.version)||Object.keys(action).some(k=>!keys.includes(k)))throw new InputError('Invalid correction.');
  const hash=await sha256(JSON.stringify({operation,...Object.fromEntries(Object.entries(action).sort(([a],[b])=>a.localeCompare(b)))}));
  const prior=await db.prepare('SELECT * FROM chair_actions WHERE id=?').bind(action.id).first();
  if(prior){if(prior.actor!==actor||prior.payload_hash!==hash)throw new InputError('Action ID already used.',409);return JSON.parse(prior.result);}
  const execution=crypto.randomUUID(),gate='EXISTS(SELECT 1 FROM chair_actions WHERE execution_id=?)';
  let guard,bindings,subjects,result;const writes=[];
  if(operation==='correct_cycle'){
    const p=await db.prepare('SELECT * FROM pairs WHERE id=?').bind(action.pairId??'').first();
    const d=action.actualDate;
    if(!p||p.version!==action.version||p.status!=='active'||!p.actual_date||!p.mentee_trained||!p.mentor_trained)throw new InputError('Review an active, trained pair before correcting its start.',409);
    if(typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d||d>now.slice(0,10)||d<p.created_at.slice(0,10))throw new InputError('Use the confirmed actual meeting date.');
    guard="EXISTS(SELECT 1 FROM pairs WHERE id=? AND version=? AND status='active')";bindings=[p.id,p.version];subjects=[p.id,p.mentee_id,p.mentor_id];
    writes.push(db.prepare(`UPDATE pairs SET actual_date=?,version=version+1 WHERE id=? AND ${gate}`).bind(d,p.id,execution));
    for(const month of [3,6,9,12])writes.push(db.prepare(`UPDATE requests SET scheduled_for=?,version=version+1 WHERE pair_id=? AND period=? AND sent_at IS NULL AND superseded=0 AND ${gate}`).bind(addMonths(d,month)+'T00:00:00.000Z',p.id,month,execution));
    result={pairId:p.id,actualDate:d,version:p.version+1,sentRequests:'Existing answers and original response deadlines are unchanged.'};
  }else{
    const r=await getRequest(db,action.requestId??'');
    if(!r||r.version!==action.version||r.superseded||r.kind==='first'||!requestFields(r).includes(action.field)||['meetings','contact'].includes(action.field)||(!r.reviewed_at&&!Object.hasOwn(r.answers,action.field)))throw new InputError('Review an existing answer or retained result before correcting its classification.',409);
    if(typeof action.conditions!=='string'||action.conditions.length>1000)throw new InputError('Use a brief condition, or an empty string.');
    if(r.reviewed_at&&action.conditions)throw new InputError('Do not retain new written detail after final review. Use an empty condition.');
    const interpretation=validateInterpretation(action.field,{status:'classified',classification:action.classification,conditions:action.conditions});
    const classifications={...r.classifications,[action.field]:interpretation.classification},conditions={...r.conditions,[action.field]:interpretation.conditions};
    guard='EXISTS(SELECT 1 FROM requests WHERE id=? AND version=? AND superseded=0)';bindings=[r.id,r.version];subjects=[r.id,r.application_id,r.pair_id];
    const answers=r.reviewed_at?{...r.answers,[action.field]:true}:r.answers;
    writes.push(db.prepare(`UPDATE requests SET answers=?,classifications=?,conditions=?,version=version+1 WHERE id=? AND ${gate}`).bind(JSON.stringify(answers),JSON.stringify(classifications),JSON.stringify(r.reviewed_at?{}:conditions),r.id,execution));
    result={requestId:r.id,field:action.field,...interpretation,version:r.version+1};
  }
  const saved=await db.batch([
    db.prepare(`INSERT OR IGNORE INTO chair_actions(id,payload_hash,execution_id,actor,action,subjects,result,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`).bind(action.id,hash,execution,actor,operation,JSON.stringify(subjects),JSON.stringify(result),now,...bindings),
    ...writes,db.prepare('SELECT payload_hash,actor,result FROM chair_actions WHERE id=?').bind(action.id)
  ]);
  const receipt=saved.at(-1).results[0];
  if(!receipt||receipt.actor!==actor||receipt.payload_hash!==hash)throw new InputError('Record changed. Review the correction again.',409);
  return JSON.parse(receipt.result);
}
