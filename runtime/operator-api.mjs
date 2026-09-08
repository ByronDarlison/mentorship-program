import {InputError} from './applications.mjs';
import {inspectProgram,executeChairAction} from './administration.mjs';
import {previewDeletion,programReport,deleteParticipant} from './privacy.mjs';
import {endRelationship} from './lifecycle.mjs';
import {inspectFollowups} from './followups.mjs';
import {correctRecord} from './corrections.mjs';
import {recommendMatches} from './matching.mjs';
import {createReviewAI} from './review-ai.mjs';
import {previewMessageAction,executeMessageAction} from './message-actions.mjs';
import {inspectTrainingCalendar,previewTrainingCalendar,executeTrainingCalendar} from './training-calendar.mjs';
import {previewFinalReview,finishFinalReview} from './retention.mjs';
import {withPrivateRecovery,inspectRecovery,repairPrivateRecovery,readCurrentRecovery,recoveryStorage} from './recovery-cycle.mjs';

const encoder=new TextEncoder();
async function key(secret){return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
const bytes=hex=>Uint8Array.from(hex.match(/../g)??[],x=>parseInt(x,16));
export async function signOperatorRequest(operation,params,operator,secret,now=Date.now()){
  const payload={operation,params,operator,expiresAt:now+120000};
  const signature=[...new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret),encoder.encode(JSON.stringify(payload))))].map(x=>x.toString(16).padStart(2,'0')).join('');
  return {payload,signature};
}
export async function handleOperatorRequest(db,envelope,env,now=Date.now()){
  const {payload,signature}=envelope??{};
  // Thirty seconds of upper-bound skew allows ordinary client clock drift.
  // Expired requests still fail without a grace period.
  if(!['review','operating'].includes(env.MODE)||!env.OPERATOR_BRIDGE_SECRET||!env.OPERATOR_ID||!payload||payload.operator!==env.OPERATOR_ID||!Number.isFinite(payload.expiresAt)||payload.expiresAt<now||payload.expiresAt>now+150000||!/^[0-9a-f]{64}$/.test(signature??''))throw new InputError('Operator authentication required.',401);
  if(!await crypto.subtle.verify('HMAC',await key(env.OPERATOR_BRIDGE_SECRET),bytes(signature),encoder.encode(JSON.stringify(payload))))throw new InputError('Operator authentication required.',401);
  if(Object.keys(payload).some(k=>!['operation','params','operator','expiresAt'].includes(k)))throw new InputError('Unexpected operator request.');
  const {operation,params}=payload;
  if(!['inspect','followups','recommend','report','recovery_status','repair_recovery','backup_now','export_recovery','deletion_preview','final_review_preview','finish_final_review','message_preview','message_action','calendar_events','calendar_preview','calendar_action','administration','end_relationship','delete_participant','correct_cycle','correct_classification'].includes(operation))throw new InputError('Unknown named operator action.');
  if(!params||Array.isArray(params)||typeof params!=='object')throw new InputError('Operator parameters must be an object.');
  if(operation==='inspect')return inspectProgram(db);
  if(operation==='followups')return inspectFollowups(db);
  if(operation==='recommend')return recommendMatches(db,createReviewAI({apiKey:env.REVIEW_OPENAI_API_KEY,spendingVerified:env.REVIEW_AI_SPENDING_VERIFIED==='true',fixturesOnly:env.MODE==='review',db}),{fixturesOnly:env.MODE==='review'});
  if(operation==='report')return programReport(db);
  if(operation==='recovery_status')return inspectRecovery({...env,DB:db});
  if(operation==='backup_now'||operation==='export_recovery'){
    if(Object.keys(params).length)throw new InputError('Unexpected operator request.');
    if(env.PRIVATE_RECOVERY_VERIFIED!=='true')throw new InputError('Private recovery is not connected.',503);
    if(operation==='backup_now')return {recovery:(await withPrivateRecovery({...env,DB:db},async()=>{})).recovery};
    return readCurrentRecovery(recoveryStorage(env));
  }
  if(operation==='deletion_preview')return previewDeletion(db,params.applicationId);
  if(operation==='final_review_preview')return previewFinalReview(db,params.applicationId);
  if(operation==='message_preview')return previewMessageAction(db,params,env);
  if(operation==='calendar_events')return inspectTrainingCalendar(env,params);
  if(operation==='calendar_preview')return previewTrainingCalendar(db,params,env);
  if(operation==='administration'&&params.name==='approve_match'&&!params.introduction)throw new InputError('Review the match and its introduction together before approving.');
  if(env.CHAT_ACTIONS_ENABLED!=='true')throw new InputError('Chat actions are not enabled. No change was made.',403);
  const execute=()=>{
    if(operation==='calendar_action')return executeTrainingCalendar(db,params,env);
    if(operation==='message_action')return executeMessageAction(db,params,env.OPERATOR_ID,env);
    if(['correct_cycle','correct_classification'].includes(operation))return correctRecord(db,operation,params,env.OPERATOR_ID);
    if(operation==='delete_participant')return deleteParticipant(db,params,env.OPERATOR_ID);
    if(operation==='finish_final_review')return finishFinalReview(db,params,env.OPERATOR_ID);
    if(operation==='administration')return executeChairAction(db,params,env.OPERATOR_ID,env);
    if(operation==='end_relationship')return endRelationship(db,params,env.OPERATOR_ID);
    throw new InputError('Unknown named operator action.');
  };
  try{
    const saved=operation==='repair_recovery'?await repairPrivateRecovery({...env,DB:db},params):await withPrivateRecovery({...env,DB:db},execute);
    return {...saved.value,recovery:saved.recovery};
  }catch(error){
    if(!(error instanceof InputError)||error.status>=500){
      console.error(JSON.stringify({event:'operator-needs-attention'}));
    }
    throw error;
  }
}
