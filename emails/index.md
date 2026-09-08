# Email examples

Open `emails/index.html` in a browser after downloading the repository. Each message is also stored as a standalone HTML file. GitHub displays HTML source rather than rendering it.

All examples are fictional. The same HTML renderer is used for outgoing email. These files are a permanent template reference, not a one-time review checklist.

- [Applications open](applications-open.html): Prospective participants. Chair-approved invitation; not automatic.
- [Application received](application-received.html): Applicant. Automatic receipt after an application is saved.
- [Moving to matching](moving-to-matching.html): Applicant. Chair-approved message.
- [Not selected](not-selected.html): Applicant. Chair-approved message.
- [Mentor invitation](mentor-invitation.html): Prospective mentor. Chair-approved invitation.
- [Match introduction](match-introduction.html): Matched participants. Chair personalizes and approves the introduction.
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
- [Day 7 reminder](reminder-7.html): Participant who has not replied. Automatic for quarterly and final check-ins. First-meeting reminders use the confirmation above.
- [Day 14 reminder](reminder-14.html): Participant who has not replied. Automatic for quarterly and final check-ins. First-meeting reminders use the confirmation above.
- [Contact request, low value or unclear feedback](chair-review.html): Chair. Automatic notice. The underlying item remains open until handled.
- [Meeting needs review](chair-meeting-review.html): Chair. Automatic notice. The underlying item remains open until handled.
- [Missing response at deadline](chair-deadline.html): Chair. Automatic notice. The underlying item remains open until handled.
- [Email needs review](chair-email-review.html): Chair. Automatic notice. The underlying item remains open until handled.
- [Processing problem](chair-processing-error.html): Chair. Automatic notice. The underlying item remains open until handled.
- [Other Chair-approved email](custom-message.html): Approved recipient. Illustrative only. The Chair supplies and approves the actual subject, body and recipient.

To regenerate after editing wording or layout, run `npm run emails`. No email is sent.
