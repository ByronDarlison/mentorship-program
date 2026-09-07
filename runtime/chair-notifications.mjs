// Fixed operational notices use the same queue and delivery evidence as the
// existing mail. The underlying flag remains open until the Chair resolves it.
const reasons={
  'chair-review':'A participant has requested contact, reported low value, or provided feedback that needs review.',
  'chair-meeting-review':'The first meeting needs your review. Its status has not been inferred.',
  'chair-deadline':'The response deadline has passed and required information is still missing.',
  'chair-email-review':'A program email needs your review.',
  'chair-processing-error':'A check-in could not be processed. Please review its status.'
};
export async function queueChairNotifications(db,{delivery=false,now=new Date().toISOString()}={}){
  const flags=(await db.prepare("SELECT j.*,a.answers,a.details_removed_at FROM jobs j LEFT JOIN applications a ON a.id=j.application_id WHERE j.status IN ('captured','pending','held') ORDER BY j.created_at,j.id").all()).results;
  let queued=0;
  for(const flag of flags){
    if(!reasons[flag.kind]||flag.details_removed_at)continue;
    const name=flag.answers?JSON.parse(flag.answers).name:null;
    const body=[name?'Participant: '+name:null,reasons[flag.kind],'Review this item in your program AI chat.','Item: '+flag.id].filter(Boolean).join('\n\n');
    const result=await db.prepare("INSERT OR IGNORE INTO jobs(id,application_id,request_id,kind,status,payload,created_at) SELECT ?,?,?,'chair-notification',?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE id=? AND status IN ('captured','pending','held')) AND (? IS NULL OR EXISTS(SELECT 1 FROM applications WHERE id=? AND details_removed_at IS NULL)) RETURNING id")
      .bind(flag.id+':notice',flag.application_id,flag.request_id,delivery?'pending':'captured',JSON.stringify({subject:'Mentorship: your attention is needed',body,flagId:flag.id}),now,flag.id,flag.application_id,flag.application_id).first();
    queued+=Number(Boolean(result));
  }
  return {queued};
}
