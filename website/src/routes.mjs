// References only. All program paragraphs come from the canonical manual.
export const routes = [
  { path: '/', title: 'Home', sections: ['home', 'current-program-status'] },
  { path: '/apply/mentee', title: 'Mentee application', sections: ['the-mentees-role', 'the-mentee-application'] },
  { path: '/apply/mentor', title: 'Mentor application', sections: ['the-mentors-role', 'the-mentor-profile'] },
  { path: '/training', title: 'Training', sections: ['training-curriculum'] },
  { path: '/owners-outcome', title: "Owner's Outcome", sections: ['owners-outcome'] },
  { path: '/terms', title: 'Program Terms', sections: ['program-terms'] },
  { path: '/privacy', title: 'Privacy Notice', sections: ['privacy-confidentiality-and-deletion'] },
];
export const navigation = routes.filter(route => ['/apply/mentee', '/apply/mentor', '/training'].includes(route.path));
