import {runFollowups} from './followups.mjs';
import {messageRenderer} from './templates.mjs';
import {createProgramMailbox} from './program-mailbox.mjs';
import {synchronizeReviewEmail} from './email-replies.mjs';
import {createReviewAI} from './review-ai.mjs';
import {deliverReviewJobs} from './review-delivery.mjs';
import {queueChairNotifications} from './chair-notifications.mjs';

export async function runReviewSchedule(env,now,{mailboxFactory=createProgramMailbox}={}){
  if(!['review','operating'].includes(env.MODE))throw new Error('Operation is not enabled.');
  const fixturesOnly=env.MODE==='review';
  const recipient=fixturesOnly?env.REVIEW_RECIPIENT:undefined;
  const deliveryOptions={mode:env.MODE,chairEmail:env.CHAIR_EMAIL,recipient};
  const previouslyConnected=Boolean(await env.DB.prepare("SELECT id FROM jobs WHERE id='system:mailbox-connected'").first());
  let inboxHealthy=env.MAIL_MODE==='capture-only'&&!previouslyConnected&&env.REVIEW_DELIVERY_VERIFIED!=='true',mailStatus=inboxHealthy?'not-connected':'configuration-missing';
  const delivery=env.REVIEW_DELIVERY_VERIFIED==='true';let mailbox;
  if(env.PROGRAM_MAILBOX_VERIFIED==='true'){
    try{
      mailbox=mailboxFactory({mailbox:env.PROGRAM_MAILBOX,chairEmail:env.CHAIR_EMAIL,clientId:env.GOOGLE_CLIENT_ID,clientSecret:env.GOOGLE_CLIENT_SECRET,refreshToken:env.GOOGLE_REFRESH_TOKEN,connectionVerified:true,deliveryVerified:delivery,reviewRecipient:recipient,mode:env.MODE});
      let messages=await mailbox.readMessages();
      // A new operating installation must not import the mailbox's old review
      // traffic. Missing dates remain visible for manual review, not discarded.
      if(env.MODE==='operating'&&env.MAILBOX_START_AT){
        const start=Date.parse(env.MAILBOX_START_AT);
        if(!Number.isFinite(start))throw new Error('Invalid mailbox start date.');
        messages=messages.filter(m=>!Number.isFinite(Number(m.internalDate))||Number(m.internalDate)>=start);
      }
      await env.DB.prepare("INSERT OR IGNORE INTO jobs(id,kind,status,payload,created_at) VALUES('system:mailbox-connected','system-mailbox-state','captured','{}',?)").bind(now).run();
      if(delivery)await deliverReviewJobs(env.DB,{enabled:true,inboxHealthy:true,...deliveryOptions,mailbox,reconcileOnly:true});
      const ai=env.REVIEW_AI_SPENDING_VERIFIED==='true'?createReviewAI({apiKey:env.REVIEW_OPENAI_API_KEY,spendingVerified:true,fixturesOnly,db:env.DB}):null;
      const sync=await synchronizeReviewEmail(env.DB,messages,{fixturesOnly,...(ai?{interpret:ai.interpretReply,classify:ai.classify}:{}),...(delivery&&fixturesOnly?{reviewRecipient:recipient}:{})});
      inboxHealthy=sync.healthy;mailStatus=inboxHealthy?'synchronized':'processing-failed';
    }catch{inboxHealthy=false;mailStatus='connection-failed';}
  }
  if(!inboxHealthy)await env.DB.prepare("INSERT INTO jobs(id,kind,status,payload,created_at) VALUES('system:mailbox-error','chair-mailbox-error','held',?,?) ON CONFLICT(id) DO UPDATE SET status='held',payload=excluded.payload")
    .bind(JSON.stringify({reason:mailStatus}),now).run();
  else await env.DB.prepare("UPDATE jobs SET status='cancelled' WHERE id='system:mailbox-error'").run();
  if(delivery&&!mailbox)inboxHealthy=false;
  const result=await runFollowups(env.DB,{mode:env.MODE,inboxHealthy,now,renderMessage:messageRenderer(env.SITE_ORIGIN),delivery});
  const notifications=await queueChairNotifications(env.DB,{delivery,now});
  const deliveryResult=delivery&&inboxHealthy?await deliverReviewJobs(env.DB,{enabled:true,inboxHealthy,...deliveryOptions,mailbox}):null;
  return {...result,mailStatus,notifications,...(deliveryResult?{delivery:deliveryResult,alertFailures:[...(result.alertFailures??[]),...(deliveryResult.alertFailures??[])]}:{})};
}
