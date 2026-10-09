import {createProgramMailbox} from './program-mailbox.mjs';
import {runReviewSchedule} from './review-schedule.mjs';
import {inspectRecovery,withPrivateRecovery} from './recovery-cycle.mjs';
import {messageReference} from './email-replies.mjs';
import {formatFailureClass,normalizeFailureClass} from './backblaze.mjs';

export const STALE_AFTER_MS=3*60*60*1000;
export const ALERT_AFTER_MS=24*60*60*1000;
const SUCCESS_JOB='system:hourly-success';
const ALERT_JOB='system:hourly-alert';
const FAILURE_JOB='system:hourly-failure';

function iso(value){
  const parsed=Date.parse(value);
  return Number.isFinite(parsed)?new Date(parsed).toISOString():null;
}

async function readJobTime(db,id){
  if(!db||typeof db.prepare!=='function')return null;
  const row=await db.prepare('SELECT payload,created_at FROM jobs WHERE id=?').bind(id).first();
  if(!row)return null;
  try {
    const at=JSON.parse(row.payload)?.at;
    return iso(at)??iso(row.created_at);
  } catch { return iso(row.created_at); }
}

async function writeJobTime(db,id,kind,at){
  const payload=JSON.stringify({at});
  await db.prepare("INSERT INTO jobs(id,kind,status,payload,created_at) VALUES(?,?,'captured',?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,created_at=excluded.created_at").bind(id,kind,payload,at).run();
}

async function readFailureRecord(db){
  if(!db||typeof db.prepare!=='function')return {count:0,class:null};
  const row=await db.prepare('SELECT payload FROM jobs WHERE id=?').bind(FAILURE_JOB).first();
  if(!row)return {count:0,class:null};
  try{
    const payload=JSON.parse(row.payload);
    const count=Number.isSafeInteger(payload?.count)&&payload.count>=0?payload.count:0;
    return {count,class:normalizeFailureClass(payload?.class)};
  }catch{return {count:0,class:null};}
}

async function writeFailureRecord(db,at,count,failureClass){
  const body={at,count};
  const normalized=normalizeFailureClass(failureClass);
  if(normalized)body.class=normalized;
  await db.prepare("INSERT INTO jobs(id,kind,status,payload,created_at) VALUES(?,?,'captured',?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,created_at=excluded.created_at").bind(FAILURE_JOB,'system-hourly-failure',JSON.stringify(body),at).run();
}

function scheduleFailureClass(error){
  const existing=normalizeFailureClass(error?.failureClass);
  if(existing?.source==='schedule')return existing;
  const fault=error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':'unusable-response';
  return {source:'schedule',fault};
}

export async function lastSuccessfulHourlyRun(env){
  return readJobTime(env.DB,SUCCESS_JOB);
}

export async function hourlyStatus(env,now=new Date().toISOString()){
  const lastSuccessfulRun=await lastSuccessfulHourlyRun(env);
  const current=iso(now)??new Date().toISOString();
  const stale=!lastSuccessfulRun||Date.parse(current)-Date.parse(lastSuccessfulRun)>STALE_AFTER_MS;
  return {ok:!stale,lastSuccessfulRun,stale};
}

function recoveryFinished(recovery){
  return recovery?.status==='verified'||recovery?.status==='not-connected';
}

async function runScheduledRecovery(env){
  if(env.PRIVATE_RECOVERY_VERIFIED!=='true')return {status:'not-connected'};
  const current=await inspectRecovery(env);
  if(current.status==='pending'&&current.startedBy==='scheduled'&&current.id){
    return (await withPrivateRecovery(env,async()=>({repaired:true}),{repairPendingId:current.id,startedBy:'scheduled'})).recovery;
  }
  if(current.status==='pending')return current;
  return (await withPrivateRecovery(env,async()=>({}),{startedBy:'scheduled'})).recovery;
}

function chairAlertMessage(now,failureClass){
  const lines=['The hourly mentorship job did not finish a fully successful run. A backup may have failed or recovery may be pending.','Participant mail is attempted separately from backup.','Check program recovery status in the connected AI chat. If recovery is pending and no other operation is running, repair it.'];
  const classText=formatFailureClass(failureClass);
  if(classText)lines.push('Failure class: '+classText);
  return {
    to:null,
    subject:'Mentorship hourly job needs attention',
    body:lines.join('\n\n'),
    reference:messageReference(`${ALERT_JOB}:${String(now).slice(0,10)}`)
  };
}

async function alertChairIfDue(env,now,{mailboxFactory,stuck,failureClass}){
  if(!stuck)return {sent:false,skipped:true};
  const previous=await readJobTime(env.DB,ALERT_JOB);
  if(previous&&Date.parse(now)-Date.parse(previous)<ALERT_AFTER_MS)return {sent:false,skipped:true};
  if(env.PROGRAM_MAILBOX_VERIFIED!=='true'||env.REVIEW_DELIVERY_VERIFIED!=='true'||!['review','operating'].includes(env.MODE)){
    console.error(JSON.stringify({event:'hourly-alert-unsent'}));
    return {sent:false,skipped:false};
  }
  const mailbox=mailboxFactory({
    mailbox:env.PROGRAM_MAILBOX,chairEmail:env.CHAIR_EMAIL,clientId:env.GOOGLE_CLIENT_ID,clientSecret:env.GOOGLE_CLIENT_SECRET,refreshToken:env.GOOGLE_REFRESH_TOKEN,
    connectionVerified:true,deliveryVerified:true,reviewRecipient:env.REVIEW_RECIPIENT,mode:env.MODE
  });
  const message=chairAlertMessage(now,failureClass);
  message.to=env.MODE==='review'?env.REVIEW_RECIPIENT:env.CHAIR_EMAIL;
  await mailbox.send(message);
  await writeJobTime(env.DB,ALERT_JOB,'system-hourly-alert',now);
  return {sent:true,skipped:false};
}

export async function runHourlyJob(env,now,{runSchedule=runReviewSchedule,mailboxFactory=createProgramMailbox}={}){
  const startedAt=iso(now)??new Date().toISOString();
  let schedule=null,scheduleError=null,scheduleClass=null;
  try { schedule=await runSchedule(env,startedAt); }
  catch(error){ scheduleError=error; scheduleClass=scheduleFailureClass(error); }

  let before=null;
  try { before=await inspectRecovery(env); } catch { before=null; }

  let recovery,recoveryClass=null;
  try { recovery=await runScheduledRecovery(env); }
  catch(error){
    recoveryClass=normalizeFailureClass(error?.failureClass);
    let after=null;
    try { after=await inspectRecovery(env); } catch { after=null; }
    const scheduledPendingAtStart=before?.status==='pending'&&before?.startedBy==='scheduled';
    recovery=scheduledPendingAtStart&&after?.status==='pending'?after:{status:'failed'};
  }

  const fullySuccessful=!scheduleError&&recoveryFinished(recovery);
  const operatorPending=recovery?.status==='pending'&&recovery?.startedBy==='operator';
  const scheduledStillPending=before?.status==='pending'&&before?.startedBy==='scheduled'&&recovery?.status==='pending';
  const failureClass=fullySuccessful?null:operatorPending?{source:'operator-pending'}:recoveryClass??(scheduleError?scheduleClass:normalizeFailureClass({source:'backup',step:'database-confirmation',fault:'unusable-response'}));
  const previousFailure=await readFailureRecord(env.DB);
  const failureCount=fullySuccessful?0:previousFailure.count+1;
  if(fullySuccessful)await writeJobTime(env.DB,SUCCESS_JOB,'system-hourly-status',startedAt);
  await writeFailureRecord(env.DB,startedAt,failureCount,failureClass);
  const stuck=!fullySuccessful&&(operatorPending||scheduledStillPending||failureCount>=2);
  let alert={sent:false,skipped:true};
  try { alert=await alertChairIfDue(env,startedAt,{mailboxFactory,stuck,failureClass}); }
  catch { console.error(JSON.stringify({event:'hourly-alert-unsent'})); alert={sent:false,skipped:false}; }
  if(scheduleError)throw scheduleError;
  return {schedule,recovery,fullySuccessful,alert};
}
