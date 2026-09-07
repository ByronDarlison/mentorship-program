import { escape } from '../src/render.mjs';

const applicationSections = { mentee: 'the-mentee-application', mentor: 'the-mentor-profile' };

function publicTokens(manual, sectionId) {
  const section = manual.sectionById.get(sectionId);
  if (!section) throw new Error(`Missing application source section: ${sectionId}`);
  return section.tokens.filter(token => !token.meta?.internalNote);
}

function sourceText(manual, sectionId, prefix) {
  const candidates = publicTokens(manual, sectionId).filter(token => token.type === 'inline' && token.content.startsWith(prefix));
  const exact = candidates.filter(token => token.content === prefix);
  const matches = exact.length ? exact : candidates;
  if (matches.length !== 1) throw new Error(`Expected one canonical paragraph: ${sectionId}, ${prefix}`);
  return matches[0].content;
}

function listUnderHeading(manual, sectionId, heading) {
  const tokens = publicTokens(manual, sectionId);
  const headingIndex = tokens.findIndex((token, index) => token.type === 'inline' && token.content === heading && tokens[index - 1]?.type === 'heading_open');
  if (headingIndex < 0) throw new Error(`Missing list heading: ${sectionId}, ${heading}`);
  const nextHeading = tokens.findIndex((token, index) => index > headingIndex && token.type === 'heading_open');
  const limit = nextHeading < 0 ? tokens.length : nextHeading;
  const start = tokens.findIndex((token, index) => index > headingIndex && index < limit && token.type === 'bullet_list_open');
  const end = tokens.findIndex((token, index) => index > start && index < limit && token.type === 'bullet_list_close');
  if (start < 0 || end < 0) throw new Error(`Missing list content: ${sectionId}, ${heading}`);
  return tokens.slice(start + 1, end).filter(token => token.type === 'inline').map(token => token.content);
}

export function applicationQuestions(manual, role) {
  const id = applicationSections[role];
  if (!id) throw new Error('Unknown application role');
  const tokens = publicTokens(manual, id);
  const start = tokens.findIndex(token => token.type === 'ordered_list_open');
  const end = tokens.findIndex((token, index) => index > start && token.type === 'ordered_list_close');
  const questions = tokens.slice(start + 1, end).filter(token => token.type === 'inline').map(token => token.content);
  const expectedCount = role === 'mentee' ? 7 : 6;
  if (start < 0 || end < 0 || questions.length !== expectedCount) throw new Error(`Application questions changed: ${role}`);
  return questions;
}

export function renderApplicationBody(manual, role) {
  const sectionId = applicationSections[role];
  const questions = applicationQuestions(manual, role);
  const title = role === 'mentee' ? 'Mentee application' : 'Mentor application';
  const get = (section, prefix) => sourceText(manual, section, prefix);
  const paragraph = (section, prefix, className = '') => `<p${className ? ` class="${escape(className)}"` : ''}>${escape(get(section, prefix))}</p>`;
  const chairContactParagraph = (section, prefix) => `<p>${escape(get(section, prefix)).replace('Mentorship Chair', '<a href="mailto:chair@example.invalid">Mentorship Chair</a>')}</p>`;
  const acknowledgement = get(sectionId, 'I understand the commitments');
  let optionalTool = '';
  if (role === 'mentee') {
    optionalTool = `<p class="application-tool">${escape(get(sectionId, 'If helpful,')).replace('Owner&#39;s Outcome', '<a href="/mentees#owners-outcome">Owner\'s Outcome</a>')}</p>`;
  }
  if (role === 'mentee') {
    const bothCommitments = listUnderHeading(manual, 'home', 'Both participants');
    const menteeCommitments = listUnderHeading(manual, 'home', 'As a mentee');
    const names = ['name', 'email', 'linkedin-url', 'business', 'challenge', 'mentor-experience', 'additional-information'];
    const rows = [0, 0, 0, 5, 6, 4, 4];
    const renderMenteeQuestion = index => {
      const id = `mentee-question-${index + 1}`;
      const question = questions[index];
      const field = index < 2
        ? `<input id="${id}" name="${names[index]}" type="${index === 1 ? 'email' : 'text'}" autocomplete="${index === 0 ? 'name' : 'email'}" required>`
        : index === 2
          ? `<input id="${id}" name="${names[index]}" type="url" autocomplete="url">`
          : `<textarea id="${id}" name="${names[index]}" rows="${rows[index]}" autocomplete="off"${index === 6 ? '' : ' required'}></textarea>`;
      return `<li><label for="${id}">${escape(question)}</label>${field}${index === 4 ? optionalTool : ''}</li>`;
    };
    const questionGroup = (title, id, indexes) => `<section class="application-question-group" aria-labelledby="${id}"><h3 id="${id}">${title}</h3><ol class="application-questions" start="${indexes[0] + 1}">${indexes.map(renderMenteeQuestion).join('')}</ol></section>`;

    return `<h1>Mentee application</h1>
<p class="application-eligibility">${escape(get(sectionId, 'For current Example Chapter members.'))}</p>
<p class="lead">${escape(get(sectionId, 'Partner with a mentor'))}</p>
<p class="lead">${escape(get(sectionId, 'Work through a business challenge'))}</p>

<div class="matching-notice"><p>${escape(get(sectionId, 'We will do our best to match'))}</p></div>
<section class="application-essentials" aria-labelledby="participation-commitments"><h2 id="participation-commitments">What we ask of you</h2>
<div class="application-commitments">
<section><h3>Both participants</h3><ul>${bothCommitments.map(item => `<li>${escape(item)}</li>`).join('')}</ul></section>
<section><h3>As a mentee</h3><ul>${menteeCommitments.map(item => `<li>${escape(item)}</li>`).join('')}</ul></section>
</div></section>

<form class="application-form" action="/apply/mentee" method="post" autocomplete="off" aria-label="Mentee application">
<noscript>This form needs JavaScript to show its confirmation screen.</noscript>
<section class="application-fields" aria-labelledby="application-questions"><h2 id="application-questions">Your application</h2>
${paragraph(sectionId, 'Please answer briefly')}
${questionGroup('About you', 'about-you', [0, 1, 2])}
${questionGroup('Your business and focus', 'business-and-focus', [3, 4, 5, 6])}</section>

<section class="application-information" aria-labelledby="information-use"><h2 id="information-use">How we use your information</h2>
${paragraph(sectionId, 'We use your application only')}
${paragraph(sectionId, 'AI will compare only the necessary application information')}
${paragraph(sectionId, 'We keep your application while')}
${chairContactParagraph(sectionId, 'You may ask the Mentorship Chair to delete')}</section>

<section class="application-acknowledgement" aria-labelledby="confirm-application"><h2 id="confirm-application">Confirm and apply</h2>
<label class="acknowledgement-label" for="mentee-acknowledgement"><input id="mentee-acknowledgement" type="checkbox" required> <span>${escape(acknowledgement)}</span></label>
<p class="policy-links"><a href="/terms">Program Terms</a><span aria-hidden="true"> · </span><a href="/privacy">Privacy Notice</a></p>
<button class="apply" type="submit">Submit application</button></section></form>
<section class="application-confirmation" hidden tabindex="-1" aria-labelledby="preview-complete"><h2 id="preview-complete">Preview complete</h2><p>Nothing was sent or saved. This was a test of the application, not an application to the program.</p><button class="apply" type="button" data-preview-again>Try another test</button><p><a href="/home">Back to the program</a></p></section>`;
  }

  const bothCommitments = listUnderHeading(manual, 'home', 'Both participants');
  const mentorCommitments = listUnderHeading(manual, 'home', 'As a mentor');
  const names = ['name', 'email', 'linkedin-url', 'experience', 'business-fit', 'additional-information'];
  const rows = [0, 0, 0, 5, 5, 4];
  const renderMentorQuestion = index => {
    const id = `mentor-question-${index + 1}`;
    const question = questions[index];
    const field = index < 2
      ? `<input id="${id}" name="${names[index]}" type="${index === 1 ? 'email' : 'text'}" autocomplete="${index === 0 ? 'name' : 'email'}" required>`
      : index === 2
        ? `<input id="${id}" name="${names[index]}" type="url" autocomplete="url">`
        : `<textarea id="${id}" name="${names[index]}" rows="${rows[index]}" autocomplete="off"${index === 5 ? '' : ' required'}></textarea>`;
    return `<li><label for="${id}">${escape(question)}</label>${field}</li>`;
  };
  const questionGroup = (groupTitle, id, indexes) => `<section class="application-question-group" aria-labelledby="${id}"><h3 id="${id}">${groupTitle}</h3><ol class="application-questions" start="${indexes[0] + 1}">${indexes.map(renderMentorQuestion).join('')}</ol></section>`;

  return `<h1>${title}</h1>
<p class="application-eligibility">${escape(get(sectionId, 'Relevant experience matters.'))}</p>
<p class="lead">${escape(get(sectionId, 'Become a mentor'))}</p>
<p class="lead">${escape(get(sectionId, 'Share what'))}</p>

<div class="matching-notice"><p>${escape(get(sectionId, 'We will do our best to match'))}</p></div>
<section class="application-essentials" aria-labelledby="participation-commitments"><h2 id="participation-commitments">What we ask of you</h2>
<div class="application-commitments">
<section><h3>Both participants</h3><ul>${bothCommitments.map(item => `<li>${escape(item)}</li>`).join('')}</ul></section>
<section><h3>As a mentor</h3><ul>${mentorCommitments.map(item => `<li>${escape(item)}</li>`).join('')}</ul></section>
</div></section>

<form class="application-form" action="/apply/mentor" method="post" autocomplete="off" aria-label="Mentor application">
<noscript>This form needs JavaScript to show its confirmation screen.</noscript>
<section class="application-fields" aria-labelledby="application-questions"><h2 id="application-questions">Your application</h2>
${paragraph(sectionId, 'Please answer briefly')}
${questionGroup('About you', 'about-you', [0, 1, 2])}
${questionGroup('Your experience', 'your-experience', [3, 4, 5])}</section>

<section class="application-information" aria-labelledby="information-use"><h2 id="information-use">How we use your information</h2>
${paragraph(sectionId, 'We use your application only')}
${paragraph(sectionId, 'AI will compare only the necessary application information')}
${paragraph(sectionId, 'We keep your application while')}
${chairContactParagraph(sectionId, 'You may ask the Mentorship Chair to delete')}</section>

<section class="application-acknowledgement" aria-labelledby="confirm-application"><h2 id="confirm-application">Confirm and apply</h2>
<label class="acknowledgement-label" for="mentor-acknowledgement"><input id="mentor-acknowledgement" type="checkbox" required> <span>${escape(acknowledgement)}</span></label>
<p class="policy-links"><a href="/terms">Program Terms</a><span aria-hidden="true"> · </span><a href="/privacy">Privacy Notice</a></p>
<button class="apply" type="submit">Submit application</button></section></form>
<section class="application-confirmation" hidden tabindex="-1" aria-labelledby="preview-complete"><h2 id="preview-complete">Preview complete</h2><p>Nothing was sent or saved. This was a test of the application, not an application to the program.</p><button class="apply" type="button" data-preview-again>Try another test</button><p><a href="/home">Back to the program</a></p></section>`;
}
