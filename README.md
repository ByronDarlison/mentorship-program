# Mentorship Program

A simple mentorship program for entrepreneurs. People apply on the website; the Chair approves participants and matches through AI chat. The software handles email check-ins and reminders.

[Visit the EO Toronto website](https://mentorship.darlison.com)

## Review the program

1. **Participant experience:** read the homepage and both applications. Are the offer, eligibility, commitments and matching expectations clear?
2. **Training:** does the curriculum prepare mentors and mentees for useful conversations?
3. **Running the program:** read the [user guide](USER_GUIDE.md). Are the Chair’s decisions, automatic follow-ups and measures of success appropriate?
4. **Privacy and terms:** review the website notices, including AI use, confidentiality, paid services, retention and deletion. Identify any changes EO Toronto requires.
5. **Taking it over:** ask a technical reviewer to check the [technical guide](TECHNICAL_GUIDE.md), local demonstration, account access, costs, backups and transfer steps. This does not require changing the live system.

Return one short response: support the program or identify required changes, list any open questions, and distinguish optional improvements. No recruitment, live participant decisions or account transfer is required for this review.

Everything needed to inspect or reuse the software is in this public repository. A technical reviewer can follow the [technical guide](TECHNICAL_GUIDE.md) to run a local demonstration, inspect the code or plan a transfer. Use the local demonstration for fictional applications; live submissions create records and send email.

## Run it locally

Install Node.js 22 or later, clone this repository, then run:

```sh
npm ci
npm run dev:connected
```

Open http://127.0.0.1:8787/. Use the supplied fictional answers. No real email is sent. Run `npm test` for automated checks.

## Reuse and licenses

- **Code and technical documentation:** [MIT License](LICENSE-CODE.txt).
- **Program guidance, questions and training:** [Creative Commons Attribution 4.0](LICENSE-MATERIALS.md). Credit Byron Darlison and identify changes.
- **Roboto font:** [SIL Open Font License](website/design-review/assets/Roboto-OFL.txt).
- EO names, logos and branding are not licensed for reuse. This source uses neutral branding. Supply your own branding, accounts and reviewed policies.

Credentials and participant records are not stored here. The website's source copy remains in `program/program-manual.md`; reviewers do not need to read that build file.
