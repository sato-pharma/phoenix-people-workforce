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

**The ال of a family name (2026-10-18).** Re-reading the places the door had left unconfirmed, the
strong reader read three plates CLEARLY in the first 153 that named the customer and were still not
matched, because one side wrote the article and the other did not: `أيمن البدوى` for `ايمن بدوي`,
`عبير محمد راوي` for `عبير الراوي`, `إبراهيم عبد الله العفيفي` for `إبراهيم عفيفي`. A plain word now
answers for the same word with `ال` in front, either way round, on the PERSON axis only, and only
where the word keeps three letters without it. 🔴 It applies to EVERY word of the name, the given name
included, not to the family name alone: of the 1,217 places re-read, one matches on that alone,
`الحسن زهران` against a plate reading `حسن زهران`, and in Arabic those are one name. A one-letter skeleton rule (the dots the reader most
often misplaces) was scored on the same reads and REFUSED: of its three extra matches one was plainly
another doctor — `محمد ابو العنيين` on a plate reading `مجدي أبو العينين`, the first name lost to a
three-word name's allowance — and one, `النجار` against `البحار`, is two real surnames. Those near
misses stay unmatched and go to the Super Admin's Approve on Not confirmed. Pinned by
`checkNameSpelling` part 6, broken twice (the rule off; the three-letter floor lowered) and seen to fail
on its own assertion each time.

**His own name first (2026-10-18).** The same night's re-read wrote every confirmed match, so its
confirmations were judged again from their own stored readings — no model call — against names that
are NOT the customer's: 20 other customers of the same list, and near misses built from his own name
(another given name before his father's and family name; his given name before another surname). Of
341 confirmations, 106 also matched one. The bag of words had three blind spots. A three-word name may
lose one word, and it could lose the GIVEN name: `وائل محمد بلحة` passed on a plate reading `احمد محمد
بلحة`. His given name could stand as another man's father: `محمد الشحري` on `أحمد محمد الشحرى`. And
the sign's whole text could lend his words from two different names: `مجدى عبد العزيز` was written as a
match off a pharmacy notice naming `الدكتور مجدى` and, further down, `الدكتور / محمود عبدالعزيز`.

`readsTheCustomersName` in `signboard-rules.ts` closes all three on the PERSON axis. A person name the
reader split out must open on one of his words — the practice's kind (`مركز`, `عيادة`) and the lone
letter `أ.د` leaves are skipped, nothing else, since `مي` is a given name — and the whole text must
carry his words in his order as one run that opens on his given name, at most two other words between
two of his. The quorum is unchanged. Requiring the given name outright was scored first and refused:
it lost three plates whose given name was simply unreadable (`د / ... عبد النبي الخولي`), where the
reader's split name still opens on his father's name.

Replayed on the same 341: 335 stand, and those also matching a decoy fall from 106 to 71 (what is left
is mostly a plate whose given name is unreadable — the allowance the quorum exists for — and AM place
names). A confirmation the night wrote that no longer matches is put back exactly as it stood before
the night, once this rule is live, for the Super Admin's Approve on Not confirmed. The six of the
341: four plates read in part whose name opens on another given name
(`مجاهد علي ضاهر` for `محمد على ضاهر`, `سينا ناجح زاخر` for `مينا ناجح زاخر`, `مرسى زاهر متري` for
`برسيس زاهر متري`, `رجاب يحيى عبد الكريم` for `رباب يحيي عبد الكريم` — misread letters or a
brother, which a look settles), the notice, and a hospital filed on the PM list. A slower "careful"
read (high reasoning effort, every unclear sign enlarged and read again) was tried on 11 unresolved
places the same night and confirmed none, at about three minutes each: the photographs are the limit,
not how hard the reader looks. Pinned by `checkNameSpelling` part 7, broken four ways (the rule off,
the text run off, the three-letter floor put back on his words, no lead word skipped) and seen to fail
each time.

**A short given name must open (code review, 19 Oct 2026).** The quorum asks only for words of three
letters or more, and the opening word could be any of his. So a two-letter given name was asked for
nowhere: `مي احمد` matched a plate reading `د/ احمد سامي` on her father's name alone, and `مي احمد علي`
matched `احمد علي حسن`. A given name under three letters must now BE the opening word of the name the
reader split out; a longer given name the damage took still matches as before. Replayed on all 1,493
stored PM confirmations in production (no model call, nothing written): none changes, the same as
origin/main's rules. Pinned by `checkNameSpelling` part 7, broken (the any-of-his-words opening put
back) and seen to fail.

- **The refusal reason** (`validation-feedback.ts`). Six closed reasons: no signboard in the photo;
  the sign is not this customer; too dark or blurred to read; not taken at the entrance; a photo of
  paper, not a building; the location is not where the photo was taken. The free note stayed on the
  record until 2026-11-01 (see "The comment written with a decision"). The rep receives `phoenix_crm.validation_not_confirmed` — in-app and Telegram only,
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
  (`SIGNBOARD_HELD_MAX_READS`), counted on the place's own `signboard_check.attempts`; a read the
  reader never answered spends none (below). A confirmed match is **approved by the system** through the same
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

### A reader that never answered read nothing (2026-10-18)

Re-reading the 1,217 places production had filed unreadable, the AI account ran out of credit at
about place 900 (01:00 Cairo, 18 Oct 2026): the remaining 241 calls came back HTTP 429 "no credits",
and the CV reader failed the same way at 01:00 and 01:06. As built, the held re-read counted only a
missing key as no read; a `call_failed` counted. So an outage would spend every held place's four
reads within hours and page the Super Admin once for each place, about a photograph nobody looked at.

- `heldSignboardReadHappened` (`signboard-rules.ts`): a check `unjudged` for `call_failed` or
  `no_api_key` is no read. `settleHeldSignboard` returns `unread`, and writes nothing and spends
  nothing; the place waits for the next run.
- `heldSignboardReaderIsDown`: three unread places with none answered stop the hourly run
  (`skipped: "reader_unavailable"`, `moreWaiting`), so a reader that is down is not asked twelve times
  an hour. One answered read means the reader is up, and the run carries on past a single bad call.
- A photo that cannot be cropped is `no_bytes`, not `call_failed`: it never gets better, so it is a
  read that answered and it spends one, or that place would wait for ever.
- A photo the storage bucket does not hand back (code review, 19 Oct 2026) was filed `no_bytes` too,
  so one storage blip spent the place's only re-read and handed it to the Super Admin unseen. It is
  `call_failed` now: nothing spent.
- `HELD_SIGNBOARD_MAX_LOST_READS` (3) bounds the other side. A photo the bucket never hands back, or a
  board too dense for the reader's room, came back unread every hour for ever: first in the
  oldest-first queue, paid for every hour, and nobody told. The hourly run now counts `lostReads` on a
  place it could not read while it read others, and on the third such run in a row records every read
  spent and tells the Super Admin, as a spent read does. A run that read nobody counts nothing, so an
  outage still spends nothing, and the first read that answers replaces the check and its count.

Every door capture is still held while the reader is down. That is the ruling ("If you couldn't read
them, then hold for manual review"); the holds wait and are read when credit returns.

### Claude reads the signboard (2026-10-18)

The owner, on Place checks, of a rep whose places read 21 places, 19 "Not readable": *"The photos are
clearly readable. Why can't you read them?"* He was right. Opened one by one, most of the 21 carry a
doctor's plate a person reads at a glance; every one had been read once, at the door, by OpenAI's
cheap model (nano until 17 Oct, then mini), and never again — the night's backlog was 690 places deep
and its 18 Oct run lost every call to the out-of-credit account.

The photographs were replayed through `signboard-check.ts`'s own code and prompt, nothing written to
the database, each reading judged against the real name, a random other customer's name and a
one-letter near miss:

| Reader | His 21 (stored: 1 match) | 45 other places stored "unreadable" | 15 stored matches | p95 | Random name matched |
| --- | --- | --- | --- | --- | --- |
| Claude Haiku, door | 12 | 2 | 12 | 7.1 s | 0 of 81 |
| Claude Sonnet, door | **14** | 2 | **13** | 6.6 s | 0 of 81 |
| Claude Sonnet, night (with its second look) | 14 | 2 | 13 | 10.1 s | 0 of 81 |
| Claude Opus, night | 14 | — | — | 15.4 s | 0 of 21 |
| Claude Sonnet, held re-read (blind, then guided + checked) | 14 | — | — | 16.9 s | 0 of 21 |

OpenAI could not be replayed: the account answered every call "no credits remaining".

- **His photos were readable; the other 45 mostly are not.** Door and held re-read together confirm 15
  of his 21. Of the 6 left, one is another doctor's plate (ريمون رفعت عبدالنور for جوزيف رفعت
  عبدالنور), four show no plate a person can read either (a shopfront, a street, a faded board, a
  steep angle), and one is a calligraphy board read "أشرف صبحي فارس" for أشرف سميح فارس. The 45 other
  places opened by eye are hospital fronts, a blank door plate and blurred night shots: there the
  system is right to leave the decision to the owner.
- **The near-miss matches (3 of 81) are the judge's one-word allowance, not the reader.** A
  three-word name may lose one word, so "عتمان هشام عثمان" matches a plate reading "عثمان هشام عثمان"
  on هشام عثمان. Unchanged.
- **Opus reads no more than Sonnet** and is half as slow again; Sonnet is the strong reader.

**What was built.** Every signboard call asks Claude first (`preferProvider: "anthropic"`; a reader is
a `SignboardReader`, a Claude model and the OpenAI model it used before): Sonnet at the door, at night
and on the held re-read, Haiku for a lost call. OpenAI answers only when Claude's account is dead;
`AI_PROVIDER` and `ANTHROPIC_MODEL` still override. The answer's token ceiling rose 1,400 → 2,400
(guided 1,800 → 2,800): Claude spends more tokens on Arabic, and at 1,400, 2 of 81 street photos came
back cut off mid-answer. Pinned by `checkTwoReaders` (`tests/phoenix-crm-signboard-check.test.ts`) and
`planningTests` (`tests/ai-provider-failover.test.ts`).

### Every "Not readable" place: the root cause, and one read each (2026-10-18)

The owner, the same evening: fix ALL the unreadable places, not one rep's — find the root cause, then
one plan for the places already on the system and for new ones — and stop paying to read the same
photos again ("a total wasting of money").

**What production held** (read-only audit, no model calls): 532 active places filed "Not readable"
(462 `unreadable`, 70 `unreadable_final`), 93 whose read was lost when the OpenAI account ran dry, and
151 never read — 776 with no trustworthy reading.

**Why, in order of weight:**

1. **The reader could not read Arabic plates.** 451 of the 532 had exactly one read, at the door, by
   OpenAI's cheapest model; it filed clear plates "unreadable", misread names, and called two practice
   boards another trade. System-wide, 1,092 of 1,509 confirmed places were confirmed only on a later
   re-read by a stronger model. So a stored "Not readable" did not even say whether the photo was bad.
2. **Every place photo was stored at 720 x 1280.** `live-photo-capture.tsx` drew the frame through the
   outstation module's `getCompressedEvidenceCanvasSize` (long side 1280) and asked the camera for
   only 1920 x 1080; a plate three or four metres away came out a few pixels per letter.
3. **Many photos show no plate at all, and the door never refused one.** A hospital front, a night
   shopfront, a blurred street, a blank door; on 45 such places Claude Sonnet confirmed 2. The app told
   the rep to photograph "the clinic sign or door", accepted whatever came, and the problem was found
   after the rep had left. It is a habit of a few reps: 10 carry half the unreadable places.
4. **Not the light:** 25% unreadable in daylight, 19% at dusk, 27% after dark.
5. **The cost:** the night re-read the same unchanged photo for up to three nights at two to four
   calls a night; a held place was re-read up to four times (typically 10, at most 13 answered calls
   for one photo); the reread script's `--apply` reset the attempt count to 1; and nothing recorded
   which reader had already read a photo.

**What was built:**

- **One read per photo.** The strong reader's `unreadable` is final at once (`strongRead` on the
  check, `signboardNextAttempt`); only a fallback reader's answer keeps a try. A held place is read by
  the door and re-read ONCE (`SIGNBOARD_HELD_MAX_READS` 4 → 2). A lost call is still retried without
  a cap — a failed call is not an answered read, and a cap would strand places after an outage.
- **The signboard is a scanner at the door**, as the timetable has been since 17 Oct: a photo with no
  readable name is refused on the spot with what to fix ("Step closer so the name fills the box",
  "This photo shows the building's sign, not the customer's own nameplate"), twice; the third is saved
  and held. Another name and a lost call are never refused. Counted per rep, per customer, per Cairo
  day in `phoenix_crm_refused_readings` (`signboard_unreadable`, `signboard_no_plate`), so the SFE's
  refused-readings board sees them. A refusal that could not be recorded is never thrown — the photo
  is saved and held — or it would be "try 2 of 3" for ever.
- **The reader names the cause** (`problem`: no plate, building sign only, too far, blurred, dark or
  glare, cut off, stylised), and the rep reads the matching sentence.
- **A signboard photo keeps up to 1920 px** on its long side and the camera is asked for 2560 x 1440
  (`place-photo-size.ts`, only for a framed signboard capture). The outstation helper is not touched.
  The stamp crop stays clear of the frame guide at the new size (1080 x 1920 → 0.18, 1920 x 1080 →
  0.4889).
- **One instruction everywhere:** photograph the customer's own nameplate, close enough that the name
  fills the box.
- **The old places, once.** `rereadUnreadablePlacesOnce` (`scripts/phoenix-crm-reread-signboards.mjs
  --unreadable`, a dry run unless `--apply`) reads each with Claude Sonnet, one look, and ends it:
  confirmed (a held one approved by the system), filed with another name for the Super Admin when a
  second reading agrees, or **sent back to its rep** — `signboard_check.retake` carries the reason and
  the check is written `unreadable_final`, so no deployed pass reads that photo again. The rep sees "New
  signboard photo needed" with the reason and retakes it at the place (within 500 m, plus the photo's
  own radius up to 250 m) through the same door scanner; the location never moves and the replaced
  photo is kept in the place's `place_signboard_retaken` event.
- **Only a photo at fault is sent back** (`signboardAsksForAPhoto`). The dry run of 20, opened by eye,
  caught the first version sending back clear plates: "د. محمد زكي" filed for محمد ذكي, a clear board
  for رضوان محمد, and five AM hospitals photographed at their own building's sign (the AM rule: a
  hospital signs itself). A new photo of the same plate reads the same, so a sign the reader calls
  legible that did not confirm — and an AM building's sign — is kept final for the Super Admin (held
  at the door, `keep` in the one-off pass), never sent back and never re-read. Too far, blurred, dark,
  cut off, no plate, or a building's sign at a PM door is the photo's fault and is sent back.
- **A decorative plate is kept too** (`stylised`). The first 157 places of the full run showed it: the
  reader read "دكتور سلامة السيد البيودي" off a clear board for سلامة اللبودي, the same letter wrong on
  both reads, and a new photo of the same plate reads the same. The Super Admin's board says "check it
  yourself" for it, and the scorecard does not count it against the rep.
- **A sideways photo is turned upright and read once more** — a fifth cause the audit had not seen.
  A phone held on its side stores the scene turned while the caption stays upright: 38 of the first 157
  photos, and 30 of the 97 sent back, were on their side by the reader's own note, and it read none of
  those plates ("too far", "cut off", "stylised"). The reader now says how the scene stands (`upright`),
  and off the door the image is turned that way and read again, the other way once if it is still on
  its side. Proven on four of them: هبة المصري went from "too far" to confirmed, and محمد شعيب from an
  unread board to "محمد شعي", truly cut off. The door has no time for a second call, so a sideways photo
  there is refused with "Hold the phone upright" (`sideways`), which the rep can fix on the spot.
- **A board too full for one answer is read in four quarters** — a sixth cause. Two places of one rep
  are the same hospital wall of about forty plates, د. طلعت فواد among them; Claude ran out of room
  before it finished listing them (`max_tokens`) on all four calls, so the place stayed a lost call,
  read and paid for every night and never answered. A whole-photo read that runs out of room is now
  read again as four overlapping quarters side by side (`signboardQuarters`, overlap 0.2, wider than
  one of those plates), within the time the first read left, and each plate's box is put back into the
  whole photo (`mergeSignboardParts`). A quarter that fails fails the read; a timeout is never split.
  Both places then answered in about 26 s.

**What the one read found, on the 842 places of the pre-image** (taken 18 Oct 21:43 Cairo, before the
run; every place read once, the 35 sideways ones once more upright, the two walls once more in
quarters; then the owner's spelling and paper rulings applied to the stored readings, below):

| Now | Places |
| --- | ---: |
| Confirmed | 128 |
| Sent back to the rep, with the reason | 292 |
| Kept for the Super Admin to look at (a legible sign that did not confirm, a decorative plate, an AM building's sign) | 152 |
| Another name, on the Super Admin's board | 77 |
| A plate naming nobody, on the board | 25 |
| Already held by another check, so its sign is never read (`held_elsewhere`, by design) | 71 |
| A shared copy or a retired place, read through its main place | 92 |
| Two readings disagreed (`unconfirmed`, the night settles it) | 4 |
| No usable name | 1 |

Ahmed Mohamed Abd-Elnaim, whose 19 started it: 13 confirmed, 1 another name, 2 kept, 3 sent back. Opened
by eye, 5 confirmed and 5 sent back at random: 4 of each were right; one confirm was a prescription sheet
held in the hand (the reader said "no plate", the letterhead named him — 4 such places system-wide), and
one sent back, وحيد محمد شومان, is readable by eye with its first letter clipped at the edge.

**Spelling, measured, then ruled by the owner (18 Oct, asked one by one).** The comparer refused some
plates the reader read right ("طلعت فواد" for طلعت فؤاد, "أحمد ذكي" for احمد دكى). Each candidate rule
was first judged on the stored readings — no model call — with the 18 Oct decoy measure (each confirmed
place against 20 other customers' names, about 32,000 tries):

| Candidate | More confirms | Stranger matches | His ruling |
| --- | ---: | ---: | --- |
| Today's rules | — | 52 | — |
| ؤ read as و, ئ as ي | +2 | 53 | **one name** (فؤاد = فواد, ناشئ = ناشي) |
| ذ, ز and د one letter; ح and خ one | +6 | 53 (no new one) | **one letter, all of them** |
| Long vowels dropped | +35 | 220, and 96 confirms lost (محمود = محمد) | refused, never asked |
| The three-word allowance tightened | — | — | **kept as it is** (137 of 219 had the same name spelt another way in the missing slot) |
| A name on paper on a PM capture (a prescription, a printed schedule) | — | — | **sent back for a nameplate** |

The letters are written one way word against word, Arabic on both sides (`spelledOneWay` inside
`nameWordIsThere`), never in `normalizeContactName`, so the SQL fold and the cross-script compiler are
untouched. The paper rule is step 2 of `judgeSignboards`: on PM, the reader's `no_plate` turns a match
into `unjudged`, which the door refuses and the backlog sends back; AM keeps "a hospital signs itself".

**The rulings reached the places already read without one model call** —
`rejudgeStoredSignboardsOnce` (`scripts/phoenix-crm-reread-signboards.mjs --rejudge`, dry unless
`--apply`) judges every stored reading again and writes only two changes (`signboardRejudge`): a stored
plate that now names the customer confirms, and a PM confirm whose photo holds no nameplate is sent
back. Run 18 Oct on production after saving the 12 rows (`rejudge-12-before.json` in the pre-image
folder): 2,346 stored readings judged, **8 confirmed** (6 had been filed as another doctor, 2 kept), **4
sent back** — exactly the 4 paper photos opened by eye — read back from the database, and a second run
changes nothing. Its 6 open board cases (`sign_other_name`) are listed and NOT settled; closing them is
the Super Admin's click.

Pinned by `checkDoorScanner`, `checkOneReadPerPhoto`, `checkBoardTooFullForOneAnswer`,
`checkOwnersSpellingRulings` and `checkStoredReadingsRejudged` (`tests/phoenix-crm-signboard-check.test.ts`) and `checkTheReReads`
(`tests/phoenix-crm-held-signboard.test.ts`).

## The one-by-one review (2026-10-18)

The owner, on Place checks: *"for the admin to facilitate on him taking the decision. Look at the
screening page in recruitment module. I want to have the picture in a very wide space in the screen
and a column on the right having all the data I need … validate from this screen or reject or approve.
Then press next … like sliding instead of opening."* Asked in chat, he chose: the Place checks tabs AND
the integrity cases, **as tabs** (*"I can make view all in a tab or … waiting only"*); a **button** that
opens it **full screen**; after a decision it **slides to the next** by itself; *"I also can choose to
view polyclinics only, or places only, or both"*; and a polyclinic **in two on one screen** — the
building's own validation approved or rejected alone, and the timetable approved or rejected **per
customer**. *"Very, very premium, polished."*

**What he sees.** A light bar at the top of his board (never a dark band — the September ruling on page
banners) holds **Review one by one** and how many wait. It opens on the board tab he stands on, filters
as they are. The review is a dark full-screen dialog: tabs with counts (Waiting for you · Not
confirmed · Integrity cases · History · All), the Places · Polyclinics · Both switch, "12 of 87", an
orange progress bar. The photo fills the left, whole and rotatable, and opens the zoom; the column on
the right is the row read whole — the system's advice, where the rep stood, the sign reading, the
comments — and the footer holds the decision and Back / Next. On a phone the photo is on top at 55% of
the screen. Location integrity links to it on the Integrity cases tab, for the Super Admin only.

**How it is built, and the rules it keeps.**

- **No second decision path.** Every button on a slide is the board's own control, exported from the
  list it lives in and posting to the route it always posted to. `usePlaceCheckDone()`
  (`place-check-done.tsx`) replaced the controls' `router.refresh()`: on the board it is exactly that
  refresh; inside the review a provider also hears which item was answered and how.
- **The tabs are taken when it opens** (`slides.ts`). A slide holds only its key and its row is looked
  up in the board's current data, so an approved place stays where it was and shows approved, and
  "12 of 87" never shifts under his finger.
- **It slides on only when nothing on the slide still waits** (`slideIsSettled`): a polyclinic needs
  its building decided and every waiting customer answered. Going Back never slides on by itself.
- **No key decides.** ← and → move, never while he types, holds a modifier or has the zoom open
  (`deckArrowStep`). These are live places.
- **The Super Admin's alone.** The board takes it as a render prop, drawn only in `mode="company"`, and
  imports nothing from it but types, so a district manager's portal bundle carries none of it.
- **The cases are read when a tab needs them**, through `GET /api/admin/phoenix-crm/integrity/cases`,
  which calls `loadIntegrityBoard` and never the table, so every narrowing of the board applies. The
  tab keeps the cases as first read; a settled case is read again to show it answered.
- **Left out on purpose:** "Same place, several reps" (it compares pairs of places, not one photo) and
  the customers waiting to be captured again (no photo, nothing to decide).

Pinned by `tests/place-review-deck.test.ts`.

### Not readable, New photo asked, and the AM short forms (2026-10-19)

**The tabs.** On 19 Oct he asked to "put the unreadable in a separate tab" and chose "every unreadable
one" and "move them out". Not readable takes three things out of Waiting for you and Not confirmed:
held places, places in use, and polyclinics whose sign or timetable the reader could not read.

- The sign rule is one function, `signCouldNotBeRead`. The scorecard's Not readable column uses it too.
- The tab opened at 349. Looking at it on production, he asked to "try to read and fix".

**What the photos showed.** I read them at full zoom in the app's own viewer.

- The ones sent back to their reps (289 of the 320 single places counted) are genuinely dark, blurred, cut off or too far. A person cannot read more on them than the reader did.
- One example: فاخر فريد. Its sign gives "بشاي … طب الأطفال … الولادة", and the given name is lost in glare.
- He chose "only what needs you". Those places now sit in their own tab, **New photo asked** (`placeAwaitsNewPhoto`, `signboard.retake`).
- Their advice now says to wait for the new photo (`adviseOnSign`, `retake`). Before, every one of them said Reject.
- The board's "pick the ones the system recommends rejecting" takes none of them any more.

**The AM short forms.** Of the 31 that waited on him, 30 were AM buildings with the sign read clearly, under a fuller name than the list uses. He chose to "teach the matcher" over approving them one by one.

- `placeWordsOnSign` (`signboard-rules.ts`) writes صدرية as صدر and الكهرباء as كهربا, on both sides, after the stem.
- It drops تعاقد, the list's word for a contract account.
- A contract row keeps no one-word allowance. Without that, "تعاقد الكهرباء كفر الشيخ" matched the Kafr El Sheikh fever hospital's board on the two town words.
- The Google listing comparison is untouched.

**The replay.** All 304 stored AM readings were replayed offline, with no new reads.

- The new rule confirms 7 places, and each is correct by eye: صدر منوف (twice, one building listed twice), الصدر in Beni Suef, صدر المحلة, كهربا بشتيل, تعاقد الكهرباء, تعاقد الغزل.
- No new match falls inside a territory. The new decoy pairs are list names that are generic on their own ("مستشفى الصدر", "تعاقد الكهرباء"), the same building listed twice, or pairs from different territories.
- The other 24 are misreads (اريزا for تريزا, مدرف for منوف), another place's sign, or nothing legible. No safe rule reads them, so they stay his to decide.

Pinned by `checkPlaceShortForms` in `tests/phoenix-crm-signboard-check.test.ts`, by the retake case in `tests/phoenix-crm-place-check-advice.test.ts`, and by `tests/place-review-deck.test.ts`.

### The 31 left in Not readable: the photo's brick, two more spellings, and timetables on a screen (2026-10-19)

On 19 Oct he asked to "read the 31 left in Not readable and fix". Every photo was read by eye, at full zoom.

**Single places (25).** Most show the right building, but the list names it differently from the board.

- **The photo's brick answers for the town** (he chose "Yes, brick counts"). "كهربا المرج" is North Cairo Electricity's board, photographed in the brick المرج. The company is on the sign, and the town is where the photo was taken.
- `signNamesCustomer` takes `photoBrick` (the place row's `brick_name`) on the place axis only. A word the brick supplies spends the whole one-word allowance.
- Something on the sign must still say WHICH place. A sign that matches only on brick words never counts, and the brick never stands in for the company: "تعاقد الكهرباء كفر الشيخ" against the Kafr El Sheikh fever hospital stays refused.
- Every reader path passes the brick: the door, the held re-read, the nightly sweep and `--rejudge`. The guided read (`spotCheck`) does not.
- **The first replay was too loose, so nothing was applied from it.** The dry run after PR 6116 confirmed 12, and four were wrong: مستشفي صحة بشتيل on a health-campaign poster from Asyum (صحة plus the brick), both جامعة اكتوبر rows on any board saying جامعة in a city with several universities, and مستشفى النصر حلوان on "عيادة النصر الشاملة".
- The fix: beside the brick, the sign's own word is never صحة or جامعة (`NEVER_WHICH_BESIDE_A_BRICK`), and a reading that calls itself a clinic and never a hospital does not match a listed hospital (`kindsClash`, asked of the WHOLE reading, because the place name the reader split out had already lost عيادة).
- The replay then confirmed 8, each checked by eye: المقاولين العرب, بنها التعليمي, الصحه النفسه, صدر أشمون (a tuberculosis notice signed by the chest hospital's director), حميات منوف, الماليه كفر الزيات, كهربا المرج and تبارك المريوطيه.
- Two more list spellings join `PLACE_SHORT_FORMS`: المقاولين is المقاولون, and النفسه is النفسية.
- The rest are misreads (الإنتاج الحربي read as الإنجاب العربي, منوف as مدرف), another sign in the frame (a lab, a pharmacy), or a photo nobody can read. Those stay his clicks.

**Timetables (15 polyclinics, 29 seated customers).** None of the stored readings contains the customers' names, so no matcher change confirms them.

- Three were photographed off a screen: a laptop showing the clinic's Facebook post, a phone showing a WhatsApp image, and a phone showing a photo of the sheet.
- **He chose "Refuse at the door"** (replaced 2026-10-28, see "Timetables that exist only online" below). The reader now names `on_a_screen` as its own problem. `judgeSchedule` checks it before the name and answers `no_schedule`, so the door asks for the wall and counts the try.
- The rep reads: "This photo shows the timetable on a phone or computer screen. Photograph the timetable on the building's own wall." The third try holds like any missing timetable.
- A display fixed on the clinic's own wall is the clinic's board, never this.
- Photos already read are not read again (one read per photo). Their advice to him says Reject only when the stored reading says `on_a_screen`.

Pinned by `checkPlaceShortForms` in `tests/phoenix-crm-signboard-check.test.ts`, the screen case in `tests/phoenix-crm-timetable-scanner.test.ts`, and the screen advice in `tests/phoenix-crm-place-check-advice.test.ts`.

### The by-eye advice in the review (2026-10-19)

On the morning of 19 October, 63 hidden by-eye notes were written on the places and seated customers
still open in Place checks. Each was written as the System Administrator, hidden from the rep, and starts
"By eye:". Asked for suggestions, the owner chose **"Show my advice by the buttons"**: each slide shows
the note's verdict as a coloured tag beside Approve and Reject, and each tab puts the "approve" ones first
so he can go through them fast.

- **A column, not a reading of the sentence.** `phoenix_crm_place_notes.advice` holds approve, your_call,
  new_photo or reject. The CHECK allows it on a `system_admin` note only, so a district manager's comment
  never carries one; his word stays in `phoenix_crm_place_recommendations`.
- **The 63 were backfilled from their own closing sentence** by the migration
  (`20261019150453_phoenix_crm_place_note_advice.sql`): "Recommend approve." → approve, "Recommend reject"
  → reject, "Approve if" → your_call, anything else → new_photo. Production read back 39 · 21 · 2 · 1 with
  none left unset. A by-eye note written after this sets `advice` in its own insert.
- **The tag** sits directly above the decision it is about: a held place's Approve and Reject, a place in
  use's Approve and Refuse, a polyclinic building's decision, and each seated customer's own.
- **The order** is ranked inside each tab and stable: approve, your call, new photo, reject, then
  everything with no advice in the board's own order. "All" ranks inside each of its tabs, never across
  them. A polyclinic sorts by the best advice among its building and its seated customers. The rank is
  taken from the notes as the review opened, like the list itself, so nothing moves under his finger.
- **It decides nothing.** The buttons are his; the rep's own read of notes never selects the column.
- **It never reaches a manager (fixed 2026-11-01).** Until then every one of these notes went to the
  district manager's browser and was drawn on their Place checks tab, with the administrator's name, and
  the Visit Report's "Place notes" column printed them too. One manager's board carried 11 on 1 November,
  and 22 of one rep's report rows carried them for the Super Admin. `placeNoteReachesManager` now holds them
  back on the server, on both screens: a manager gets their own notes and any note the rep may read, and
  `advice` is not read for their board at all. The deciders' page is unchanged.

Pinned by section 7 of `tests/place-review-deck.test.ts`; each of its eight rules was broken and seen to
fire.

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

## The SFE Manager decides on the company board (2026-10-19)

Owner, 19 October 2026: *"show check place to sfe manager exactly as it in the admin account to be
able validate approve and refuse."* The Place checks page (`/admin/field-crm/validation-reviews`) was
the Super Admin's alone from 3 October (*"only system admin can approve or reject"*). It is now the
Super Admin's and the SFE Manager's, and the SFE Manager takes every decision the Super Admin takes
there: approve and reject a held place, refuse or confirm a validated one, take a rejection back,
approve, reject or restore a polyclinic, and answer the same-place comparison.

**What changed.** `canDecideValidationReviews` (`server/access.ts`) admits the Super Admin on `update`
and the SFE Manager on `approve`, and still refuses a test account and every district manager. The
page, the Place Checks card in the CRM hub, and the seven decision routes are gated on `approve`.

**Why `approve` and not `update`.** The SFE Manager holds `phoenix_crm` read + approve and no `update`.
Handing him `update` would have cleared every gate at once and opened every other `update` route in
the module to him, so the gates moved to the grant both deciders already hold. A district manager, a
regional or national manager and the CEO also hold `approve`, so the route gate alone admits them —
the service's `canDecideValidationReviews` is the boundary, exactly as it already was for the comment
and recommendation routes.

**What did not widen — each is its own ruling and is pinned beside the widening:**

- *Seating a customer in a polyclinic* (2026-10-10, "never the SFE Manager"). `canDecideSharedPlaces`
  used to be the venue's decider as well; it now gates seating only, and approving, rejecting or
  restoring a venue asks `canDecideValidationReviews`.
- *Settling a location-integrity case* (2026-10-09). The deck tells him "Settling a case is the Super
  Admin's alone" and draws no settle control.
- *The notice of a new hold* — email, in-app and Telegram — is still sent to the Super Admin alone.
  The SFE Manager sees the queue on the page and, through the same predicate, on his Needs you board.
- *`readsTeamPlaceChecks`* is the district manager's own team board and stays `{DM, ACTING_DM}`.

**The device's evidence on this screen (owner, 2026-10-19, the same day: "show the mock-location
evidence to the SFE Manager too").** It was the one place his board still differed from the Super
Admin's, held back by the 2 October ruling that the position cases and the phone's mock answer are the
Super Admin's. On the Place checks screen it is now his as well: `loadPlaceCheckIntegrity` selects
`device_mocked` and reads every detector for everybody it admits. There is no tier left inside it,
because its audience is `placeChecksSeatScope`, which throws for anybody who may not open the board:
the Super Admin, the district manager on his own team's board (2026-10-13) and the SFE Manager.
**Nothing else moved.** The integrity board and the Visit report still narrow him to the photo cases
(`readsPositionCases`, `SFE_SOURCES`) and leave `device_mocked` out of his select, and settling stays
the Super Admin's.

**What the rep sees.** Nothing different. The decisions run through the same functions, so the rep is
still told only what is wrong with his photograph, in the system's words. The SFE Manager's comments
are filed as `system_admin`, which is what the rep reads ("From the System Administrator").

Pinned by `tests/phoenix-crm-sfe-place-checks.test.ts`, which evaluates the predicates rather than
spelling-checking them, and by the boundary and refusal suites it sits beside.

### No sentence on his board promises a take-back (14 Nov 2026)

Taking a rejection back became the Super Admin's alone on 10 November 2026 (*"the SFE cannot"*), and
the buttons left the SFE Manager's board that day. Two sentences stayed. The board was opened as the
SFE Manager on 14 November and still read:

- on the Polyclinics tab, *"Show the 100 rejected buildings, which can be brought back"*;
- before the second press of a seated customer's reject, *"You can approve it after all from this row."*

Both were worded by `mode`, and the company board is the Super Admin's **and** the SFE Manager's, so
`mode` cannot tell them apart. They are now `rejectedBuildingsSwitchLabel` and `seatedRejectWarning`
in `src/lib/phoenix-crm/validation-feedback.ts`, and both ask `canRestore`, the screen's
`useCanRestoreValidation()`, which is the page's `canRestoreValidation(viewer)`. The SFE Manager reads
"Show the 100 rejected buildings" and what the rejection costs; the Super Admin's wording is unchanged;
a district manager's board still reads "no longer in use". Owner, 14 November 2026: *"fix the brought
back wording for the SFE Manager"*.

### Timetables that exist only online (2026-10-28)

- Nada Saied could not validate her doctors at Alma, a polyclinic in Shibin el Kom. Alma's only timetable is the picture it posts online, so her photo of it on a screen was refused twice as "no timetable".
- The owner: *"some polyclinics have their timetable only online"*, and he chose **"Save it, hold for me"**.
- A timetable photographed on a phone or computer screen is now saved and held for him on the first try, as `timetable_on_a_screen`. No try is spent, because a retake cannot fix it. The rep reads: "The timetable was photographed on a screen, so it is held for admin approval."
- It still never validates by itself. In Place checks the system says what it saw and recommends nothing ("look"); he checks the customer's name on the screen and decides. Until then the doctor stays out of the KPIs, like every held seating.

## The comment written with a decision (2026-11-01)

Owner: "when sfe or admin reject or approve validation and write the comment this comment appear to the rep and his maanger".

- **What changed.** A comment typed while approving, refusing or taking back a place or a polyclinic used to be the record's alone. It now also becomes a visible place comment, written by `tellDecisionComment` through `savePlaceNote`. An empty comment writes nothing.
- **What the rep reads.** "From the System Administrator" and the words, with no name and no notice. An SFE Manager's comment reads the same, because both are the `system_admin` source.
- **What the manager reads.** The comment on the row of their own Place checks tab, with the role alone: `loadPlaceNoteIndex(subjects, { managerBoard: true })` keeps the name on the server.
- **A building has no customer of its own.** Its comment sits on the card of every customer of that territory ever seated there. For a building with nobody seated (62 of the 96 rejected by 2026-11-01) it shows inside To validate for 30 days, under the chooser.
- **The older comments were copied once (owner, 2026-11-01).** 159 review decisions and 34 building decisions carried an older note written under "never shown to the rep". Asked who should see them, the owner chose the rep and the manager: "i want the rep to be able to the the decider comment and the manager of the rep can also see it". 51 became visible comments, each keeping its words, decider and date (`20261101130000_phoenix_crm_older_decision_comments_reach_rep.sql`, which holds the rollback). 142 stayed in `decision_note`: 86 the system wrote about reading the signboard, 30 clean-up lines about duplicate buildings (the owner chose to leave them out when shown them), 11 that are only "-", and 15 that name another employee.
- **Failure.** The decision is already committed when the comment is written, so a failed write is logged (`phoenix_crm_decision_comment_failed`) and the words stay in `decision_note`.
- **Printed once.** The deciders' page hides `decision_note` when the same words are already a visible comment on that row (`decisionNoteIsAComment`).
- **The private column stays off a manager's browser (fixed 2026-11-01).** The board never drew `decision_note` or the decider's name for a manager, but the loaders still sent both, and a field a browser receives counts as shown. Every Place checks loader now nulls `decidedByName`, `refusedByName`, `decisionNote` and `timetableExempt.byName` for a viewer who is not `canDecideValidationReviews`. One line was drawn on their screen: a closed integrity case read "Settled by" and a name, and it now reads "Settled" and the time. The deciders' board, its "Decided by" filter and `decisionStamp` are unchanged. The Visit Report is a separate ruling: `docs/phoenix-crm-visit-report.md`.
