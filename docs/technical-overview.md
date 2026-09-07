# Technical overview

Participants use public applications, private request links and email. The Mentorship Chair operates the software through existing AI chat. Ordinary code controls dates, permissions and reporting arithmetic. There is no separate dashboard, participant account system or custom chat client.

## Components

| Component | Responsibility |
|---|---|
| Program Manual and website build | Pages, applications, training, terms and privacy copy |
| Cloudflare Worker | Pages, APIs, authenticated Chair actions and hourly scheduling |
| Private D1 database | Applications, pairs, requests, replies, messages and results |
| Dedicated Google mailbox | Sending, reading and receipt reconciliation |
| OpenAI adapter | Permitted-text interpretation, classification and match recommendations |
| Private Backblaze B2 bucket | Encrypted snapshots, deletion checkpoints and exact-version expiry |

Local review mode accepts invented fixtures and captures messages. Operating mode accepts ordinary text and sends approved automatic messages to participants. See [runtime setup](../runtime/README.md), [data dictionary](data-dictionary.md) and [email processing](email-processing.md). Installation-specific status belongs in the private handover evidence.

## Applications and check-ins

Application, receipt and Chair notification save together. Stable identifiers protect duplicate retries. Failed saves retain browser answers. No public endpoint lists applications.

The Chair approves participants and matches. Training and booking do not begin the twelve-month cycle; confirmed first attendance does. The mentee owns scheduling and the pair keeps three to six upcoming meetings booked. Check-ins follow at months 3, 6, 9 and 12.

Private request links carry a secret in the URL fragment, sent to the API in an authorization header. Opening one neither submits nor exposes past answers. Partial replies and corrections preserve the original deadline. Email and forms update the same request. Genuine replies stop individual no-response reminders. Missing answers are not invented. The scheduler reads mail before reminders and overdue judgments, holding them if the scan is incomplete.

Early ending cancels future quarterly work and supersedes open quarterly requests with final feedback. Earlier answers and failure history remain.

## AI and Chair control

Matching uses coded relevant facts instead of name, email or LinkedIn fields. Recommendations include reasons, gaps and questions. Changed source records invalidate recommendations. AI cannot approve participants or matches.

Operating text processing removes known identifiers and refuses suspicious residual contact patterns. It cannot recognize every name or confidential fact and is not guaranteed anonymization. AI errors leave interpretation pending. Requests disable provider response storage, but provider retention and account settings still require review.

The current cap is US$5 per UTC month, reserved conservatively before calls. Recheck the model and pricing assumptions in `review-ai.mjs` and `ai-budget.mjs` before adoption.

The Chair approves an exact proposal in chat. Named backend actions check record versions and review hashes. Changed proposals require fresh approval. Authentication proves the connection, not the human decision.

## Results and deletion

Business progress, mentee value, mentor value and mentor return interest are separate measures. Significant and Meaningful count positively; Unclear is non-positive pending review. Return interest preserves Interested, Unsure, Not interested and conditions. Outcomes remain pending until the role's required outcome answers arrive or the original deadline expires. A missing meeting count affects completion, not an answered outcome.

Deletion must not improve success rates. Details are removed while approved temporary private pending results remain until their original window closes, then fold into overall totals. They are not described as anonymous. The counterpart can still give final feedback. Final-review cleanup instead preserves approved minimal personal outcomes and permits later classification-only correction without collecting new detail.

Applications, brief feedback and operational history never belong in GitHub. Confidential mentoring conversations are not collected. Database deletion does not erase email, forwarded copies, exports or provider backups. The operator handles those separately under the Privacy Notice. Small-group totals are not automatically anonymous.

## Recovery and portability

Protected operations mark recovery pending before changes and ready only after verified snapshot/checkpoint readback. An incomplete latest cycle blocks restoring an older copy. Hourly backups also cover ordinary form updates. Cloudflare recovery and provider retention are separate from B2's seven-day expiry.

B2 namespaces isolate installations. Expiry deletes exact old versions and retains the latest complete set. Failures appear in ordinary logs and Chair-visible status; no phone-alert service is required.

A successor uses its own accounts, credentials and reviewed policies. Restore into an empty stopped database with the current privacy checkpoint so deleted details stay deleted. Preserve request IDs, dates, replies and results. Verify the destination, stop the original sender and enable only one sender. A real organizational transfer is a future operating action, not an unfinished software feature.

Original program materials use CC BY 4.0 and code uses MIT in the clean reusable release. EO branding, third-party marks, private data and private history are excluded. The live Example Chapter website retains its approved presentation; the reusable edition uses neutral branding.
