import {finalContribution} from './feedback.mjs';

// anonymous_outcomes is the legacy table name. Its rows are PRIVATE pending
// results, not anonymous: their deadlines may correlate with other records.
export const pendingContribution=(row,now)=>finalContribution({kind:'final',role:row.role,deadline:row.deadline,reporting_only:row.reporting_only,answers:JSON.parse(row.answered),classifications:JSON.parse(row.classifications)},now);

export function foldStatements(db,row,now){
  const contribution=pendingContribution(row,now);
  if(!contribution.included)return [];
  const writes=Object.entries(contribution.metrics).map(([field,result])=>{
    const metric=row.role==='mentee'?(field==='progress'?'menteeProgress':'menteeValue'):(field==='value'?'mentorValue':'mentorReturn');
    return db.prepare('UPDATE outcome_totals SET included=included+1,positive=positive+?,missing=missing+?,interpretationPending=interpretationPending+? WHERE metric=? AND EXISTS(SELECT 1 FROM anonymous_outcomes WHERE id=?)')
      .bind(Number(result.positive),Number(result.missing),Number(result.interpretationPending),metric,row.id);
  });
  writes.push(db.prepare('DELETE FROM anonymous_outcomes WHERE id=?').bind(row.id));
  return writes;
}

export async function foldFinishedOutcomes(db,now){
  const rows=(await db.prepare('SELECT * FROM anonymous_outcomes').all()).results;
  // A transaction increments totals and removes the row together. If another
  // run already folded it, the existence check prevents double counting.
  for(const row of rows){const writes=foldStatements(db,row,now);if(writes.length)await db.batch(writes);}
}
