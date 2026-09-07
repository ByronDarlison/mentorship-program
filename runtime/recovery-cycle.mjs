import {InputError,sha256} from './applications.mjs';
import {exportSnapshot,exportPrivacyCheckpoint,writePrivateBackup,readPrivateBackup,replayDeletions} from './recovery.mjs';
import {createBackblazeBucket} from './backblaze.mjs';

// Backblaze has no conditional write, so the single current pointer is one D1
// row updated by compare-and-set. Storage holds only append-once evidence:
// a begin marker before any protected change and a done marker after the copy
// is verified. A begin without a done means the outcome is unknown, and no
// elapsed time is ever allowed to decide that question.
const CYCLE_PREFIX='recovery/cycles/';
const SNAPSHOT_PREFIX='snapshots/';
const CHECKPOINT_PREFIX='recovery/checkpoints/';
const CYCLE_KEY=/^recovery\/cycles\/(\d{10})-(begin|done)\.json$/;
const CYCLE_FORMAT='eo-mentorship-cycle';
const CYCLE_VERSION=1;
const MAX_SEQUENCE=9999999999;
const SHA256=/^[a-f0-9]{64}$/;
const pad=sequence=>String(sequence).padStart(10,'0');
const markerKey=(sequence,stage)=>`${CYCLE_PREFIX}${pad(sequence)}-${stage}.json`;

function namespacedBucket(bucket,namespace){
  if(!/^[a-z0-9][a-z0-9-]{0,30}$/.test(namespace))throw new InputError('Configure a valid backup namespace.',503);
  const root=`recovery/${namespace}/`;
  const physical=key=>{
    if(typeof key!=='string'||! /^(snapshots|recovery)\//.test(key)||key.includes('..'))throw new InputError('Invalid recovery key.');
    return root+key;
  };
  const logical=key=>{
    if(typeof key!=='string'||!key.startsWith(root)||key.length===root.length)throw new InputError('Recovery object belongs to another installation.',503);
    return key.slice(root.length);
  };
  return {
    async get(key){const object=await bucket.get(physical(key));return object?{...object,key:logical(object.key)}:null;},
    async put(key,text,options){const saved=await bucket.put(physical(key),text,options);return {...saved,key:logical(saved.key)};},
    async deleteVersion({key,fileId}){const removed=await bucket.deleteVersion({key:physical(key),fileId});return {...removed,key:logical(removed.key)};},
    async listVersions({prefix,cursor,limit}={}){
      const page=await bucket.listVersions({prefix:physical(prefix),cursor,limit});
      return {versions:page.versions.map(version=>({...version,key:logical(version.key)})),cursor:page.cursor};
    }
  };
}
export function recoveryStorage(env) {
  const bucket=env.PRIVATE_RECOVERY??createBackblazeBucket({keyId:env.B2_KEY_ID,applicationKey:env.B2_APP_KEY,bucketId:env.B2_BUCKET_ID,bucketName:env.B2_BUCKET});
  return env.BACKUP_NAMESPACE?namespacedBucket(bucket,env.BACKUP_NAMESPACE):bucket;
}

async function readState(db) {
  if(!db||typeof db.prepare!=='function')throw new InputError('Private recovery storage is unavailable.',503);
  const row=await db.prepare('SELECT * FROM recovery_state WHERE id=1').first();
  if(!row)throw new InputError('Private recovery is not installed. Apply the recovery migration.',503);
  return row;
}
// One claim for ordinary work and for repair. A repair may only advance from
// exactly the pending row it names, so two concurrent repairs cannot both claim.
async function claimSequence(db,{sequence,cycleId,startedAt,fromPendingId=null}) {
  const guard=fromPendingId?"status='pending' AND cycle_id=?5":"status IN ('empty','ready')";
  const statement=db.prepare(`UPDATE recovery_state SET cycle_sequence=?1,status='pending',cycle_id=?2,started_at=?3,created_at=NULL,backup_key=NULL,backup_sha256=NULL,checkpoint_key=NULL,checkpoint_sha256=NULL,expiry=NULL WHERE id=1 AND cycle_sequence=?4 AND ${guard} RETURNING cycle_sequence`);
  const row=await (fromPendingId?statement.bind(sequence,cycleId,startedAt,sequence-1,fromPendingId):statement.bind(sequence,cycleId,startedAt,sequence-1)).first();
  return Boolean(row);
}
async function completeSequence(db,{sequence,cycleId,createdAt,backup,checkpoint}) {
  const row=await db.prepare("UPDATE recovery_state SET status='ready',created_at=?1,backup_key=?2,backup_sha256=?3,checkpoint_key=?4,checkpoint_sha256=?5,expiry='pending' WHERE id=1 AND cycle_sequence=?6 AND status='pending' AND cycle_id=?7 RETURNING cycle_sequence").bind(createdAt,backup.key,backup.sha256,checkpoint.key,checkpoint.sha256,sequence,cycleId).first();
  return Boolean(row);
}

// A verified restore is the only way a new database adopts existing storage.
// Maintainer-only: it is deliberately not reachable from any runtime route.
export async function seedRecoveryState(db,manifest) {
  if(!Number.isSafeInteger(manifest?.sequence)||manifest.sequence<1||manifest.sequence>MAX_SEQUENCE||typeof manifest.cycleId!=='string'||!manifest.cycleId||!SHA256.test(manifest.backup?.sha256??'')||!SHA256.test(manifest.checkpoint?.sha256??''))throw new InputError('Seed the recovery sequence from a verified completed cycle.');
  // The done marker is written before expiry runs, so a completed cycle carries
  // no evidence that old copies were removed. The destination records expiry as
  // pending and earns its own result on its next cycle.
  const row=await db.prepare("UPDATE recovery_state SET cycle_sequence=?1,status='ready',cycle_id=?2,started_at=?3,created_at=?4,backup_key=?5,backup_sha256=?6,checkpoint_key=?7,checkpoint_sha256=?8,expiry='pending' WHERE id=1 AND status='empty' AND cycle_sequence=0 RETURNING cycle_sequence")
    .bind(manifest.sequence,manifest.cycleId,manifest.startedAt??null,manifest.createdAt??null,manifest.backup.key,manifest.backup.sha256,manifest.checkpoint.key,manifest.checkpoint.sha256).first();
  if(!row)throw new InputError('Seed the recovery sequence only into a new, empty installation.',409);
  return {sequence:manifest.sequence,cycleId:manifest.cycleId};
}

export async function inspectRecovery(env) {
  if(env.PRIVATE_RECOVERY_VERIFIED!=='true')return {status:'not-connected'};
  try { recoveryStorage(env); } catch { return {status:'not-connected'}; }
  let state;
  try { state=await readState(env.DB); } catch { return {status:'not-connected'}; }
  if(state.status==='empty')return {status:'not-started'};
  return {status:state.status,id:state.cycle_id,sequence:state.cycle_sequence,at:state.status==='pending'?state.started_at:state.created_at,...(state.expiry?{expiry:state.expiry}:{})};
}

export async function repairPrivateRecovery(env,action) {
  if(env.PRIVATE_RECOVERY_VERIFIED!=='true')throw new InputError('Private recovery is not connected.',503);
  if(!action||Object.keys(action).some(k=>!['pendingId','previousRunStopped'].includes(k))||typeof action.pendingId!=='string'||!action.pendingId||action.previousRunStopped!==true)throw new InputError('Verify that the previous operation and scheduled work have stopped before repairing recovery.');
  // The repair backs up the database as it stands now, in a new cycle. It never
  // replays the interrupted action, because a lost acknowledgement is not a
  // failed write, and it never edits the earlier cycle's markers.
  return withPrivateRecovery(env,async()=>({repaired:true,repeatedAction:false}),{repairPendingId:action.pendingId});
}

async function listAll(bucket,prefix) {
  const found=[];let cursor=null,pages=0;
  do {
    const page=await bucket.listVersions({prefix,cursor,limit:1000});
    found.push(...page.versions);
    cursor=page.cursor;
    if(++pages>1000)throw new Error('Incomplete recovery-object listing.');
  } while(cursor);
  return found;
}

async function surveyCycles(bucket) {
  const stages=new Map();let latest=null;
  for(const version of await listAll(bucket,CYCLE_PREFIX)) {
    const match=CYCLE_KEY.exec(version.key);
    if(!match||version.action!=='upload')throw new InputError('Private recovery storage contains an unexpected cycle object.',503);
    const sequence=Number(match[1]),stage=match[2];
    const digest=version.customMetadata?.sha256;
    if(!SHA256.test(digest??''))throw new InputError('Private recovery storage holds a cycle marker without its verified checksum.',503);
    const entry=stages.get(sequence)??{sequence,begin:null,done:null};
    // A transient upload error can leave a retried, byte-identical extra version.
    // Identical content is accepted. Different content under the same marker key
    // means two runs disagree about one cycle, which is never resolved silently.
    if(entry[stage]) {
      if(entry[stage].sha256!==digest)throw new InputError('Private recovery storage holds conflicting versions of a cycle marker.',503);
    } else entry[stage]={key:version.key,sha256:digest};
    stages.set(sequence,entry);
    if(latest===null||sequence>latest)latest=sequence;
  }
  return {latest,stages};
}

async function readMarker(bucket,key,stage,expectedSha256) {
  const object=await bucket.get(key);
  if(!object)throw new InputError('A recovery cycle marker is missing.',503);
  const text=await object.text();
  if(await sha256(text)!==expectedSha256)throw new InputError('A recovery cycle marker is damaged.',503);
  let marker;
  try { marker=JSON.parse(text); } catch { throw new InputError('A recovery cycle marker is damaged.',503); }
  if(marker?.format!==CYCLE_FORMAT||marker.version!==CYCLE_VERSION||marker.stage!==stage||!Number.isSafeInteger(marker.sequence)||typeof marker.cycleId!=='string'||!marker.cycleId)throw new InputError('A recovery cycle marker is damaged.',503);
  if(stage==='done'&&(!marker.backup?.key?.startsWith(SNAPSHOT_PREFIX)||!SHA256.test(marker.backup?.sha256??'')||!marker.checkpoint?.key?.startsWith(CHECKPOINT_PREFIX)||!SHA256.test(marker.checkpoint?.sha256??'')))throw new InputError('A recovery cycle marker is damaged.',503);
  return marker;
}

async function writeMarker(bucket,sequence,stage,body) {
  const key=markerKey(sequence,stage);
  // Immutable. An existing marker is never replaced, so a completed cycle
  // cannot be rewritten by a later run or a repeated repair.
  if(await bucket.get(key))throw new InputError(`This recovery cycle already has a ${stage} marker.`,409);
  const text=JSON.stringify(body);
  await bucket.put(key,text,{customMetadata:{sha256:await sha256(text)}});
  const readback=await bucket.get(key);
  if(!readback||await readback.text()!==text)throw new Error('Recovery cycle marker readback failed.');
  return key;
}

export async function pruneExpiredRecovery(bucket,{retentionDays,now,keep=[]}) {
  if(!Number.isSafeInteger(retentionDays)||retentionDays<1||!Number.isFinite(Date.parse(now)))throw new InputError('Set the approved backup-retention period before enabling private recovery.');
  const cutoff=Date.parse(now)-retentionDays*86400000,protectedKeys=new Set(keep);let removed=0;
  for(const prefix of [SNAPSHOT_PREFIX,CHECKPOINT_PREFIX,CYCLE_PREFIX]) {
    // Collect the whole prefix first: deleting during pagination would move the
    // name-and-version cursor past objects that were never examined.
    const expired=(await listAll(bucket,prefix)).filter(version=>!protectedKeys.has(version.key)&&Number.isFinite(Date.parse(version.uploadedAt??''))&&Date.parse(version.uploadedAt)<=cutoff);
    for(const version of expired) {
      // Exact version removal. Hiding would leave the participant copy stored.
      await bucket.deleteVersion({key:version.key,fileId:version.fileId});
      removed++;
    }
  }
  return {removed};
}

export async function withPrivateRecovery(env,operation,{repairPendingId}={}) {
  if(env.PRIVATE_RECOVERY_VERIFIED!=='true')return {value:await operation(),recovery:{status:'not-connected'}};
  const bucket=recoveryStorage(env);
  const retentionDays=Number(env.BACKUP_RETENTION_DAYS);
  if(!Number.isSafeInteger(retentionDays)||retentionDays<1)throw new InputError('Set the approved backup-retention period before enabling private recovery.',503);
  const state=await readState(env.DB);
  const survey=await surveyCycles(bucket);
  // A replacement or restored database must never reuse a sequence that storage
  // already holds. Adopting existing cycles is an explicit verified-restore step.
  if(survey.latest!==null&&survey.latest>state.cycle_sequence)throw new InputError('Private recovery storage holds newer cycles than this database. Complete a verified restore before protected work.',503);
  if(state.status==='pending'&&!repairPendingId)throw new InputError('Recovery needs attention before another protected operation. Do not restore the earlier snapshot.',503);
  if(repairPendingId&&(state.status!=='pending'||state.cycle_id!==repairPendingId))throw new InputError('The pending recovery item changed.',409);

  // Every run, a repair included, claims the next sequence and writes its own
  // begin and done markers. Earlier markers are never touched, so an unknown
  // outcome stays visible and the newest complete cycle is the current one.
  // That single rule covers a failed start, a failed copy, and a saved copy
  // whose database confirmation was lost.
  const sequence=state.cycle_sequence+1;
  if(sequence>MAX_SEQUENCE)throw new InputError('Private recovery has reached its maximum cycle count.',503);
  const cycleId=crypto.randomUUID(),startedAt=new Date().toISOString();
  if(!await claimSequence(env.DB,{sequence,cycleId,startedAt,fromPendingId:repairPendingId??null}))throw new InputError('Recovery state changed. Review the current status before retrying.',409);
  await writeMarker(bucket,sequence,'begin',{format:CYCLE_FORMAT,version:CYCLE_VERSION,stage:'begin',sequence,cycleId,startedAt});

  let value,failure;
  try { value=await operation(); } catch(error) { failure=error; }
  // Export the current database even if the action returned an error, since a
  // lost acknowledgement does not prove that its database transaction failed.
  let backup,checkpointRecord,snapshot;
  try {
    snapshot=await exportSnapshot(env.DB);
    const checkpoint=await exportPrivacyCheckpoint(null,snapshot);
    backup=await writePrivateBackup(bucket,snapshot,`${SNAPSHOT_PREFIX}${pad(sequence)}-${cycleId}.json`);
    const checkpointText=JSON.stringify(checkpoint),checkpointSHA=await sha256(checkpointText);
    const checkpointKey=`${CHECKPOINT_PREFIX}${pad(sequence)}-${cycleId}.json`;
    await bucket.put(checkpointKey,checkpointText,{customMetadata:{sha256:checkpointSHA}});
    const check=await bucket.get(checkpointKey);
    if(!check||await sha256(await check.text())!==checkpointSHA)throw new Error('Recovery checkpoint readback failed.');
    checkpointRecord={key:checkpointKey,sha256:checkpointSHA};
    await writeMarker(bucket,sequence,'done',{format:CYCLE_FORMAT,version:CYCLE_VERSION,stage:'done',sequence,cycleId,startedAt,createdAt:snapshot.createdAt,backup,checkpoint:checkpointRecord});
    if(!await completeSequence(env.DB,{sequence,cycleId,createdAt:snapshot.createdAt,backup,checkpoint:checkpointRecord}))throw new Error('Recovery cycle changed.');
  // The stored copy may in fact be complete and readable. What is unconfirmed is
  // this installation's record of it, so the warning does not claim more.
  } catch { throw new InputError('The action may have saved, but its recovery confirmation needs attention. Review saved records, then repair recovery.',503); }

  // Expiry is reported separately. A housekeeping failure must not turn a
  // verified, usable backup into a permanently blocked application.
  let expiry='complete';
  try { await pruneExpiredRecovery(bucket,{retentionDays,now:snapshot.createdAt,keep:[backup.key,checkpointRecord.key,markerKey(sequence,'begin'),markerKey(sequence,'done')]}); } catch { expiry='failed'; }
  try { await env.DB.prepare("UPDATE recovery_state SET expiry=?1 WHERE id=1 AND cycle_sequence=?2 AND cycle_id=?3 AND status='ready'").bind(expiry,sequence,cycleId).run(); } catch { expiry='unconfirmed'; }
  if(expiry!=='complete') {
    console.error(JSON.stringify({event:'recovery-expiry-needs-attention',expiry}));
  }
  if(failure)throw failure;
  return {value,recovery:{status:'verified',id:cycleId,sequence,expiry}};
}

// Storage-only read, used when the database is gone. It reads the newest cycle
// and refuses if that cycle is unfinished: an older completed cycle predates
// whatever the interrupted one may have saved, so it is never substituted.
export async function readCurrentRecovery(bucket) {
  const survey=await surveyCycles(bucket);
  if(survey.latest===null)throw new InputError('No completed recovery cycle is stored.',503);
  const cycle=survey.stages.get(survey.latest);
  if(!cycle.begin)throw new InputError('The latest recovery cycle has no start marker.',503);
  if(!cycle.done)throw new InputError('The latest recovery cycle did not complete. Repair recovery before restoring.',503);
  const begin=await readMarker(bucket,markerKey(survey.latest,'begin'),'begin',cycle.begin.sha256);
  const manifest=await readMarker(bucket,markerKey(survey.latest,'done'),'done',cycle.done.sha256);
  if(manifest.sequence!==survey.latest||begin.sequence!==survey.latest||begin.cycleId!==manifest.cycleId)throw new InputError('The stored recovery cycle is inconsistent.',503);
  const snapshot=await readPrivateBackup(bucket,manifest.backup.key,manifest.backup.sha256);
  const object=await bucket.get(manifest.checkpoint.key);
  if(!object)throw new InputError('Current privacy checkpoint is missing.',503);
  const text=await object.text();
  if(await sha256(text)!==manifest.checkpoint.sha256)throw new InputError('Current privacy checkpoint is damaged.',503);
  const checkpoint=JSON.parse(text),prepared=replayDeletions(snapshot,checkpoint);
  const after=await surveyCycles(bucket);
  const current=after.stages.get(survey.latest);
  if(after.latest!==survey.latest||current?.done?.sha256!==cycle.done.sha256)throw new InputError('Recovery changed during the read. Start again.',409);
  return {snapshot:prepared,checkpoint,manifest};
}
