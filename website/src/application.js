// The connected review uses the same fields as the approved prototype.
(async () => {
  const form = document.querySelector('.application-form[data-connected]');
  if (!form) return;
  const button = form.querySelector('[type="submit"]');
  const confirmation = form.nextElementSibling;
  const role = form.action.split('/').at(-1);
  const status = document.createElement('p');
  status.setAttribute('role', 'status'); status.tabIndex = -1;
  button.before(status);
  const acknowledgement = form.querySelector('[type="checkbox"]');
  acknowledgement.name = 'acknowledgement';
  let submissionKey = crypto.randomUUID(), config, saving = false;
  const fieldErrors = [];
  const clearErrors = () => {
    for (const {field, message} of fieldErrors.splice(0)) { field.removeAttribute('aria-invalid'); field.removeAttribute('aria-describedby'); message.remove(); }
  };
  const showError = (text, errors = {}) => {
    status.textContent = text;
    for (const [name, text] of Object.entries(errors)) {
      const field = form.elements.namedItem(name); if (!field) continue;
      const message = document.createElement('p'); message.id = `${field.id}-error`; message.textContent = text;
      field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', message.id); field.after(message);
      fieldErrors.push({field, message});
    }
    (fieldErrors[0]?.field || status).focus();
  };
  button.disabled = true;
  try {
    const result = await fetch('/application-config.json', {cache: 'no-store'});
    if (!result.ok) throw new Error(); config = await result.json();
    if(config.mode==='review')for (const [name, value] of Object.entries(config.examples[role])) form.elements.namedItem(name).value = value;
    acknowledgement.checked = false;
    confirmation.querySelector('h2').textContent = config.copy.savedTitle;
    confirmation.querySelector('p').textContent = config.copy.saved;
    confirmation.querySelector('[data-preview-again]').hidden=config.mode==='operating';
    button.disabled = false;
  } catch { showError('We could not load the application. Please reload this page.'); return; }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || !form.reportValidity()) return;
    clearErrors(); saving = true; button.disabled = true; button.textContent = config.copy.saving;
    status.textContent = config.copy.saving;
    const answers = Object.fromEntries(config.fields[role].map(name => [name, form.elements.namedItem(name).value]));
    try {
      const response = await fetch('/api/applications', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({role, submissionKey, answers, acknowledgement: acknowledgement.checked,
          termsVersion: config.termsVersion, privacyVersion: config.privacyVersion}), signal: AbortSignal.timeout(15000)
      });
      const result = await response.json();
      if (!response.ok) { showError(result.error || config.copy.failed, result.fields); return; }
      if (result.saved !== true || result.mode !== config.mode || result.emailSent !== false) throw new Error();
      form.reset(); form.hidden = true; confirmation.hidden = false;
      confirmation.focus({preventScroll:true}); confirmation.scrollIntoView({block:'start'});
      status.textContent = '';
    } catch { showError(config.copy.failed); }
    finally { saving = false; button.disabled = false; button.textContent = 'Submit application'; }
  });
  confirmation.querySelector('[data-preview-again]').addEventListener('click', () => {
    submissionKey = crypto.randomUUID(); clearErrors(); status.textContent = '';
    if(config.mode==='review')for (const [name, value] of Object.entries(config.examples[role])) form.elements.namedItem(name).value = value;
    acknowledgement.checked = false; confirmation.hidden = true; form.hidden = false; form.querySelector('input').focus();
  });
})();
