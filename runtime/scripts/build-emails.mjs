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
function behavior(id){
  const manualReply='If the reply reaches the program mailbox, it is flagged for the Chair rather than applied automatically. The Chair handles it and approves any record change in chat.';
  const feedbackReply='The software matches the sender and request, records the answers and classifies feedback. A genuine reply stops that person’s no-response reminders. Missing answers keep the original deadline; unclear answers and requests for help go to the Chair. Automatic replies do not count.';
  const triggers={
    'applications-open':'The Chair decides to invite applications and approves the wording and recipients. No automatic campaign is scheduled.',
    'application-received':'An applicant successfully submits either application. The system queues the receipt after saving it.',
    'moving-to-matching':'After the readiness decision, the Chair chooses to tell the applicant they are moving to matching and approves this message. Approval of an application alone does not send it.',
    'not-selected':'The Chair decides not to offer a place and separately approves this message. A decision alone does not send it.',
    'mentor-invitation':'The Chair chooses a prospective mentor and approves the invitation. It is not sent automatically.',
    'match-introduction':'After approving the match, the Chair personalizes and separately approves the introduction. Approving the match alone does not send it.',
    'training-invitation':'The Chair fills the double-braced variables with the training date, one-hour time slot, time zone, Zoom details and recipients, then approves a calendar invitation. This is the content template; calendar-invite delivery still needs implementation.',
    'first-meeting':'The day after the planned first meeting. If unanswered, the same request is repeated 7 and 14 days after the first email; the Chair is notified at day 21.',
    'chair-review':'A check-in requests contact, reports low value or contains feedback needing review. The next scheduled processing run queues the Chair notice.',
    'chair-meeting-review':'The first meeting needs a Chair decision, such as an unclear reply or no new date. The next scheduled processing run queues the notice.',
    'chair-deadline':'A request reaches its original 21-day response deadline with required information still missing. The next scheduled processing run queues the notice.',
    'chair-email-review':'An incoming email cannot be matched safely or its content needs a Chair decision. The next scheduled processing run queues the notice.',
    'chair-processing-error':'A check-in processing error creates an unresolved Chair flag. The next scheduled processing run queues the notice.',
    'custom-message':'The Chair asks for a personal message, reviews its exact wording and recipient, and approves sending. This example is not an automatic template.'
  };
  if(id.startsWith('chair-application-'))return {trigger:'A '+id.split('-').at(-1)+' application is saved. The system queues a separate notification to the Chair.',reply:'Replying to this notice does not approve or decline the applicant. The Chair makes that decision in program chat. A reply reaching the program mailbox is flagged for review.'};
  if(id.startsWith('check-in-'))return {trigger:'At month '+id.split('-').at(-1)+' after the confirmed first meeting, each participant receives a separate check-in. The hourly job sends due requests.',reply:feedbackReply};
  if(id.startsWith('final-'))return {trigger:id.endsWith('-0')?'The Chair records an early ending. The system cancels future quarterly requests and queues final feedback for each participant whose information has not been deleted.':'At month 12 after the confirmed first meeting, the system queues final feedback with the questions for this participant’s role.',reply:feedbackReply+' Final answers update the program results; missing outcome answers count as failures after the original deadline until corrected.'};
  if(id.startsWith('reminder-'))return {trigger:id.split('-').at(-1)+' days after the original check-in was sent, only if that participant has not genuinely replied and the request is still active.',reply:feedbackReply+' The reply updates the original check-in, not a new request.'};
  if(id==='first-meeting')return {trigger:triggers[id],reply:'A clear attendance reply records the actual meeting date and starts the twelve-month cycle. A clear reschedule moves the booking and follow-up. An unclear reply goes to the Chair and does not start the cycle. A genuine reply stops the old no-response reminders; an automatic reply does not.'};
  if(id==='training-invitation')return {trigger:triggers[id],reply:'Accepting or declining the calendar invitation records an RSVP, not training attendance. Questions or requests to change arrangements go to the Chair. Actual attendance is recorded separately. Calendar RSVP handling remains to be implemented.'};
  if(id.startsWith('chair-'))return {trigger:triggers[id],reply:'Replying does not resolve the item or authorize a change. The Chair handles the underlying issue in program chat. If the reply reaches the program mailbox, it is flagged for review.'};
  return {trigger:triggers[id],reply:manualReply};
}
async function add(id,title,recipient,when,message){
  const body=(message.body??message.text).replace(/\[([^\]]+)\]\(https:\/\/example\.invalid\/check-in#FICTIONAL-LINK\)/g,'$1: {{private_check_in_link}}');
  await writeFile(path.join(destination,id+'.html'),renderEmailHTML({subject:message.subject,body}));
  entries.push({id,title,recipient,when,subject:message.subject,...behavior(id)});
}
const manualTemplate=heading=>{
  const section=source.split('#### '+heading+'\n')[1]?.split('\n#### ')[0]?.split('\n## ')[0];
  const subject=section?.match(/\*\*Subject:\*\* ([^\n]+)/)?.[1];
  const body=section?.split(/\*\*Subject:\*\* [^\n]+\n/)[1]?.trim();
  if(!subject||!body)throw new Error('Missing email source: '+heading);
  return {subject,body:body.replaceAll('[Brief positive explanation of why this fit may be useful.]','{{reason_for_this_match}}')};
};
for(const [id,heading,to,when] of [
  ['applications-open','Applications open','Prospective participants','Chair-approved invitation; not automatic.'],
  ['application-received','Application received','Applicant','Automatic receipt after an application is saved.'],
  ['moving-to-matching','Moving to matching','Mentee','Chair-approved message.'],
  ['not-selected','Not selected','Applicant','Chair-approved message.'],
  ['mentor-invitation','Mentor invitation','Prospective mentor','Chair-approved invitation.'],
  ['match-introduction','Match introduction','Matched participants','Chair personalizes and approves the introduction.'],
  ['training-invitation','Training invitation','Selected participants','Chair fills in the meeting details and approves sending.']
])await add(id,heading,to,when,manualTemplate(heading));
for(const role of ['mentee','mentor'])await add('chair-application-'+role,'New '+role+' application','Chair','Automatic notice after an application is saved.',chairApplicationMessage('{{applicant_name}}',role));
const render=messageRenderer('https://example.invalid');
await add('first-meeting','First meeting confirmation','Mentee','Day after the booked meeting. The same wording is repeated on days 7 and 14 if unanswered.',render({id:'example',kind:'first',mentor_name:'{{mentor_name}}',first_meeting_date:'{{first_meeting_date}}'},'initial',null));
for(const period of [3,6,9])await add('check-in-'+period,'Month '+period+' check-in','Mentee and mentor','Automatic, measured from confirmed first attendance.',render({id:'example',kind:'quarterly',role:'mentee',period},'initial','FICTIONAL-LINK'));
for(const role of ['mentee','mentor'])for(const period of [12,0])await add('final-'+role+'-'+period,(period?'Month 12':'Early ending')+': '+role,role,'Final feedback. Each role receives its own questions.',render({id:'example',kind:'final',role,period},'initial','FICTIONAL-LINK'));
for(const day of [7,14])await add('reminder-'+day,'Day '+day+' reminder','Participant who has not replied','Automatic for quarterly and final check-ins. First-meeting reminders use the confirmation above.',render({id:'example',kind:'quarterly',role:'mentee',period:3},'reminder-'+day,'FICTIONAL-LINK'));
for(const [kind,label] of Object.entries({'chair-review':'Contact request, low value or unclear feedback','chair-meeting-review':'Meeting needs review','chair-deadline':'Missing response at deadline','chair-email-review':'Email needs review','chair-processing-error':'Processing problem'}))await add(kind,label,'Chair','Automatic notice. The underlying item remains open until handled.',chairNoticeMessage(kind,'{{participant_name}}','{{item_id}}'));
await add('custom-message','Other Chair-approved email','Approved recipient','The Chair supplies and approves the actual subject, body and recipient.',{subject:'{{email_subject}}',body:'Hi {{recipient_name}},\n\n{{approved_message}}\n\nIf you have any questions, reply to this email and the Mentorship Chair will get back to you.'});
await writeFile(path.join(destination,'index.html'),renderEmailCatalog(entries));
await writeFile(path.join(destination,'index.md'),'# Email examples\n\nOpen `emails/index.html` in a browser after downloading the repository. Each message is also stored as a standalone HTML file. GitHub displays HTML source rather than rendering it.\n\nAll examples are fictional. The same HTML renderer is used for outgoing email. These files are a permanent template reference, not a one-time review checklist.\n\n'+entries.map(e=>`- [${e.title}](${e.id}.html): ${e.recipient}. ${e.when}`).join('\n')+'\n\nTo regenerate after editing wording or layout, run `npm run emails`. No email is sent.\n');
console.log('Generated '+entries.length+' fictional HTML email examples in emails/.');
