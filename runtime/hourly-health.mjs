import {createProgramMailbox} from './program-mailbox.mjs';
import {runReviewSchedule} from './review-schedule.mjs';
import {inspectRecovery,withPrivateRecovery} from './recovery-cycle.mjs';
import {messageReference} from './email-replies.mjs';

export const STALE_AFTER_MS=3*60*60*1000;
export const ALERT_AFTER_MS=24*60*60*1000;
const SUCCESS_JOB='system:hourly-success';
const ALERT_JOB='system:hourly-alert';

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

function chairAlertMessage(now){
  return {
    to:null,
    subject:'Mentorship hourly job needs attention',
    body:['The hourly mentorship job did not finish a fully successful run. A backup may have failed or recovery may be pending.','Participant mail is attempted separately from backup.','Check program recovery status in the connected AI chat. If recovery is pending and no other operation is running, repair it.'].join('\n\n'),
    reference:messageReference(`${ALERT_JOB}:${String(now).slice(0,10)}`)
  };
}

async function alertChairIfDue(env,now,{mailboxFactory,stuck}){
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
  const message=chairAlertMessage(now);
  message.to=env.MODE==='review'?env.REVIEW_RECIPIENT:env.CHAIR_EMAIL;
  await mailbox.send(message);
  await writeJobTime(env.DB,ALERT_JOB,'system-hourly-alert',now);
  return {sent:true,skipped:false};
}

export async function runHourlyJob(env,now,{runSchedule=runReviewSchedule,mailboxFactory=createProgramMailbox}={}){
  const startedAt=iso(now)??new Date().toISOString();
  let schedule=null,scheduleError=null;
  try { schedule=await runSchedule(env,startedAt); }
  catch(error){ scheduleError=error; }

  let recovery;
  try { recovery=await runScheduledRecovery(env); }
  catch { recovery={status:'failed'}; }

  const fullySuccessful=!scheduleError&&recoveryFinished(recovery);
  if(fullySuccessful)await writeJobTime(env.DB,SUCCESS_JOB,'system-hourly-status',startedAt);
  let alert={sent:false,skipped:true};
  try { alert=await alertChairIfDue(env,startedAt,{mailboxFactory,stuck:!fullySuccessful}); }
  catch { console.error(JSON.stringify({event:'hourly-alert-unsent'})); alert={sent:false,skipped:false}; }
  if(scheduleError)throw scheduleError;
  return {schedule,recovery,fullySuccessful,alert};
}
