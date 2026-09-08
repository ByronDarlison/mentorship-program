import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {renderEmailHTML,escapeHTML} from '../email-html.mjs';
import {renderEmailCatalog} from '../email-catalog.mjs';
import {messageRenderer} from '../templates.mjs';
import {chairNoticeMessage} from '../chair-notifications.mjs';
import {chairApplicationMessage} from '../applications.mjs';

// Static, fictional examples only. This script has no database or mail client.
const root=fileURLToPath(new URL('../../',import.meta.url));
const source=await readFile(path.join(root,'program/program-manual.md'),'utf8');
const destination=path.join(root,'emails');
await mkdir(destination,{recursive:true});
const entries=[];
async function add(id,title,recipient,when,message){
  const body=message.body??message.text;
  await writeFile(path.join(destination,id+'.html'),renderEmailHTML({subject:message.subject,body}));
  entries.push({id,title,recipient,when,subject:message.subject});
}
const manualTemplate=heading=>{
  const section=source.split('#### '+heading+'\n')[1]?.split('\n#### ')[0]?.split('\n## ')[0];
  const subject=section?.match(/\*\*Subject:\*\* ([^\n]+)/)?.[1];
  const body=section?.split(/\*\*Subject:\*\* [^\n]+\n/)[1]?.trim();
  if(!subject||!body)throw new Error('Missing email source: '+heading);
  return {subject,body:body.replaceAll('[link]','https://example.invalid/training').replaceAll('[date and time]','October 1 at 12:00 p.m.').replaceAll('[Brief positive explanation of why this fit may be useful.]','For this fictional example, Alex is exploring delegation and Jordan brings experience building leadership teams.')};
};
for(const [id,heading,to,when] of [
  ['applications-open','Applications open','Prospective participants','Chair-approved invitation; not automatic.'],
  ['application-received','Application received','Applicant','Automatic receipt after an application is saved.'],
  ['moving-to-matching','Moving to matching','Applicant','Chair-approved message.'],
  ['not-selected','Not selected','Applicant','Chair-approved message.'],
  ['mentor-invitation','Mentor invitation','Prospective mentor','Chair-approved invitation.'],
  ['match-introduction','Match introduction','Matched participants','Chair personalizes and approves the introduction.'],
  ['training-invitation','Training invitation','Selected participants','Chair fills in the meeting details and approves sending.']
])await add(id,heading,to,when,manualTemplate(heading));
for(const role of ['mentee','mentor'])await add('chair-application-'+role,'New '+role+' application','Chair','Automatic notice after an application is saved.',chairApplicationMessage('TEST Alex Example',role));
const render=messageRenderer('https://example.invalid');
await add('first-meeting','First meeting confirmation','Mentee','Day after the booked meeting. The same wording is repeated on days 7 and 14 if unanswered.',render({id:'example',kind:'first'},'initial',null));
for(const period of [3,6,9])await add('check-in-'+period,'Month '+period+' check-in','Mentee and mentor','Automatic, measured from confirmed first attendance.',render({id:'example',kind:'quarterly',role:'mentee',period},'initial','FICTIONAL-LINK'));
for(const role of ['mentee','mentor'])for(const period of [12,0])await add('final-'+role+'-'+period,(period?'Month 12':'Early ending')+': '+role,role,'Final feedback. Each role receives its own questions.',render({id:'example',kind:'final',role,period},'initial','FICTIONAL-LINK'));
for(const day of [7,14])await add('reminder-'+day,'Day '+day+' reminder','Participant who has not replied','Automatic for quarterly and final check-ins. First-meeting reminders use the confirmation above.',render({id:'example',kind:'quarterly',role:'mentee',period:3},'reminder-'+day,'FICTIONAL-LINK'));
for(const [kind,label] of Object.entries({'chair-review':'Contact request, low value or unclear feedback','chair-meeting-review':'Meeting needs review','chair-deadline':'Missing response at deadline','chair-email-review':'Email needs review','chair-processing-error':'Processing problem'}))await add(kind,label,'Chair','Automatic notice. The underlying item remains open until handled.',chairNoticeMessage(kind,'TEST Alex Example','FICTIONAL-ITEM'));
await add('custom-message','Other Chair-approved email','Approved recipient','Illustrative only. The Chair supplies and approves the actual subject, body and recipient.',{subject:'Example of a personal follow-up',body:'Hi Alex,\n\nThis is fictional example text. A Chair-approved email uses this same layout, with the exact wording approved in chat.\n\nThank you.'});
await writeFile(path.join(destination,'index.html'),renderEmailCatalog(entries));
await writeFile(path.join(destination,'index.md'),'# Email examples\n\nOpen `emails/index.html` in a browser after downloading the repository. Each message is also stored as a standalone HTML file. GitHub displays HTML source rather than rendering it.\n\nAll examples are fictional. The same HTML renderer is used for outgoing email. These files are a permanent template reference, not a one-time review checklist.\n\n'+entries.map(e=>`- [${e.title}](${e.id}.html): ${e.recipient}. ${e.when}`).join('\n')+'\n\nTo regenerate after editing wording or layout, run `npm run emails`. No email is sent.\n');
console.log('Generated '+entries.length+' fictional HTML email examples in emails/.');
