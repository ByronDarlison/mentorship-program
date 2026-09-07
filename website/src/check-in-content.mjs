export function checkInContent(source){
  const section=source.split('### Check-in questions\n')[1]?.split('\n### ')[0];
  const lists=[...section.matchAll(/(?:^|\n)(1\. [^\n]+(?:\n\d\. [^\n]+)+)/g)].map(m=>m[1].split('\n').map(line=>line.replace(/^\d\. /,'')));
  if(lists.length!==3||lists[0].length!==3||lists[1].length!==4||lists[2].length!==4)throw new Error('Canonical check-in questions changed. Review the mapping.');
  const copySection=source.split('## Check-in review messages\n')[1]?.split('\n## ')[0];
  const copy=JSON.parse(copySection?.match(/```json\n([\s\S]*?)\n```/)?.[1]??'null');
  if(!copy?.partial||!copy?.complete)throw new Error('Missing check-in interface copy.');
  const template=heading=>{
    const section=source.split('#### '+heading+'\n')[1]?.split('\n#### ')[0]?.split('\n## ')[0];
    const subject=section?.match(/\*\*Subject:\*\* ([^\n]+)/)?.[1];
    const body=section?.split(/\*\*Subject:\*\* [^\n]+\n/)[1]?.trim();
    if(!subject||!body)throw new Error('Missing canonical message: '+heading);
    return {subject,body};
  };
  const reminderSection=source.split('#### Check-in reminders\n')[1]?.split('\n#### ')[0];
  const reminders={};for(const [day,name] of [[7,'seven'],[14,'fourteen']]){
    const part=reminderSection?.split('**Day '+name+' subject:** ')[1]?.split('\n**Day ')[0];
    if(!part)throw new Error('Missing canonical reminder.');const [subject,...lines]=part.split('\n');reminders[day]={subject,body:lines.join('\n').trim()};
  }
  const final=template('Cycle completion');
  const earlyOpening=final.body.match(/If the relationship ends early,[^\n]*“([^”]+)”/)?.[1];
  final.body=final.body.replace(/^If the relationship ends early,[^\n]+\n?/m,'').trim();
  if(!earlyOpening)throw new Error('Missing canonical early-ending opening.');
  return {copy,questions:{quarterly:lists[0],mentee:lists[1],mentor:lists[2]},messages:{first:template('First meeting confirmation'),quarterly:template('Quarterly check-in'),final,earlyOpening,reminders}};
}
