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

Open http://127.0.0.1:8787/. Submit the prefilled fictional applications. Messages are captured locally, not sent. Check-ins are email-only; inspect the rendered examples in `emails/index.html`. Reply processing is exercised by the email-reply tests and, separately, a controlled mailbox test in an isolated installation.

Run `npm test` for automated checks. `npm run preview` shows the disconnected visual preview. The local demonstration does not exercise real email, paid AI or production backups.

## Where things live

| Path | Purpose |
|---|---|
| `program/program-manual.md` | Website and program content source: copy, training, policies, questions and message templates. |
| `website/design-review/` | The website's current layout, styling and assets. The directory name is historical. |
| `website/config/` | Public contact and application settings. |
| `runtime/worker.mjs` | Website/API entry point and scheduled processing. |
| `runtime/operator-server.mjs` | Chair's chat tools. |
| `runtime/migrations/` | Database tables and constraints. |
| `runtime/tests/` | Behavior and failure tests. |
| `runtime/classification-rules.mjs` | Feedback categories and fictional evaluation cases. |
| `emails/` | Standalone HTML examples and a browser index. No real recipients or request links. |
| `runtime/email-html.mjs` | Shared HTML email layout. The mailbox sends HTML plus plain text. |

Edit message wording in the existing content source and the fixed notification helpers. Run `npm run emails` to rebuild the website-derived templates and HTML examples. This renders files only; it does not send email or run tests. `runtime/scripts/build-emails.mjs` generates the example catalog using the same renderers. Open `emails/index.html` in a browser; GitHub shows the files as source.

Keep participant records, credentials, `.wrangler/`, generated `website/dist/` and `runtime/private/` out of Git. `SOURCE.json` and `MANIFEST.json` identify the exported source and file checksums.

## Set up an operating installation

These steps are for a new installation. To replace the Chair of an existing program, skip to [Connect the Chair's AI chat](#connect-the-chairs-ai-chat). Do not create a new database or change the mailbox just to replace the Chair.

The authorized maintainer needs access to the program's Cloudflare account and, for a new installation, its Google, Backblaze and OpenAI accounts. GitHub access supplies none of those permissions. Run `npx wrangler login` and `npx wrangler whoami` to confirm the intended Cloudflare account. Its account ID is shown by `whoami`; `npx wrangler d1 create YOUR_DATABASE_NAME` returns the new database ID. Put that ID in the operating configuration under the existing `DB` binding. Choose the Worker name yourself; deployment creates it if it does not exist. Obtain the full source commit with `git rev-parse HEAD`.

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

Use a separate test installation and addresses you control for email/AI checks. Confirm the application is saved once after a retry, its receipt reaches the intended inbox, a reply updates the same request, and an unclear reply remains flagged. Check `program_recovery_status` for `ready` after a backup and inspect Worker logs for `scheduled-review-failed` or `operator-needs-attention`. A health response proves the website and database are reachable, not that email, AI or backups work. Flags enable capabilities; they are not test results. In the isolated setup, enable the relevant flags when ready to exercise those services, then verify the actual results before accepting real participants.

The operating configuration uses `MODE=operating`, `MAIL_MODE=delivery` and hourly cron `0 * * * *`. Add a custom-domain route for your hostname and set `SITE_ORIGIN` to its HTTPS address. Do not rely only on the provider's hostname when checking a deployment.

For a hostname managed in the same Cloudflare account, the route entry is `{"pattern":"YOUR-PROGRAM-HOST","custom_domain":true}` inside the configuration's `routes` array. Cloudflare provisions its DNS and certificate. Verify the address in an ordinary browser before sharing it.

When moving the program to another domain, update every website and email link, not just DNS. Change `SITE_ORIGIN` and the Chair's `OPERATOR_ORIGIN`, then replace the old domain in the manual's email templates, website configuration and documentation. Regenerate the website and HTML email examples with `npm run emails` and deploy the updated application. The application links in the manual are written explicitly and do not automatically follow `SITE_ORIGIN`. Use descriptive hyperlinks in HTML emails, such as “Apply as a mentee”, rather than displaying full URLs. Keep the old domain redirecting to the new one where possible so previously sent links continue to work; otherwise those old emails retain their original addresses. Check application and check-in links before retiring the old domain.

Tests build the local review version. Always rebuild with `website/config/operating.json` immediately before an operating deployment. Keep the previous code revision available for rollback; never reset the database to roll back code.

### Secrets and providers

Store these through Cloudflare's secret storage, never in a committed file:

| Secret | Used for |
|---|---|
| `OPERATOR_BRIDGE_SECRET` | Authenticating the Chair's chat connection. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | Dedicated program mailbox. |
| `B2_KEY_ID`, `B2_APP_KEY` | Private backup bucket. Restrict the key to that bucket with list/read/write/delete access. |
| `REVIEW_OPENAI_API_KEY` | Automated AI. The name also applies to operating mode. |

For each secret, run `npx wrangler secret put SECRET_NAME --config wrangler.operating.jsonc` and paste the value at its hidden prompt. Check the Worker name and account first. This command updates the deployed Worker immediately. It is not a dry run. [Cloudflare secret instructions](https://developers.cloudflare.com/workers/configuration/secrets/).

Where the values come from:

- **Google:** download the web OAuth client JSON from the program's Google Cloud project. The authorization helper below writes `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN` to its private output file. Install those three values as separate Worker secrets.
- **Backblaze:** the bucket details show its name and ID. Create a bucket-restricted application key in the account's Application Keys section. Its `keyID` is `B2_KEY_ID`; its one-time `applicationKey` is `B2_APP_KEY`. Save the latter privately when created. The namespace is a unique label you choose for this installation, not another credential.
- **OpenAI:** an authorized administrator creates an API key in the program's OpenAI project and saves it as `REVIEW_OPENAI_API_KEY`. A chat subscription is not this API credential. Keep the existing approved spending limit; a new operator must approve its own charges.

**Email and training calendar:** Enable Gmail API and Google Calendar API in the same Google Cloud project. Create a web OAuth client with redirect `http://127.0.0.1:8765/oauth2callback`. Set the mailbox constant in `runtime/scripts/authorize-mailbox.mjs` to your dedicated address, then run:

```sh
node runtime/scripts/authorize-mailbox.mjs /absolute/private/client.json /absolute/private/mailbox-oauth.json
```

Use private paths outside the repository; the output must not exist. The helper requests `gmail.readonly`, `gmail.send` and `calendar.events.owned`. Connect the program mailbox, not a personal inbox. Forwarding to the Chair's usual inbox is optional; retain originals for processing. Set `PROGRAM_MAILBOX_VERIFIED` and `REVIEW_DELIVERY_VERIFIED` after testing.

For an existing Gmail-only connection, enable Calendar API, add the Calendar scope to the OAuth consent configuration and repeat authorization into a new private output file. Install the resulting secrets on the same Worker. Keep `PROGRAM_CALENDAR_ENABLED=false` until the calendar is ready for controlled verification. Enable it in an isolated operating-mode installation using only test recipients, verify creation, RSVP readback, rescheduling, cancellation and retry behavior, then enable the operating installation. Review mode cannot send calendar invitations.

### Training calendar operation

`runtime/training-calendar.mjs` uses the program Google account's primary calendar. The Chair supplies the Zoom link; the software does not create Zoom meetings or require a new scheduling service. Google owns events and RSVP status, separate from D1 attendance records. Guest names and addresses, event details and responses are stored by Google. Google Calendar copies are not included in the D1/B2 backup, and database deletion does not remove them. Handle those provider copies separately during deletion and transfer.

The chat connection exposes `program_training_calendar` for reading events and responses. `program_prepare_action` and `program_action` use operation `calendar_action`. Parameters are:

- `action`: `create`, `update` or `cancel`.
- `id`: a new UUID with hyphens removed, retained for retries of this exact action.
- `eventId`: the same as `id` for creation; the existing returned event ID for changes or cancellation.
- For creation or update: `applicationIds`, `start` as an RFC3339 timestamp with seconds and offset, `timeZone` as an IANA zone, and `zoomUrl`. Optional `zoomMeetingId` and `zoomPasscode` are omitted from the description when absent. The end is one hour later.
- `reviewHash`: returned by preparation, included unchanged in the approved execution.

Preview resolves recipients from current approved, matched applications and renders the canonical invitation. Updates supply the complete desired recipient list. Show the exact recipients, removed guests, date, time zone and full invitation in chat before approval. No automatic invitation follows from matching, and no separate ordinary training email should duplicate it.

Creation uses a stable event ID. Updates and cancellation keep that ID and use the current event version so changed events require a fresh proposal. Google sends guest notifications using `sendUpdates=all`. On an uncertain result, inspect the event and retry the same approved action, not a new event ID. RSVP reads do not mark attendance, start the pair's cycle or reschedule anything. Ordinary emailed requests still go to the Chair. A calendar acceptance does not guarantee that every mail client added the event automatically.

On transfer, retain or migrate the program Google account and its calendar separately from the database. If changing domains, update future invitation links and explicitly update existing events whose links must change. Do not recreate events simply because the Chair changes.

API references: [Google Calendar events](https://developers.google.com/workspace/calendar/api/v3/reference/events), [event updates and guest notifications](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch).

**Backups:** Set `B2_BUCKET`, `B2_BUCKET_ID`, `BACKUP_NAMESPACE` and `BACKUP_RETENTION_DAYS` (currently 7). Verify a snapshot and deletion checkpoint before setting `PRIVATE_RECOVERY_VERIFIED`. Expiry removes exact old versions while protecting the latest complete recovery set. Cloudflare and other provider retention are separate.

**AI:** `REVIEW_AI_SPENDING_VERIFIED` enables approved use. The current ceiling is US$5 per UTC month. `runtime/ai-budget.mjs` reserves allowance before calls; check model and pricing assumptions in `runtime/review-ai.mjs` before changing providers or models. Run the cases in `runtime/classification-rules.mjs` after changing the model or prompt. Local tests alone do not establish real-model accuracy.

### Connect the Chair's AI chat

After setup, the Chair must select or explicitly name this connection in their AI chat. Start with: “Using the mentorship program connection, show me new applications and anything that needs my attention.” A general chat cannot infer the intended application from “show new applications” alone. See the [Chair instructions](USER_GUIDE.md#what-you-do-as-chair). A dedicated mentorship chat may retain context, but the AI must still read current records through the connection.

The program owner authorizes the Chair. A maintainer with permission to update this Cloudflare Worker performs the setup. This supports one Chair connection identity, not separate accounts for several Chairs.

| Setting | Where to get it |
|---|---|
| `OPERATOR_ORIGIN` | The existing program's HTTPS website address, the same origin as the Worker's `SITE_ORIGIN`. Do not include `/api/operator`. For a new installation, use its own deployed address. |
| `OPERATOR_ID` | The Worker's current `OPERATOR_ID`. For a replacement Chair, choose a new label such as `chair-jane` and install that exact label on both sides. The label is not a password. |
| `OPERATOR_BRIDGE_SECRET` | Generate a new random 64-character password with a password manager. Store it as a private item and use the exact same value for the Worker secret and connector file. Never use an example value, publish it or paste it into an AI conversation. Cloudflare does not reveal an existing secret; rotate it if the authorized private copy is unavailable. |

**1. Prepare the private connector file.** Create a folder outside the checkout, accessible only to its owner. Save `mentorship-operator.json` there, replacing the three placeholders below. On macOS/Linux, set the folder to mode 700 and the file to mode 600 with `chmod`. File values override environment values.

```json
{
  "OPERATOR_ORIGIN": "https://YOUR-PROGRAM-HOST",
  "OPERATOR_ID": "chair-jane",
  "OPERATOR_BRIDGE_SECRET": "REPLACE_WITH_NEW_PRIVATE_RANDOM_VALUE",
  "CHAT_ACTIONS_ENABLED": "false"
}
```

**2. Install the server settings.** Confirm the existing Worker name, account and database in `wrangler.operating.jsonc`. Keep its current mailbox, domain, recovery settings and other variables. Set `OPERATOR_ID` to the chosen label and temporarily set `CHAT_ACTIONS_ENABLED` to the string `false`. Rebuild and deploy using the operating commands above, then run:

```sh
npx wrangler secret put OPERATOR_BRIDGE_SECRET --config wrangler.operating.jsonc
```

Paste the new password at the hidden prompt. Coordinate this brief cutover with the outgoing Chair: changing the server key immediately invalidates the old connector. It does not stop the scheduled emails or delete program records.

**3. Register the connector in the new Chair's AI app.** The app must support local MCP servers (stdio). In its MCP configuration use:

- Command: the absolute Node executable path, found with `node -p process.execPath`.
- First argument: the absolute checkout path to `runtime/operator-server.mjs`.
- Second argument: the absolute path to the private `mentorship-operator.json` file.

For clients that use an `mcpServers` JSON configuration, the entry looks like this. Replace all paths with actual absolute paths on the Chair's computer; other clients offer the same command and argument fields in settings.

```json
{
  "mcpServers": {
    "mentorship": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/mentorship-program/runtime/operator-server.mjs",
        "/absolute/private/mentorship-operator.json"
      ]
    }
  }
}
```

Reload that connection. A website URL alone is not an MCP connection, and an app that accepts only hosted MCP URLs cannot run this local connector. The secret stays in the private file; the AI app receives access to program tools and records, so use only an authorized account with appropriate data settings.

The access key authorizes the operator, not one narrowly limited task. Keeping actions disabled in the local file is useful during testing but is not a separately restricted read-only credential. If the key is exposed, the authorized maintainer rotates the Worker secret and updates the authorized connector. Removing a local file alone does not revoke a copied key.

**4. Test access before enabling changes.** Ask the new Chair's AI to call `program_results` and `program_recovery_status`. Successful tool responses prove the connection; an ordinary conversational answer does not. Ask the old connector to call `program_results` and confirm it fails authentication. Do not test by approving a real applicant. If only `connection_check` appears, the private file is missing, unreadable or lacks a required setting. An authentication error means the origin, ID or key does not match. If the new connection fails, the maintainer corrects the settings; do not share the old key as a workaround.

**5. Enable approved changes.** Set `CHAT_ACTIONS_ENABLED` to the string `true` in both the Worker configuration and private connector file, redeploy the operating build, and reload the connection. Remove the old connector and its private key copy. Update the Chair's notification/contact email and mailbox forwarding separately if responsibility for those has changed. Do not reconnect a personal inbox.

Verify read-only calls first. The exact string `true` enables `CHAT_ACTIONS_ENABLED` on both the connection and Worker. The assistant calls `program_prepare_action`, shows the exact proposal, waits for the Chair's explicit approval, then calls `program_action` with the approved parameters and checks the result. Authentication identifies the connection; it is not proof of human approval.

## What the software does

Applications, receipts and Chair notifications save together. Submission IDs prevent duplicate retries. The Chair approves participants and matches. Confirmed first attendance starts the twelve-month cycle; booking and training do not.

Each hourly run reads mail before applying reminders and deadlines. Sender and original message references must match. Quoted text, attachments and automatic replies are excluded. A failed mailbox scan holds deadline processing. The current scan bound is 500 messages; monitor volume before reaching it.

Check-ins are email-only. Sender and email-thread/request matching connect replies to records; message IDs prevent duplicate updates. Partial replies preserve the original deadline. An uncertain send is held until mailbox evidence resolves it, not blindly retried. The retired `/api/check-in` endpoint returns 410 and does not read or write participant records. `/check-in` only directs visitors to reply to their email. Legacy form helpers remain for historical tests, not as an available participant response route.

AI receives limited text and coded matching facts, not name, email or LinkedIn fields. Identifier checks are not guaranteed anonymization. AI failures leave work pending for review. Only the Chair approves participants, matches and discretionary messages. Record versions prevent stale proposals being applied.

## Records, deletion and recovery

The Chair's `administration` action `approve_match` includes `introduction: {subject, body}`. The proposal shows the pair, current recipient addresses and complete introduction. One approval saves the pair and queues both message copies in the same database transaction. Versions and the action ID prevent stale or duplicate execution. Include both names, roles and contact details in the body, since each person receives a separate email. This replaces a second approval/send step; it does not authorize an introduction that was omitted from the reviewed proposal.

The SQL migrations define applications, groups, pairs, check-ins, responses, message jobs, actions, aggregate results and recovery state. Business dates are `YYYY-MM-DD`; event times use UTC. Keep booked and actual meeting dates distinct. Captured jobs are not sent jobs.

Final reporting counts each relationship-role once, including early endings. Missing outcomes fail at the original deadline, not before. The legacy `anonymous_outcomes` table holds temporary private results, not guaranteed anonymous data. Its rows are folded into overall totals and removed when due.

Final-review cleanup removes detailed answers but retains the permitted minimal participation record. Full personal deletion also removes the individual outcome lookup. Deletion must not improve overall success rates. Database deletion does not erase mailbox, forwarded, exported or provider copies. Handle those separately under the Privacy Notice; the mailbox connection cannot permanently delete email.

Protected changes mark recovery pending, then ready after snapshot/checkpoint verification. If pending, verify that the previous operation stopped before using the explicit repair action. Never restore an older snapshot simply to clear the error.

### Back up or transfer the program

1. The maintainer calls the signed operator API action `backup_now` and verifies success. `export_recovery` reads the current verified set. These are not registered tools in the ordinary Chair chat. Use `remoteOperatorBackend` from `runtime/operator-tools.mjs` with the private origin, ID and key, then call it with `('backup_now', {})` or `('export_recovery', {})`. Write exports directly to a private file, never chat or terminal output. The Chair can read backup status through `program_recovery_status`.
2. Prepare the successor's accounts and an empty, stopped destination. Apply the current migrations.
3. Use `runtime/recovery.mjs` to validate and import the export with the latest independent privacy checkpoint. Use `seedRecoveryState` from `runtime/recovery-cycle.mjs` with the verified manifest. Preserve record IDs, dates, replies, message receipts and results so prior deletions stay deleted and sent messages are not repeated.
4. Verify the restored records and destination services without enabling a second sender. Stop the original sender before enabling the replacement, then verify a controlled reply and revoke former access.

Do not import into a populated database, relabel old snapshot versions or put recovery files in GitHub. The current package is version 6. Older versions require their original code/schema and migration before a fresh export. Transfer the domain, mailbox, private records and credentials separately from the public code.

Restoration is a maintainer operation using a destination D1 binding, not a built-in one-command installer. The executable examples are in `runtime/tests/recovery-cycle.test.mjs` and `runtime/tests/recovery.test.mjs`. Disable the destination cron and public intake while preparing it; setting chat actions to false alone does not stop scheduled work. After importing, check record counts, original deadlines, sent-message receipts and deleted-record absence before cutover. Do not enable two senders against a copied mailbox.

## Maintenance

Check health, failed jobs and backup status through the Chair connection and Worker logs. Investigate held sends before retrying. Keep only one active sender. Run tests after changes and visually check affected pages before deploying. Keep program copy in its source file so generated pages remain consistent.
