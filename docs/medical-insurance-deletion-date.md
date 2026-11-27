# Medical insurance: the deletion date and how far back it may go

The owner asked on 27 November 2026. He had set Salim Gomha's removal to 22 November, and the emailed Deletions
file said 23 November, the exit day. His words: "It must follow what I say … audit the contract … always go back as
far as you can". He then shared the signed policy and the renewal offer: "audit it, and identify".

## What the code does

- **The Deletion date.** Every person to remove on the Add / Remove screen has one.
  - Export, Send and End cover all use it.
  - The Send confirm panel lists it per person.
- **The rule's file.** It is `src/lib/medical-insurance/deletion-day.ts`, read by both the screen and
  `prepareLibanoMemberFile`.
- **The default.** The date starts as far back as Libano-Suisse's own file accepts.
- **Limits a typed date must meet:**
  - not before the person's own cover began;
  - not after the policy ends;
  - at most `LIBANO_MOST_DAYS_BACK` (14) days behind the sending day.
- **The family.** They go on the same date. A spouse or child whose own cover began later goes from their own start.
- **Later leavers.** Someone leaving later keeps their exit day.
- **The test.** `testADeletionGoesWithTheTypedDayAndAsFarBackAsAllowed` pins all of this.

## What the papers say, highest first

1. **The signed policy 50048950, clause 5/5/4 "الحذف" (pages 21–22)** is the highest document.
   - The deletion needs Libano-Suisse's deletion form, filled in.
   - The membership cards must come back before the deletion date.
   - **The deletion takes effect from the day the company receives the deletion request and the cards.**
   - (b) No card back means no refund at all.
   - A late card cuts the refund in proportion to the delay.
   - Sato alone pays what the deleted person runs up from the deletion date until the cards are back.
   - (c) Deleting the employee ends the family's cover at once.
   - **So the contract gives no right to backdate.** An earlier date is a request the insurer may honour.
2. **The policy's annex (page 34)** changes clause (a): the rest of the term is refunded one month after the deletion
   date, whether or not claims were made.
3. **The signed renewal offer, page 6 "إجراءات الإضافة و الحذف".**
   - It asks for the Excel file, with the card returned on the deletion day.
   - It refunds by the day, from the deletion date to the policy's end.
   - It sets no limit on how far back.
4. **Libano-Suisse's Additions and Deletions workbook.**
   - Its deletion check is `IF((TODAY()-date)<Assumptions!E7,"Checked","Exceed Grace period")`.
   - E7 is "Gras Period for addition or deletion".
   - Our file writes `LIBANO_GRACE_PERIOD_DAYS` = 15 there, the grace the rules page gives additions.
   - So a date passes when it is at most 14 days behind the day the insurer opens the file.
   - The blank template as Libano-Suisse issued it holds 31.
   - The workbook's own rules page (English I11, Arabic I10) accepts a deletion only from the request day.

## His decision

After the audit (27 November 2026): "consider the backdate is 14 days and always use the maximum backdate, but
take care of the policy start, which is the 22nd … you always go back 14 days, but never before 22 November".
The default is therefore 14 days behind the sending day, floored at the policy's first day and the person's own
cover start; `earliestDeletionDay` is the one place that says so.

## So

- **The 14 days are the most Libano-Suisse's own file marks "Checked".** They are not a refund the contract
  promises.
- **Return the card on the day.** Without it there is no refund, and Sato carries the person's costs.
