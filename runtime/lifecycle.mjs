import {InputError,sha256} from './applications.mjs';
import {addMonths} from './feedback.mjs';

// Not exposed to chat until actual human confirmation is qualified. This is a
// named Chair action, never an inference from a participant's free-text reply.
export async function endRelationship(db,action,actor,now=new Date().toISOString()){
  if(!action||Object.keys(action).some(k=>!['id','pairId','version','endDate'].includes(k))||typeof action.id!=='string'||!action.id||typeof actor!=='string'||!actor||!Number.isSafeInteger(action.version))throw new InputError('Invalid ending action.');
  const hash=await sha256(JSON.stringify({pairId:action.pairId,version:action.version,endDate:action.endDate}));
  const prior=await db.prepare('SELECT * FROM chair_actions WHERE id=?').bind(action.id).first();
  if(prior){if(prior.actor!==actor||prior.payload_hash!==hash)throw new InputError('Action ID already used.',409);return JSON.parse(prior.result);}
  const p=await db.prepare('SELECT * FROM pairs WHERE id=?').bind(action.pairId??'').first();
  if(!p||p.version!==action.version||p.status==='ended')throw new InputError('Pair changed. Review it again.',409);
  const date=action.endDate;
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date>now.slice(0,10)||(p.actual_date&&date<p.actual_date))throw new InputError('Use the actual ending date.');
  if(!p.actual_date&&date<p.created_at.slice(0,10))throw new InputError('An unstarted relationship cannot end before its match was recorded.');
  if(p.actual_date&&date>=addMonths(p.actual_date,12))throw new InputError('This is not an early ending. Review the existing final feedback.',409);
  const execution=crypto.randomUUID(),gate='EXISTS(SELECT 1 FROM chair_actions WHERE execution_id=?)';
  const result={pairId:p.id,status:'ended',endDate:date,version:p.version+1};
  const writes=[
    db.prepare("INSERT OR IGNORE INTO chair_actions(id,payload_hash,execution_id,actor,action,subjects,result,created_at) SELECT ?,?,?,?,'end_relationship',?,?,? WHERE EXISTS(SELECT 1 FROM pairs WHERE id=? AND version=? AND status!='ended') AND NOT EXISTS(SELECT 1 FROM requests WHERE pair_id=? AND kind='final' AND sent_at IS NOT NULL AND superseded=0)")
      .bind(action.id,hash,execution,actor,JSON.stringify([p.id]),JSON.stringify(result),now,p.id,p.version,p.id),
    db.prepare(`UPDATE pairs SET status='ended',ended_date=?,version=version+1 WHERE id=? AND ${gate}`).bind(date,p.id,execution),
    db.prepare(`UPDATE requests SET superseded=1,version=version+1 WHERE pair_id=? AND superseded=0 AND (kind IN ('first','final') OR sent_at IS NULL OR json_type(answers,'$.meetings') IS NULL OR json_type(answers,'$.value') IS NULL OR json_type(answers,'$.contact') IS NULL) AND ${gate}`).bind(p.id,execution),
    db.prepare(`UPDATE jobs SET status='cancelled' WHERE kind IN ('request','reminder','chair-deadline') AND request_id IN (SELECT id FROM requests WHERE pair_id=? AND superseded=1) AND status IN ('pending','captured') AND ${gate}`).bind(p.id,execution)
  ];
  for(const role of ['mentee','mentor'])writes.push(db.prepare(`INSERT OR IGNORE INTO requests(id,pair_id,application_id,role,kind,period,scheduled_for) SELECT ?,?,?,?,'final',0,? WHERE ${gate}`).bind(crypto.randomUUID(),p.id,p[role+'_id'],role,now,execution));
  writes.push(db.prepare('SELECT payload_hash,actor,result FROM chair_actions WHERE id=?').bind(action.id));
  const saved=(await db.batch(writes)).at(-1).results[0];
  if(!saved||saved.payload_hash!==hash||saved.actor!==actor)throw new InputError('Pair changed or already has final feedback. Review it again.',409);
  return JSON.parse(saved.result);
}
