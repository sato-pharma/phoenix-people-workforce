# Job offers wait for the HR Manager's approval

**Owner, 2026-11-10, verbatim:** "When the talent acquisition sends a job offer, it doesn't send
automatic. It comes to me, the HR manager, for my approval. If I approved, the email is pumped. If I
reject or leave it pending, it leaves as it is. Got me? And of course, I have the option to edit
anything in the offer. But she never automatic sent. My approval first."

## Before

Anybody holding `offers:create` could press **Send offer** and the letter left at once. That was the
Super Admin and HR Resourcing (shown as Talent Acquisition). `offers:approve` existed as a permission
(Talent Acquisition's bundle withheld it on purpose) but no route ever asked for it.

## The rule now

| Who presses | What Send does |
| --- | --- |
| Holds `offers:approve` (only the Super Admin, which is the HR Manager) | Emails the candidate. On an offer that is waiting, this press is the approval: `approved_at` and `approved_by` are stamped with the send. |
| Does not hold it (Talent Acquisition) | The offer becomes `pending_approval`. Nothing is emailed. The CC and BCC she typed are kept on the row for his send. He gets a notice in-app, by push and on Telegram, never by email. |

While an offer waits:

- **Only he edits it.** `updateOffer` refuses everybody else, so what he approves is what he read.
- **His Reject** (`POST /api/offers/:id/reject`, `offers:approve`) puts it back to draft, unsent, with
  his note. Talent Acquisition is told in-app and by push, and the note shows on the draft's row.
- **Leaving it alone** leaves it waiting. Nothing ever sends on a timer.
- **No hand-set status skips him.** The status PATCH refuses `pending_approval`, refuses `sent` on any
  unsent offer, and refuses `accepted` or `declined` on a waiting one. A waiting offer can still be
  withdrawn.
- **It counts as not sent everywhere.** Resend and Expire refuse it, the joining form reads it as
  `not_sent`, the Talent Acquisition overview leaves it out of live letters, and the HR command
  centre's offers chart shows it as its own bar.

## Where it lives

- `src/lib/offers/approval-rules.ts`: the pure rules. The screen uses them too.
- `src/lib/offers/approval.ts`: `canApproveOffers` and the three notices.
- `src/lib/offers/service.ts`: `markOfferPendingApproval` (only from `draft`) and `returnOfferToDraft`
  (only from `pending_approval`). `markOfferSent` accepts either starting status.
- `src/lib/offers/send.ts`: `sendOfferEmail` requires `approvedByHrManager: true`. This is a literal
  type checked first, so any new caller has to say in its own code that an approver pressed the button.
- `app/api/offers/[id]/send/route.ts`: asks `offers:approve` and either parks the offer or sends it.
- Migration `20261110190002_offer_hr_manager_approval.sql`: the status and seven columns. It was
  applied to staging and production on 2026-11-10, and every existing row was left untouched.

Pinned by `tests/offer-hr-manager-approval.test.ts`.
