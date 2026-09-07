// A conservative monthly allowance, not a claim of actual provider charges.
// Pinned GPT-5.4 mini: $0.75 input / $4.50 output per million tokens.
// https://developers.openai.com/api/docs/models/gpt-5.4-mini
// Count the whole UTF-8 request plus framing headroom, never average characters
// per token. No tools, retries, regional endpoint or higher-price service tier.
export const MAX_REQUEST_BYTES=64000;
export const MAX_OUTPUT_TOKENS=1200;
export const MONTHLY_CAP_MICRO_USD=5_000_000;
export function maximumCharge(bytes){
  if(!Number.isSafeInteger(bytes)||bytes<0||bytes>MAX_REQUEST_BYTES)return null;
  return Math.ceil((bytes+4096)*0.75+MAX_OUTPUT_TOKENS*4.5);
}
export async function reserveAIAllowance(db,bytes,now=new Date().toISOString()){
  const charge=maximumCharge(bytes);
  if(!db||charge===null||!Number.isFinite(Date.parse(now)))return false;
  const month=new Date(now).toISOString().slice(0,7),id='system:ai-budget:'+month;
  await db.prepare("INSERT OR IGNORE INTO jobs(id,kind,status,payload,created_at) VALUES(?,'system-ai-budget','captured',?,?)")
    .bind(id,JSON.stringify({month,reservedMicroUsd:0}),now).run();
  // SQLite checks and increments in one write. Corruption never resets usage.
  const claimed=await db.prepare("UPDATE jobs SET payload=json_set(payload,'$.reservedMicroUsd',CAST(json_extract(payload,'$.reservedMicroUsd')+? AS INTEGER)) WHERE id=? AND kind='system-ai-budget' AND json_valid(payload) AND json_extract(payload,'$.month')=? AND json_type(payload,'$.reservedMicroUsd') IN ('integer','real') AND json_extract(payload,'$.reservedMicroUsd')=CAST(json_extract(payload,'$.reservedMicroUsd') AS INTEGER) AND json_extract(payload,'$.reservedMicroUsd')>=0 AND json_extract(payload,'$.reservedMicroUsd')+?<=? RETURNING id")
    .bind(charge,id,month,charge,MONTHLY_CAP_MICRO_USD).first();
  // Keep the reservation even on a lost response. Never refund uncertain spend.
  return Boolean(claimed);
}
