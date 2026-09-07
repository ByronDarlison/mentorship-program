import {InputError,sha256} from './applications.mjs';
import {requestFields,reviewFeedback,reviewLowValue,validateFeedback} from './feedback.mjs';
import {decodeRequest,receiveFeedback} from './followups.mjs';

export async function checkInRequest(db,authorization){
  const token=authorization?.match(/^Bearer ([0-9a-f-]{72})$/i)?.[1];
  if(!token)throw new InputError('This check-in link is unavailable.',404);
  const row=await db.prepare("SELECT * FROM requests WHERE token_hash=? AND kind!='first' AND sent_at IS NOT NULL AND superseded=0").bind(await sha256(token)).first();
  if(!row)throw new InputError('This check-in link is unavailable.',404);
  return decodeRequest(row);
}
export async function saveReviewCheckIn(db,request,input,now=new Date().toISOString(),{mode='review',classify}={}){
  if(!['review','operating'].includes(mode))throw new InputError('Check-ins are unavailable.',403);
  if(!input||Object.keys(input).some(k=>!['id','answers'].includes(k))||typeof input.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id))throw new InputError('Invalid submission.');
  const answers=validateFeedback(request,input.answers);
  if(mode==='review')for(const [field,value] of Object.entries(answers)){
    if(field==='contact'||field==='meetings'||(field==='value'&&value===reviewLowValue))continue;
    const expected=reviewFeedback[field];
    if(value!==expected)throw new InputError('Use only the supplied fictional answers for this review.',400,{[field]:'Use the supplied fictional example.'});
  }
  return receiveFeedback(db,{id:input.id,requestId:request.id,answers,receivedAt:now,source:'form'},classify);
}
export const publicRequestDetails=r=>({kind:r.kind,role:r.role,period:r.period,fields:requestFields(r)});
