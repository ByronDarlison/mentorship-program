# Email examples

Open `emails/index.html` in a browser after downloading the repository. Select or scroll through the email list to see the template with insertion variables on the left and a finished fictional example on the right. Both panes update together. This viewer is designed for a large desktop screen. Each pane shows its subject; the shared information above explains the recipient, sending trigger and reply handling. Emails without insertion variables have the same content in both panes. The day 7 and day 14 examples illustrate a month 6 check-in reminder.

Each template is also stored as a standalone HTML file with a matching Markdown copy. Finished examples are embedded in the catalog HTML, so the complete comparison is available from the repository. GitHub displays HTML source rather than rendering it.

All example details are fictional, including the non-working Zoom link. The same HTML renderer is used for outgoing email. Check-in examples use the delivery message renderer with fictional history. These files are a permanent template reference, not a one-time review checklist.

- [Applications open](applications-open.html): Prospective participants. Chair-approved invitation; not automatic.
- [Application received](application-received.html): Applicant. Automatic receipt after an application is saved.
- [Moving to matching](moving-to-matching.html): Mentee. Chair-approved message.
- [Not selected](not-selected.html): Applicant. Chair-approved message.
- [Mentor invitation](mentor-invitation.html): Prospective mentor. Chair-approved invitation.
- [Match introduction](match-introduction.html): Matched participants. Approved together with the match, then queued for both participants.
- [Training invitation](training-invitation.html): Selected participants. Chair fills in the meeting details and approves sending.
- [New mentee application](chair-application-mentee.html): Chair. Automatic notice after an application is saved.
- [New mentor application](chair-application-mentor.html): Chair. Automatic notice after an application is saved.
- [First meeting confirmation](first-meeting.html): Mentee. Day after the booked meeting. The same wording is repeated on days 7 and 14 if unanswered.
- [Month 3 check-in](check-in-3.html): Mentee and mentor. Automatic, measured from confirmed first attendance.
- [Month 6 check-in](check-in-6.html): Mentee and mentor. Automatic, measured from confirmed first attendance.
- [Month 9 check-in](check-in-9.html): Mentee and mentor. Automatic, measured from confirmed first attendance.
- [Month 12: mentee](final-mentee-12.html): mentee. Final feedback. Each role receives its own questions.
- [Early ending: mentee](final-mentee-0.html): mentee. Final feedback. Each role receives its own questions.
- [Month 12: mentor](final-mentor-12.html): mentor. Final feedback. Each role receives its own questions.
- [Early ending: mentor](final-mentor-0.html): mentor. Final feedback. Each role receives its own questions.
- [Day 7 reminder](reminder-7.html): Participant who has not replied. Variable template for quarterly and final check-ins. First-meeting reminders use the confirmation above.
- [Day 14 reminder](reminder-14.html): Participant who has not replied. Variable template for quarterly and final check-ins. First-meeting reminders use the confirmation above.
- [Contact request, low value or unclear feedback](chair-review.html): Chair. Automatic notice. The underlying item remains open until handled.
- [Meeting needs review](chair-meeting-review.html): Chair. Automatic notice. The underlying item remains open until handled.
- [Missing response at deadline](chair-deadline.html): Chair. Automatic notice. The underlying item remains open until handled.
- [Email needs review](chair-email-review.html): Chair. Automatic notice. The underlying item remains open until handled.
- [Processing problem](chair-processing-error.html): Chair. Automatic notice. The underlying item remains open until handled.
- [Other Chair-approved email](custom-message.html): Approved recipient. The Chair supplies and approves the actual subject, body and recipient, including a closing only when it adds something useful.

To regenerate after editing wording or layout, run `npm run emails`. No email is sent.
