# Private record dictionary

Schema version: migrations `0001` through `0008`. SQL in `runtime/migrations/` is authoritative for columns and constraints. This file contains definitions only, never participant rows.

| Table | Purpose |
|---|---|
| `applications` | Role, answers, acknowledgement versions, readiness, Chair decision and retention preference. Unique submission key and digest protect retries; version protects concurrent changes. |
| `cohorts` | Named groups. Unique `first_cohort=1` identifies the first group for its ten-pair cap. Names are case-insensitive. |
| `pairs` | Participant references, group, fit reason, status, training, planned date/revision, actual date, ending and version. A mentee has one open pair at most. Deleted references become null only on ended pairs. |
| `chair_actions` | Action digest, execution, actor, named action, subject IDs and saved result. Private history is not itself approval authority. |
| `matching_copies` | Temporary coded facts removed after match approval. No confidential mentoring text. |
| `requests` | One relationship-role's first-meeting, quarterly or final request. Scheduled time, initial capture, deadline, token hash, reply time, answers, per-field receipt times, categories, conditions and failure history. Superseded requests retain history but stop reminders. |
| `received_responses` | Stable source response ID, request, digest, original receipt time and saved result. Shared email/form duplicate protection. |
| `jobs` | Captured or pending work, kind, payload, request, status and optional delivery receipt. Private payloads can contain request links. Captured is not sent. |
| `activity` | Minimal subject, actor, operation and timestamp. No full answers or credentials in logs. |
| `anonymous_outcomes` | Legacy name for private pending results: random ID, role, deadline, reporting-only flag, answer-presence flags and categories. Dates may still make these traceable. No participant or pair ID, raw text or conditions. Removed when folded into totals. |
| `outcome_totals` | Four aggregate rows, one per outcome measure: included, positive, missing and unresolved-interpretation counts. No individual IDs or dates. |
| `anonymous_completion` | Aggregate required/completed counts and prior missed deadlines removed from personal records. |
| `deletion_ledger` | Coded application and execution IDs plus deletion time for restoration prevention and safe retry. No actor, feedback or action digest. Never use as an outcome lookup. |
| `recovery_state` | Current recovery sequence, pending/ready state, snapshot/checkpoint hashes and separate expiry result. This installation-specific pointer is rebuilt from a verified recovery manifest, not imported as participant data. |

## Dates and status

Business dates use `YYYY-MM-DD`; event times use UTC ISO timestamps. Month offsets clamp to the last valid day. Booked and actual first-meeting dates have different meanings.

In the disconnected demonstration, the response deadline begins at initial capture. With delivery enabled, it begins only at confirmed sending, not queuing. A reply does not imply every answer is complete. Missing is not zero meetings or a negative answer.

Job states are captured, pending, sending, sent, held and cancelled. Local demonstrations capture jobs. Verified delivery configurations queue requests, reminders, application notices and Chair-approved messages. An uncertain send is held until exact provider evidence settles it, never blindly retried. Pre-claim validation failure leaves a message pending with a separate delivery-error flag. Chair flags can be resolved without altering answers or delivery evidence. Captured demonstrations are never promoted to outgoing mail. Migration 0007 adds the stored RFC Message-ID. Monthly AI allowance records also use system jobs, with integer microdollar reservations.

Two system job IDs preserve mailbox connection history and a deduplicated visible mailbox error. No new table is needed. A previously connected installation cannot silently resume form-only deadlines after losing its connection settings. Participant support/review notices remain open when reminders are cancelled by rescheduling or early ending.

## Deletion and recovery

The Chair reviews unresolved interpretations and missing answers before approving the exact deletion preview in chat. Erased feedback cannot be reclassified. Approved temporary private reporting data remains until the result is included. Completed results fold immediately; pending results fold at their original deadline through the hourly job, even if email processing is held. Each fold atomically increases totals and removes its row. Provider copies must be handled separately under the Privacy Notice.

After a confirmed final review, `applications.details_removed_at` marks the removal of detailed answers. Only the name remains in the application answers. Final requests retain boolean answer-presence markers, categories and contact preference, with `reviewed_at` marking the cleanup. They have no feedback wording or usable form token. Earlier requests, matching copies, related old activity, approvals and outgoing jobs are removed. Completion counts move into the existing aggregate row exactly once. The other person's final feedback remains available. A retained missing result may be corrected by the Chair without storing new wording; full personal-record deletion removes that later correction route.

The version 6 recovery package contains all thirteen tables and must stay outside GitHub. Its privacy checkpoint carries the current minimal reviewed records and later classification-correction receipts as well as deletion and reporting state. Import into an empty stopped standby using that current checkpoint independently of the historical backup. Schemas and tests may enter a clean release; actual records may not. Earlier version 4 or 5 local snapshots require their original code and schema to restore, followed by the remaining migrations through 0006 and a fresh export. Do not merely relabel a snapshot's version. Do not use an older schema as a way around current deletion or cleanup state.
