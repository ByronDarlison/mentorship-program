import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {renderEmailHTML,escapeHTML} from '../email-html.mjs';
import {renderEmailCatalog} from '../email-catalog.mjs';
import {messageRenderer,reminderTemplate} from '../templates.mjs';
import {chairNoticeMessage} from '../chair-notifications.mjs';
import {chairApplicationMessage} from '../applications.mjs';

// Static, fictional examples only. This script has no database or mail client.
const root=fileURLToPath(new URL('../../',import.meta.url));
const source=await readFile(path.join(root,'program/program-manual.md'),'utf8');
const destination=path.join(root,'emails');
await mkdir(destination,{recursive:true});
const entries=[];
const exampleValues={
  applicant_name:'Alex Morgan',participant_name:'Alex Morgan',recipient_name:'Alex',
  mentor_name:'Jordan Lee',first_meeting_date:'March 15, 2026',
  training_date:'March 10, 2026',start_time:'10:00 a.m.',end_time:'11:00 a.m.',time_zone:'America/Toronto',
  organizer_name:'Taylor Chen',organizer_email:'chair@example.invalid',
  zoom_join_link:'https://example.invalid/fictional-zoom-meeting',zoom_meeting_id:'123 456 7890',zoom_passcode:'EXAMPLE',
  reason_for_this_match:'Jordan has experience building a sales team, which fits Alex’s goal of making sales less dependent on the founder.',
  item_id:'example-review-1042',email_subject:'Following up on your mentorship',
  approved_message:'Thank you for letting us know about the change in your schedule. I will follow up with you next week to see how things are going.\n\nBest,\nTaylor'
};
const sampleHistory=(period,role='mentee')=>({countFrom:{6:'2026-06-15',9:'2026-09-15',12:'2026-12-15'}[period],fromStart:false,previousUnanswered:null,lastReport:{date:{6:'2026-06-15',9:'2026-09-15',12:'2026-12-15'}[period],period:period-3,answers:{meetings:3,value:role==='mentor'?'The conversations have helped me question some of my own assumptions about leading a sales team.':'Talking things through with Jordan helped me see that I was still holding on to sales decisions my team could make. I have started handing those decisions over.'}}});
function finishedExample(id,message){
  const period=Number(id.split('-').at(-1));
  if(id.startsWith('reminder-'))return render({id:'fictional',kind:'quarterly',role:'mentee',period:6,history:sampleHistory(6)},'reminder-'+period,null);
  if(id.startsWith('check-in-')||id.startsWith('final-')){
    const role=id.startsWith('final-')?id.split('-')[1]:'mentee';
    return render({id:'fictional',kind:id.startsWith('final-')?'final':'quarterly',role,period,...([6,9,12].includes(period)?{history:sampleHistory(period,role)}:{})},'initial',null);
  }
  const fill=text=>text.replace(/\{\{([a-z_]+)\}\}/g,(_,key)=>{
    if(!(key in exampleValues))throw new Error('Missing fictional value: '+key);
    return exampleValues[key];
  });
  return {subject:fill(message.subject),body:fill(message.body??message.text)};
}
const render=messageRenderer('https://example.invalid');
function behavior(id){
  const manualReply='If the reply reaches the program mailbox, it is flagged for the Chair rather than applied automatically. The Chair handles it and approves any record change in chat.';
  const feedbackReply='The software matches the sender and request, records the answers and classifies feedback. A genuine reply stops that person’s no-response reminders. Missing answers keep the original deadline; unclear answers and requests for help go to the Chair. Automatic replies do not count.';
  const triggers={
    'applications-open':'The Chair decides to invite applications and approves the wording and recipients. No automatic campaign is scheduled.',
    'application-received':'An applicant successfully submits either application. The system queues the receipt after saving it.',
    'moving-to-matching':'After the readiness decision, the Chair chooses to tell the applicant they are moving to matching and approves this message. Approval of an application alone does not send it.',
    'not-selected':'The Chair decides not to offer a place and separately approves this message. A decision alone does not send it.',
    'mentor-invitation':'The Chair chooses a prospective mentor and approves the invitation. It is not sent automatically.',
    'match-introduction':'The Chair reviews the pair and complete introduction together. One approval records the match and queues this introduction for both participants. Each copy includes both people’s names, roles and contact details.',
    'training-invitation':'After matching, the Chair selects participants, supplies a one-hour date/time slot, time zone and Zoom link, then approves the exact calendar invitation. Google Calendar sends the event once calendar access is configured and enabled. The code is implemented; calendar setup, testing and release are still pending.',
    'first-meeting':'After both participants complete training, the day after the planned first meeting. If unanswered, the same request is repeated 7 and 14 days after the first email; the Chair is notified at day 21.',
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
  if(id.startsWith('reminder-'))return {trigger:id.split('-').at(-1)+' days after the original check-in was sent, only if that participant has not genuinely replied and the request is still active. Preview variables: {{check_in_label}} is the original month or final check-in; {{check_in_context}} is the previous-report recap, including its date, meeting count and feedback, or is omitted when not applicable; {{reporting_guidance}} explains the reporting period when needed; {{check_in_questions}} is the original set of questions for this participant and stage.',reply:feedbackReply+' The reply updates the original check-in, not a new request.'};
  if(id==='first-meeting')return {trigger:triggers[id],reply:'A clear attendance reply records the actual meeting date and starts the twelve-month cycle. A clear reschedule moves the booking and follow-up. An unclear reply goes to the Chair and does not start the cycle. A genuine reply stops the old no-response reminders; an automatic reply does not.'};
  if(id==='training-invitation')return {trigger:triggers[id],reply:'Google records calendar acceptance, tentative response or decline. The Chair can read current RSVPs in program chat. An RSVP does not record training attendance or move the pair forward. Ordinary email questions go to the Chair; they do not automatically reschedule the event. Chair-approved updates or cancellation use the same event.'};
  if(id.startsWith('chair-'))return {trigger:triggers[id],reply:'Replying does not resolve the item or authorize a change. The Chair handles the underlying issue in program chat. If the reply reaches the program mailbox, it is flagged for review.'};
  return {trigger:triggers[id],reply:manualReply};
}
async function add(id,title,recipient,when,message){
  const body=(message.body??message.text).replace(/\[([^\]]+)\]\(https:\/\/example\.invalid\/check-in#FICTIONAL-LINK\)/g,'$1: {{private_check_in_link}}');
  await writeFile(path.join(destination,id+'.html'),renderEmailHTML({subject:message.subject,body}));
  await writeFile(path.join(destination,id+'.md'),'# '+message.subject+'\n\n'+body+'\n');
  const example=finishedExample(id,message);
  entries.push({id,title,recipient,when,subject:message.subject,exampleSubject:example.subject,exampleHTML:renderEmailHTML(example),exampleNote:id.startsWith('reminder-')?'Fictional month 6 check-in reminder.':'Fictional details only. No email is sent.',...behavior(id)});
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
  ['match-introduction','Match introduction','Matched participants','Approved together with the match, then queued for both participants.'],
  ['training-invitation','Training invitation','Selected participants','Chair fills in the meeting details and approves sending.']
])await add(id,heading,to,when,manualTemplate(heading));
for(const role of ['mentee','mentor'])await add('chair-application-'+role,'New '+role+' application','Chair','Automatic notice after an application is saved.',chairApplicationMessage('{{applicant_name}}',role));
const history=period=>[6,9,12].includes(period)?{history:{countFrom:'{{meeting_count_start_date}}',fromStart:false,previousUnanswered:null,lastReport:{date:'{{previous_report_date}}',period:period-3,answers:{meetings:'{{previous_meeting_count}}',value:'{{previous_feedback}}'}}}}:{};
await add('first-meeting','First meeting confirmation','Mentee','Day after the booked meeting. The same wording is repeated on days 7 and 14 if unanswered.',render({id:'example',kind:'first',mentor_name:'{{mentor_name}}',first_meeting_date:'{{first_meeting_date}}'},'initial',null));
for(const period of [3,6,9])await add('check-in-'+period,'Month '+period+' check-in','Mentee and mentor','Automatic, measured from confirmed first attendance.',render({id:'example',kind:'quarterly',role:'mentee',period,...history(period)},'initial','FICTIONAL-LINK'));
for(const role of ['mentee','mentor'])for(const period of [12,0])await add('final-'+role+'-'+period,(period?'Month 12':'Early ending')+': '+role,role,'Final feedback. Each role receives its own questions.',render({id:'example',kind:'final',role,period,...history(period)},'initial','FICTIONAL-LINK'));
for(const day of [7,14])await add('reminder-'+day,'Day '+day+' reminder','Participant who has not replied','Variable template for quarterly and final check-ins. First-meeting reminders use the confirmation above.',reminderTemplate(day));
for(const [kind,label] of Object.entries({'chair-review':'Contact request, low value or unclear feedback','chair-meeting-review':'Meeting needs review','chair-deadline':'Missing response at deadline','chair-email-review':'Email needs review','chair-processing-error':'Processing problem'}))await add(kind,label,'Chair','Automatic notice. The underlying item remains open until handled.',chairNoticeMessage(kind,'{{participant_name}}','{{item_id}}'));
await add('custom-message','Other Chair-approved email','Approved recipient','The Chair supplies and approves the actual subject, body and recipient, including a closing only when it adds something useful.',{subject:'{{email_subject}}',body:'Hi {{recipient_name}},\n\n{{approved_message}}'});
await writeFile(path.join(destination,'index.html'),renderEmailCatalog(entries));
await writeFile(path.join(destination,'index.md'),'# Email examples\n\nOpen `emails/index.html` in a browser after downloading the repository. Select or scroll through the email list to see the template with insertion variables on the left and a finished fictional example on the right. Both panes update together. This viewer is designed for a large desktop screen. Each pane shows its subject; the shared information above explains the recipient, sending trigger and reply handling. Emails without insertion variables have the same content in both panes. The day 7 and day 14 examples illustrate a month 6 check-in reminder.\n\nEach template is also stored as a standalone HTML file with a matching Markdown copy. Finished examples are embedded in the catalog HTML, so the complete comparison is available from the repository. GitHub displays HTML source rather than rendering it.\n\nAll example details are fictional, including the non-working Zoom link. The same HTML renderer is used for outgoing email. Check-in examples use the delivery message renderer with fictional history. These files are a permanent template reference, not a one-time review checklist.\n\n'+entries.map(e=>`- [${e.title}](${e.id}.html): ${e.recipient}. ${e.when}`).join('\n')+'\n\nTo regenerate after editing wording or layout, run `npm run emails`. No email is sent.\n');
console.log('Generated '+entries.length+' fictional HTML email examples in emails/.');
