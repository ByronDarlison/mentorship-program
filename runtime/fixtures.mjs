// Public, invented examples. No participant information belongs in this file.
export const examples = Object.freeze({
  mentee: {
    name: 'Alex Example', email: 'alex@example.test', 'linkedin-url': '',
    business: 'Fictional North Shore Supply sells maintenance supplies to local businesses. It has operated for eight years, has annual revenue of CAD 3 million and employs eighteen people.',
    challenge: 'Delivery errors are increasing. I want to help our operations leader make decisions without waiting for me.',
    'mentor-experience': 'Experience delegating operations decisions in a growing distribution business.',
    'additional-information': ''
  },
  mentor: {
    name: 'Jordan Example', email: 'jordan@example.test', 'linkedin-url': '',
    experience: 'I led a fictional distribution business with thirty employees and helped an operations team take responsibility for daily decisions.',
    'business-fit': 'Distribution, growing teams, operational quality and delegation.',
    'additional-information': ''
  }
});

export const fields = {
  mentee: ['name', 'email', 'linkedin-url', 'business', 'challenge', 'mentor-experience', 'additional-information'],
  mentor: ['name', 'email', 'linkedin-url', 'experience', 'business-fit', 'additional-information']
};
