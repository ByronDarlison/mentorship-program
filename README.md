# Mentorship Program

A simple mentorship program for entrepreneurs. People apply on the website; the Chair approves participants and matches through AI chat. The software handles email check-ins and reminders.

[Visit the EO Toronto website](https://mentorship.darlison.com)

## Review the program

1. Visit the website. Read the mentee and mentor applications, training, Terms and Privacy Notice.
2. Read the [user guide](USER_GUIDE.md) to see how the Chair runs it.
3. Send Byron any questions or requested changes.

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
