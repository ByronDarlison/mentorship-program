import { InputError, saveApplication } from './applications.mjs';
import policy from '../website/dist/application-config.json' with { type: 'json' };
import {checkInRequest,saveReviewCheckIn,publicRequestDetails} from './check-in-api.mjs';
import {runReviewSchedule} from './review-schedule.mjs';
import {handleOperatorRequest} from './operator-api.mjs';
import {withPrivateRecovery} from './recovery-cycle.mjs';
import {createReviewAI} from './review-ai.mjs';

const responseHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: responseHeaders });

export async function readJSON(request, limit = 40000) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new InputError('Use JSON for this request.',415);
  const reader = request.body?.getReader();
  if (!reader) throw new InputError('Missing request.');
  const chunks = []; let size = 0;
  try {
    for (;;) { const {value,done}=await reader.read(); if(done)break; size+=value.byteLength;
      if(size>limit) { await reader.cancel(); throw new InputError('This request is too large.',413); } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset=0; for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new InputError('Invalid JSON.');}
  } finally { reader.releaseLock(); }
}

export default {
  async scheduled(controller,env){
    try{
      const {value:result,recovery}=await withPrivateRecovery(env,()=>runReviewSchedule(env,new Date(controller.scheduledTime).toISOString()));
      console.log(JSON.stringify({event:'review-followups',changed:result.changed,held:result.held,mailStatus:result.mailStatus,failures:result.errors?.length??0,alertFailures:result.alertFailures?.length??0,recovery:recovery.status,recoveryExpiry:recovery.expiry}));
    }catch{
      console.error(JSON.stringify({event:'scheduled-review-failed'}));
      throw new Error('Scheduled mentorship review failed. Check current recovery and connection status.');
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if(url.pathname==='/api/operator'){
        if(request.method!=='POST')return json({error:'Method not allowed.'},405);
        return json(await handleOperatorRequest(env.DB,await readJSON(request),env));
      }
      if(url.pathname==='/api/check-in'){
        if(!['review','operating'].includes(env.MODE))throw new InputError('Check-ins are unavailable.',403);
        if(!['GET','POST'].includes(request.method))return json({error:'Method not allowed.'},405);
        const origin=request.headers.get('origin');
        if(origin&&origin!==url.origin&&origin!==env.SITE_ORIGIN)throw new InputError('Use the program website.',403);
        const record=await checkInRequest(env.DB,request.headers.get('authorization'));
        const ai=createReviewAI({apiKey:env.REVIEW_OPENAI_API_KEY,spendingVerified:env.REVIEW_AI_SPENDING_VERIFIED==='true',fixturesOnly:env.MODE==='review',db:env.DB});
        return json(request.method==='GET'?publicRequestDetails(record):await saveReviewCheckIn(env.DB,record,await readJSON(request),new Date().toISOString(),{mode:env.MODE,...(env.MODE==='operating'?{classify:ai.classify}:{})}));
      }
      if (url.pathname === '/api/applications') {
        if(request.method !== 'POST')return json({error:'Method not allowed.'},405);
        const origin=request.headers.get('origin');
        if(origin && origin!==url.origin && origin!==env.SITE_ORIGIN)throw new InputError('Use the program website to apply.',403);
        return json(await saveApplication(env.DB, await readJSON(request),{...env, TERMS_VERSION:policy.termsVersion, PRIVACY_VERSION:policy.privacyVersion, COPY:policy.copy}));
      }
      if(url.pathname === '/api/health') { await env.DB.prepare('SELECT 1').first(); return json({ok:true, mode:env.MODE, release:env.RELEASE || 'local'}); }
      if(url.pathname.startsWith('/api/'))return json({error:'Not found.'},404);
      if(!['GET','HEAD'].includes(request.method))return json({error:'Method not allowed.'},405);
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found.',{status:404});
    } catch(error) {
      if(error instanceof InputError)return json({error:error.message,fields:error.errors},error.status);
      // No submitted fields, tokens or provider errors belong in logs or responses.
      console.error(JSON.stringify({event:'request-failed',path:url.pathname.startsWith('/api/')?'api':'page'}));
      if(url.pathname==='/api/operator')return json({error:'The operator request could not be completed. No successful result is confirmed. Review the saved records before retrying.'},503);
      return json({error:'We could not confirm the save. Your answers are still in the form. Please try again.'},503);
    }
  }
};
