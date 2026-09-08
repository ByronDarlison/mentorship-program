# User guide

The program helps entrepreneurs make meaningful business progress through mentorship. The Chair manages it through connected AI chat. Participants use the website and email. There is no separate dashboard.

## How the program works

See [the mentorship journey](PROGRAM_JOURNEY.md) for the application-to-completion diagram and the emails sent along the way.

Mentees are current chapter members. Mentors need relevant experience but do not need to be members. Applications stay open, but a match and start date are not guaranteed. The Chair approves every participant and match. The first group has no more than ten pairs.

Both people attend a joint, live, one-hour online training. Each pair then meets for one hour in ten of the next twelve months, starting from its first actual meeting. The mentee schedules meetings and keeps the next three to six booked, or the remaining meetings near the end.

Participants begin in groups, called cohorts, and train together. Each pair's twelve-month cycle runs independently of the chapter's fiscal year and can continue across annual membership renewal dates. The new year does not restart or end the mentorship cycle.

The mentee comes prepared, considers what the mentor shares, decides what to do and acts on commitments. The mentor listens, asks questions, shares experience, points out possible blind spots and checks progress. Both keep conversations confidential, answer check-ins and do not engage in paid services between each other while participating together.

## What you do as Chair

Before your first use, the program owner authorizes your access and a technical maintainer connects your AI app using the [Chair connection steps](TECHNICAL_GUIDE.md#connect-the-chairs-ai-chat). You do not obtain a live access key from GitHub. Replacing a Chair does not require rebuilding the program.

Open an AI chat where the mentorship program connection is available. A general chat does not know which program you mean from “show new applications” alone. Start with:

> Using the mentorship program connection, show me new applications and anything that needs my attention.

The AI should use that connection to read current program records, not infer status from earlier conversation. If the connection is unavailable, use the setup link above; naming the program does not grant access.

You can keep a dedicated mentorship chat and use shorter follow-up requests once that context is established. In a new or general chat, name the mentorship program connection explicitly. The examples below assume you have already done that.

1. **Review applications.** Speak with each prospective mentee about readiness, membership and commitments. Speak with prospective mentors you do not know. Approve, wait or decline. Ask waiting applicants whether they want to remain under consideration; there is no automatic expiry.
2. **Make matches.** Ask AI for suggestions and the reasons behind them. Consider experience, fit and conflicts. Review the pair, group, recipients and introduction together. One approval records the match and queues the introduction for both people. Do not share full applications or rankings.
3. **Arrange training.** Choose the facilitator, date, time zone and Zoom link. Ask the AI to prepare a one-hour calendar invitation for the selected matched participants. Review the invitation and guest list, then approve it. Ask to see responses or change/cancel the same event when needed. Calendar acceptance is not attendance: record actual attendance after training and the pair's planned first meeting date separately. The pair manages its own mentoring meetings, keeping three to six booked.
4. **Review exceptions.** Handle unclear replies, requests for contact, low-value feedback and delivery problems. Ask for a proposed correction or message when needed.
5. **Review final results.** Confirm classifications, request a summary and approve removal of detailed applications and feedback after the final review.

For any change, the AI shows the exact proposal first. Approve it in chat, then check the saved result. Approving a participant does not approve a match or an email. If a proposal changes, approve the new version. Reading records needs no approval.

Useful requests:

> Suggest matches from the approved applications. Explain the fit and any concerns. Do not contact anyone.

> Propose this match with its introduction. Show me both recipients and the complete email so I can approve them together.

> Prepare a training calendar invitation for these matched participants on [date] at [time and time zone], using this Zoom link: [link]. Show me the invitation and guests before sending.

> Show the training calendar and who has accepted, declined or not answered.

> Show missing replies, requests for help and anything that failed.

> Show program results with counts, percentages and pending answers. Do not include names.

## What happens automatically

See [email examples](emails/index.md) for the wording, recipients and HTML format of program messages. Download the repository and open `emails/index.html` in a browser to view them as emails.

- An application is saved, a receipt is queued and you are notified.
- The day after the booked first meeting, the mentee is asked whether it happened or was rescheduled. Confirmed attendance starts the twelve-month cycle. Booking alone does not.
- Both people receive check-ins at months 3, 6, 9 and 12. They reply to the email with their answers. There is no separate check-in form.
- Unanswered requests receive reminders after 7 and 14 days. At 21 days, you are notified of the failure.
- A genuine reply stops that person's no-response reminders. Partial answers remain incomplete and do not reset the deadline. Automatic replies do not count.
- AI classifies brief feedback and flags unclear answers or low value for you. It does not approve participants or matches.

The hourly process runs even when your chat is closed. It sends the approved routine messages only; other messages need your approval. A queued message is not proof that it was sent.

## Check-ins and results

At month 12 or when a relationship ends early, both people are also asked what could improve the program. Their written recommendations are saved with their feedback and flagged for your review. Suggestions are optional and are not scored as program outcomes.

Quarterly check-ins ask how many meetings took place, what value the participant received and whether they want you to contact them. Month three counts from the first mentoring meeting; later scheduled check-ins count from the previous check-in. An early-ending check-in allows zero meetings if the pair never began. The final check-in also asks mentees about business progress and mentors about mentoring again.

Month 6, 9 and 12 emails briefly recall that person's previous check-in in conversational language, including its date, meeting count and exact feedback. They do not repeat previous Chair-contact requests, show AI ratings or share the partner's report. The meeting question gives an explicit start date based on the last reported count, or the first meeting if no count was received. Missing prior answers are identified, not invented. At month 12, progress and overall value refer to the whole mentorship, while meeting counts cover only the stated period.

Participants reply directly to the check-in email. The software connects the reply to the participant and original request. Reminders repeat the questions, so nobody needs to find another page or an earlier message. Unclear or incomplete answers go to the Chair for follow-up. There is no check-in webpage.

The four targets are 80% of mentees reporting meaningful business progress, 80% of mentees receiving meaningful value, 80% of mentors receiving meaningful value and 80% of mentors interested in mentoring again. Progress and value are separate. Enjoying the conversations does not replace business progress; an important decision can count without financial proof.

Results stay pending until the required outcome answers arrive or the original 21-day deadline expires. Missing outcomes then count as failures until corrected. Unclear answers are not positive results. Report counts alongside percentages and review small-group summaries for identifying details.

## Changes, endings and privacy

Ask for a correction if a recorded date or classification is wrong. If a pair ends early, record its actual end date. The software replaces unfinished quarterly requests with final feedback and includes the pair in results.

Participants may request access, corrections or deletion. Review the proposed deletion before approving. Deletion removes personal detail, not the person's contribution to overall results. Erased feedback cannot be revisited. Limited pending reporting data remains only until its reporting window closes, then becomes totals without an individual lookup. Withdrawal and deletion before a final request use a 21-day reporting-only window without sending further messages.

After the final review, retain only the permitted minimal participation record. Deleting database records does not erase email, calendar events or guest copies, forwarded copies, exports or chat history. Handle those copies separately and follow the website Privacy Notice. Never put participant data or confidential mentoring conversations in GitHub.

## If something stops working

Ask the AI to read the current status. Do not blindly resend uncertain mail or reset records. Have the maintainer check the mailbox receipt or recovery state. Setup, backups and transfer are covered in the [technical guide](TECHNICAL_GUIDE.md).
