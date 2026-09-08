import content from '../website/dist/check-in-config.json' with {type:'json'};
import {historyDate,historyText} from './check-in-history.mjs';

export function messageRenderer(origin){
  const site=new URL(origin);
  if(site.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(site.hostname))throw new Error('Use the configured HTTPS program origin.');
  return (request,phase,token,initial={})=>{
    const {messages,questions}=content;
    if(request.kind==='first'){
      const mentorName=request.mentor_name??initial.mentorName,meetingDate=request.first_meeting_date??initial.meetingDate;
      if(!mentorName||!meetingDate)throw new Error('First-meeting email requires mentor name and booked date.');
      return {...messages.first,body:messages.first.body.replaceAll('{{mentor_name}}',mentorName).replaceAll('{{first_meeting_date}}',meetingDate),mentorName,meetingDate,requestId:request.id,phase};
    }
    let message;
    if(phase.startsWith('reminder-'))message=messages.reminders[Number(phase.split('-')[1])];
    else message=request.kind==='final'?messages.final:messages.quarterly;
    if(!message)throw new Error('Unknown approved message.');
    let body=message.body;
    if(request.kind==='final'&&request.period===0)body=body.replace(/^Your twelve months[^\n]+/,messages.earlyOpening);
    const list=[...questions[request.kind==='final'?request.role:'quarterly']];
    if(request.kind==='final'&&request.period===12)list.splice(list.length-1,0,content.copy.improvementQuestion);
    const history=request.history??initial.history;
    if([6,9,12].includes(request.period)&&!history)throw new Error('Later check-ins require the recipient’s previous-report context.');
    if(request.period===3)list[0]=content.copy.firstMeetingQuestion;
    if(request.period===0)list[0]=content.copy.earlyMeetingQuestion;
    if([6,9,12].includes(request.period))list[0]=`How many times have you met since ${historyDate(history.countFrom)}?`;
    if([6,9].includes(request.period))list[1]=content.copy.laterValueQuestion;
    if(phase.startsWith('reminder-')){
      const label=request.kind==='final'?'final check-in':`month-${request.period} check-in`;
      body=body.replace('a check-in for',`your ${label} for`).replace('the check-in we emailed you',`the ${label} we emailed you`);
    }
    const values={months_elapsed:({3:'three',6:'six',9:'nine',12:'twelve'})[request.period]??'',
      check_in_context:history?historyText(history):'',
      reporting_guidance:request.period===0?content.copy.earlyMeetingGuidance:request.period===12?content.copy[request.role==='mentor'?'finalScopeMentor':'finalScopeMentee']:'',
      check_in_questions:list.map((q,i)=>`${i+1}. ${q}`).join('\n')};
    // Insert once into the approved layout. Never rewrite participant quotes or
    // append an extra explanation/footer after rendering the canonical copy.
    body=body.replace(/\{\{(months_elapsed|check_in_context|reporting_guidance|check_in_questions)\}\}/g,(_,key)=>values[key]).replace(/\n{3,}/g,'\n\n').trim();
    return {subject:message.subject,body,requestId:request.id,phase,...(history?{history}:{})};
  };
}
