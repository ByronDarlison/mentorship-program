# Technical guide

One Cloudflare Worker serves the website, API and hourly job. Private D1 storage holds applications and program records. A dedicated Google mailbox sends messages and receives replies. OpenAI interprets replies and suggests matches. Backblaze B2 stores encrypted backups. The Chair uses an existing AI chat connection, not a custom dashboard.

## Run and test locally

Install Node.js 22 or later and Git:

```sh
git clone https://github.com/ByronDarlison/mentorship-program.git
cd mentorship-program
npm ci
npm run dev:connected
```

Open http://127.0.0.1:8787/. Submit the prefilled fictional applications. Messages are captured locally, not sent. In a second terminal, run `node runtime/scripts/seed-review.mjs` and open the printed check-in link. Try partial answers, completion and corrections.

Run `npm test` for automated checks. `npm run preview` shows the disconnected visual preview. The local demonstration does not exercise real email, paid AI or production backups.

## Where things live

| Path | Purpose |
|---|---|
| `program/program-manual.md` | Website copy, training, policies, questions and message templates. This is build source, not required reading for reviewers. |
| `website/design-review/` | The website's current layout, styling and assets. The directory name is historical. |
| `website/config/` | Public contact and application settings. |
| `runtime/worker.mjs` | Website/API entry point and scheduled processing. |
| `runtime/operator-server.mjs` | Chair's chat tools. |
| `runtime/migrations/` | Database tables and constraints. |
| `runtime/tests/` | Behavior and failure tests. |
| `runtime/classification-rules.mjs` | Feedback categories and fictional evaluation cases. |

Keep participant records, credentials, `.wrangler/`, generated `website/dist/` and `runtime/private/` out of Git. `SOURCE.json` and `MANIFEST.json` identify the exported source and file checksums.

## Set up an operating installation

1. Create a Cloudflare Worker and an empty D1 database. Copy `wrangler.operating.example.jsonc` to `wrangler.operating.jsonc`; replace every placeholder with your installation's values.
2. Set the website origin, Chair contact, dedicated program mailbox, operator ID and a unique backup namespace. Update `website/config/operating.json`. Supply your own permitted branding and review the Terms and Privacy Notice for your organization and providers.
3. Configure Google email, B2 and OpenAI as described below. Set each verification flag only after its connection has been tested. `MAILBOX_START_AT` is the initial cutover timestamp; do not advance it during routine deployments.
4. Apply migrations, build and deploy:

```sh
npx wrangler d1 migrations apply DB --remote --config wrangler.operating.jsonc
node website/scripts/build.mjs website/config/operating.json
npx wrangler deploy --config wrangler.operating.jsonc --var RELEASE:YOUR_FULL_COMMIT_SHA
```

5. Check `/api/health`, the public hostname, both application forms and training on desktop and mobile. Verify one controlled application, outgoing email, reply, scheduled follow-up and backup readback. Remove the test records afterward.

The operating configuration uses `MODE=operating`, `MAIL_MODE=delivery` and hourly cron `0 * * * *`. Add a custom-domain route for your hostname and set `SITE_ORIGIN` to its HTTPS address. Do not rely only on the provider's hostname when checking a deployment.

Tests build the local review version. Always rebuild with `website/config/operating.json` immediately before an operating deployment. Keep the previous code revision available for rollback; never reset the database to roll back code.

### Secrets and providers

Store these through Cloudflare's secret storage, never in a committed file:

| Secret | Used for |
|---|---|
| `OPERATOR_BRIDGE_SECRET` | Authenticating the Chair's chat connection. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | Dedicated program mailbox. |
| `B2_KEY_ID`, `B2_APP_KEY` | Private backup bucket. Restrict the key to that bucket with list/read/write/delete access. |
| `REVIEW_OPENAI_API_KEY` | Automated AI. The name also applies to operating mode. |

**Email:** Enable Gmail API and create a web OAuth client with redirect `http://127.0.0.1:8765/oauth2callback`. Set the mailbox constant in `runtime/scripts/authorize-mailbox.mjs` to your dedicated address, then run:

```sh
node runtime/scripts/authorize-mailbox.mjs /absolute/private/client.json /absolute/private/mailbox-oauth.json
```

Use private paths outside the repository; the output must not exist. The helper requests `gmail.readonly` and `gmail.send`. Connect the program mailbox, not a personal inbox. Forwarding to the Chair's usual inbox is optional; retain originals for processing. Set `PROGRAM_MAILBOX_VERIFIED` and `REVIEW_DELIVERY_VERIFIED` after testing.

**Backups:** Set `B2_BUCKET`, `B2_BUCKET_ID`, `BACKUP_NAMESPACE` and `BACKUP_RETENTION_DAYS` (currently 7). Verify a snapshot and deletion checkpoint before setting `PRIVATE_RECOVERY_VERIFIED`. Expiry removes exact old versions while protecting the latest complete recovery set. Cloudflare and other provider retention are separate.

**AI:** `REVIEW_AI_SPENDING_VERIFIED` enables approved use. The current ceiling is US$5 per UTC month. `runtime/ai-budget.mjs` reserves allowance before calls; check model and pricing assumptions in `runtime/review-ai.mjs` before changing providers or models. Run the cases in `runtime/classification-rules.mjs` after changing the model or prompt. Local tests alone do not establish real-model accuracy.

### Connect the Chair's AI chat

Add an MCP server to the Chair's AI client with command `node` and arguments consisting of the absolute path to `runtime/operator-server.mjs` and an optional absolute private JSON configuration path. That file contains `OPERATOR_ORIGIN`, `OPERATOR_ID`, `OPERATOR_BRIDGE_SECRET` and `CHAT_ACTIONS_ENABLED`. Keep it outside Git, readable only by its owner. File values override environment values.

Verify read-only calls first. The exact string `true` enables `CHAT_ACTIONS_ENABLED` on both the connection and Worker. The assistant calls `program_prepare_action`, shows the exact proposal, waits for the Chair's explicit approval, then calls `program_action` with the approved parameters and checks the result. Authentication identifies the connection; it is not proof of human approval.

## What the software does

Applications, receipts and Chair notifications save together. Submission IDs prevent duplicate retries. The Chair approves participants and matches. Confirmed first attendance starts the twelve-month cycle; booking and training do not.

Each hourly run reads mail before applying reminders and deadlines. Sender and original message references must match. Quoted text, attachments and automatic replies are excluded. A failed mailbox scan holds deadline processing. The current scan bound is 500 messages; monitor volume before reaching it.

Email and private forms update the same request. Link secrets travel in URL fragments and API authorization headers. Message IDs prevent duplicate updates. Partial replies preserve the original deadline. An uncertain send is held until mailbox evidence resolves it, not blindly retried.

AI receives limited text and coded matching facts, not name, email or LinkedIn fields. Identifier checks are not guaranteed anonymization. AI failures leave work pending for review. Only the Chair approves participants, matches and discretionary messages. Record versions prevent stale proposals being applied.

## Records, deletion and recovery

The SQL migrations define applications, groups, pairs, check-ins, responses, message jobs, actions, aggregate results and recovery state. Business dates are `YYYY-MM-DD`; event times use UTC. Keep booked and actual meeting dates distinct. Captured jobs are not sent jobs.

Final reporting counts each relationship-role once, including early endings. Missing outcomes fail at the original deadline, not before. The legacy `anonymous_outcomes` table holds temporary private results, not guaranteed anonymous data. Its rows are folded into overall totals and removed when due.

Final-review cleanup removes detailed answers but retains the permitted minimal participation record. Full personal deletion also removes the individual outcome lookup. Deletion must not improve overall success rates. Database deletion does not erase mailbox, forwarded, exported or provider copies. Handle those separately under the Privacy Notice; the mailbox connection cannot permanently delete email.

Protected changes mark recovery pending, then ready after snapshot/checkpoint verification. If pending, verify that the previous operation stopped before using the explicit repair action. Never restore an older snapshot simply to clear the error.

### Back up or transfer the program

1. Use the Chair action `backup_now` and verify success. `export_recovery` reads the current verified set. Keep it private.
2. Prepare the successor's accounts and an empty, stopped destination. Apply the current migrations.
3. Use `runtime/recovery.mjs` to validate and import the export with the latest independent privacy checkpoint. Use `seedRecoveryState` from `runtime/recovery-cycle.mjs` with the verified manifest. Preserve record IDs, dates, replies, message receipts and results so prior deletions stay deleted and sent messages are not repeated.
4. Verify the restored records and destination services without enabling a second sender. Stop the original sender before enabling the replacement, then verify a controlled reply and revoke former access.

Do not import into a populated database, relabel old snapshot versions or put recovery files in GitHub. The current package is version 6. Older versions require their original code/schema and migration before a fresh export. Transfer the domain, mailbox, private records and credentials separately from the public code.

## Maintenance

Check health, failed jobs and backup status through the Chair connection and Worker logs. Investigate held sends before retrying. Keep only one active sender. Run tests after changes and visually check affected pages before deploying. Keep program copy in its source file so generated pages remain consistent.
