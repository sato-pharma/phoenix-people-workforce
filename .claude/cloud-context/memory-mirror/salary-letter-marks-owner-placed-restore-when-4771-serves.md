---
name: salary-letter-marks-owner-placed-restore-when-4771-serves
description: "RESTORED 2026-09-29 19:31 Cairo - the owner's own hand-placed stamp and signature positions on the Arabic salary letter, with the coordinates kept in case they are ever lost again"
metadata:
  node_type: memory
  type: project
  originSessionId: 58f3e480-4d78-4e33-bc7c-c27f8b77f55d
  modified: 2026-09-29T16:31:32.349Z
---

✅ **RESTORED — this is CLOSED.** The owner's signature and stamp positions are back on the Arabic
salary letter in production, put back at 19:31 Cairo on 2026-09-29 the moment PR #4771 was confirmed
serving (live revision `2df4e8c15`, which contains the merge `305112798`). New ids
`7b84faa9-7921-4d1d-8add-1ca5b33edd2a` (signature) and `7baaf010-f718-4d46-bc62-504314699bbc`
(stamp), both `created_by_hr_id = 'B-10'`. **Do not restore them again** — check
`hiring_pack_document_fields where source_kind = 'mark'` before acting on this file at all.

**The history, because it explains why they were ever gone.** He placed them himself in the layout
editor at 17:05 and 17:06 Cairo that day. They were removed the same evening at his instruction —
"remove my salary letter marks until 4771 is serving" — because until #4771 deployed, a placed mark
printed on EVERY copy of that paper automatically, and he had ruled against exactly that ("donot put
the stamp permanent, make able to add them freely as i want"). Leaving them would have auto-stamped
every Arabic salary letter printed in the meantime. **#4771 makes a placed mark a POSITION only**,
ticked per print in the dialog that already asks for copies and address, so the same rows are now
safe and are what the tick-boxes offer.

**These are HIS coordinates, dragged by hand against the rendered page — not derived and not
re-derivable.** Kept here only as a recovery copy. If they are ever lost, put back exactly this and
do not "improve" the selector, the offsets or the sizes:

```sql
insert into public.hiring_pack_document_fields (
  document, template_version_id, employee_hr_id, default_key, hidden,
  page, anchor_selector, anchor_dx, anchor_dy, x, y, w, h, align, font_size,
  source_kind, value_key, literal_text, created_by_hr_id, updated_by_hr_id
) values
  ('salaryLetterAr', 'salary-letter-ar-v1', null, null, false,
   null, 'table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(1) > td:nth-of-type(1) > table:nth-of-type(2) > tbody:nth-of-type(1) > tr:nth-of-type(1) > td:nth-of-type(2)',
   48.70, 14.68, 0, 0, 90.00, 35.00, 'left', 9.00, 'mark', 'signature', null, 'B-10', 'B-10'),
  ('salaryLetterAr', 'salary-letter-ar-v1', null, null, false,
   null, 'table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(1) > td:nth-of-type(1) > table:nth-of-type(2) > tbody:nth-of-type(1) > tr:nth-of-type(1) > td:nth-of-type(2)',
   52.63, 0.00, 0, 0, 96.00, 96.00, 'left', 9.00, 'mark', 'stamp', null, 'B-10', 'B-10');
```

**Note both marks share ONE cell** — the salary letter's signature table has only `الاسم والصفة`
and `التوقيع`, with no `خاتم الشركة` column (removed by his 2026-09-20 ruling), so he put the stamp
in the signature cell beside his signature. That is deliberate, not a mistake to correct.

**Why:** the coordinates cost him hand-work against the page and cannot be recovered from the repo or
from any default, so the recovery copy stays even though the restore is done. **How to apply:** treat
this file as closed history — read the live `mark` rows before believing anything is missing.
Related: [[the-nda-stays-hand-stamped-it-has-no-room-for-a-seal]].
