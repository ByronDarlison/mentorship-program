# Mentorship Program

A small, portable mentorship program: a website, applications, training curriculum, email check-ins, results and Chair administration through existing AI chat. Original program materials by Byron Darlison.

This clean source edition comes from commit 1d83bc199109871181a608c3359ca9dbf3236e1f. It contains no private Git history, participant records, credentials or EO brand assets. See SOURCE.json for adaptations and MANIFEST.json for source checksums. Supply your own permitted branding.

## Try it locally

Install Node.js 22 or later:

```sh
npm ci
npm run dev:connected
```

Open http://127.0.0.1:8787/. Review mode is the safe default: supplied invented applications only, no external connections or email delivery. Run npm test for behavior checks. The code also includes operating mode, which accepts ordinary applications and sends real email once configured.

## Understand and operate

- [Chair's guide](docs/chair-guide.md): practical steps, approvals, examples and exception handling.
- [Program Manual](program/program-manual.md): program design, commitments, training and communication copy.
- [Runtime setup](runtime/README.md): local use, operating configuration, Chair chat, backups and transfer.
- [Technical overview](docs/technical-overview.md): components, responsibility and privacy boundaries.
- [Data dictionary](docs/data-dictionary.md): records and relationships.
- [Email processing](docs/email-processing.md): mailbox setup, replies, deadlines and delivery.
- [Classification guide](docs/feedback-classification.md): fixed categories and fictional examples.
- runtime/migrations/ and runtime/tests/: schema and behavior tests.

Copy wrangler.operating.example.jsonc to your own operating configuration and replace every placeholder. Configure your own Cloudflare, Google, Backblaze and OpenAI accounts. Update the public contact in website/config/operating.json. Verify provider settings, costs, a full reply cycle, private recovery and rendered pages before real use. Verification flags begin disabled intentionally. The current AI cap is US$5 per UTC month; recheck model pricing assumptions before adopting them.

Program terms and privacy text are examples, not legal approval for your organization, jurisdiction or providers. Adapt and review them. Database deletion does not automatically remove mailbox, forwarded, exported or provider copies. See the guides before enabling intake.

For takeover, use one empty stopped destination, preserve records and request identifiers with the current privacy checkpoint, verify restoration, then stop the former sender before activating the replacement. Transfer private data outside GitHub. No phone-alert service or separate admin dashboard is required.

## Licenses

Code and technical documentation: [MIT](LICENSE-CODE.txt). Original program materials: [CC BY 4.0](LICENSE-MATERIALS.md). Credit Byron Darlison and identify changes. Roboto retains its included SIL Open Font License. No EO endorsement or right to use EO trademarks is granted.
