import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {examples} from '../fixtures.mjs';

// Explicit local fixture setup. This does not impersonate the Chair or qualify
// native chat approval. Never accepts participant data or a remote target.
const root=fileURLToPath(new URL('../../',import.meta.url));
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
const pairId=crypto.randomUUID(),requestId=crypto.randomUUID();
const now=new Date().toISOString(),deadline=new Date(Date.now()+21*86400000).toISOString();
const ids={mentee:crypto.randomUUID(),mentor:crypto.randomUUID()};
const queries=[];
queries.push("INSERT OR IGNORE INTO cohorts(name,first_cohort) VALUES('Local demonstration',NULL)");
for(const role of ['mentee','mentor'])queries.push(`INSERT INTO applications(id,submission_key,payload_hash,role,answers,terms_version,privacy_version,created_at,decision,readiness) VALUES(${[ids[role],crypto.randomUUID(),'local-fixture',role,JSON.stringify(examples[role]),'fixture','fixture',now,'approved'].map(quote).join(',')},1)`);
queries.push(`INSERT INTO pairs(id,mentee_id,mentor_id,group_name,fit_reason,status,mentee_trained,mentor_trained,actual_date,created_at) VALUES(${[pairId,ids.mentee,ids.mentor,'Local demonstration','Fictional distribution and delegation experience.','active'].map(quote).join(',')},1,1,'2025-09-01',${quote(now)})`);
queries.push(`INSERT INTO requests(id,pair_id,application_id,role,kind,period,scheduled_for,sent_at,deadline) VALUES(${[requestId,pairId,ids.mentee,'mentee','final'].map(quote).join(',')},12,${[now,now,deadline].map(quote).join(',')})`);
execFileSync(process.execPath,[root+'node_modules/wrangler/bin/wrangler.js','d1','execute','DB','--local','--command',queries.join(';')],{cwd:root,stdio:['ignore','pipe','pipe']});
console.log(JSON.stringify({pairId,requestId,fixtureOnly:true,checkIns:'email-only'}));
