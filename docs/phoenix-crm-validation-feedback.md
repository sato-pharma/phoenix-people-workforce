# Phoenix CRM — validating a place, and telling the rep why

The account behind the rules in `.claude/rules/phoenix-crm-validation.md`. Written 2026-10-08, the day
of the 643-photo audit and the owner's rulings on it.

## What the audit found

Phoenix CRM place validation went live on 03 October 2026. In five days reps created **643 validated
places**. Every photo was looked at by eye and the module audited end to end.

**The module validated a LOCATION. The owner grades an IDENTIFICATION. Only the first was ever built.**
The accuracy gate (both readings within 250 m) was honest and working. Nothing asked the photo to show
*who* the customer is, and nothing told a rep when he got it wrong.

| Figure | What it measured |
| --- | --- |
| 643 | validated places created in the first five days |
| 233 / 231 / 179 | good (36%) · weak (36%) · fail (28%) — street shots, blank walls, inside a moving car, a paper timetable, dark night shots |
| 561 of 643 | places that got no identity check at all: the Google listing comparison applied to AM only |
| 598 of 643 | places that had never had a review row; the Place checks page read a capped 400 of 612 |
| 27 | refusals recorded before the refusal reason existed — they fall back to the system's own sentence |
| 22 of 24 | refusal notes that were the single character `-` |
| 22 | reopened customers still waiting to be captured again — none re-validated, average wait 40.8 h, oldest 76.7 h |

The reps were honest: no reused photo files, no clock skew over five minutes, every photo submitted
within 18 minutes of its shutter. It was an instruction-and-feedback problem.

## The owner's rulings (2026-10-08)

1. Require the customer's name on the signboard, always — no exception for a building with no nameplate.
2. Tell the rep why, from a fixed pick-list worded about **his photo**, never naming a person.
3. One plan, the automated signboard read included.
4. Merge the proven same-seat duplicates automatically, with a pre-image and a report.
5. The 179 bad places are FLAGGED and he decides each one. Nothing is un-validated and no rep is told.
6. The hold wording says "this place", not "the location".
7. Never a person on an AM sign; a PM sign must name the person.

## What was built

- **The signboard read** (`signboard-rules.ts`, `server/signboard-check.ts`). A save at the door reads
  the sign; `judgeSignboard` decides. A confident "no signboard" holds on either list. AM reads place
  names only; PM must name the person. An `unjudged` answer (no key, a failed call, an unreadable sign)
  never holds — the key has run out of credits silently twice, and a hold on no answer would have
  held every validation in the field on both days.
- **The stamp crop.** The customer's name is burned into the stored photo by `drawStamp` before the
  file exists, so the band is cropped off first, from `drawStamp`'s own arithmetic on the decoded
  image (`stampBandFraction`: 0.18 portrait, 0.4917 landscape). Reading the uncropped photo would
  report a match on a blank wall every time.
- **The nightly signboard pass** (`server/signboard-sweep.ts`), between the photo and behaviour passes
  of the integrity sweep: 60 places a night, oldest first, four at once, two minutes at most. It files
  a FLAG on the integrity board for a confident negative and never holds or un-validates. 612 active
  places had never been read on the first night — about ten nights of backlog.
- **The refusal reason** (`validation-feedback.ts`). Six closed reasons: no signboard in the photo;
  the sign is not this customer; too dark or blurred to read; not taken at the entrance; a photo of
  paper, not a building; the location is not where the photo was taken. The free note stays on the
  record. The rep receives `phoenix_crm.validation_not_confirmed` — in-app and Telegram only,
  push-blocked, never email.
- **One notice per row.** "Validate again" and "Not validated yet" both rendered for five days because
  both branches tested the same condition and both titles were literals. Both now come from
  `google-place-rules.ts` and exclude each other.
- **Validate first.** In the rep's To-validate list, `validateFirstIn` puts the customers waiting to be
  captured again first (oldest reopening first, marked in rose), then the visits-waiting order.
  `rankValidateNext` has no caller.
- **The Place checks page** reads every row, paged, and says when a read hit its ceiling. The
  reopened customers waiting to be captured again have their own section, and a row on Needs You.
- **The brick lookup.** A place row records whether a brick was matched, none was nearby, or the
  lookup could not run — so "no brick" is never confused with "never looked".

## The same-seat duplicate merge

A one-off script and a guarded database function, never a feature.

- `scripts/phoenix-crm-merge-same-seat-duplicates.ts` runs **dry by default** and writes, to
  `F:\PHX backup\phoenix-crm-duplicate-merge-20261008\`: `report.xlsx` (Merged, Refused and Totals
  sheets, names only), `merge-plan.json` and `pre-image.sql`.
- `--apply` needs the plan, the pre-image schema name and the actor, and verifies the pre-image exists
  on production before it touches a row.
- `phoenix_crm_merge_duplicate_customer` re-checks every guard itself under the seat's advisory lock,
  withdraws the loser's pending requests, moves its children to the keeper, archives the loser as
  `dropped` / `duplicate` (never deleted — a deleted reference row is re-minted) and writes a
  `customer_merged_out` / `customer_merged_in` event pair. Only the service role may run it.
- The keeper is chosen by: holds an active place → validated → most visits → oldest → lowest id.

**The dry run on production, 2026-10-08:** 163 groups, 163 merging, 0 refused, 166 rows leaving,
1 place and 0 visits moving, 32 territories. The plan had estimated 172 groups and 175 rows from an
earlier count; the script's set is the board's own `groupSameRepDuplicates`, and the gap was not traced.

Archiving 166 rows in one run is a bulk production change: it is announced to the owner before
`--apply`, and the pre-image is applied first.
