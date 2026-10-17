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
  the sign; `judgeSignboards` decides. A confident "no signboard" holds on either list. AM reads place
  names only; PM must name the person. An `unjudged` answer (no key, a failed call, an unreadable sign)
  never holds — the key has run out of credits silently twice, and a hold on no answer would have
  held every validation in the field on both days.
- **Every sign in the frame, since 2026-10-09** — see "The four false holds" below. The reader returns
  a LIST of signs, each with its own text, names, box, legibility (`clear` / `partial` / `unreadable`)
  and trade (`medical` / `other` / `unknown`), and the choosing happens in `signboard-rules.ts`: any
  sign that names him is a match; only a sign read `clear` may hold; and a frame where something
  defeated the reader while nothing it did read answers the question (a PERSON for PM, a PLACE for AM)
  is `unjudged`. The nightly pass reads with the strong model, and when the first look finds nobody it
  crops the chosen sign out of the frame and reads **that** — which decides, in either direction.
- **Across the two scripts** (`nameMatchesAcrossScripts`). An Arabic list row and an English board
  scored 0 against each other, so a hospital that signs itself in English was held for its SCRIPT.
  The compiler is the house one, `compileArabicWord` in `src/lib/geo/arabic-place-match.ts`. 🔴 A
  cross-script reading may find a MATCH and may never file a FLAG on a name it cannot pin — a word
  with a second ال inside it (عبدالعال, عبدالرحمن, نورالدين) compiles to a pattern demanding the
  inner article's alif as a literal "a" while English writes that syllable "abdel", so such a place
  is `unjudged` with reason `not_comparable` rather than flagged.
- **The stamp crop.** The customer's name is burned into the stored photo by `drawStamp` before the
  file exists, so the band is cropped off first, from `drawStamp`'s own arithmetic on the decoded
  image (`stampBandFraction`: 0.18 portrait, 0.4917 landscape). Reading the uncropped photo would
  report a match on a blank wall every time.
- **The nightly signboard pass** (`server/signboard-sweep.ts`), between the photo and behaviour passes
  of the integrity sweep: **200 places a night since 2026-10-09** (60 before that), oldest first, four
  at once, two minutes at most. It files a FLAG on the integrity board for a confident negative and
  never holds or un-validates. 612 active places had never been read on the first night. **The raise
  came from that night's own clock, not from ambition:** it read its 60 between 03:35:04 and 03:35:45
  Cairo — 42 seconds, about 1.4 places a second with four in flight — and stopped on its LIMIT with
  547 places still waiting and its 120-second budget barely touched. The budget is untouched and is
  now what ends a normal night, so a slow night still costs the same wall clock as before; what the
  raise buys is three nights of backlog instead of nine.
### The four false holds — what the first night actually proved (2026-10-09)

The pass ran once, read 60 places and flagged five. Read off production the next afternoon, **four of
the five flags were wrong, and not one of them was wrong about a letter.** Every verdict, transcription
and note below is the row the single-sign reader wrote:

| Customer | What it transcribed | Its own note | Verdict |
| --- | --- | --- | --- |
| احمد صباح الشعراوي | `عيادات / دكتور أحمد الشرباوي` | the board is not fully clear apart from the name at the top | held — other name |
| اسلام عبدالعال | `Clin ic 4` | the Arabic above the Clinic sign is not clear enough to transcribe | held — no name |
| رضوان محمد | `DOKANAT / BANAT EL BALAD / WOMEN'S & KIDS' STYLE` | — | held — no name |
| محمد فرج | *nothing stored*, person read as `محمد فريد` | other lines are not confidently readable | held — other name |
| مستشفى المنشاوى العام | `TANTA GENERAL HOSPITAL` | — | held — **correct** |

Three failure classes, none of them OCR quality:

1. **The pipeline threw away the reader's own uncertainty.** Three of the four carry a note saying the
   board was illegible, and the verdict was computed from the names alone. A hedged read became a
   confident flag.
2. **One photograph, several signs, one bag of names.** The schema had a single `sign_text`, so the
   reader picked the biggest, clearest board — a clothes shop, a room number — and the practice's own
   plate was never considered. At a PM door the nameplate is routinely the SMALLEST thing in frame.
3. **Script.** مستشفى المنشاوى العام against `TANTA GENERAL HOSPITAL` is a true negative, but the fold
   compares Arabic letters to Latin ones, so any practice signing itself in English could only ever
   mismatch.

And one defect: محمد فرج was flagged with `signText` null — a flag carrying no evidence of itself.

### The night's YIELD was 4 answers out of 60 reads, and that is what the re-read fixes (2026-10-09)

Read off production after the first night and the evening's re-read, over the 652 non-pharmacy places
— every one of which has a photo:

| | |
| --- | --- |
| Places the reader could judge | **652** |
| Of those, it has produced an answer for | **4** |
| Never read yet | **592** |
| Read and ended `unreadable` — and never revisited | **42** |
| Read and the model call itself failed | **14** |

The first night read exactly 60 places: four answers, 42 `unreadable`, 14 `call_failed`. **A 6.7%
yield**, and the two losses had different causes with the same shape — a night's work filed as a
permanent answer on the strength of one reading.

🔴 **`unreadable` was TERMINAL, and the evening proved that was the wrong resting place.** Legibility
is not a property of the photograph: مستشفى المنشاوى العام read its Arabic board at 18:12 and
`TANTA GENE` at 18:34, and اسلام عبدالعال read a blank `unjudged` at 18:35 and a clear
`د/ اسلام حشيش` at 18:48. The same frame, the same reader, minutes apart. So an unread frame is now
read again — **bounded at `SIGNBOARD_MAX_READ_ATTEMPTS` (3) by a counter on the row**, after which the
reason becomes `unreadable_final`, which no backlog query takes. The stopping condition is a value in
the row rather than a filter over a JSON number, because a filter that is wrong reads as an empty
backlog and nothing goes red.

🔴 **A lost call is retried inside the same night.** 14 of 60 — 23% of the pass — ended `call_failed`,
which was already re-read, but only on the NEXT night. A quarter of every night was producing rows
that said nothing and then waiting 24 hours. The budget was never the constraint: those 60 places took
**42 seconds** of a 120-second window.

🔴 **And nothing reaches the integrity board on one reading any more.** The flag is the only output of
this pass a human ever sees and it carries a person's name, so a verdict of `other_name` or `no_name`
is read a second time and filed only if the second reading agrees. On disagreement the place is
recorded `unjudged` / `unconfirmed`, keeping the first reading's text and signs as evidence, and read
again on a later night — nothing is flagged and nothing is thrown away. A `match` and an `unjudged`
cost no extra call at all: nobody is named by either.

**What that costs, measured against the same clock.** One place can now take two full reads, never
three — a lost call is `unjudged` and only a flaggable verdict is confirmed, so the two are mutually
exclusive. A place is finished once started, so the pass's worst case became the budget plus
`2 × 25 s`, and **`SIGNBOARD_SWEEP_BUDGET_MS` came down from 120 s to 100 s** to hold the 150-second
ceiling the photo and behaviour passes share. The measured night used 42 s of that window, so nothing
real was given up. `tests/phoenix-crm-signboard-check.test.ts` multiplies by 2 now; asserting 1 would
have measured a worst case 25 s short and passed.

**And the Place checks page says which of the four it is.** `unjudged` used to be one state and one
sentence; it is now four, and "the signboard could not be read" is misleading for a verdict two
readings disagreed about, hides that a place has had every attempt it gets, and says nothing about a
place there was never anything to compare. Both boards carry the reason and show it in words — never a
code — with the verdict's own sentence as the fallback, so a reason added later cannot surface as one.

### The five verdicts as they now stand on the place rows (2026-10-09, written and read back)

`--apply` wrote each verdict to `phoenix_crm_places.signboard_check`. Read back from production:

| Customer | Stored verdict | What the row holds | Cairo |
| --- | --- | --- | --- |
| محمد فرج | **match** | `الدكتور محمد فرج …`, 8 signs kept | 18:34 |
| احمد صباح الشعراوي | **match** | `معا للصحة — عيادات دكتور احمد الشعراوي` | 18:35 |
| اسلام عبدالعال | **other_name** | the nameplate `د/ اسلام حشيش`, read `clear` | 18:48 |
| رضوان محمد | unjudged / unreadable | the clothes shop clear, the practice board partial | 18:35 |
| مستشفى المنشاوى العام | unjudged / unreadable | `TANTA GENE` and two boards nothing could read | 18:34 |

🔴 **Two things in that table are not what the dry run predicted, and both matter.**

**One write was LOST, silently, and the pass reported it as written.** `recordPlaceSignboard` catches
and drops its error on purpose — a failed record must never turn a rep's successful validation into an
error at the door — so "written to the place row" was a statement about a function call, not about a
row. اسلام عبدالعال kept its old `no_name / "Clin ic 4"` while the pass printed success for all five.
`jsonb` had refused the payload: Postgres rejects `\u0000` and an unpaired surrogate outright, and a
model transcribing a half-lit signboard produces them. Three things changed: the recorder answers
`boolean`, it sends `jsonbSafe(check)`, and the pass reads the row back and prints `NOT WRITTEN` with a
non-zero exit when the stored verdict is not the one it meant to store. Without the read-back this
section would have reported five writes and four rows.

**And the same photograph does not read the same twice.** مستشفى المنشاوى العام read the Arabic board
at 18:12 and `unjudged` at 18:34; اسلام عبدالعال read `unjudged` at 18:35 and `other_name` at 18:48,
once its nameplate came back `clear` instead of `partial`. Legibility is what moves between runs, and
legibility is exactly what decides whether a sign may hold a place — so a flag one pass calls
SUPERSEDED can be correct on the next. **A single re-read is evidence, never a verdict on a flag**,
which is the second reason the script will not clear one.

### What the same five photographs say when they are read again (2026-10-09, evening)

`scripts/phoenix-crm-reread-signboards.mjs` re-reads every place carrying a signboard flag with the
reader in the working tree. Run against the five, it is the only evidence that matters:

| Customer | Old flag | Read again | What the board actually says |
| --- | --- | --- | --- |
| محمد فرج | other name (`محمد فريد`, no text stored) | **match** | `الدكتور محمد فرج — مدرس واستشاري طب المخ والأعصاب والطب النفسي، كلية الطب جامعة طنطا`. **Eight** signs in that one photograph. |
| احمد صباح الشعراوي | other name (`أحمد الشرباوي`) | **match** | `عيادات دكتور احمد الشعراوي — استشاري الجراحة العامة والأورام`. The surname was two letters lost to scale. |
| اسلام عبدالعال | no name (`Clin ic 4`) | `unjudged` | the nameplate reads `د/ اسلام حشيش`, in part — a different surname, but not read well enough to flag. |
| رضوان محمد | no name (the clothes shop) | `unjudged` | above the shop, in part: `مركز الدكتور رضوان التخصصى لجراحة المسالك البولية`. |
| مستشفى المنشاوى العام | other name | **other name** | `TANTA GENERAL HOSPITAL`, and the same board in Arabic: `مستشفى طنطا العام`. Still held, correctly. |

Two of the four were real customers standing at their own doors. Two cannot be judged from the
photograph and go back to the queue rather than onto the board — which is the owner's own rule (no
answer never holds), and they stay visible with their reason on the Place checks page.

🔴 **The re-read caught a defect the tests could not: the quorum was counted on words that name
nothing.** Reading that photograph returned the Arabic board too — `مستشفى طنطا العام` — and
`signNamesCustomer` called it a MATCH for `مستشفى المنشاوى العام`, because a three-token name may lose
one and the two it kept were `مستشفى` and `العام`, which every general hospital in Egypt shares. The
one correct flag of the night had only ever been correct because the board was in ENGLISH and the fold
could not compare scripts at all. The place axis now counts its quorum on `distinctiveWords`, exactly
as the Google listing comparison always has — only the n-1 half of that rule had been borrowed. Two
smaller defects came out of the same run: the second look was cropping the sign that had already been
read CLEARLY instead of the one that defeated the reader, and it was judging that crop ON ITS OWN, so
a frame correctly left `unjudged` came back as a flag once the crop was the only sign in view.

What the fix does NOT do: it does not loosen either of the owner's rulings. A confident "no signboard
at all" still holds, an AM board that names nobody is still a match, and nothing is ever un-validated.
Each of the five rows above is replayed as a test case in `tests/phoenix-crm-signboard-check.test.ts`
(`checkManySigns`), including the true hold — a change that fixes the four by weakening the check
breaks the fifth.

### One name, two spellings: the compound and the professor's title (2026-10-12)

The CRM integrity audit of 3–11 Oct found seven strong "sign names another person" places on the
board. Replayed through the judge on `main`, one of them was the matcher's own fault:
`ابراهيم عبدالشافى` on the list, filed at 03:37 Cairo on 11 Oct off a plate the night read CLEARLY
as `الأستاذ الدكتور / إبراهيم عبد الشافى`, with two readings agreeing. The fold keeps each script's
spaces where they are, so the list's one word `عبدالشافي` was missing from a plate that wrote it as
two — and a two-word name may miss nothing. The other six were not spelling: a misread surname, two
later reads that already match, and three AM boards for other buildings.

The same space was also making FALSE matches. `عبد` and `ابو` fold to three letters, so each counted
as a word of the name and spent the one-word allowance of a three-word name: `د.هشام ابو الدهب` was
MATCHED on a plate reading `د/ هشام أحمد أبو الوفا`. The owner asked for the fix the same day ("fix the
signboard reader's name matching for titles and spaces"). `personNameWords` in `signboard-rules.ts`
now counts each compound as ONE word on both sides — a head (`عبد`, `ابو`) takes the next word, a
tail (`الدين`, `الله`) joins the word before it — and drops `الأستاذ`, the one honorific on every
professor's plate that `normalizeContactName`'s title list does not carry (0 of 9,215 PM list rows
carry it today; on a list row it would spend the allowance and match any professor with the same
first name).

Joining strictly was tried first and replayed badly: a reader that drops the head has still read the
name. `الله عفيفي` for `عبد الله عفيفي` turned from a match into a FLAG — filed by the other plates
in the same frame — and `النعماني نار` for `النعماني ابو نار` went to `unjudged`. So a compound's core
(`الشافي`, `نار`, `نور`) also answers for it when it stands ALONE on the other side, in either
direction, and never inside another compound: the `الله` of `جاد الله` is not `عبد الله`.

Replayed over all 389 stored readings: **six** move, none onto the board — `ابراهيم عبدالشافى` and
`عبدالعزيز القاضي` (both stored `other_name`) and three stored `unjudged` become matches, and the
`ابو الدهب` match becomes `unjudged` (its plate was read only in part). A stored verdict does not
change until the place is read again; the held `ابراهيم عبدالشافى` row stays on the owner's board for
him to settle. The place axis is untouched — its quorum is `distinctiveWords`, no AM reading moved,
and joining there would take the allowance off `مستشفى ابو كبير المركزي`. Pinned by
`checkNameSpelling` in `tests/phoenix-crm-signboard-check.test.ts`, each half broken and seen to fail.

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

## The door reader and the held re-read (2026-10-17)

The owner, looking at the photographs Place checks filed "Not readable": *"how come any unreadable
should be not validated, should be wait until the system check and I manual approve or reject"* — and,
of the places already validated, *"I can read them. So why you cannot?"* Asked in chat, he chose:
new validations **hold, are re-read, and are his only when the system cannot read them**; a reading
service that is down is retried and then held for him (*"try to reread, try to fix, try to fall back
on other way. If you couldn't read them, then hold for manual review"*); the rep reads **"The system
is checking this place"**, the wording a Google hold already shows; and he gets an **Approve** of his
own on Not confirmed, one row or ticked rows.

**Why the door could not read them.** Thirty production photographs a person reads at a glance, all
filed `unreadable` at the door, were replayed through every reader on 2026-10-17:

| Reader | Confirmed | Wrong name confirmed |
| --- | --- | --- |
| The door's reader that day (`gpt-5.4-nano`) | 1 of 30 | 0 |
| `gpt-5.4-mini` at the door | 12 of 30 | 0 |
| The strong model, blind | 14 of 30 | 0 |
| Door + strong blind + guided read confirmed by a blind close look | **16 of 30** | **0** |
| The guided read on its own (told the name) | 19 of 30 | **8** (on 40 near-miss decoys) |
| An enhanced (sharpened, contrast-stretched) image | no gain | — |

The guided read is the one that finds the most, and the one that cannot be trusted alone: handed a
decoy name one letter away from the real one, it wrote the decoy back eight times, two AM hospitals
among them. So its answer counts only when a BLIND close look at the spot it pointed to reads the name
itself — and `signboardReadsCustomerName` asks that the name was READ, never merely that the frame is
a `match`: the AM rule makes a frame whose clear signs name no place at all a match, and a close look
that read only "صيدلية" would otherwise confirm whatever name the guided read was handed.

**What was built.**

- **The door** reads with `gpt-5.4-mini` (`PHOENIX_CRM_SIGNBOARD_DOOR_MODEL`), nano behind it, one look
  inside the rep's 8 s. `signboardDoorHolds` holds everything but a match — an unreadable sign, a lost
  call and a missing key included — except a place another check already holds (`held_elsewhere`, one
  review row) and a name with nothing to compare (`name_unusable`, no reading can answer it). The
  Super Admin is NOT told at the door: the system has not finished.
- **The re-read** (`server/signboard-holds.ts`) runs straight after the rep's reply and then hourly,
  riding the visit roll-up's fire: `rereadHeldPlaceSignboard` reads blind with the strong model (mini
  behind it when a call fails), then guided with a blind spot check, inside a 45 s budget and a 20 s
  cap per call — the fallback the owner asked for when the reading service is down. Four reads in all
  (`SIGNBOARD_HELD_MAX_READS`), counted on the place's own `signboard_check.attempts`; a missing key
  spends none. A confirmed match is **approved by the system** through the same
  `phoenix_crm_decide_validation_review` approve his own button runs, as the actor `SYSTEM`, and the
  board says "The system". Every read spent with nothing confirmed: the last unreadable read is kept as
  `unreadable_final` and he is told then.
- **Never:** the system never rejects; never touches a Google or a timetable hold (only
  `google->>verdict = 'signboard'`); never a building — a venue is held on the same test but stays his
  decision alone; and the night's signboard pass leaves every held place to the re-read.
- **His Approve** (`approveValidatedPlace`, `/api/phoenix-crm/validation-reviews/approve`): the Super
  Admin alone, an active place, a place already decided left as it is; otherwise the place's one review
  row is raised or reused as `confirmed_by_admin` and approved. A district manager's board approves
  nothing. Needs you shows "The system is still reading this sign" while reads are left.

Pinned by `tests/phoenix-crm-held-signboard.test.ts` and `tests/phoenix-crm-signboard-check.test.ts`.

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

**Applied on production, 2026-10-08 at about 14:15 Cairo, on the owner's go-ahead ("Yes, backup
first").** A fresh dry run first matched the plan byte for byte. The pre-image schema
`phoenix_crm_merge_backup_20261008` was loaded and held all 329 customer rows (163 kept, 166 leaving)
and their 34 child rows. Then 163 groups merged, 0 refused. After it: 166 rows `dropped` / `duplicate`
and still present, 166 `customer_merged_out` and 166 `customer_merged_in` events by B-10, live real
customers 10,830 → 10,664, no visit without its customer, and a fresh dry run finds 0 groups. The
first `--apply` stopped before any write because the direct database host did not resolve from the
laptop; the pre-image check now uses the session pooler, as `scripts/apply-sql-file.mjs` does.

The owner also confirmed on 2026-10-08 that an AM photo with no signboard keeps holding, and that the
PM "no name" holds are watched on the integrity board for their first week rather than sampled.
