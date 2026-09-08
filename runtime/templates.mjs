import content from '../website/dist/check-in-config.json' with {type:'json'};

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
    let body=message.body.replace('month-[three, six, nine, or twelve]','month-'+({3:'three',6:'six',9:'nine',12:'twelve'}[request.period]??request.period));
    // Keep each template's own thank-you after the generated questions.
    // No universal footer: messages without a closing do not acquire one.
    const closing=body.match(/\n\n(Thank you[^\n]+)$/)?.[1]??'';
    if(closing)body=body.slice(0,-closing.length).trim();
    if(request.kind==='final'&&request.period===0)body=body.replace(/^Your twelve months[^\n]+/,messages.earlyOpening);
    const list=[...questions[request.kind==='final'?request.role:'quarterly']];
    if(request.period===3){
      body=body.replace('Count meetings since your last check-in, or since your mentorship began if this is your first.',content.copy.firstPeriod);
      list[0]=content.copy.firstMeetingQuestion;
    }else if(request.period!==0){
      body=body.replace('Count meetings since your last check-in, or since your mentorship began if this is your first.','Count meetings since your last check-in.');
    }else{
      body=body.replace('Count meetings since your last check-in, or since your mentorship began if this is your first.',content.copy.earlyMeetingGuidance);
      list[0]=content.copy.earlyMeetingQuestion;
    }
    if(phase.startsWith('reminder-')){
      const label=request.kind==='final'?'final check-in':`month-${request.period} check-in`;
      body=body.replace('a check-in for',`your ${label} for`).replace('the check-in we emailed you',`the ${label} we emailed you`);
      const guidance=request.period===0?content.copy.earlyMeetingGuidance:request.period===3?content.copy.firstPeriod:'Count meetings since your last check-in.';
      body=body.trim()+'\n\n'+guidance;
    }
    if(phase==='initial'||phase.startsWith('reminder-')){
      body=body.trim()+'\n\n'+list.map((q,i)=>`${i+1}. ${q}`).join('\n');
    }
    if(closing)body+='\n\n'+closing;
    return {subject:message.subject,body,requestId:request.id,phase};
  };
}
