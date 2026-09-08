// Read only this person's earlier quarterly answers in this relationship.
// The saved invitation keeps its reference period unchanged on reminders.
export async function checkInHistory(db,request){
  if(![6,9,12].includes(request.period))return null;
  const pair=await db.prepare('SELECT actual_date FROM pairs WHERE id=?').bind(request.pair_id).first();
  const rows=(await db.prepare("SELECT period,sent_at,replied_at,answers,answer_times FROM requests WHERE pair_id=? AND application_id=? AND role=? AND kind='quarterly' AND period<? AND superseded=0 AND reviewed_at IS NULL AND sent_at IS NOT NULL ORDER BY period DESC")
    .bind(request.pair_id,request.application_id,request.role,request.period).all()).results.map(row=>({...row,answers:JSON.parse(row.answers),times:JSON.parse(row.answer_times)}));
  const report=rows.find(r=>['meetings','value','contact'].some(k=>Object.hasOwn(r.answers,k)));
  const count=rows.find(r=>Number.isSafeInteger(r.answers.meetings));
  const reportDates=report?Object.values(report.times).filter(t=>Number.isFinite(Date.parse(t))).sort():[];
  return {countFrom:count?(count.times.meetings??count.replied_at):pair?.actual_date,
    fromStart:!count,
    previousUnanswered:rows[0]&&!['meetings','value','contact'].some(k=>Object.hasOwn(rows[0].answers,k))?{period:rows[0].period,sentAt:rows[0].sent_at}:null,
    lastReport:report?{date:reportDates.at(-1)??report.replied_at,period:report.period,answers:Object.fromEntries(['meetings','value','contact'].filter(k=>Object.hasOwn(report.answers,k)).map(k=>[k,report.answers[k]]))}:null};
}

export function historyDate(value){
  if(typeof value==='string'&&value.startsWith('{{'))return value;
  if(!value||!Number.isFinite(Date.parse(value)))throw new Error('A dated check-in reference is required.');
  return new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'}).format(new Date(value));
}
export function historyText(history){
  const parts=[];
  if(history.previousUnanswered)parts.push(`We do not have answers to your month-${history.previousUnanswered.period} check-in sent on ${historyDate(history.previousUnanswered.sentAt)}.`);
  if(history.lastReport){
    const {date,answers}=history.lastReport;
    parts.push(`Your last report: ${historyDate(date)}`);
    if(Object.hasOwn(answers,'meetings'))parts.push(`You reported ${answers.meetings} meetings.`);
    if(Object.hasOwn(answers,'value'))parts.push('You wrote:\n'+String(answers.value).split('\n').map(line=>'> '+line).join('\n'));
    if(Object.hasOwn(answers,'contact'))parts.push(typeof answers.contact==='boolean'?`You ${answers.contact?'asked':'did not ask'} for the Mentorship Chair to contact you.`:`Your previous request for Chair contact: ${answers.contact}`);
  }else if(!history.previousUnanswered)parts.push('We do not have an earlier check-in report from you.');
  if(history.fromStart)parts.push('We do not have an earlier meeting count from you, so please count from the start of your mentorship.');
  return parts.join('\n\n');
}
