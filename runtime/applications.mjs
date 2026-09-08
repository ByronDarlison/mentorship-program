import { examples, fields } from './fixtures.mjs';

export function chairApplicationMessage(name,role){return {subject:'New mentorship application',text:`${name} applied as a ${role}.\n\nOpen an AI chat with the mentorship program connection and ask: “Using the mentorship program connection, show me new applications and anything that needs my attention.”\n\n[How to review applications](https://github.com/ByronDarlison/mentorship-program/blob/main/USER_GUIDE.md#what-you-do-as-chair). Replying to this notice does not approve or decline the applicant.`};}

export class InputError extends Error {
  constructor(message, status = 400, errors = {}) { super(message); this.status = status; this.errors = errors; }
}
export async function sha256(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, '0')).join('');
}

export function validateApplication(input, config) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Invalid application.');
  if(Object.keys(input).some(key=>!['role','submissionKey','answers','acknowledgement','termsVersion','privacyVersion'].includes(key))) throw new InputError('Unexpected application field.');
  const { role, submissionKey, answers, acknowledgement, termsVersion, privacyVersion } = input;
  if (typeof role !== 'string' || !Object.hasOwn(fields,role)) throw new InputError('Choose a valid application.');
  if (typeof submissionKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionKey)) throw new InputError('Please reload the application.');
  if (acknowledgement !== true) throw new InputError('Please confirm the application commitments.', 400, {acknowledgement: 'Please confirm the commitments.'});
  if (termsVersion !== config.TERMS_VERSION || privacyVersion !== config.PRIVACY_VERSION) throw new InputError('The program information changed. Please reload and review it before applying.', 409);
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new InputError('Please complete the application.');
  if (Object.keys(answers).some(key => !fields[role].includes(key))) throw new InputError('Unexpected application field.');
  const clean = {}, errors = {};
  for (const key of fields[role]) {
    const value = answers[key];
    if (typeof value !== 'string' || value.length > (key === 'name' ? 200 : 6000)) { errors[key] = 'Please enter a shorter answer.'; continue; }
    clean[key] = value.trim();
    if (!clean[key] && !['linkedin-url', 'additional-information'].includes(key)) errors[key] = 'Please answer this question.';
  }
  if (clean.email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email) || clean.email.length > 254)) errors.email = 'Please enter a valid email address.';
  if (clean['linkedin-url']) {
    try { const url = new URL(clean['linkedin-url']); if (url.protocol !== 'https:' || !['linkedin.com','www.linkedin.com'].includes(url.hostname) || url.username || url.password) throw new Error(); }
    catch { errors['linkedin-url'] = 'Please enter an HTTPS LinkedIn profile link, or leave this blank.'; }
  }
  if (Object.keys(errors).length) throw new InputError('Please check the highlighted answers.', 400, errors);
  if (!['review','operating'].includes(config.MODE)) throw new InputError('Applications are closed.', 403);
  if (config.MODE === 'review') {
    for (const key of fields[role]) if (clean[key] !== examples[role][key]) errors[key] = 'Use the supplied fictional example for this review.';
    if (Object.keys(errors).length) throw new InputError('Only the supplied fictional examples can be saved during this review.', 400, errors);
  }
  return { role, submissionKey, answers: clean, termsVersion, privacyVersion };
}

export async function saveApplication(db, input, config) {
  const application = validateApplication(input, config);
  const { role, submissionKey, answers, termsVersion, privacyVersion } = application;
  const payloadHash = await sha256(JSON.stringify({ role, answers, termsVersion, privacyVersion }));
  const id = crypto.randomUUID(), now = new Date().toISOString();
  const mailStatus=config.PROGRAM_MAILBOX_VERIFIED==='true'&&config.REVIEW_DELIVERY_VERIFIED==='true'?'pending':'captured';
  // INSERT OR IGNORE plus SELECT ties all jobs to the winning application,
  // including concurrent retries. D1 batch rolls every statement back on error.
  const statements = [db.prepare('INSERT OR IGNORE INTO applications(id,submission_key,payload_hash,role,answers,terms_version,privacy_version,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind(id, submissionKey, payloadHash, role, JSON.stringify(answers), termsVersion, privacyVersion, now)];
  for (const kind of ['application-receipt','chair-application']) {
    const payload = kind === 'application-receipt'
      ? {to: answers.email, subject: config.COPY.receiptSubject, text: config.COPY.receiptBody, template: 'application-received'}
      : {to: config.CHAIR_EMAIL, ...chairApplicationMessage(answers.name,role), template: 'chair-application', name: answers.name, role};
    statements.push(db.prepare("INSERT OR IGNORE INTO jobs(id,application_id,kind,status,payload,created_at) SELECT id || ?,id,?,?,?,? FROM applications WHERE submission_key=? AND payload_hash=?")
      .bind(':'+kind, kind, mailStatus, JSON.stringify(payload), now, submissionKey, payloadHash));
  }
  statements.push(db.prepare("INSERT OR IGNORE INTO activity(id,subject_id,actor,action,created_at) SELECT id || ':received',id,'applicant','application-received',created_at FROM applications WHERE submission_key=? AND payload_hash=?").bind(submissionKey,payloadHash));
  statements.push(db.prepare('SELECT id,payload_hash FROM applications WHERE submission_key=?').bind(submissionKey));
  const results = await db.batch(statements);
  const saved = results.at(-1).results[0];
    if (!saved || saved.payload_hash !== payloadHash) throw new InputError('This submission changed after saving. Reload the page to start another application.',409);
  return { saved: true, reference: saved.id, mode: config.MODE, emailSent: false };
}
