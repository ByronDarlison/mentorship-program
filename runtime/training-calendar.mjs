import {InputError,sha256} from './applications.mjs';
import {escapeHTML} from './email-html.mjs';
import content from '../website/dist/check-in-config.json' with {type:'json'};

// Google owns the event and RSVP record. No second calendar or attendance store.
const marker='mentorship-training';
const fail=(message,status=409)=>{throw new InputError(message,status);};
const eventId=value=>typeof value==='string'&&/^[0-9a-f]{32}$/.test(value);
function own(event){
  if(event?.extendedProperties?.private?.program!==marker)fail('This is not a program-created training event.');
  return event;
}
function summary(event){
  return {eventId:event.id,status:event.status,etag:event.etag,title:event.summary,start:event.start,end:event.end,
    calendarLink:event.htmlLink,organizer:event.organizer,description:event.description,
    attendees:(event.attendees??[]).map(a=>({email:a.email,name:a.displayName,response:a.responseStatus??'needsAction'})),
    attendanceRecorded:false};
}
async function calendar(env,fetcher=fetch){
  if(env.PROGRAM_CALENDAR_ENABLED!=='true'||env.PROGRAM_MAILBOX_VERIFIED!=='true')fail('Program calendar is not connected. Calendar permission and activation are required.',503);
  if(!env.GOOGLE_CLIENT_ID||!env.GOOGLE_CLIENT_SECRET||!env.GOOGLE_REFRESH_TOKEN||!env.PROGRAM_MAILBOX)fail('Program Google connection is incomplete.',503);
  const auth=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,refresh_token:env.GOOGLE_REFRESH_TOKEN,grant_type:'refresh_token'}),signal:AbortSignal.timeout(20000)});
  if(!auth.ok)fail('Program Google authorization failed.',503);
  const token=await auth.json();if(!token.access_token)fail('Program Google authorization failed.',503);
  const headers={Authorization:'Bearer '+token.access_token,'Content-Type':'application/json'};
  const profile=await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers,signal:AbortSignal.timeout(20000)});
  if(!profile.ok||(await profile.json()).emailAddress?.toLowerCase()!==env.PROGRAM_MAILBOX.toLowerCase())fail('Google account does not match the program mailbox.',503);
  return async(path='',method='GET',body,etag)=>{
    let response;
    try{response=await fetcher('https://www.googleapis.com/calendar/v3/calendars/primary/events'+path,{method,headers:{...headers,...(etag?{'If-Match':etag}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});}
    catch{fail('Calendar result is uncertain. Read the event before retrying the same action. Do not create a new event ID.',503);}
    if([404,410].includes(response.status)&&method==='GET')return null;
    if(!response.ok)fail(response.status===412?'Calendar event changed. Review it again.':`Calendar request failed (${response.status}). Read the event before retrying.`,response.status===412?409:503);
    return response.status===204?null:response.json();
  };
}
export async function inspectTrainingCalendar(env,params={},fetcher){
  const api=await calendar(env,fetcher);
  if(params.eventId){
    if(!eventId(params.eventId))fail('Use the event ID returned by the program.');
    const event=await api('/'+params.eventId);
    return event?summary(own(event)):{eventId:params.eventId,status:'not-found'};
  }
  const query=new URLSearchParams({privateExtendedProperty:'program='+marker,maxResults:'100',showDeleted:'false'});
  if(params.pageToken)query.set('pageToken',params.pageToken);
  const page=await api('?'+query);
  return {events:(page.items??[]).map(summary),nextPageToken:page.nextPageToken??null};
}
async function proposal(db,params,env,current){
  const {action,id,eventId:target}=params;
  if(!['create','update','cancel'].includes(action)||!eventId(id)||!eventId(target))fail('Use create, update or cancel with a stable 32-character lowercase hex action ID and event ID.');
  if(action==='create'&&id!==target)fail('For creation, use the action ID as the event ID.');
  if(action!=='create'&&!current)fail('Training event not found.');
  if(current)own(current);
  if(current?.status==='cancelled')fail('This training event is cancelled.');
  if(action==='cancel')return {action,id,eventId:target,etag:current.etag,event:summary(current),effect:'Cancel this event and notify its guests. Training attendance and pair dates are unchanged.'};
  if(!Array.isArray(params.applicationIds)||!params.applicationIds.length||params.applicationIds.length>100||new Set(params.applicationIds).size!==params.applicationIds.length)fail('Select the participants to invite.');
  const attendees=[],versions=[];
  for(const appId of [...params.applicationIds].sort()){
    if(typeof appId!=='string')fail('Select valid participants.');
    const row=await db.prepare('SELECT * FROM applications WHERE id=?').bind(appId).first();
    const pair=await db.prepare("SELECT id,version FROM pairs WHERE (mentee_id=? OR mentor_id=?) AND status='matched' ORDER BY id").bind(appId,appId).all();
    if(!row||row.decision!=='approved'||row.retention==='delete-requested'||row.details_removed_at||!pair.results.length)fail('Training recipients must be approved, matched participants awaiting the start of mentoring.');
    const answers=JSON.parse(row.answers);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answers.email??''))fail('Participant email is unavailable.');
    if(!attendees.some(a=>a.email.toLowerCase()===answers.email.toLowerCase()))attendees.push({email:answers.email,displayName:answers.name});
    versions.push([row.id,row.version,pair.results]);
  }
  const stamp=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;
  if(!stamp.test(params.start??'')||!Number.isFinite(Date.parse(params.start)))fail('Supply a start date and time with seconds and UTC offset.');
  try{new Intl.DateTimeFormat('en',{timeZone:params.timeZone}).format();if(!params.timeZone)throw Error();}catch{fail('Supply an IANA time zone, such as America/Toronto.');}
  let zoom;try{zoom=new URL(params.zoomUrl);}catch{fail('Supply the Zoom joining link.');}
  if(zoom.protocol!=='https:'||!(zoom.hostname==='zoom.us'||zoom.hostname.endsWith('.zoom.us'))||zoom.username||zoom.password)fail('Supply an HTTPS Zoom joining link.');
  for(const field of ['zoomMeetingId','zoomPasscode'])if(params[field]!==undefined&&(typeof params[field]!=='string'||params[field].length>150||/[\r\n{}]/.test(params[field])))fail('Invalid Zoom detail.');
  const end=new Date(Date.parse(params.start)+3600000).toISOString();
  const date=new Date(params.start),format=options=>new Intl.DateTimeFormat('en-CA',{timeZone:params.timeZone,...options}).format(date);
  const vars={training_date:format({dateStyle:'full'}),start_time:format({timeStyle:'short'}),end_time:new Intl.DateTimeFormat('en-CA',{timeZone:params.timeZone,timeStyle:'short'}).format(new Date(end)),time_zone:params.timeZone,organizer_name:'Mentorship Chair',organizer_email:env.PROGRAM_MAILBOX,zoom_join_link:`[Join Zoom](${zoom.href})`,zoom_meeting_id:params.zoomMeetingId??'',zoom_passcode:params.zoomPasscode??''};
  let text=content.messages.training.body;
  if(!vars.zoom_meeting_id)text=text.replace(/^Meeting ID:.*\n?/m,'');
  if(!vars.zoom_passcode)text=text.replace(/^Passcode:.*\n?/m,'');
  text=text.replace(/\{\{(\w+)\}\}/g,(_,key)=>vars[key]??'{{'+key+'}}');
  if(/\{\{/.test(text))fail('Complete every training invitation variable.');
  const description=escapeHTML(text).replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g,'<a href="$2">$1</a>').replace(/\n/g,'<br>');
  const oldAttendees=current?.attendees??[];
  const event={summary:content.messages.training.subject.replace('{{training_date}}',vars.training_date),description,location:zoom.href,start:{dateTime:params.start,timeZone:params.timeZone},end:{dateTime:end,timeZone:params.timeZone},
    attendees:attendees.map(a=>({...a,...(oldAttendees.find(old=>old.email.toLowerCase()===a.email.toLowerCase())?.responseStatus?{responseStatus:oldAttendees.find(old=>old.email.toLowerCase()===a.email.toLowerCase()).responseStatus}:{})})),
    guestsCanModify:false,guestsCanInviteOthers:false,guestsCanSeeOtherGuests:false,visibility:'private'};
  const removedGuests=oldAttendees.filter(old=>!attendees.some(a=>a.email.toLowerCase()===old.email.toLowerCase())).map(a=>({email:a.email,name:a.displayName}));
  return {action,id,eventId:target,etag:current?.etag??null,event,versions,removedGuests,effect:'Send calendar invitations or updates to these guests, including removal notices for removed guests. RSVP is not training attendance. No pair dates change.'};
}
export async function previewTrainingCalendar(db,params,env,fetcher){
  let current=null;
  if(params.action!=='create'){
    if(!eventId(params.eventId))fail('Use the program event ID.');
    current=await (await calendar(env,fetcher))('/'+params.eventId);
  }
  const draft=await proposal(db,params,env,current);
  return {...draft,reviewHash:await sha256(JSON.stringify(draft)),connected:env.PROGRAM_CALENDAR_ENABLED==='true'};
}
export async function executeTrainingCalendar(db,params,env,fetcher){
  if(env.MODE!=='operating')fail('Calendar sending is disabled in review mode.',403);
  if(!eventId(params.eventId)||!eventId(params.id)||!params.reviewHash)fail('An approved calendar proposal is required.');
  const api=await calendar(env,fetcher),current=await api('/'+params.eventId);
  const fingerprint=await sha256(JSON.stringify(Object.fromEntries(Object.entries(params).sort(([a],[b])=>a.localeCompare(b)))));
  if(current?.extendedProperties?.private?.lastAction===fingerprint)return {event:summary(own(current)),alreadyApplied:true};
  const draft=await proposal(db,params,env,current);
  if(await sha256(JSON.stringify(draft))!==params.reviewHash)fail('Calendar proposal or participant records changed. Review a fresh proposal.');
  if(params.action==='create'&&current)fail('Event ID already exists. Inspect it rather than creating another.');
  const properties={private:{...current?.extendedProperties?.private,program:marker,lastAction:fingerprint}};
  // Cancel with a conditional patch, retaining the action marker for safe retries.
  const body=params.action==='cancel'?{status:'cancelled',extendedProperties:properties}:{...draft.event,extendedProperties:properties,...(params.action==='create'?{id:params.eventId}:{})};
  const saved=await api(params.action==='create'?'?sendUpdates=all':'/'+params.eventId+'?sendUpdates=all',params.action==='create'?'POST':'PATCH',body,current?.etag);
  return {event:summary(saved),attendanceRecorded:false};
}
