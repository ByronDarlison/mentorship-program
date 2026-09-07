import {inspectProgram,codedMatchingFacts} from './administration.mjs';

// Recommendations are read-only. Nothing is selected, introduced or retained
// as a second matching record. Approval uses the existing versioned action.
export async function recommendMatches(db,ai,{fixturesOnly=true}={}){
  const {applications,pairs}=await inspectProgram(db);
  const paired=new Set(pairs.filter(p=>p.status!=='ended').map(p=>p.mentee_id));
  const candidates=applications.filter(a=>a.decision==='approved'&&a.readiness===1&&a.retention!=='delete-requested'&&!paired.has(a.id));
  const facts=codedMatchingFacts(candidates,{fixturesOnly});
  if(!facts.some(f=>f.role==='mentee')||!facts.some(f=>f.role==='mentor'))return {status:'recommended',suggestions:[],facts};
  const result=await ai.recommend(candidates);
  if(result.status!=='recommended')return {...result,facts};
  const current=await inspectProgram(db);
  const changed=candidates.some(a=>!current.applications.some(b=>b.id===a.id&&b.version===a.version));
  if(changed||JSON.stringify(pairs)!==JSON.stringify(current.pairs))return {status:'pending',reason:'Records changed while recommendations were prepared. Request a fresh comparison.'};
  const byCode=new Map(candidates.map(a=>[`${a.role}-${a.id}`,a]));
  return {status:'recommended',facts,suggestions:result.suggestions.map(s=>({...s,
    menteeId:byCode.get(s.mentee).id,mentorId:byCode.get(s.mentor).id,
    menteeVersion:byCode.get(s.mentee).version,mentorVersion:byCode.get(s.mentor).version})),
    notice:'Recommendations only. The Chair decides the match and confirms readiness, scheduling and conflicts.'};
}
