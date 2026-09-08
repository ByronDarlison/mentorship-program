import {InputError} from './applications.mjs';

export const ratings=['Significant','Meaningful','Some','Little or none','Unclear'];
export const returnRatings=['Interested','Unsure','Not interested'];
export const outcomeFields=role=>role==='mentee'?['progress','value']:['value','returnInterest'];
export const requestFields=r=>r.kind==='final'?['meetings',...outcomeFields(r.role),...(r.period===12?['recommendations']:[]),'contact']:['meetings','value','contact'];
export const addDays=(iso,n)=>new Date(Date.parse(iso)+n*86400000).toISOString();
export function addMonths(date,n){
  const d=new Date(date+'T00:00:00Z'),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+n);
  const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return d.toISOString().slice(0,10);
}
export function validateFeedback(request,patch){
  if(!patch||Array.isArray(patch)||typeof patch!=='object')throw new InputError('Answers must be an object.');
  const fields=requestFields(request),result={};
  for(const [key,value] of Object.entries(patch)){
    if(!fields.includes(key))throw new InputError('Unexpected answer.');
    if(value===''||value===null)continue; // An omission never erases a valid answer.
    if(key==='meetings'){
      if(!Number.isSafeInteger(value)||value<0)throw new InputError('Use a whole number of meetings, zero or more.');
    }else if(key==='contact'){
      if(typeof value!=='boolean')throw new InputError('Choose yes or no for Chair contact.');
    }else if(typeof value!=='string'||!value.trim()||value.length>6000)throw new InputError('Use a brief written answer.');
    result[key]=typeof value==='string'?value.trim():value;
  }
  return result;
}
export function feedbackStatus(request,now){
  const answers=request.answers,fields=requestFields(request);
  const missing=fields.filter(k=>k!=='recommendations'&&!Object.hasOwn(answers,k));
  const expired=Boolean(request.deadline&&Date.parse(now)>=Date.parse(request.deadline));
  return {missing,complete:missing.length===0,expired,
    noResponseFailure:expired&&!request.replied_at&&!request.superseded,
    missingOutcomes:expired&&!request.superseded?outcomeFields(request.role).filter(k=>fields.includes(k)&&!Object.hasOwn(answers,k)):[]};
}
// No language-model judgment participates in deadlines or arithmetic.
export function finalContribution(request,now){
  if(request.kind!=='final'||request.superseded)return null;
  const fields=outcomeFields(request.role),has=k=>Object.hasOwn(request.answers,k);
  const expired=Boolean(request.deadline&&Date.parse(now)>=Date.parse(request.deadline));
  const included=(fields.every(has)&&!request.reporting_only)||expired;
  return {role:request.role,included,pending:!included,metrics:Object.fromEntries(fields.map(k=>{
    const classification=request.classifications[k];
    return [k,{positive:has(k)&&(k==='returnInterest'?classification==='Interested':['Meaningful','Significant'].includes(classification)),
      missing:!has(k),interpretationPending:has(k)&&!classification,classification:classification??null}];
  }))};
}
export function summarizeResults(requests,now,anonymous=[]){
  const metrics={menteeProgress:{},menteeValue:{},mentorValue:{},mentorReturn:{}};
  for(const key of Object.keys(metrics))metrics[key]={included:0,positive:0,missing:0,pending:0,interpretationPending:0,percent:null};
  const contributions=[...requests.map(r=>finalContribution(r,now)).filter(Boolean),...anonymous];
  for(const c of contributions){
    for(const [field,result] of Object.entries(c.metrics)){
      const key=c.role==='mentee'?(field==='progress'?'menteeProgress':'menteeValue'):(field==='value'?'mentorValue':'mentorReturn');
      const m=metrics[key];if(!c.included){m.pending++;continue;}
      m.included++;m.positive+=Number(result.positive);m.missing+=Number(result.missing);m.interpretationPending+=Number(result.interpretationPending);
    }
  }
  for(const m of Object.values(metrics))m.percent=m.included?100*m.positive/m.included:null;
  const required=requests.filter(r=>r.kind!=='first'&&!r.superseded&&r.sent_at&&!r.reviewed_at);
  return {metrics,completion:{required:required.length,complete:required.filter(r=>feedbackStatus(r,now).complete).length}};
}

// Only exact supplied fictional answers are interpreted in the review build.
// Unknown input remains pending. This is not a production language classifier.
export const reviewFeedback={
  recommendations:'It would help to include more practice during training.',
  progress:'The mentorship helped me decide to close an unprofitable product line.',
  value:'The questions helped me see my own role and make useful changes.',
  returnInterest:'I would like to mentor again if the timing works.'
};
export const reviewLowValue='These conversations have not been useful to me.';
export async function classifyReview(field,text){
  if(field==='value'&&text===reviewLowValue)return {status:'classified',classification:'Little or none',conditions:''};
  if(text!==reviewFeedback[field])return {status:'pending',reason:'Review example not recognized.'};
  return {status:'classified',classification:field==='returnInterest'?'Interested':'Meaningful',conditions:field==='returnInterest'?'if the timing works':''};
}
export function validateInterpretation(field,result){
  if(result?.status!=='classified')return null;
  if(!(field==='returnInterest'?returnRatings:ratings).includes(result.classification))throw new InputError('Invalid interpretation.');
  return {classification:result.classification,conditions:typeof result.conditions==='string'?result.conditions.slice(0,1000):''};
}
