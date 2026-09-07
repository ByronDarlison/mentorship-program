# Mentorship runtime

One Cloudflare Worker serves the website and API. D1 stores private records. A dedicated Google mailbox handles email. Backblaze B2 stores encrypted recovery copies. OpenAI interprets permitted replies, classifies feedback and recommends matches. The Chair makes participant and matching decisions through existing AI chat.

## Local review

Use Node.js 22 or later:

```sh
npm ci
npm run dev:connected
```

Open http://127.0.0.1:8787/. The default configuration accepts supplied fictional applications and captures messages without sending. `npm run preview` opens the disconnected visual preview. `node runtime/scripts/seed-review.mjs` creates a fictional local final-check-in link.

`npm test` builds and runs behavior tests. `npm run check:deploy` performs a deployment dry run. The original branded source also includes browser tests; a neutral reusable edition needs its own rendered checks.

## Operating setup

1. Create your own Cloudflare Worker and empty D1 database. Apply every migration in `runtime/migrations/`.
2. Copy `wrangler.operating.example.jsonc` to `wrangler.operating.jsonc` in the reusable edition. Replace all placeholders, including contacts, origin and database details.
3. Update `website/config/operating.json` with your public contact. Review your branding, program terms, privacy statement and provider settings.
4. Configure and verify the dedicated mailbox, private backup bucket and approved AI connection. Store secrets privately.
5. Build with `node website/scripts/build.mjs website/config/operating.json`. Validate the deployment, then deploy using your operating configuration. Verify actual bindings, health, scheduled execution, a controlled application and a complete reply cycle.

| Setting | Purpose |
|---|---|
| `MODE=operating`, `MAIL_MODE=delivery` | Ordinary applications and pending-message delivery |
| `CHAIR_EMAIL`, `PROGRAM_MAILBOX`, `SITE_ORIGIN` | Public contact, separate mailbox and website origin |
| `OPERATOR_ID`, `CHAT_ACTIONS_ENABLED` | Named Chair connection and action switch |
| `PROGRAM_MAILBOX_VERIFIED`, `REVIEW_DELIVERY_VERIFIED` | Verified mailbox access and delivery |
| `MAILBOX_START_AT` | Initial inbox cutover only, not a rolling date |
| `PRIVATE_RECOVERY_VERIFIED`, `B2_BUCKET`, `B2_BUCKET_ID` | Verified private storage connection |
| `BACKUP_NAMESPACE`, `BACKUP_RETENTION_DAYS` | Installation isolation and retention, currently 7 days |
| `REVIEW_AI_SPENDING_VERIFIED` | Approved AI use, including operating mode |

Secrets: `OPERATOR_BRIDGE_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `B2_KEY_ID`, `B2_APP_KEY`, `REVIEW_OPENAI_API_KEY`. Never commit or print values. The B2 key must be restricted to the chosen bucket with list/read/write/delete capabilities. See [email setup](../docs/email-processing.md) for mailbox authorization.

The hourly cron is `0 * * * *`. Version uploads do not change triggers. The current AI cap is US$5 per UTC month. `ai-budget.mjs` reserves whole microdollars conservatively before calls. Verify its model and pricing assumptions against current provider pricing before adoption or change.

## Chair chat connection

Register Node with the absolute path to `runtime/operator-server.mjs` and optionally an absolute private JSON configuration path. The private file holds `OPERATOR_ORIGIN`, `OPERATOR_ID`, `OPERATOR_BRIDGE_SECRET` and `CHAT_ACTIONS_ENABLED`. Keep it outside Git with mode 0600. File values override environment values. Only the exact string `true` enables actions on both server and Worker.

Verify signed read-only calls first. `program_prepare_action` displays the exact proposal and affected records. Wait for explicit Chair approval in chat, then call `program_action` with those exact parameters and verify the saved result. No separate popup is required. The signature authenticates the connection, not human consent. Continuing software work is not approval of a real participant or match.

## Recovery and transfer

`backup_now` verifies a new private snapshot and deletion checkpoint. `export_recovery` reads the current verified set. Native B2 stores exact versions under the installation namespace. Expiry removes old versions and protects the latest complete set; an expiry error is separate from backup validity.

Restore only into an empty, stopped destination. Apply migrations, use `recovery.mjs` to validate/import with the latest independent privacy checkpoint, then use `seedRecoveryState` with the verified completed manifest. Preserve IDs, deadlines, late replies and results. If recovery is pending, verify the previous operation has stopped before the explicit repair action. Never guess that an old copy is current.

Verify restored records and a controlled reply, stop the old sender and enable only one sender. Transfer private data outside GitHub and replace credentials. Database deletion and final-review cleanup require exact previews. Neither erases provider copies automatically; handle program email, forwarded copies and exports separately under the Privacy Notice.

## Documentation and source

- [Data dictionary](../docs/data-dictionary.md): records and relationships.
- [Technical overview](../docs/technical-overview.md): system behavior.
- [Classification guide](../docs/feedback-classification.md): fixed categories and examples.
- `program/program-manual.md`: program guidance and canonical copy.
- `node runtime/scripts/print-manual.mjs --pdf`: optional private tagged PDF using local Chrome.

Generated `website/dist/`, `.wrangler/` and `runtime/private/` stay outside Git. Build metadata records the source revision and manual digest. The original repository's packaging script produces an allowlisted neutral copy without private history, under MIT code and CC BY 4.0 materials licenses. Reusers supply their own branding, accounts and reviewed policies.
