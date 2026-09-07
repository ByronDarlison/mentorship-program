# Email processing

One hourly Worker reads the dedicated program mailbox, applies replies, queues due requests and reminders, sends pending messages and verifies a private backup. Operating mode uses ordinary text and actual participant addresses. Local review mode accepts invented fixtures and captures messages.

## Incoming replies

1. `program-mailbox.mjs` refreshes Google access and verifies the actual dedicated mailbox address. It never falls back to the Chair's personal mailbox.
2. It reads received messages, including read and archived mail. A failed page or message fetch holds reminders and deadline judgments. The current bound is 500 messages; review mailbox volume before reaching it.
3. `email-replies.mjs` excludes quoted history, attachments, recognized signatures and automatic replies. A reply must match both the participant's address and an original sent request reference. Unmatched messages become Chair-review items.
4. Operating mode interprets permitted current text with AI. Known identifiers are removed and suspicious residual contact patterns are refused. This is not guaranteed anonymization. Confidential mentoring conversations should not be emailed to the program.
5. Email and private forms use the same response functions. Gmail message IDs prevent duplicate updates. Partial answers retain their original deadline. Genuine replies stop that person's no-response reminders without inventing missing answers.

First-meeting confirmation must establish actual attendance. A booking or date alone never starts the cycle. Rescheduling cancels obsolete requests. Quarterly checks follow the first actual meeting at months 3, 6, 9 and 12. Reminders are due at days 7 and 14. The Program Manual and `followups.mjs` define the complete rules.

## Outgoing messages

`review-delivery.mjs` claims each pending job once. The mailbox sends it with a tracking header and verifies sender, recipient and Gmail's actual RFC Message-ID. The response deadline begins at confirmed sending. An uncertain send is held, not automatically retried. A bounded Sent-mail lookup can reconcile its receipt. Captured demonstrations never become outgoing mail.

In operating mode, messages go to the participant and Chair notices go to `CHAIR_EMAIL`. Review delivery uses `REVIEW_RECIPIENT`. A discretionary message requires its exact subject, body and destination to be approved in chat. Changed content, destination or record version invalidates the proposal.

## Connection and transfer

- `PROGRAM_MAILBOX` is separate from `CHAIR_EMAIL`. Forwarding can keep one inbox, but retain originals in the program mailbox for processing.
- Store `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN` only in private deployment secret storage.
- `PROGRAM_MAILBOX_VERIFIED=true` and `REVIEW_DELIVERY_VERIFIED=true` follow actual read/send verification. `MAIL_MODE=delivery` enables delivery. Missing configuration holds work.
- `MAILBOX_START_AT` is the initial operating cutover timestamp. Do not advance it during routine deployment.
- `REVIEW_AI_SPENDING_VERIFIED=true` and `REVIEW_OPENAI_API_KEY` enable approved AI. These legacy names also apply to operating mode.

For a new installation, enable Gmail API and create a web OAuth client with redirect `http://127.0.0.1:8765/oauth2callback`. Run `node runtime/scripts/authorize-mailbox.mjs /absolute/private/client.json /absolute/private/mailbox-oauth.json`. Both paths must be outside the repository and the output must not exist. The helper requests only `gmail.readonly` and `gmail.send`, verifies the dedicated account and saves owner-only credentials. It closes after completion or ten minutes. Replace its mailbox constant with the successor's address before authorization.

Stop the former sender before activating a replacement. Preserve request IDs, deadlines and message receipts, then verify one controlled reply on the destination. Sender/reference matching is not cryptographic DKIM/SPF verification.

## Deletion and verification

Database deletion does not delete email. The Chair separately removes applicable program-mailbox, forwarded inbox and exported copies under the Privacy Notice. The mailbox API scopes do not include permanent deletion. Provider retention and backup windows remain as disclosed.

Local tests verify failure, duplicate, deadline and parsing behavior. Live evidence belongs with the private installation's handover record, not reusable operational instructions.

Sources: [Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Gmail API](https://developers.google.com/workspace/gmail/api/reference/rest).
