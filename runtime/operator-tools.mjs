import {z} from 'zod';
import {createOperatorConnection} from './operator-connection.mjs';
import {signOperatorRequest} from './operator-api.mjs';

// This module is not the registered entry point. Keep the actual local server
// on the harmless probe until chat actions are separately enabled.
export function createAdministrativeConnection({callBackend,chatActionsEnabled=false}={}){
  const server=createOperatorConnection();
  if(typeof callBackend!=='function')return server;
  const programActionInput={operation:z.enum(['administration','end_relationship','delete_participant','finish_final_review','correct_cycle','correct_classification','message_action','repair_recovery']),params:z.record(z.string(),z.unknown())};
  server.registerTool('program_records',{description:'Read the fictional program records. Does not change records or send messages.',inputSchema:{},annotations:{readOnlyHint:true}},async()=>({content:[{type:'text',text:JSON.stringify(await callBackend('inspect',{}))}]}));
  server.registerTool('program_results',{description:'Read the four separate mentorship outcome measures and completion totals.',inputSchema:{},annotations:{readOnlyHint:true}},async()=>({content:[{type:'text',text:JSON.stringify(await callBackend('report',{}))}]}));
  server.registerTool('program_recovery_status',{description:'Read whether private recovery is ready or needs attention. No records or backups are changed.',inputSchema:{},annotations:{readOnlyHint:true}},async()=>({content:[{type:'text',text:JSON.stringify(await callBackend('recovery_status',{}))}]}));
  server.registerTool('program_followups',{description:'Read check-in answers, classifications, missing answers, deadlines and message status. No records are changed.',inputSchema:{},annotations:{readOnlyHint:true}},async()=>({content:[{type:'text',text:JSON.stringify(await callBackend('followups',{}))}]}));
  server.registerTool('program_recommendations',{description:'Compare approved fictional applications and suggest matches with reasons, risks and questions. Does not approve a match or send an introduction. Requires the separately configured review AI connection.',inputSchema:{},annotations:{readOnlyHint:true}},async()=>({content:[{type:'text',text:JSON.stringify(await callBackend('recommend',{}))}]}));
  server.registerTool('program_prepare_action',{
    description:'Prepare one exact named action from current records and return the proposal as text. Does not change records or send messages.',
    inputSchema:programActionInput,
    annotations:{readOnlyHint:true}
  },async({operation,params})=>{
    let deletionPreview,finalReviewPreview,snapshot,request,messagePreview,recoveryPreview;
    try{
      deletionPreview=operation==='delete_participant'?await callBackend('deletion_preview',{applicationId:params.applicationId}):null;
      finalReviewPreview=operation==='finish_final_review'?await callBackend('final_review_preview',{applicationId:params.applicationId}):null;
      snapshot=await callBackend('inspect',{});
      if(operation==='repair_recovery'){
        recoveryPreview=await callBackend('recovery_status',{});
        if(recoveryPreview.status!=='pending'||params.previousRunStopped!==true)throw new Error('Verify that prior work stopped and review the pending recovery item.');
        params={pendingId:recoveryPreview.id,previousRunStopped:true};
        recoveryPreview={...recoveryPreview,effect:'Back up the current saved state without repeating the earlier action. Confirm only after verifying that the previous operation and scheduled work have stopped.'};
      }
      if(operation==='message_action'){
        messagePreview=await callBackend('message_preview',params);
        params={...params,reviewHash:messagePreview.reviewHash};
      }
      if(operation==='correct_classification'){
        request=(await callBackend('followups',{})).requests.find(r=>r.id===params.requestId);
        if(!request||request.version!==params.version||(!request.reviewed_at&&!Object.hasOwn(request.answers,params.field)))throw new Error('Refresh the current answer before correcting it.');
      }
    }catch{return {isError:true,content:[{type:'text',text:'Could not prepare the action from current records. No change was made.'}]};}
    if(deletionPreview)params={applicationId:params.applicationId,reviewHash:deletionPreview.reviewHash};
    if(finalReviewPreview)params={applicationId:params.applicationId,reviewHash:finalReviewPreview.reviewHash};
    const ids=new Set(['applicationId','pairId','menteeId','mentorId'].map(k=>params[k]).filter(v=>typeof v==='string'));
    if(request)ids.add(request.application_id);
    if(messagePreview?.applicationId)ids.add(messagePreview.applicationId);
    for(const pair of snapshot.pairs??[])if(ids.has(pair.id)){ids.add(pair.mentee_id);ids.add(pair.mentor_id);}
    const affected=(snapshot.applications??[]).filter(r=>ids.has(r.id)).map(r=>({id:r.id,name:r.answers.name,role:r.role}));
    return {content:[{type:'text',text:JSON.stringify({operation,params,affected,...(messagePreview?{messagePreview}:{}),...(recoveryPreview?{recoveryPreview}:{}),...(request?{currentAnswer:request.reviewed_at?'Written feedback removed after final review.':request.answers[params.field],currentClassification:request.classifications[params.field]??'Missing'}:{}),...(deletionPreview?{deletionPreview}:{}),...(finalReviewPreview?{finalReviewPreview}:{})},null,2)}]};
  });
  server.registerTool('program_action',{
    description:'Execute one exact named action using the exact operation and params already shown in a prior proposal in this chat. Call only after the user explicitly approved that exact proposal after it was shown. Tool flags and signatures do not prove consent.',
    inputSchema:programActionInput,
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true}
  },async({operation,params})=>{
    if(!chatActionsEnabled)return {isError:true,content:[{type:'text',text:'Chat actions are not enabled. No change was made.'}]};
    const saved=await callBackend(operation,params);
    return {content:[{type:'text',text:JSON.stringify({savedResult:saved})}]};
  });
  return server;
}

export function remoteOperatorBackend({origin,operator,secret,fetcher=fetch}){
  const url=new URL('/api/operator',origin);
  if(url.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('Operator connection requires HTTPS.');
  return async(operation,params)=>{
    const envelope=await signOperatorRequest(operation,params,operator,secret);
    const response=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(envelope),signal:AbortSignal.timeout(20000)});
    const result=await response.json();if(!response.ok)throw new Error(result.error??'Operator action failed.');return result;
  };
}
