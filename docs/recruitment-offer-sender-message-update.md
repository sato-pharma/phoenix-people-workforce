# Job offers: who sent it, HR's own message, and the updated offer

Owner, 2026-11-10, word for word: "add a coloumn to show the job offer was sent by whom .... also add a
field for the HR to write whatever he wants and this goes in the job offer email body of the job offer
.... also make an option for the updated job offer i may need to update a job offer".

All three live on the Job Offers page (`/offers` for the admin shell, `/employee-portals/offers` for
Talent Acquisition). They sit on top of the HR Manager's approval (`docs/recruitment-offer-approval.md`)
and change none of it.

## 1. The "Sent by" column

A seventh column on the offers table, and the same line on the phone cards. It prints names, never HR
codes, read from the Employee Master by `src/lib/offers/people.ts`.

| Offer status | What the column says |
| --- | --- |
| Draft | "Drafted by" the person who created it |
| Waiting for approval | The person who asked for approval, with "awaiting approval" under it |
| Sent, accepted, declined, withdrawn | The person who pressed Send (the requester when it went through approval), and "Approved by" the HR Manager when that is somebody else |

A name that cannot be read says "Not recorded". The page still loads if the name read fails: a name is
display only, and nothing is decided from it.

## 2. HR's message in the email

The editor has a "Message to the candidate" box (`offer-email-message`). Whatever is typed there is
printed at the top of the offer EMAIL, under the letterhead and above the letter's first words, in both
the HTML part and the plain-text part.

- **Plain text.** It is escaped, so typed markup prints as typed. Line breaks are kept; runs of blank
  lines fold to one.
- **2,000 characters** on the screen and in the routes; the database refuses over 4,000.
- **Never on the PDF letter.** The letter is a signed document in a frozen design; the message is a
  covering note.
- **It travels with the offer row**, so the HR Manager reads and approves it with the rest, and Resend
  carries it again.

Column: `offers.email_message`. Rules: `normalizeOfferEmailMessage` in `src/lib/offers/revision-rules.ts`.

## 3. The updated offer

An updated offer is the **same offer row**, not a new letter: the reference, the seat, the candidate
link and the hire bridge all stay pointed at it.

1. On a sent offer the candidate has not answered, **Update offer** (`POST /api/offers/:id/revise`,
   `{ action: "start" }`, permission `offers:create`, audited) freezes the version that went out into
   `revision_history` (its terms, its letter snapshot, who sent and approved it, and when), puts the row
   back to draft and raises `revision` by one. Nothing is emailed.
2. HR edits it like any draft. The row shows "2nd version", "3rd version" and so on.
3. It goes out through the ordinary **Send**, so Talent Acquisition's update waits for the HR Manager
   exactly like a first send. His button reads "Send updated offer".
4. The candidate's email subject starts "Updated Offer of Employment", and its first line says it
   replaces the offer sent on the earlier date (Cairo calendar). The provider's idempotency key carries
   the revision (`offer-letter:<id>:rev:<n>`), so the updated letter is really sent and not answered with
   the first one. Revision 0 keeps the key every first send always used.
5. **Cancel update** (`{ action: "cancel" }`) throws the edits away and puts the version that went out
   back exactly as it was. It is refused while the update waits for approval: reject it to draft first.

While an update is in progress, the candidate's old link shows "being updated" (English and Arabic)
instead of letting the old terms be accepted.

Only a **sent** offer can be updated. A draft or a waiting offer is simply edited. An accepted, declined
or withdrawn offer, or one whose joining form was already submitted, is refused: re-issuing it is a new
offer. An offer with no candidate email or no saved letter copy is refused too.

Both start and cancel are conditional on the status and the revision number in the database, so two
presses cannot each freeze a copy.

## Where it lives

- `src/lib/offers/revision-rules.ts`: the pure rules (message, refusals, subject, key, update line).
- `src/lib/offers/service.ts`: `startOfferRevision` and `cancelOfferRevision`.
- `src/lib/offers/render-email.ts`: the message and the update line in the email.
- `src/lib/offers/people.ts`: the names for the Sent by column.
- `app/api/offers/[id]/revise/route.ts`: start and cancel.
- Migration `20261110195450_offer_email_message_and_revisions.sql`: `email_message`, `revision`,
  `revision_history`, `revised_at`, `revised_by`. Additive only; no existing row changes.

Pinned by `tests/offer-email-message-and-update.test.ts`.
