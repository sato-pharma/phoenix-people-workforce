# One way to raise an approval, one way to decide it

*14 November 2026 · REC-032*

Thirteen modules ask someone to decide something: leave, excuses, weekly plans, Phoenix CRM, outstation,
direct orders, marketing, Market Awareness, resignations, contracts, probation, offers and Early Bird.
Until now each one told its approvers in its own way and showed its decision buttons in its own way.
Now there is one path for the notices and one look for the buttons.

## The notices: `raiseApproval`

`src/lib/approvals/raise-approval.ts`. Every "a decision is waiting for you", "moved to the next step"
and "approved, rejected or returned" notice passes through it. It has four delivery forms, and each one
is the sender the module already used:

| Form | Sender it calls |
| --- | --- |
| `notice` | `createSystemNotification` |
| `notices` | `createSystemNotificationForRecipients` (a fixed To and Cc list, one email envelope) |
| `durable-email` | `sendDurableEmail` (leave's approval emails, with Send again) |
| `direct-email` | the module's own email call, run unchanged (the direct-order final approval, the marketing "approved requests" list) |

**Same notices only (owner, 14 Nov 2026).** Nobody gains or loses a notice. Each caller passes the same
recipients, channels, wording and email as before. The door adds one thing: a tag on the in-app notice's
metadata, `approval: { module, step, decision }`. The step is one of `waiting`, `decided`, `returned`,
`reminder` or `fyi`.

The tag does not change de-duplication. A notice's event key is built from the actor, type, module,
title, link and recipient, plus `metadata.idempotencyKey`. It never reads the rest of the metadata, so
no notice merges or splits.

Some notices are not approvals, so they still go straight to the engine: the outstation departure-photo
reminder, the leave balance-settlement email, and the Phoenix CRM day-start, first-visit, forecast and
rep-plan notices. Each is named in `tests/approvals-one-door.test.ts`.

### Gaps that stay as they are

These are deliberate. Each one is the owner's decision, and none belongs to the door:

- When an expense claim is waiting, nobody is told, and nobody is told when it is approved.
- Probation and deduction decisions send no notice.
- Market Awareness reaches the requester and the chain only as a Cc on an email.
- The WhatsApp reminders and the production-planning alarms are not approvals, so they are out of scope.

## The buttons: the approval action kit

`src/components/approvals-hub/approval-action-kit.tsx`. These screens draw their decision buttons from
it:

- the request pages (`DecisionActions`, used by leave, excuses, direct orders and Early Bird);
- the weekly-plan and manager-plan panels;
- the Action Center's inline row;
- the Expense Approvals queue.

The same act now looks the same everywhere:

- Approve is filled green and Acknowledge is filled ink.
- Return is an amber outline and Reject is a rose outline.
- The System Administrator's answer is an ink outline.
- The "are you sure" step is always orange.

Every button has square corners and is 44 px tall at the regular size. A table row uses the dense size,
which is flat.

Only the look and the words are shared. Each module still decides who may act and where the decision is
sent:

- **Expense Approvals keeps its batch save** (owner, 14 Nov 2026). Approve on a row only marks the trip.
  Save sends the whole batch.
- **Marketing and Market Awareness keep their own inboxes.**

Pinned by `tests/approvals-one-interface.test.ts`.
