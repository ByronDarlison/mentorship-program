import {InputError,sha256} from './applications.mjs';
import {examples,fields} from './fixtures.mjs';
import {sanitizeForProvider} from './identifiers.mjs';

// Domain functions only. No HTTP or MCP mutation route exposes these while
// native human confirmation is unqualified. The caller owns authentication.
const fail=message=>{throw new InputError(message,409);};
const uuid=value=>typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const date=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const allowed={
  participant_decision:['applicationId','version','decision','readiness'],
  retention_choice:['applicationId','version','choice'],
  approve_match:['menteeId','mentorId','menteeVersion','mentorVersion','group','conflictsChecked','fitReason','introduction'],
  training:['pairId','version','menteeAttended','mentorAttended'],
  planned_meeting:['pairId','version','date']
};
function validate(action){
  if(!action || !uuid(action.id) || !Object.hasOwn(allowed,action.name))fail('Unknown or invalid action.');
  if(Object.keys(action).some(k=>!['id','name',...allowed[action.name]].includes(k)))fail('Unexpected action field.');
}
async function application(db,id,version){
  const row=await db.prepare('SELECT * FROM applications WHERE id=?').bind(id??'').first();
  if(!row || !Number.isSafeInteger(version) || row.version!==version||row.details_removed_at)fail('Application changed or its details were removed after final review. Review it again.');
  return row;
}
async function pair(db,id,version){
  const row=await db.prepare('SELECT * FROM pairs WHERE id=?').bind(id??'').first();
  if(!row || !Number.isSafeInteger(version) || row.version!==version || row.status==='ended')fail('Pair changed or ended. Review it again.');
  return row;
}
export async function inspectProgram(db){
  return {applications:(await db.prepare('SELECT * FROM applications ORDER BY created_at,id').all()).results.map(r=>({...r,answers:JSON.parse(r.answers)})),
    pairs:(await db.prepare('SELECT * FROM pairs ORDER BY created_at,id').all()).results};
}

export async function executeChairAction(db,action,actor,env={}){
  validate(action);
  if(typeof actor!=='string'||!actor.trim())fail('Configured operator required.');
  const hash=await sha256(JSON.stringify(Object.fromEntries(Object.keys(action).sort().map(k=>[k,action[k]]))));
  const previous=await db.prepare('SELECT * FROM chair_actions WHERE id=?').bind(action.id).first();
  if(previous){if(previous.payload_hash!==hash||previous.actor!==actor)fail('Action ID already used.');return JSON.parse(previous.result);}
  const execution=crypto.randomUUID(), now=new Date().toISOString();
  const gate='EXISTS(SELECT 1 FROM chair_actions WHERE execution_id=?)';
  const writes=[],guards=[],subjects=[];let result;
  const protect=(table,row)=>{guards.push({sql:`EXISTS(SELECT 1 FROM ${table} WHERE id=? AND version=?)`,args:[row.id,row.version]});subjects.push(row.id);};
  if(['participant_decision','retention_choice'].includes(action.name)){
    const row=await application(db,action.applicationId,action.version);protect('applications',row);
    if(await db.prepare("SELECT id FROM pairs WHERE (mentee_id=? OR mentor_id=?) AND status!='ended'").bind(row.id,row.id).first())fail('Participant belongs to an open pair. Use the relationship workflow.');
    guards.push({sql:"NOT EXISTS(SELECT 1 FROM pairs WHERE (mentee_id=? OR mentor_id=?) AND status!='ended')",args:[row.id,row.id]});
    if(action.name==='participant_decision'){
      if(!['approved','declined','waiting'].includes(action.decision)||typeof action.readiness!=='boolean')fail('Decision and readiness required.');
      if(action.decision==='approved'&&!action.readiness)fail('Complete the readiness review before approval.');
      writes.push(db.prepare(`UPDATE applications SET decision=?,readiness=?,version=version+1 WHERE id=? AND ${gate}`).bind(action.decision,Number(action.readiness),row.id,execution));
      result={applicationId:row.id,decision:action.decision,readiness:action.readiness,version:row.version+1};
    } else {
      if(!['keep','delete-requested'].includes(action.choice))fail('Choose keep or record a deletion request.');
      writes.push(db.prepare(`UPDATE applications SET retention=?,version=version+1 WHERE id=? AND ${gate}`).bind(action.choice,row.id,execution));
      result={applicationId:row.id,retention:action.choice,version:row.version+1,deleted:false};
    }
  }else if(action.name==='approve_match'){
    const mentee=await application(db,action.menteeId,action.menteeVersion),mentor=await application(db,action.mentorId,action.mentorVersion);
    if(mentee.role!=='mentee'||mentor.role!=='mentor'||[mentee,mentor].some(r=>r.decision!=='approved'||!r.readiness||r.retention==='delete-requested'))fail('Both roles must be ready and approved.');
    if(action.conflictsChecked!==true||typeof action.group!=='string'||!action.group.trim()||action.group.length>100)fail('Group and Chair conflict check required.');
    if(typeof action.fitReason!=='string'||!action.fitReason.trim()||action.fitReason.length>1000)fail('Record a brief positive fit explanation.');
    for(const row of [mentee,mentor])protect('applications',row);
    const cohort=(await db.prepare('SELECT name FROM cohorts WHERE name=? COLLATE NOCASE').bind(action.group.trim()).first('name'))??action.group.trim();
    guards.push({sql:'(NOT EXISTS(SELECT 1 FROM cohorts WHERE name=? COLLATE NOCASE AND first_cohort=1) OR (SELECT COUNT(*) FROM pairs WHERE group_name=? COLLATE NOCASE)<10)',args:[cohort,cohort]});
    guards.push({sql:"NOT EXISTS(SELECT 1 FROM pairs WHERE mentee_id=? AND status!='ended')",args:[mentee.id]});
    const id=crypto.randomUUID();
    writes.push(db.prepare(`INSERT OR IGNORE INTO cohorts(name,first_cohort) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM cohorts) THEN NULL ELSE 1 END WHERE ${gate}`).bind(cohort,execution));
    writes.push(db.prepare(`INSERT INTO pairs(id,mentee_id,mentor_id,group_name,fit_reason,created_at) SELECT ?,?,?,?,?,? WHERE ${gate}`).bind(id,mentee.id,mentor.id,cohort,action.fitReason.trim(),now,execution));
    for(const row of [mentee,mentor]){
      writes.push(db.prepare(`UPDATE applications SET version=version+1 WHERE id=? AND ${gate}`).bind(row.id,execution));
    }
    writes.push(db.prepare(`DELETE FROM matching_copies WHERE ${gate}`).bind(execution));
    result={pairId:id,menteeId:mentee.id,mentorId:mentor.id,group:cohort,fitReason:action.fitReason.trim(),status:'matched',version:1};
    if(action.introduction){
      const {subject,body}=action.introduction;
      if(Object.keys(action.introduction).some(k=>!['subject','body'].includes(k))||typeof subject!=='string'||!subject.trim()||subject.length>250||/[\r\n]/.test(subject)||typeof body!=='string'||!body.trim()||body.length>20000||/\{\{/.test(body))fail('Review a complete introduction subject and body with the match.');
      const enabled=env.PROGRAM_MAILBOX_VERIFIED==='true'&&env.REVIEW_DELIVERY_VERIFIED==='true';
      const status=enabled?'pending':'captured';
      result.introductionJobs=[];
      for(const person of [mentee,mentor]){
        const to=env.MODE==='operating'?JSON.parse(person.answers).email:env.REVIEW_RECIPIENT??'capture-only@example.test';
        const jobId=action.id+':introduction:'+person.role;
        writes.push(db.prepare(`INSERT INTO jobs(id,application_id,kind,status,payload,created_at) SELECT ?,?,'chair-approved-message',?,?,? WHERE ${gate}`).bind(jobId,person.id,status,JSON.stringify({to,subject,body}),now,execution));
        result.introductionJobs.push({id:jobId,to,status});
      }
      result.emailSent=false;
    }
  }else{
    const row=await pair(db,action.pairId,action.version);protect('pairs',row);
    if(action.name==='training'){
      if(typeof action.menteeAttended!=='boolean'||typeof action.mentorAttended!=='boolean')fail('Record actual attendance for both people.');
      if(row.actual_date&&(!action.menteeAttended||!action.mentorAttended))fail('Cannot remove required attendance after the cycle started.');
      const trained=action.menteeAttended&&action.mentorAttended;
      writes.push(db.prepare(`UPDATE pairs SET mentee_trained=?,mentor_trained=?,planned_date=?,planned_revision=?,version=version+1 WHERE id=? AND ${gate}`).bind(Number(action.menteeAttended),Number(action.mentorAttended),trained?row.planned_date:null,trained?row.planned_revision:null,row.id,execution));
      result={pairId:row.id,menteeAttended:action.menteeAttended,mentorAttended:action.mentorAttended,version:row.version+1};
    }else{
      if(!date(action.date))fail('Use a valid meeting date.');
      if(!row.mentee_trained||!row.mentor_trained)fail('Both participants must complete live training first.');
      if(row.actual_date)fail('Cycle already started. Use a cycle correction, not another booking.');
      writes.push(db.prepare(`UPDATE pairs SET planned_date=?,planned_revision=?,version=version+1 WHERE id=? AND ${gate}`).bind(action.date,action.id,row.id,execution));
      result={pairId:row.id,plannedDate:action.date,actualDate:null,version:row.version+1};
    }
  }
  const sql=`INSERT OR IGNORE INTO chair_actions(id,payload_hash,execution_id,actor,action,subjects,result,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${guards.map(g=>g.sql).join(' AND ')}`;
  const saved=await db.batch([
    db.prepare(sql).bind(action.id,hash,execution,actor,action.name,JSON.stringify(subjects),JSON.stringify(result),now,...guards.flatMap(g=>g.args)),
    ...writes,
    db.prepare('SELECT payload_hash,actor,result FROM chair_actions WHERE id=?').bind(action.id)
  ]);
  const receipt=saved.at(-1).results[0];
  if(!receipt||receipt.payload_hash!==hash||receipt.actor!==actor)fail('Records changed. Review a fresh proposed action.');
  return JSON.parse(receipt.result);
}

export function codedMatchingFacts(records,{fixturesOnly=true}={}){
  // The review system only exports the prescribed invented profiles. Regex
  // redaction cannot establish that arbitrary prose contains no identifiers.
  return records.filter(r=>r.decision==='approved'&&r.retention!=='delete-requested').map(r=>{
    if(!uuid(r.id)||!Object.hasOwn(examples,r.role)||!r.answers||Object.keys(r.answers).some(k=>!fields[r.role].includes(k))||fields[r.role].some(k=>typeof r.answers[k]!=='string'||r.answers[k].length>6000))fail('Only complete approved profiles can enter matching.');
    if(fixturesOnly&&fields[r.role].some(k=>r.answers[k]?.trim()!==examples[r.role][k]))fail('Only the controlled fictional profiles can enter review matching.');
    const facts={};
    for(const key of fields[r.role].filter(k=>!['name','email','linkedin-url'].includes(k))){
      const prepared=fixturesOnly?{text:r.answers[key]}:sanitizeForProvider(r.answers[key],r.answers);
      if(prepared.refused)fail('An application contains contact details in its business answers. Review a safe extract before matching.');
      facts[key]=prepared.text;
    }
    return {code:`${r.role}-${r.id}`,role:r.role,facts};
  });
}
