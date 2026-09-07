import content from '../website/dist/check-in-config.json' with {type:'json'};

export function messageRenderer(origin){
  const site=new URL(origin);
  if(site.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(site.hostname))throw new Error('Use the configured HTTPS program origin.');
  return (request,phase,token,initial={})=>{
    const {messages,questions}=content;
    const link=token?new URL('/check-in#'+token,site).href:initial.link;
    if(request.kind==='first')return {...messages.first,requestId:request.id,phase};
    if(!link)throw new Error('Private request link unavailable.');
    let message;
    if(phase.startsWith('reminder-'))message=messages.reminders[Number(phase.split('-')[1])];
    else message=request.kind==='final'?messages.final:messages.quarterly;
    if(!message)throw new Error('Unknown approved message.');
    let body=message.body.replaceAll('[link]',link).replace('month-[three, six, nine, or twelve]','month-'+({3:'three',6:'six',9:'nine',12:'twelve'}[request.period]??request.period));
    if(request.kind==='final'&&request.period===0)body=body.replace('Your twelve-month mentorship cycle is complete.',messages.earlyOpening);
    const list=questions[request.kind==='final'?request.role:'quarterly'];
    if(phase==='initial')body+='\n\n'+list.map((q,i)=>`${i+1}. ${q}`).join('\n');
    return {subject:message.subject,body,link,requestId:request.id,phase};
  };
}
