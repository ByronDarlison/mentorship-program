// References only. All program paragraphs come from the canonical manual.
export const routes = [
  { path: '/', title: 'Home', sections: ['home', 'current-program-status'] },
  { path: '/program', title: 'About the program', sections: ['the-result-we-want', 'who-the-program-is-for', 'how-the-program-works', 'starting-small-and-expanding-carefully', 'why-the-program-uses-this-approach'] },
  { path: '/mentees', title: 'For mentees', sections: ['the-mentees-role', 'the-mentee-application', 'owners-outcome'] },
  { path: '/mentors', title: 'For mentors', sections: ['the-mentors-role', 'the-mentor-profile'] },
  { path: '/training', title: 'Training', sections: ['training-curriculum'] },
  { path: '/terms', title: 'Program Terms', sections: ['program-terms', 'relationship-boundaries'] },
  { path: '/privacy', title: 'Privacy Notice', sections: ['privacy-confidentiality-and-deletion'] },
  { path: '/contact', title: 'Contact and support', sections: ['contact-and-support'] },
  { path: '/licensing', title: 'Licensing and reuse', sections: ['sharing-and-reusing-the-program'] },
  { path: '/manual', title: 'Complete Program Manual', sections: '*' }
];
export const navigation = routes.slice(1, 5);
