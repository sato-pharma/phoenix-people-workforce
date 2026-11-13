# Phoenix CRM — settling a location-integrity case, and the fifth detector that was not in the reader

The account behind two rule lines in `.claude/rules/phoenix-crm-boards.md`. Both shipped on
2026-10-09, and they are the same defect seen from two sides: the board could only be READ, so there
was nowhere for the owner to record that he had looked — and the reader did not know every detector
by name, so a case could be labelled as evidence it is not.

## 1 · The settle click

**His words, 2026-10-09:** "build the settle click on the integrity board", after he had already
settled who the board belongs to — "keep the signboard cases to the Super Admin".

### Why four columns and not a status

The board's own header carried the reason it had no settle button for a fortnight: *the table has no
resolution column, so the only way to clear a flag today is to delete the row — and deleting evidence
because a second reading disagreed is how the record of what the detector actually did disappears.*

A `status` enum would have been that same mistake one step along. It says a case is **closed** without
saying **what** was closed, so a detector that files a NEW flag on the same subject tomorrow lands on
a row already marked done, and nobody ever looks at it. The flags are the case; a settlement that does
not name them is a settlement of nothing in particular.

So migration **20261009190708** adds four columns to `phoenix_crm_location_integrity` and nothing
else:

| Column | What it holds |
| --- | --- |
| `settled_at` | when, in UTC. Null = never settled, or reopened since |
| `settled_by` | the HR id of whoever settled it. The board prints his **name** |
| `settled_note` | why. Required, kept for ever, never shown to the rep |
| `settled_flags` | **the flags it was settled ON** — the whole design |

A database CHECK makes it all four or none. A half-written settlement — a note with no author, an
author with no flags — would be a case the board could neither show as settled nor show as standing,
and a reader would have to guess which.

### `settled_flags` is the reopening mechanism

A case counts as settled **only while `settled_flags` still equals the row's `flags`**. The detectors
upsert on `(subject_kind, subject_id, source)`, so a fresh finding **replaces `flags` in place** — and
the moment it does, the stored settlement no longer describes the row, the case reopens by itself, and
it is back in the counters.

That is why **not one filer changed in this PR**, and none has to: no detector knows settling exists,
and no job has to go back and clear a settlement. Settled means *he has looked*, never *the subject is
cleared*.

The comparison is on SETS, not arrays. A filer that rebuilt the same flags in a different order would
otherwise reopen every case it touched, which would look exactly like a new finding — the one thing
this must not invent.

The rule is pure, in `src/lib/phoenix-crm/integrity-settlement.ts` (`readIntegritySettlement`), so a
test can break it and watch the assertion fire. A test importing `server/integrity-board.ts` would
pull in `getSupabaseAdmin`, the same reason `judgeLaterSignboardReading` lives outside that file. The
server module adds the person's NAME on top of what the pure rule returns and nothing else.

### Who may settle, and what settling does not do

`canSettleIntegrityCases` = `isSuperAdmin && canUpdate && !isTestPersona` — the same shape as every
other decision in the module (`canDecideValidationReviews`), and **narrower than reading the board**.
🔴 The SFE Manager reads this board and does not decide on it: settling is a judgement that a flag
about a named person needs nothing further, which is the one decision on the screen. A test persona is
refused too — a trial account must not be able to close a real case about a real rep.

Three gates, in this order: the page renders no button, the route asks `phoenix_crm.update`, the
service refuses before it reads a row. Only the last one is the gate.

**And it refuses with a 404, never a 403.** "Only the Super Admin settles these" tells whoever asked
that the board exists, that cases can be closed on it, and who closes them. Nothing on this table
explains itself to someone outside its audience — the same rule the board's own read is refused by,
pinned in `tests/phoenix-crm-blind-half.test.ts` §6.

### Neither file sits where a rep's app can see it

The button is in `src/components/crm-integrity/` and **not** in `src/components/phoenix-crm/`, and
its two routes are under `/api/admin/`. Both directories are swept as the rep's own surface: a file
under `src/components/phoenix-crm/` may not so much as say "integrity", and nothing under
`app/api/phoenix-crm/` may reach `integrity-board` at all. That is also why the module's old
`/api/phoenix-crm/integrity` GET was deleted in 2026-09-26 — an address a curious rep can probe is a
disclosure whatever it answers — and the admin namespace keeps that space empty.

- **The note is required to settle and never to reopen.** Closing a case about a named person has to
  be answerable months later; deciding to look at it again must never be discouraged by a form.
- **The stamped flags are read from the ROW, inside the call.** A client-supplied list could claim to
  cover flags the row does not carry — precisely the state that would keep a case closed through a new
  finding.
- **Nobody is notified.** No rep is ever told he was flagged (Golden Rule #1), so none can be told a
  flag about him was closed either. No notice, no email, no field he can see.
- **Nothing is deleted or rewritten.** The row keeps its flags, its signals, its evidence and the
  detector's own verdict.

### Withdrawn is not settled

Two different things, and the page says so:

- **Withdrawn** = the EVIDENCE gave way. A later signboard reading no longer supports the flag. It is
  derived at board time and nobody decided anything.
- **Settled** = a DECISION. He looked, and wrote why.

A case that is both is listed as **withdrawn**, so that section's claim — *each of these was read
again, to a verdict that does not carry the flag* — stays true of every row in it, which it became
only with §4: until then a reading that reached NO verdict landed there too, and the sentence was
untrue of it. A withdrawn case
offers no settle button: the evidence has already given way, so there is no decision left to take.

### It means the same thing on every surface

`loadIntegrityCasesForWindow` — the weekly fraud scan's reader — drops settled cases by the board's
own test. Without that, a case he closed on Thursday would arrive in Saturday's scan as a fresh
finding and he would close it again. The test is `settled_flags = flags`, a column against a column,
which PostgREST cannot ask; asking only for `settled_at is null` would wrongly drop a settled case the
detectors have since flagged again, which is the opposite of the point.

**And the rank, from 2026-10-09.** When this shipped, two other readers of the same table still
ignored a settlement, and the owner was shown both in review. He ruled on the one that turns a flag
into a number a manager reads: *"make settling drop the rep-ranks penalty too"*. Phoenix Ranks' own
reader (`readIntegrityFlags` in `src/lib/rep-ranks/server/compute.ts`) now selects the four
`settled_*` columns and decides through `rankCountedFlags` in `src/lib/rep-ranks/field-quality.ts` —
the same pure `readIntegritySettlement` the board and the scan use, so there is one rule and not
three. A settled case costs the integrity pillar and the admin twin's counts nothing; a fresh finding
on the same subject replaces `flags` in place and the penalty returns on the next nightly pass.
Because ranks are rebuilt nightly for everybody rather than patched, a settlement never
retro-rewrites a window that has already closed. `tests/rep-ranks.test.ts` pins both halves — the
rule, and the fact that the READ asks for the columns the rule needs, which the pure function cannot
prove and the compiler cannot see in a PostgREST select string.

**And the behaviour board's strong-case gate, the same evening.** The second reader raised in that
review was `readStrongCaseReps` in `src/lib/phoenix-crm/server/behaviour.ts`, where a strong location
case is the **company** a save-time pattern needs before the board may print a suspicion about it: one
rep's odd saves alone say nothing, so the gate asks whether anybody else in the same month carries a
strong case. He ruled on it in his own words: *"make settling drop the behaviour board's strong-case
gate too"*. It now selects the four `settled_*` columns alongside `flags` and drops a settled row
through the shared test, so a case he has closed can no longer be the corroboration that unlocks a new
suspicion about the same person — which is precisely what settling decided against.

That takes the readers of this table to **four, each going through one of the two shared functions**:
the board itself needs the settlement to print it (`readIntegritySettlement`), and the weekly fraud
scan, Phoenix Ranks' nightly score and this gate need only the yes/no (`isSettledIntegrityRow`, which
takes the database's own snake_case column names so none of them has to restate the rule).

🔴 **A FIFTH READER THAT WRITES ITS OWN `settled_flags = flags` TEST IS THE DEFECT.** A length check in
place of a set comparison already held one case closed through a genuinely different finding before any
of this shipped, and `tests/phoenix-crm-integrity-settle.test.ts` §5 refuses a reader that compares
`settled_flags` itself — asserted against the source of both server files, with comments stripped by
the shared lexer, because their own prose names the column.

## 2 · `capture_trust` — the signboard defect, unsprung

`signboard` began filing on 2026-10-08 and was never added to the reader's source union, so the row
mapper's `: "gps"` fallback relabelled all five of its cases **Position** — mock-location evidence,
the one kind they are not — and because the detector tally renders only when two or more sources are
present, folding one detector into another **suppressed the callout that would have shown it**.

**`capture_trust` was the same omission in the same migration (20261008023051), and escaped only by
accident.** It files on a place VALIDATION rather than on a nightly pass, so production held **0 of
its rows** when the signboard defect was found on the 9th. The first rep whose photo shutter fix and
capture pin disagreed would have had his case printed as Position. It is in the list on the evidence
that it CAN file, never on a count — a detector that has filed nothing yet is a detector that files
tomorrow.

The fix is **one exported list**, `INTEGRITY_SOURCES`, which the type, the labels, a row's own
coercion and the detector tally are all derived from. There is no second hand-written tuple left to
drift.

🔴 **The compiler cannot catch this.** `source` is a `text` column and each filer writes a string
literal, so nothing in the type system connects a filer to the reader.
`tests/phoenix-crm-integrity-settle.test.ts` makes the connection by hand: it reads every filer's own
`source: "…"` literal out of the source files and asserts each one is in the array, and it compares
the array against the `source` CHECK list in migration 20261008023051 — a value the table allows but
the reader does not know is a case waiting to be mislabelled; one the reader knows and the table
refuses is a filer that will fail at 23514.

Its label is **"Capture trust"**, and the test asserts it does not read as a position verdict. That
confusion is the entire defect.

## 3 · Withdrawn by a later signboard reading — the measurement

The withdrawal half shipped earlier the same day and is the rule the settle click had to be told
apart from (§1, "Withdrawn is not settled"). Its account:

A signboard flag is a reading with a date on it. A LATER reading of the same place that no longer
supports the flag **withdraws** the case — derived at board time from
`phoenix_crm_places.signboard_check`, never written to the integrity row.

**Measured on production on 2026-10-09: four of the five open signboard cases were unsupported** —
two places by then read `match`, two `unjudged`, and the one case that still stood had been filed as
the wrong kind. 🔴 **Two of those four were the defect in §4, not a withdrawal:** an `unjudged`
reading answered nothing, so those two cases should have gone on standing. A place reading `match` leaves the nightly backlog, so nothing would ever have
re-read those four: without this, the board would have gone on showing a flag whose own evidence had
already been replaced.

`judgeLaterSignboardReading` compares the reading against the case's **`created_at`, never
`captured_at`**. The capture predates every nightly read by construction, so judging against it
withdraws every case at once — which would read as the detector being wrong about all of them. A
missing or unparseable date leaves the flag standing: an unreadable reading is not a contradiction.

It is pure, and it lives in `location-integrity.ts` rather than in `server/integrity-board.ts`,
because a test importing the server module would pull in `getSupabaseAdmin` — the same reason
`readIntegritySettlement` is a separate module (§1).

## 4 · An unreadable re-read leaves the case standing (2026-10-12)

**The defect.** `FLAGGABLE_SIGNBOARD_VERDICTS` is `{other_name, no_name}`, so `supportsFlag` is
false for three different things at once: a reading that ANSWERS the flag (`match`), a reading that
answered NOTHING (`unjudged`), and a place never read. `integrity-board.ts` split the board on
`!supportsFlag`, so a night that could not read the sign withdrew the case — the opposite of what
the page says it is showing.

**What it cost, read from production.** Of 106 signboard cases, 5 were withdrawn and **2 of those 5
were this defect**: مستشفى المنشاوى العام — a STRONG case, filed 9 Oct, withdrawn by the 12 Oct 03:36
pass — and رضوان محمد. Two things made it worse than a mislabelled section:

- A withdrawn case renders **no settle button** (§1, "Withdrawn is not settled"), so nobody could
  ever decide those two. The evidence had not given way; the camera had.
- `SIGNBOARD_REREAD_REASONS` keeps re-reading exactly the places that reached no verdict, so such a
  case **flickered** — standing or withdrawn with each night's legibility, with nothing decided.

**The fix.** Withdrawal is now its own list rather than the negation of the flag list:
`WITHDRAWING_SIGNBOARD_VERDICTS = {match}`, surfaced as `withdrawsFlag` on `IntegrityLaterReading`.
The board splits on `withdrawsFlag` and the settle gate on `!withdrawsFlag`. `supportsFlag` keeps
its old meaning — a flag may still not STAND on a reading that reached no verdict — so no existing
assertion was weakened; the two ideas were simply never the same one.

**Why no copy change.** The counter already read *"read again to a verdict that no longer carries
them"*. That sentence was untrue of an `unjudged` reading; the fix makes it true.

Pinned by `tests/crm-integrity-signboard-cases.test.ts`, whose three new assertions each fire on
their own break: the board split put back to `!supportsFlag`, `withdrawsFlag` defined as
`!supportsFlag`, and the settle gate put back to `supportsFlag`.

## 5 · The four readers of this table, audited (2026-10-12)

The second-pass CRM audit of 3–11 Oct listed 23 gaps in the checks. Gap 23 shipped as PR 5764. Of
the 22 that remained, nine were the owner's own decisions (recorded in the plan, not implemented),
and four of the real defects are in the READERS of `phoenix_crm_location_integrity` — all of them
present since the table's own detectors grew past `gps` and `photo`.

### D1 · The board silently dropped cases past 200, and under-reported its own blind spot

`BOARD_LIMIT = 200` with `.order("strong", desc).order("captured_at", desc)` and **no unique
tiebreaker**, so paging that order would skip and repeat at a seam. Nothing pinned it:
`BOARD_LIMIT` appeared in no test, and `tests/phoenix-crm-sweep-paging.test.ts`'s `.limit()` ban
scopes to two other files with a regex (`[0-9_]{4,}`) that cannot match `200`.

Worse than a truncation on the evidence read: `behaviourNotChecked` counts the unmeasured months
**among the rows returned**, so a truncated read made the board's own "not checked" number smaller
than the truth — the one number on the page whose job is to say what it cannot see.

Both reads now use `readEveryPage` with `whenFull: "stop"` (this read presents, it does not judge),
`uniqueBy: row => row.id` and `.order("id")` last for a total order. `capped` reaches the page, and
the "nothing flagged" line is suppressed on a capped read.

🔴 **A `uniqueBy` assertion written with `includes` is not an assertion.** The first version was
satisfied by EITHER paged read, so deleting `uniqueBy` from the capture read left the gate green. It
is a count of 2 now, re-broken and watched to fire.

### D2 · The weekly fraud scan had never seen a place case, and its stated reason was false

`loadIntegrityCasesForWindow` carried `.eq("subject_kind", "visit")` with the comment *"a PLACE case
has no visit day"*. **Both place filers write `visit_date`** (`server/location-integrity.ts:271`,
`:323`), so `signboard` and `capture_trust` — which file ONLY against places — were invisible to
every Thursday scan for their whole lives.

Dropping the filter exposed a second defect the audit did not list: **`sfeVisibleCases` narrowed by
SUBTRACTION** (`source !== "gps"`), which equals the `SFE_SOURCES` allow-list only while `photo` is
the only other detector — and it has not been since 2026-10-08. Nothing had leaked only because the
board's reader was collapsing every non-photo source into `gps`; correcting that collapse so a
signboard case is labelled honestly would have put the Super Admin's own evidence into the SFE
Manager's weekly report. Resolved by keeping ONE read and stamping `sfeVisible` on each row from the
already-pinned allow-list, so `.in("source", SFE_SOURCES)` still appears exactly twice (pinned at
`tests/crm-integrity-signboard-cases.test.ts`) and no second copy of the list exists.

### D3 · Phoenix Ranks counted visit cases only — and the who-moves list

The integrity pillar read `subject_kind = "visit"`, keyed by `subject_id` = visit id, which
`readFieldSaves` joins to. A place case has no visit to join to, so widening that filter would key
on a place id matching no save and drop silently; it needs a second per-seat read
(`readIntegrityPlaceCases`), counted per rep. The numerator is visit cases **plus** place cases; the
denominator stays field saves, because a validation is not a save and adding it to both halves would
let a flagged place IMPROVE a low-volume rep's ratio.

🔴 **The owner's condition, 2026-10-12: "Count place cases, and tell me who moves" — the list from
production reaches him before it ships.** Read read-only the same day, against the standings the
04:17 run wrote (scoring version 4, windows through Thursday 11 Oct):

- **10 strong place cases exist in all**, 7 `signboard` (all 3 Oct, `sign_other_name`) and 3 `gps`
  (`coordinate_replay`, 6/10/12 Oct). None is settled; every accuracy is under 500 m, so the
  coarse-location rule suppresses nothing. The 12 Oct case is outside every window until the next run.
- **The live month ladder (1–11 Oct) moves 7 reps' Integrity and swaps 2 pairs of positions:** Sara
  Mohy Eldeen 100 → 95, Nada Saied 94 → 83 (one visit case and two place cases), Mohamed Ahmed
  100 → 94 (10th → 11th), Esraa fotooh 100 → 92 (14th → 15th), Khaled Saied 100 → 93, Ahmed Farag
  100 → 91, Ebtissam Alaa 100 → 90. Radwa Ahmed and Fatma Gharib rise a place without changing.
- **Quarter and semester** hold the same five ranked reps and one swap; **the week of 10 Oct and the
  day of 11 Oct do not move at all.**
- 🔴 **The penalty is five saves' worth per case, so the DAY window is a cliff, and that is the
  pillar's existing design rather than anything this change introduced.** A single case against a
  12-save day costs 42 points: on the stored day window of 3 Oct, Mohamed Ahmed would lose the top of
  the day to Hassan Mohamed, and Ahmed Farag's 6 saves would score 17. Those older day and week
  windows are only rewritten by a deliberate `rebuildMonth`, never by the nightly anchor run.
- **One rep is wiped by the denominator:** Mahmoud Abdelreheem has 4 field saves in the whole
  semester against one case, so `1 − 5 × 1 ⁄ 4` clamps his Integrity to **0**. He is `too_few_days`
  and therefore unranked in every window he appears in, so nobody sees it today.

### D4 · A seated place's timetable was about to be read as a signboard

`signboardBacklog` applied no `shared_place_id` filter, so seated rows were swept — and a seated
row's `photo_path` **is the building's timetable** (the owner's 2026-10-10 amendment: one timetable
per venue, not a photo per doctor). Reading a timetable in signboard mode is wrong by construction.

Caught with a number: production holds **8 seated places and 0 signboard verdicts on any of them**.
The sweep reads 200 a night oldest-first against a 552-place backlog, so the fix landed roughly
three nights before the first timetable would have been read. The door never had the defect — both
call sites sit inside `else if (place)`.

### Three stale comments, two of them worse than the audit said

`server/signboard-check.ts` claimed a *"120 s … 145 s"* budget: it was lowered to **100 s** on
2026-10-09 and the real worst case is exactly **150 s**, outside it. The accuracy-gate titles in the
test file and in `tests/run-tests.ts` still described the both-readings rule that **#5751 superseded
on 2026-10-11 with pin-alone**. And `integrity-board.ts`'s header claimed to be the table's *"ONLY
reader"* — three modules select from it (this file for the evidence, `server/behaviour.ts` and
`rep-ranks/server/compute.ts` for `rep_hr_id` + `flags`).

## 6 · The silent detectors — the four checks nobody was making (2026-10-12)

Phase 3 of the second-pass audit. Three new `source` values and two new `subject_kind` values, one
nightly pass (`server/silent-detectors.ts`, 21-day window), and **not one refusal added anywhere**.

| Source | What it asks | Measured on production, 12 Oct 2026 |
| --- | --- | --- |
| `roster` | Was the rep in the field at all that day? | **22** visits by **3** reps on full-day away activities; **0** on full-day leave; **0** with an off-duty companion |
| `cadence` | One customer called 3+ times inside a rolling 7 days | **14** customers |
| `coverage` | An active place further from its own brick than any brick is wide (3 km) | **71** places |
| `capture_trust` over `shared_place` | The venue's two independent fixes, compared | **24** active venues, all 24 with both fixes, worst gap **62 m**, none over 150 m |

### Every flag it files is weak, and that is the design

`visit_on_leave`, `visit_on_full_day_activity`, `companion_off_duty`, `customer_revisited_fast` and
`place_brick_far` are **none of them in `PHOENIX_CRM_STRONG_INTEGRITY_FLAGS`**. Two independent gates
sit between this pass and anything a rep can read: `countedIntegrityFlags`
(`rep-ranks/field-quality.ts`) filters to the strong list, and the nightly ranks reader asks the
table for `strong = true` as well. **So Phase 3 needed no who-moves list** — the condition the owner
set on D3 (gap 10) does not arise, because no rep-visible number moves. A rep on a conference day
very often was at a conference *and* at a doctor.

### Full-day only — and that is what made the audit's own counts wrong

The audit reported "1 visit inside approved leave" and 8 companion hits. Restricted to
`day_part = 'full_day'`, **all nine disappear**: every one was a half-day leave, where a visit in the
other half is exactly right. `v2_vacation_requests.day_part` is NOT NULL on production (514
`full_day`, 85 `pm_only`, 56 `am_only`), and `phoenix_crm_day_activities.half_day` is a boolean, so
both halves of the roster read narrow to the full day. 🔴 **The narrowing is in the QUERY, not in the
rows** — `getLeaveDayMap` has a batched branch and an unbatched one, and the CRM sweep uses the
batched one; a filter applied to only one of them reads as working.

🔴 **And the money path is untouched.** `getApprovedLeaveDayMap` — absence counting and pay — still
asks for every day part. `getFullDayApprovedLeaveMap` is the new, narrower caller, and the
`dayParts` argument is optional for exactly that reason.

### Gap 5 as the audit framed it is unbuildable

It asked for the named companion's **own position** on the day. Of the 15 distinct companions named
on production visits, **zero have ever saved a CRM visit themselves** — managers do not use the rep
app, so there is no fix of theirs to compare. What is buildable, and is what shipped, is whether the
companion was **off duty**: the same full-day leave and away-activity read, run over the companion's
HR id. `companion_off_duty` says that and its label says that.

### Gap 8 needed the CHECK widened, and reuses the detector that already exists

`phoenix_crm_shared_places` reached no detector of any kind, while carrying the same two independent
fixes an ordinary place does — the photo's shutter reading and the capture pin. So the **existing**
capture-trust comparison is run over it, through one filer parameterised with `subjectKind`; nothing
new was invented for venues. 🔴 **`CaptureFix` is `latitude` / `longitude` / `capturedAt: string | null`
and every field is OPTIONAL** — a `fixOf` helper spelled `lat` / `lon` / `Date` type-checks perfectly
and builds a fix with no coordinates, so every venue answers "unmeasured" while the pass looks like
it worked. That is why the counter is named `venuesMeasured` and not `venuesFlagged`: the capture-trust
filer is void by this module's own rule, so the pass cannot know how many venues it filed on.

### `INTEGRITY_SUBJECT_KINDS` — a latent defect, not tidying

Before Phase 3 the board coerced `subject_kind` two ways (`row.subject_kind === "place" ? "place" : "visit"`)
and gathered visit ids with `subject_kind !== "place"`. A `customer` row would therefore have had its
customer id looked up in `phoenix_crm_visits`, found nothing, and **printed on the owner's board as a
visit**. One exported list now drives the type, the labels, the coercion and a POSITIVE
`=== "visit"` test for the id gather, and the page prints the label at **both** its sites — the
desktop row and the mobile card. An assertion written as a single `match` is satisfied by either one
of those two, which is how a missing mobile label would pass; both are counted.

### Only this table's CHECK is widened

`phoenix_crm_photo_fingerprints` and `phoenix_crm_refused_readings` carry the same
`('visit','place')` CHECK and are **left exactly as they are**: they never receive the new kinds, and
a CHECK is the only record a column has of what may be in it. Widening one that nothing writes throws
that record away for nothing. The settle test's migration pin had to move from `20261008023051` to
`20261012210000` — a `drop` + `add` pair means only the newest migration describes the constraint, so
repointing the pin is part of widening a CHECK, not an afterthought.

### Two checks the audit asked for and this file refuses

Both measured on production the same day, both recorded in `silent-detectors.ts` beside the refusal,
so a later session does not re-chase them out of the workbook. A comment-stripped assertion in
`tests/phoenix-crm-integrity-settle.test.ts` refuses a half-built one — read from the stripped source
deliberately, so the explanation of the refusal cannot satisfy the check that the refusal holds.

- **A shared phone number across customers.** Keyed on the last nine digits: 15 shared numbers over
  88 customers, worst group 30 doctors on one number — and the groups plainly contain
  مستشفي النفسيه والعصبيه and الوحده الصحيه بزناره, i.e. hospital and polyclinic switchboards, which
  is the correct number for every doctor in the building. Only **one** of the 15 crosses a seat. It
  would file 88 customers of noise to find nothing. The duplicate-**name** pairs the same sweep
  surfaced belong to the duplicate customers board and the name fold, which already have them.
- **A customer with no place to compare a visit against.** **10,397 of 11,560** live customers (90%)
  have no active place, 286 of them visited across 26 reps. That is the ordinary state of a module
  about 10% of the way through its validation drive — a coverage number for the validation board to
  chase. Naming 286 rows as integrity cases would bury the 11 real ones.

## 7 · The two readings were one reading, and the replay detector was rounding (2026-10-12)

The photo-versus-pin comparison shipped on 2026-10-08 to answer one question: was the camera still
where the pin said when the shutter fired? Reading its first full week of production rows found that
on 89% of places it was comparing one reading with itself, and that the one detector it did fire was
firing on a rounding artefact. Both were fixed together on the owner's instruction — *"fix the
shutter fix cache and the replay rounding in one PR"*.

### A · The shutter's "own" reading was the pin again, out of the browser's cache

`readShutterFix` asked `getCurrentPosition` for a position up to `SHUTTER_FIX_TIMEOUT_MS` — **eight
seconds** — old, on the reasoning that a fix from a few seconds ago is still a genuinely independent
reading of where the camera is now. It is not. The Capture-location pin is taken moments earlier with
`maximumAge: 0` (`src/components/phoenix-crm/capture-location.tsx`), the browser keeps that result as
the last known position, and the eight-second grace then handed **the same position straight back** —
identical down to the 13-decimal accuracy figure.

Measured on production, the day the comparison first had enough rows to speak:

| Of the 141 places whose two readings were compared | Count |
| --- | --- |
| Carry `photo_pin_identical` — bit-for-bit the same reading | **127** |
| Of those 127, whose two timestamps are **8 seconds or less** apart | **119** |
| Of those 127, reporting an accuracy better than 100 m | **105** |
| Verdicts across all 141 — agrees / drifted / disagrees | 133 / 7 / 1 |

The 119 is the window itself, and the 105 rules out coarse-fix handsets: it was the option, not the
phones. It is the same defect #4781 removed one layer up — defaulting the photo fix to the pin when
the shutter read nothing — surviving in the browser's cache instead of in our own code.

🔴 **`SHUTTER_FIX_MAX_AGE_MS = 0` and it must stay zero.** A fresh read that times out resolves to
`NO_SHUTTER_FIX`, which the caller treats as "not measured" rather than as corroboration — the
outcome the file's own header asks for. The timeout is how long we WAIT; it is not how stale a
position may be, and the two are not interchangeable.

### B · `sameCoordinate` rounded to six decimals, so 1.3 cm read as a replay

`coordinate_replay` is one of the two STRONG location flags. `sameCoordinate` compared the two
readings at `REPLAY_DECIMALS = 6` — about 11 cm — so two honest readings taken minutes apart by a
phone reporting 13 decimals matched, and the row was filed as a replayed coordinate.

The one `coordinate_replay` case on the board was exactly this. Samir Saad, 11 October:

| | Latitude | Longitude | Accuracy |
| --- | --- | --- | --- |
| First reading | 30.032354829736 | 31.0041317788402 | 49.9 m |
| Second reading | 30.0323547138734 | 31.0041319110873 | 54.9 m |

**About 1.3 cm apart, 22 minutes apart, and with different accuracies** — so neither is a cached copy
of the other; a replay repeats a reading, it does not re-measure it. `sameCoordinate` is now exact
equality (`left.lat === right.lat && left.lon === right.lon`), which is what a replayed coordinate
actually looks like: the same float, twice.

🔴 **`REPLAY_DECIMALS` stays, and it is NOT the detector's threshold.** It is the band the history
query asks the database for (`COORDINATE_BAND`, `server/location-integrity.ts`) so the read can use an
index instead of scanning a rep's whole history. Narrowing the comparison **inside** that band can
only ever drop a case, never add one — the band is the candidate set, the equality is the verdict.
Deleting the constant breaks the query; widening it is what would change who is accused.

### Who moves when this merges: nobody

`coordinate_replay` is strong, and `countedIntegrityFlags` charges a strong flag to the Integrity
score in Phoenix Ranks — so the question had to be asked before this shipped. The answer is measured:
**no rep's score changes on merge.** `judgeCapture` runs only on save (`server/list.ts`,
`server/visits.ts`); no cron and no route re-judges history, so a row already filed stays filed with
the flags it was given.

🔴 **Samir Saad's existing strong row therefore stands, and keeps costing him, until somebody clears
it.** The fix stops the next honest pair being filed this way; it does not retract the one already
there. Clearing that row is the **settle click on the integrity board** (§1), which is the Super
Admin's — it is not done from a migration, a script or a chat instruction, and nothing here touches
it.

### The other eight strong cases, read to primary evidence

They were read the same night, to see whether either defect explained them too. It does not — but
only one of the eight is unambiguous, which is why neither fix was allowed to widen into them:

| Rep | What the primary evidence says |
| --- | --- |
| Yasmeen Samy | Photo and pin **2,768 m apart** — the one case that is not in question |
| Mahmoud Abdelreheem | Both readings at accuracy **exactly 100.0 m**, as are **27 of his 30** place captures over his first three days — a network fix, not a position case |
| Nada Saied | Two rows are one fact: a second doctor's place pinned at the identical 13-decimal point 31 minutes after the first |
| Ebtissam Alaa | معتز الصاوي vs معتز المحلاوي — a real name conflict |
| Two signboard cases | Name only a department (قسم الاستقبال, عيادة الأطفال), so there is no person's name to conflict with |
| Khaled Saied | Tanta General vs El Menshawy — two hospitals |

The board as a whole, read through `loadIntegrityBoard` with a Super Admin viewer rather than
hand-rolled SQL: **157 standing cases, 10 strong, 3 withdrawn, 0 settled, `capped` false.** It is 10
and not 11 because the 12 October re-read withdrew three signboard cases (§3, §4).

## 8 · An unknown accuracy was being judged as a good one (2026-10-12)

The second-pass audit listed "unknown accuracy passes the 250 m gate" as gap 15. The gate itself is
the owner's own decision and was not touched — `entry-rules.ts` says so in as many words, *"an
UNKNOWN accuracy is still taken, as it always was"*, so that a handset which reports no accuracy
figure never costs a rep his visit. Reading the two sides of that decision together found a real
sub-defect underneath it, fixed on his instruction: *"fix the unknown-accuracy hole in the precision
detectors"*.

### The two sides disagreed about what "unknown" means

`isCoarse` required a non-null accuracy:

```
accuracyMeters !== null && Number.isFinite(accuracyMeters) && accuracyMeters >= COARSE_ACCURACY_METERS
```

So a reading with **no accuracy figure at all** returned `false` — not coarse — and the four
precision detectors (`coordinate_replay` and `zero_jitter`, both STRONG, plus `constant_accuracy`
and `typed_coordinate`) judged it in full. The capture gate admitted the reading *because* its
precision cannot be measured, and the detectors then drew precise conclusions from it. The gate was
right and the detectors were wrong about the same reading.

### What it was worth, measured before the change

| On production, 12 October | Count |
| --- | --- |
| Visits carrying no accuracy figure | **18** of 1,598 |
| Places carrying no accuracy figure | **7** of 1,418 |
| Photo fixes present but with no accuracy | 2 |
| Of the 163 integrity rows, those carrying a precision flag | 5 |
| **Of those 5, how many had a null accuracy** | **0** |

All five precision flags standing report a real accuracy — 18.7, 18.7, 100.0, 54.9 and 100.0 m — so
**the hole had not yet accused anybody.** 25 captures were eligible for all four detectors and none
had tripped one. It is closed before it bites rather than after, which is the opposite of how the
coarse case was found: that one was already flagging Yasmeen Samy when he caught it.

### The fix, and the two things it deliberately does not do

`isCoarse` keeps its meaning — measured, and at or past the 500 m line — because `coarse_location`
is a true statement only about such a reading. Beside it:

- `isUnmeasured` — null, or any non-finite value.
- `cannotSupportPrecision` — either of the two. It gates `addPrecisionFlag` **and** filters the
  history, so an unmeasured reading is neither judged nor judged against. Both halves are needed: a
  precise fix must not be flagged for "replaying" a point nobody ever measured.

🔴 **No flag is filed for an unmeasured reading.** `coarse_location` would be a false statement
about it, and a flag of its own would raise a standing board case against all 25 — against every rep
whose handset is simply quiet about accuracy, which is the false-accusation cost this whole file
exists to avoid. The suppression is recorded in `signals.unmeasuredAccuracy` instead, and
`coarseHistoryIgnored` and `unmeasuredHistoryIgnored` are counted apart, because reading one as the
other sends the next session to the wrong rule.

🔴 **`mock_provider` and `impossible_travel` still fire**, per the owner's 2026-10-05 ruling. Neither
is a claim about precision. Travel is in fact *stricter* on an unmeasured reading, not kinder: it
subtracts both readings' error bars from the distance first, and a null contributes no slack, so a
missing accuracy can never buy immunity from a trip nobody could have made.

### The test pinned the hole, so the assertion was edited rather than added to

`tests/phoenix-crm-location-integrity.test.ts` asserted the opposite until this change — *"an older
build that sends no accuracy must keep being judged as before"*, with
`assert.ok(silent.flags.includes("coordinate_replay"))`. That line **was** the hole, written down and
guarded, so it was edited in place rather than contradicted by a second assertion beside it.

🔴 **The replacement pins the two halves as SEPARATE cases, and it must stay that way.** Written
first as one case with a null accuracy on *both* the fix and the prior, it passed with the old gate
restored — each half suppressed the verdict the other half was supposed to be proving, so the break
fired nothing. Half one is an unmeasured fix over an ordinary 20 m prior; half two is an ordinary fix
over an unmeasured prior. Breaking the gate fires the first, breaking the history filter fires the
second, and both were watched to fail before the fix was restored from a copy.

### Who moves when this merges: nobody, again

`judgeCapture` runs only on save, so no filed row is re-judged, and no existing row was filed through
this hole in any case. The change alters what the *next* save concludes.

## 9 · A withdrawn case was still charging the rank, and nobody could clear it (2026-10-13)

Found while reading the owner's own question of 12 October — "open the integrity board on the 03 Oct
`sign_other_name` cases" — against production.

### What the board already does, and what the pillar did not

A signboard flag stands on the reading that filed it, and the nightly pass re-reads the same sign.
When a later reading comes back `match` — the sign names this customer after all — the board moves the
case into its **withdrawn** section, where by design it offers **no settle button**: nobody has
anything left to decide (§ "Only a later reading that reached a verdict may withdraw a case").

`readIntegrityPlaceCases` in `src/lib/rep-ranks/server/compute.ts` read the integrity table alone. It
honoured a **settlement** and knew nothing of a **withdrawal** — so a case the board had already
dropped kept costing its rep five saves' worth of the Integrity pillar, and the one click that could
have cleared it does not exist on a withdrawn case. The charge was unreachable, permanent and
invisible on the screen where it would have been read.

### Measured on production, 13 October 2026, 00:30 Cairo

42 filed signboard flags are live (25 `other_name`, 17 `no_name`). Three of them sit on places a
later reading has since withdrawn — every one of them in the 3 October cluster the owner asked about:

| Rep | Customer | Filed | Re-read `match` |
| --- | --- | --- | --- |
| AI-0020 | محمد فرج | 9 Oct 03:35 | 9 Oct 18:34 |
| AI-0021 | احمد صباح الشعراوي | 9 Oct 03:35 | 9 Oct 18:35 |
| B-129 | ابراهيم عبدالشافى | 11 Oct 03:37 | **12 Oct 13:24** |

The last is the sharpest: the sign reads `إبراهيم عبد الشافى` — **the customer's own name**, written
with a hamza and a space the matcher could not see until the compound-name fix shipped at 12:46 that
day (#5756). The place was re-read 38 minutes later and read `match`. The case stayed.

Re-judging all 42 from their STORED readings against today's rules — no vision call, nothing written —
changes four other verdicts, every one `no_name → unjudged (unreadable)`, which withdraws nothing by
the rule above. So three is the whole population.

### Who moves when this merges: three reps, by name

Measured through `loadRankData` on production, anchor 2026-10-12, read-only:

| Rep | Line | Integrity | Total | Company position |
| --- | --- | --- | --- | --- |
| Nada Saied | CNS | 85 → 90 | 87.7 → 88.12 | 9 → 9 |
| Esraa fotooh | Anti Infective | 93 → **100** | 86 → 86.58 | 14 → 14 |
| Ahmed Farag | Anti Infective | 92 → **100** | 75.5 → 76.17 | 25 → 25 |

Identical in the month, quarter and semester windows; nobody's position changes, and no other rep
moves. **No rep had seen the charge**: `rep_rank_standings` was last written at 04:17 Cairo, before
the pillar counted place cases at all, and the nightly publishes whatever is on `main` at 04:17.

### The fix, and what it deliberately does not do

`readIntegrityPlaceCases` now reads `source`, `created_at` and `subject_id`, then asks the board's own
pure rule — `judgeLaterSignboardReading` — about each signboard case's current place verdict, and
drops the ones it answers `withdrawsFlag`. 🔴 **It reads `withdrawsFlag`, never `!supportsFlag`**: an
unreadable re-read answers nothing and leaves the case standing, charge and settle button both. The
place read fails towards **charging** — a verdict that could not be read keeps its case counted, which
is where the board leaves it too, so the two screens still agree. The coercion of `signboard_check` is
now one exported function (`readStoredSignboardVerdict`), shared with the board, because a second
hand-rolled `typeof` block is how the two would drift apart again.

Nothing is re-filed, re-judged or deleted, and no migration is involved. The board's own sentence for
`sign_other_name` was corrected in the same change: it said "names somebody else", which on an **AM**
capture is simply untrue — the check asks an AM frame for a **place**, and three of the seven cases
standing that night carried no person's name at all. It reads **"The signboard in the photo names a
different person or place"**. 🔴 **It may not say "doctor":** the first wording did, and
`tests/phoenix-crm-am-pm-words.test.ts` — the owner's 2026-09-23 rule that this module says AM and PM,
never doctor or account — turned the required `validate` job RED on that one line. Any later rewording
of a Phoenix CRM label is swept the same way.

## 10 · The board nobody could judge from (2026-10-13)

The owner's own words, that morning: *"first of all me abl to filter by everypossible thing secoond
make me ble to multi slect and settle third put more شرح للcase fouth show me live the difference in
locations sixth if pics avaulable show me 7th make every case a story tellling in clear simple
english"* — and, asked which of the fifth item he wanted, *"all above"*.

### The measurement

Read on production that morning: **165 cases, 13 strong, 0 ever settled**, over 20 reps and 3–12
October. The settle click had shipped on 9 October (§1) and had been used **not once**.

That is not a board nobody needs. It is a board nobody can decide on. It showed five columns and a
per-row button, and judging a single case meant leaving the page:

| What the row said | What judging it actually needed |
| --- | --- |
| "The signboard names somebody else" | Which name is on the sign, and which is on the list |
| "The photo and the pin are 2,768 m apart" | Where either point is |
| 130 of the 165 rows, identical | The 13 that stand on their own, first |
| No photograph, no history, no filter, no export | All four |

### His four answers on shape

Put to him as multiple choice before anything was built:

- **Strong first, the weak folded** into a counted band — nothing hidden; the band says how many and
  opens, and the strength filter reaches them directly.
- **One line per case, expand for the rest** — the headline sentence on the row; the story, the
  photograph, the map, the evidence and the timeline on opening it.
- **A note stays REQUIRED for a bulk settle**, with ready-made reasons he can send as they are or
  edit. Both halves matter: "settled" with no words is a decision nobody can check, and typing the
  same sentence forty times is why nothing had ever been settled at all.
- **Every filter group** — sixteen of them plus a free-text box, instant in the screen and mirrored
  into the address.

### Four pure modules, so the rules are testable away from the screen

| Module | What it owns |
| --- | --- |
| `src/lib/crm-integrity/integrity-board-filters.ts` | The sixteen groups, the distance bands, the dropdown values derived from the rows, and the URL round trip |
| `src/lib/crm-integrity/integrity-case-story.ts` | One headline sentence and a paragraph per detector — the measured fact, then the ordinary innocent explanation. Also the one copy of the detector and subject-kind names |
| `src/lib/crm-integrity/integrity-case-map.ts` | The frame in Web Mercator, the address of its streets (one Google picture through `/api/admin/phoenix-crm/case-map-basemap` since 13 Nov 2026; free OpenStreetMap tiles before), the markers, the leader lines and the metres between every pair of readings |
| `src/lib/crm-integrity/integrity-settle-presets.ts` | The seven ready-made reasons, as starting text |
| `src/lib/crm-integrity/integrity-board-rows.ts` | One case prepared once — its standing, its story, its map and everything the filters read |

The loader (`src/lib/phoenix-crm/server/integrity-board.ts`) widened three chunked reads and added
two, all non-fatal, all failing towards an empty field rather than a blank board. 🔴 **It still
measures no distance at all** — it hands over the *points*, and the metres between them are measured
in `integrity-case-map.ts`. Two derivations of one number drift, and then this board and the
place-vs-actual report disagree about the same visit with no way for a reader to know which is right.

### The one thing that keeps "download what I am looking at" true

The export route rebuilds its rows from the SAME loaded board with `integrityBoardRows`, narrows them
with the SAME `matchesIntegrityFilters`, and reads the filters out of the query string the screen
wrote with `integrityFiltersFromParams`. That is the entire reason `integrity-board-rows.ts` is a
module and not part of the view.

🔴 **A second copy in the route would have drifted the first time a filter learned a new field, and
nothing would have gone red** — each half would still have been self-consistent. The same reasoning
moved `INTEGRITY_SUBJECT_KINDS` and its labels into `integrity-case-story.ts`: the view may not import
a runtime symbol from the server loader (the service-role Supabase client would go into the browser
bundle with it), so the first draft of the view carried its own copy of that map — which is exactly
how a kind added later prints as `shared_place` on one screen and reads properly on the other.

### Two things on the screen that are not obvious

- **The URL mirror is `window.history.replaceState`, never `router.replace`.** The page is one server
  render of about ten chunked reads; a `router.replace` per keystroke re-runs every one of them.
- **The acted-on selection is intersected with what is on screen** (`selectableIds.filter(id =>
  selected.has(id))`), so a tick left behind by a filter change or a fold can never reach the route —
  and only the ids the route reports as settled are un-ticked, so a failure stays selected for a retry.

### The bulk settle: one note, each case's own flags

`settleManyIntegrityCases` stamps one note on every selected case and runs **one `.update()` per
row**, with `flagsNow` read from the row.

🔴 **A single statement over an `.in()` would stamp one case's flags onto the whole batch.** Because
`settled_flags` *is* the reopening mechanism (§1), that is precisely the state that holds a case closed
through a genuinely different finding — the one failure this table was shaped to avoid.

🔴 **It is the last function in the loader, and it is deliberately not called
`settleIntegrityCases`.** `tests/phoenix-crm-integrity-settle.test.ts` slices the file from
`settleIntegrityCase` to `reopenIntegrityCase` by `indexOf` to read the single settle in isolation; a
`settleIntegrityCase*` prefix would move that slice onto the wrong function, and every assertion in it
would then be read against this one.

A failure on one row never stops the others and each comes back named — being told only "it failed"
after ticking forty cases is how nobody settles anything again. Capped at
`INTEGRITY_BULK_SETTLE_CAP` (200). Nothing is deleted and nobody is notified.

### Both new routes refuse with a 404

`/api/admin/phoenix-crm/integrity/settle-many` mirrors the single settle's gate exactly, and
`/api/admin/phoenix-crm/integrity/export` reads `loadIntegrityBoard(viewer)` rather than the table —
so the SFE's detector allow-list, the `device_mocked` tiering and `is_test = false` all apply for
free, and no new paged read lands in a loader whose read shapes are pinned at exactly two occurrences
each.

🔴 **The export's own template, `app/api/admin/activity/export/route.ts`, ends in an
`isForbiddenError` branch answering 403 with the resource named.** Copying it would tell whoever asked
that a location-integrity board exists and that they are not allowed on it. Both routes go through
`phoenixCrmFailure`, which passes the service's own `notFoundError` through untouched. Pinned.

### Five pins moved with the markup, none deleted

Moving the three case lists out of the page re-pointed, never removed, the assertions that were
reading them: the signboard test's render sweep and its `settleCode` slice (which now reads **both**
files for the no-truncation rule, because the story paragraph is the longest string this board has ever
printed), the place-distance render test (plus a new assertion that the view never re-measures a
visit's distance from its place), `card-table-parity`'s `<Position entry={row.entry} />` count of 2,
and the settle test's `CaseList` and `integritySubjectKindLabel` counts.

`tests/neutral-wording.test.ts` caught a real string on the way through: a section heading reading
"Every group he asked for" became "Sixteen groups and a free-text box". The sweep strips comments, so a
comment may say "he"; a screen string may not.

## 11 · The panel he could not read (2026-10-13)

He opened the new board the night it shipped, pasted one capture-trust case back, and wrote:
**"i donot understand anything."** Every number in that panel was right. Five things about the
*words* were wrong, and together they made a two-point case read as gibberish.

**1 — the customer's name printed twice.** A `place` case with no venue name of its own builds its
subject as "the place saved for <customer>", and the opening sentence then appended "for <customer>"
a second time. The first line he read was *"Yasmeen Samy captured the place saved for ليندا اسكندر
for ليندا اسكندر (Internal Medicine) on the PM list."* `openingSentence` now appends that clause
only when the subject phrase does not already carry the name.

**2 — "Filed by: Pin and photograph".** `Filed by` reads as a person, and the value is the detector.
It is **"What raised it"** now. The timeline directly below it is what made the collision visible:
*"Filed by: Pin and photograph"* sitting above *"Added to the list — Yasmeen Samy"*.

**3 — a duration inside a list of distances.** *"Between the pin and the picture: 20 seconds"* sat
between *"From its brick: 3.2 km"* and the readings. It is **"Time between the pin and the
picture"**.

**4 — three coordinates, two of them identical, and nothing saying which one was doubted.** This was
the real damage. A one-tap capture saves **one** reading, and the panel printed it under two names —
*Where the place was captured* and *Where the photograph was taken*, the same six decimals — so a
case about **two** points looked like three points disagreeing with each other. Worse, the reader
was left to work out for himself that the odd one is *the pin saved for the place*, and that it is
accurate only to about 100 m where the other two are accurate to 25 m, which is the whole answer to
"so which one is wrong".

**5 — and the map block said the same thing twice.** Three readings give three pairs, and with two
of them on one point two of those pairs carry the identical number. He was sent *"Where the place
was captured and the pin saved for the place are 2.8 km apart"* and then *"The pin saved for the
place and where the photograph was taken are 2.8 km apart"*, immediately above a line saying two of
the three are one reading. `buildCaseMap` now emits **one line per pair of distinct points** —
keeping the zero-distance pair, because naming both labels is the finding, and 🔴 **leaving the
markers undeduped**, because two markers on one pixel is the evidence and the view already says
which one it is sitting on.

Two pure additions fix it, both in `integrity-case-story.ts`:

- `groupReadings()` collapses readings sharing a coordinate to six decimals, and the evidence line
  for a shared reading says so in words — *"one reading, under both names"*. Only the first label in
  a joined phrase keeps its capital, so it reads *"Where the place was captured and where the
  photograph was taken"*.
- `oddReadingSentence()` adds one sentence to the paragraph when the shape is *several agreeing
  readings and exactly one odd*: which readings are one tap, which one disagrees, and both accuracy
  figures. 🔴 **It returns null for any other shape**, because a replay case carries one coordinate by
  definition and a sentence naming an odd one out there would be inventing a second point.

🔴 **AND IT REFUSES TO SAY WHICH OF THE TWO IS WRONG — the first draft of that sentence did, and his
very first case proved it backwards within the hour.** The draft read "the least precise of them …
so of the two it is the likelier to be the stale one", ranking the photograph (±25 m) above the pin
(±100 m). Pulled from production the same night, this is what that place actually holds:

| Cairo time, 12 Oct 2026 | What | Where | Reported accuracy |
| --- | --- | --- | --- |
| 15:56:50 | photograph taken | 30.439637, 31.171245 | ±25.3 m |
| 15:57:06 | capture saved (same reading) | 30.439637, 31.171245 | ±25.3 m |
| 15:57:39 | place validated — `point_source = "photo"`, so the photograph's reading became the place | — | — |
| *(the pin she carried for it)* | | 30.463103, 31.180882 | ±100 m |
| 15:58:42 | **a visit saved to the same customer** | 30.463512, 31.181219 | ±35.7 m |

The visit sits **56 m from the pin** and therefore **2,822 m from the place the validation had just
fixed**, which is why it carries `location_flag = far`. So the pin and the visit — two separate
readings 96 seconds apart — agree with each other, and the **photograph** is the lone outlier,
despite carrying the tightest figure of the three. 🔴 **A phone reports a cached position exactly as
confidently as a live one: accuracy ranks precision, never truth.** The sentence now gives both
figures and says so outright, and what settles such a case is whether anything else from that day
sits near one of the readings — a question about other rows, not about this one.

His case now reads: *"Where the place was captured and where the photograph was taken are one and
the same reading, saved in a single tap. The one that disagrees is the pin saved for the place. It is
also the least precise of them — accurate to about 100 m against 25 m — so of the two it is the
likelier to be the stale one."*

🔴 **The lesson for every detector added later: the panel is prose, and prose has no type checker.**
All five defects passed `validate` because each one is a correct string in the wrong place. The ten
assertions in `runReadablePanelTests` (`tests/crm-integrity-board-view.test.ts`) are built from the
exact case he pasted, and every one of them fails on the panel he was sent.

## 12 · The photograph is the anchor, and the visits are what is measured against it (2026-10-13)

He read §11's corrected panel and answered in one line:

> since u have the accurate validation the photo with location then drop the suspected one and
> compare visits vs the accurate

Three instructions in one sentence. **The photograph together with its own location is the accurate
validation** — a photograph carries the fix its own shutter took at the door, and that is the one
reading nobody can drag across a map, where a pin can be. **Drop the suspected one** — the pin leaves
the judgement. **Compare visits against the accurate one** — the evidence that settles a place's two
disagreeing readings is what the rep saved there afterwards.

### What the comparison actually returns

Read on production the same morning, every visit carrying a fix measured against its own customer's
photograph (1,284 visits across the active validated places, 3–12 October):

| Visit against the photograph | Visits | Share |
| --- | --- | --- |
| 0–100 m — at the place | 1,143 | 89.02% |
| 100–300 m | 93 | 7.24% |
| 300 m – 1 km | 34 | 2.65% |
| 1–5 km | 12 | 0.93% |
| over 5 km | 2 | 0.16% |

The settings call a visit **far** past 300 m (`visit_far_meters = 300`, read live), so **48 of the
1,284 are far from the photograph and 14 of those are more than a kilometre away.**

🔴 **And anchoring on the photograph changes almost nothing, because the board already does it.**
A validated place keeps ONE point, and `point_source` says which reading it is: that point is the
photograph for **1,312 of the 1,403** active validated places. Re-deriving every visit's distance
against the photograph instead of the kept point moves the verdict for **2 of the 1,284** — one
`far → ok` and one `no_place → ok`, both where the kept point was the pin. Every other row holds, and
48 of the 48 far visits are far either way.

So his instruction did not need a detector change, a restatement or a migration. What it needed was
for the panel to **say** the comparison, which is exactly the question §11's `oddReadingSentence`
has to leave open: *"which of the two is stale is settled by whether anything else from that day sits
near one of them."* That is now answered from rows the case already carries.

### Where the 48 sit, and why the list is a story about one rep

| Rep | Visits measured | Far from the photograph | Over 1 km | Worst |
| --- | --- | --- | --- | --- |
| Nourhan Fawzy Ahmed Ali Moussa | 26 | **13** | **7** | 5,864 m |
| Hana Abdelaziz Samir Abdelaziz | 28 | 5 | 3 | 5,813 m |
| Aya Ibrahim Mohamed Salam | 70 | 5 | 0 | 981 m |
| Samir Saad Samir Habib Rizk | 30 | 4 | 1 | 1,514 m |
| Omaima Wael ElHabashi ElSayed AbdelMaaboud | 21 | 4 | 0 | 738 m |
| Yasmeen Samy Shawky Mahdy | 69 | 3 | 1 | 2,822 m |
| eleven others | — | 1–2 each | 0–1 | 3,236 m |

Half of one rep's own measured visits are more than 300 m from the door, **ten of her thirteen were
saved after 20:00**, and six of them land between 21:58 and 22:10 on 11 October — six customers,
1.4 km to 5.9 km away, every one reported accurate to 2 m. That is the shape of a day written up in
one sitting, and it is a reading, not a verdict: the board exists so the look happens.

Two of the 48 explain themselves and must not be read as anything else: `مستشفي التعليمي` and
`المركز الطبي`, both Yasmeen Samy on 3 October, each reported **2,000 m of accuracy** — a phone with
precise location switched off (§8), which is the one explanation on this board that is not a
judgement call.

### The sentence the panel prints

`visitsAgainstThePhotographSentence` in `src/lib/crm-integrity/integrity-case-story.ts` finds the
photograph among the case's readings, measures every visit of that customer against it, and says:

> The one visit saved for ليندا اسكندر sits about 2.8 km from the photograph and about 56 m from the
> pin saved for the place — so what the rep saved later sits with the pin, not with the photograph.
> A visit is saved where the phone is when the box is filled in, which is not always the door.

That is her case verbatim: she has exactly one visit to that customer, read on production, saved at
15:58:42 Cairo on 12 October — 96 seconds after she validated the place. With several visits the
opening reads *"Of the N visits saved for X, the nearest sits about …"*.

Five rules it keeps, each pinned by a broken-on-purpose assertion in `runReadablePanelTests`:

1. **The photograph is found by its LABEL**, from the one exported `CASE_READING_LABELS` the loader
   now names its readings from. A renamed label would otherwise orphan the sentence silently.
2. **Both figures, and the other reading named** — never a bare "the visits disagree".
3. **Clearly nearer, not merely nearer:** 100 m AND half the distance, so a phone's own margin cannot
   pick the side. A visit 1,275 m from the photograph against 1,493 m from the pin says *"about as
   far from each, so the later visits settle nothing between them"*, which is the honest answer.
4. **Silent where there is nothing to compare** — no visit, no photograph reading, or a replay case
   with one coordinate. A sentence there would read as corroboration that was never measured.
5. **It concludes nothing.** "Sits with the pin" says where the later readings are, never who was
   where; the ordinary cause closes every version of the sentence.

🔴 **Nothing in the detector or in a stored distance moves.** The loader still READS
`distance_meters` and still computes no metres of its own (`tests/crm-integrity-place-distance.test.ts`
refuses a derived distance by reading the file's SOURCE — **comments included**, so even naming the
formula in a comment turns that pin red, which is how this change first went red). The new points are
one more chunked, non-fatal `.in("customer_id", …)` read, and an empty answer reads as *no visit to
compare* rather than *the visits agree*.

## 13 · The 48 visits that sat far from the photograph, and reached the board as nothing (2026-10-13)

§12 made the photograph the anchor and said, inside each case's panel, how far the customer's own
visits sit from it. He read that and asked for the next thing:

> **"yes with same requirments i told u before i want the integrity report to show exactly this with
> story with the pictures and live loc numbers and photos"**

A sentence inside somebody else's case is not a case. Measured on production that morning, before a
line of this was written, with the detector's own rules:

| The 21-day window, every visit carrying a fix | Visits |
| --- | --- |
| Saved with a coordinate | 1,630 |
| Measurable against a photograph captured before them | 1,286 |
| Past the live 300 m line (`visit_far_meters`) | 48 |
| Still past it after the accuracy guard | 46 |
| More than a kilometre out | 14 |
| Filed as a case (one row names no rep) | 45 |

**47 of those 48 reached his board through no case of their own.** The worst is 5,864 m. Sixteen reps
hold them, and they are not spread evenly: Nourhan Fawzy Ahmed Ali Moussa holds 13 of the 48 and 7 of
the 14 over a kilometre, Hana Abdelaziz 5 (3 over a kilometre), Aya Ibrahim 5, Samir Saad 4, Omaima
Wael 4, and eleven others one or two each. **That is a reading and not a verdict** — the board exists
so that the look happens.

### What was built

A **ninth detector**, `visit_photo`, as the fifth pass of the nightly silent sweep. It measures the
rep's own visit fix against the photograph of the place he named, and **the pin takes no part in the
judgement at all** — his instruction. A photograph carries the fix its own shutter took at the door;
a pin can be saved from anywhere.

Four rules decide which photograph, and each one is there because the other answer is wrong:

1. **Captured BEFORE the visit.** A clinic validated in October must not retroactively make a
   September visit far — nor near. Where none qualifies, the EARLIEST is used, which is the other
   half of the 2026-09-29 ruling about a customer visited before he was validated.
2. **The NEAREST eligible one.** A customer with two clinics is at whichever door the rep stood at,
   and judging him against the further one files a finding the data itself refutes.
3. **Keyed on customer AND seat**, as the rest of the module is: a customer is a row per seat here,
   and keying on the customer alone measures one territory's visit against another's door.
4. **The accuracy circles are read as circles.** 🔴 **This is what takes 48 to 46, by measurement
   and never by judgement:** Yasmeen Samy's two 3 October readings reported about 2,000 m of their
   own margin — precise location switched off — so the gap to the photograph was never measured at
   all. Either reading's margin reaching the other one means nothing was measured, and the case is
   not filed rather than filed and settled later.

🔴 **A visit with no rep on the row is a MANAGER'S OWN VISIT, and it is filed under his own name.**
The pass shipped reading `rep_hr_id` alone and skipping those 17 rows, on the reading that a capture
path was losing the rep. **It was not.** `resolveVisitParticipants` (`scope.ts`) returns
`repHrId: null, managerHrId: actor` when a manager enters a single visit on a territory, and its
sibling refusal says so in words — *"This territory has no rep, so the visit can only be entered as
your own single visit."* Every one of the 17 carries `manager_hr_id` equal to `entered_by_hr_id`
(two District Sales Managers, 3–12 October), a real fix accurate to **12–27 m**, and
`capture_source = 'server'` because the save came from a browser rather than the app. Nothing was
lost; the person on the visit was simply read from the wrong column. The correction is §14.

🔴 **Both flags are WEAK, and that is the rule rather than an oversight.** `visit_far_from_photo` and
`visit_very_far_from_photo` are absent from `PHOENIX_CRM_STRONG_INTEGRITY_FLAGS`, which is the one
gate `countedIntegrityFlags` and the nightly rep-ranks score share — both read `strong = true` — so
not one of these 45 cases moves a number any rep can see. A visit is saved where the phone is when
the box is filled in: the car outside, the lift, the next clinic along. The second flag exists only
because *past a kilometre* is a different question to a reader, and it rides on the same case so the
shorter ones can still be seen for what they are.

### What the panel shows

The story, the photograph and the live coordinates, which is what he asked for by name:

> Nourhan Fawzy Ahmed Ali Moussa saved a visit to ليندا اسكندر (Pediatrics) on the PM list.
> The visit was saved 5.9 km from the photograph taken at the place — past the 300 m the settings
> call far. That is 5.9 km — more than a kilometre from the door the picture was taken at.
> The place on the list and the photograph saved for the place are one and the same reading — the
> point kept for the place is the photograph's own reading. The one that disagrees is where the visit
> was saved. […]
> The photograph below is the one the place was validated with — the reading this visit was measured
> against, not a picture from this call.
> Usually: A visit is saved where the phone is when the box is filled in — the car outside, the lift,
> or the next clinic along — which is not always the door.

Five things in that panel were new work rather than a free ride on §12's wiring:

1. **The metres printed are the metres the detector JUDGED**, filed on the row as
   `signals.metresFromPhotograph`. The pass chose which photograph to measure against; a panel
   re-deriving the distance from coordinates would print a different number for a customer with two
   clinics, and the sentence and the evidence table would disagree about the same pair of points.
2. **The anchor is read by `signals.placeId`, not by the visit's own `place_id`** — they are not
   always the same row, for rule 2 above. `anchorPlaceIdOf` resolves it, the loader reads that place,
   and the panel draws its photograph as a reading of its own (only on these cases: a point on the
   map reads as part of the finding, and on a replay or roster case this one had no part in it).
3. 🔴 **"Saved in a single tap" stopped being asserted where it is false.** The pin and the
   photograph coinciding IS a one-tap capture. The point kept for the place coinciding with the
   place's photograph is a different mechanism — `point_source` says the kept point was taken FROM
   the photograph, true of 1,312 of the 1,403 active validated places — and on a visit case those
   are exactly the two labels that agree. The sentence now names the real reason.
4. 🔴 **The photograph is captioned as what it is.** A one-tap visit keeps no picture, so what is
   shown is the one the PLACE was validated with, taken by whoever validated it on whatever day
   that was. The old caption stamped this rep's name and this visit's Cairo time on it.
5. **The place's photograph and the place's kept point are grouped**, so two identical coordinates
   print on one line saying *"one reading, under both names"* rather than as two disagreeing points.

Nothing else moves: no detector's threshold, no stored `distance_meters`, no notification, no rep
told anything, and `SFE_SOURCES` is untouched — a position finding stays the Super Admin's alone.
The only database change is the `source` CHECK widening to admit the ninth value.

**Pinned by** fifteen assertions across `tests/phoenix-crm-location-integrity.test.ts` (the pure
judgement, the accuracy guard, the far-line fallback, neither flag strong),
`tests/phoenix-crm-integrity-settle.test.ts` (the ninth source in the list and in the CHECK, the pass
wired into the sweep, the subject resolved for every row, the live setting, strength from the shared
list) and
`tests/crm-integrity-board-view.test.ts` (the judged metres in the headline and the evidence, the
one-tap clause, the caption, the grouped readings, nothing accused). **Every one of the fifteen was
broken on purpose and watched fire on its own headline**, then restored from a copy.

## 14 · A manager's own visit was checked by nothing, and `rep_hr_id` was never the question (2026-10-13)

§13 shipped at 04:41 Cairo. Within the hour the same board was asked the obvious next question — fix
the path that saves a visit with no rep — and **the path turned out to be correct.** What was wrong
was every detector that reads it.

### What `rep_hr_id IS NULL` actually means

`resolveVisitParticipants` in `src/lib/phoenix-crm/scope.ts` has one branch that writes no rep:

```ts
if (input.kind === "single") return { ok: true, value: { repHrId: null, managerHrId: actor, … } };
```

— reached when `enteredAs === "manager"`. Its sibling refusal, eight lines below, says the rule out
loud: *"This territory has no rep, so the visit can only be entered as your own single visit."* So a
null rep is a **manager's own call**, deliberately recorded against him and nobody else.

Read on production, all 17 rows agree with that and with nothing else:

| | |
| --- | --- |
| Rows with no rep, ever | **17** (3 Oct – 13 Oct 2026) |
| `manager_hr_id` = `entered_by_hr_id` | **17 of 17** |
| Who they are | **Mahmoud ElHassanin Imam Muslim ElHassanin** (12) and **Mahmoud Mohamed Said Mohamed Badawy** (5) — both District Sales Managers |
| `kind` | `single`, all 17 |
| Carrying a real fix | **17 of 17**, accurate to 11.9–26.9 m |
| `capture_source` | `server` on all 17 — a browser save, not the app |
| `is_test` | false on all 17 |

Nothing is losing a rep. A District Sales Manager opened the web form on his phone, entered his own
single visit, and the row records exactly that.

### The defect that is real

Every visit-keyed pass in the nightly sweep took the rep column as the subject and `continue`d when
it was empty — the roster walk, the cadence tally built on the same walk, and §13's photograph pass.
**So a District Sales Manager's own calls were checked by nothing at all.** One of the 17 sits
**3,236 m** from the photograph of the place it names: measurable, past the 300 m line, past both
accuracy margins, over a kilometre — and invisible to the board on every one of its nine sources.

The fix is one answer in the pure module, `personOnTheVisit({ repHrId, managerHrId })`, used by both
walks:

- **`rep ?? manager`, never the other way round.** On a double or a chain visit the rep is whose call
  it was and the manager was with him; reading the manager first would file every double visit
  against the manager and take the rep's own call off his own board.
- **Null only where neither is set**, so a row naming nobody is still filed against nobody.
- 🔴 **And the subject is never his own companion.** The roster judge asks separately whether somebody
  who should not have been there was with him, reading `manager_hr_id`, `senior_hr_id` and
  `product_manager_hr_id`. On a manager's own single visit he IS the row's `manager_hr_id`, so leaving
  him in that list files his own leave day twice — once as his, once as *"somebody else was with
  him"*. He is filtered out of his own companions.

Today's arithmetic, measured before the change: **one** new case (the 3,236 m one), **zero** new
roster flags and **zero** new cadence flags — no manager's own visit falls on his own full-day leave
or away day, and no manager visited one customer three times inside seven days. The hole was worth
one case today and stays open for every manager's own call from here.

### The board stopped calling everybody a rep

A case filed against a District Sales Manager would have printed his name under a column headed
**Rep**, in the admin table, in the filter beside it and in both sheets of the XLSX export. That is a
false statement about a real person on the one board whose entire purpose is that each line of it is
true, so the column, the filter and both export headers now read **Who**. Nothing else is renamed:
the URL parameter stays `rep`, the summary sheet is still *By rep*, and no other screen in the app is
touched.

Nothing else moves. No threshold, no stored `distance_meters`, no migration, no notification, no rep
told anything, both flags still weak, and `SFE_SOURCES` untouched.

**Pinned by** eight assertions — `tests/phoenix-crm-location-integrity.test.ts` (the manager branch,
the rep winning on a double visit, nobody staying nobody), `tests/phoenix-crm-integrity-settle.test.ts`
(both walks resolving through `personOnTheVisit` at exactly two call sites, no pass reading the rep
column alone, the photograph pass reading `manager_hr_id`, the subject excluded from his own
companions) and `tests/crm-integrity-board-view.test.ts` (the person column and the export headers).
**All eight were broken on purpose and watched fire on their own headline**, then restored from a copy.

## 15 · The panel he could not read, and the four points that replaced it (2026-10-13)

He had just been shown the board after the sweep filed the manager's own visit, and he answered:

> **"I told the fuck out of you, you are putting too much text with which will make me not
> understand, which will make me lost as as as what happened. I want it as easy as visits, location
> versus the validation location with a story listed pointed 1, 2, 3 and the life map photo and clear
> English. Don't make me enter a loop. Restructure the module based on these instructions."**

### What the panel actually was

Measured on the shipped module, one opened case printed, in this order: a paragraph of **eight to
twelve sentences**; the photograph; a measurements list of up to a dozen rows; the history; the map;
the reasons. Two of the paragraph's lines earned nothing at all — one announced that a photograph was
below it, which the reader could see, and the ordinary cause took a heading plus one line per flag,
which reads as an accusation with a list of excuses under it. The section descriptions around the
case list ran to **241, 263, 481, 535 and 572 characters**, each a paragraph in its own right.

The two locations — the one thing a case is a comparison between — were two rows **inside** that
measurements list, under the photograph, below the paragraph. The sentence he had asked for the day
before, *location versus the validation location*, was the one thing the panel never put in front
of him.

### What it is now

1. **The comparison first.** `caseComparison` returns the capture side (*where this says it
   happened*), the validation side, and the metres between them. The two sit side by side with the
   distance between them, stacking on a phone so the order still reads as a comparison. 🔴 The
   validation side is the **photograph** wherever there is one, never the pin — the anchor he ruled
   on earlier the same day. A case with one coordinate, which is every replay case, says so instead
   of inventing a second location.
2. **The story as an ordered list, five points at most.** `caseStory.story` is built in priority
   order — what happened, the findings (the two strongest), where the customer's visits stand against
   the photograph or which reading is the odd one out, the ordinary cause, and the absence of a
   photograph if there is none — and capped. 🔴 The cap is applied in that order **so it can never
   eat the `Usually:` line**: a case with four flags prints two findings and the cause, never four
   findings and no explanation.
3. **The map and the photograph side by side**, directly under the points, with nothing between them
   and the words.
4. **The measurements, the history and the reasons behind one `<details>`.** They are what a reader
   wants when he doubts the four points above, and together they were longer than the story itself.

The five section descriptions were cut to one line each, and the ordinary cause now reads as a single
`Usually: …` line however many flags the case carries.

### What was deliberately NOT lost

- **The photograph still says whose it is** — on the ninth detector it belongs to whoever validated
  the place, not to this rep, so the heading reads *The photograph of the place* and the alt text
  *The photograph the place was validated with*. That requirement moved from the story to the
  picture; `tests/crm-integrity-board-view.test.ts` was re-pointed, never deleted, and still refuses
  *"as it was sent"* on a `visit_photo` case.
- **Every measurement.** Nothing was removed from `evidence` — the pin included, which takes no part
  in the judgement but is still printed, so nothing is hidden.
- **The voice.** State the measured fact, name the ordinary explanation, never a verdict. Fewer words
  is not a licence to conclude.

### Proof

`runShortPanelTests` in `tests/crm-integrity-board-view.test.ts` pins all four: five points at most
for every detector the board knows **and** on a crowded case that would print seven uncapped, the
`Usually:` line surviving a four-flag case, the comparison naming the visit and the photograph (not
the pin), a single reading yielding no comparison, and the panel's own order — comparison before the
list, measurements after it. **Eight assertions, each broken on purpose and watched fire on its own
headline, 7 of 7 breaks reported and the suite green again after every restore.**

## 16 · The photograph that read 10 km from the door (2026-10-22)

Dr Tharwat Milad's clinic in Dishna was validated on 20 October at 15:36 Cairo. The live photo's own
reading put the signboard in **Faw Bahari** (26.0839274, 32.3733084) at ±65.1 m, taken at 15:36:34; the
**Capture location** pin the same phone took at 15:36:39 read **Dishna** (26.1208047, 32.465416) at
±20.1 m. That is **10,070 m in five seconds**. The board filed a strong `photo_pin_disagrees` case. The
pin was the true one: the previous rep's two April check-ins at this doctor in the old CRM sit 242 m and
273 m from it. The case stays open and strong, by his choice the same night.

The same night he settled the seven visits the ninth detector had filed at four other places whose
photograph sits away from their pin — Sehet Behteem Hospital (2), Ashmoun Fever Hospital (3), Ahmed Sabry
Mashaal (1) and Linda Iskandar (1). Every one was saved **7-56 m from the pin** and 351 m to 2.8 km from
the photograph. All seven were settled on 22 October at 03:21 Cairo with the reason *"the rep stood at
the place's validated pin, and the photo's location was the phone's error"*.

### Why a phone does this

A location receiver that has just been switched on answers first from nearby networks, Wi-Fi routers
and phone masts looked up in a database, and only later from the satellites. That first answer can land
kilometres from the phone while claiming tens of metres: a router that moved house is still filed at its
old address. The camera switched its receiver on as it opened, enabled the shutter on the first answer,
and kept it, because the fresh reading taken at the shutter replaced the kept one **only when it claimed
to be sharper**. Whatever the shutter read that afternoon did not claim better than ±65 m, so the Faw
Bahari answer stayed; the pin came from the separate **Capture location** button five seconds later.

### What the camera does now

- **Two readings contradict** when they sit further apart than both claimed accuracies together, and
  never on less than the place's 250 m line, so two honest readings a doorway apart never do
  (`readingsContradict`, `src/lib/phoenix-crm/photo-reading-rules.ts`).
- **A reading taken in the receiver's first 30 seconds is cold**, and a later reading that contradicts
  it wins whatever accuracy either claims (`laterReadingOverrules`). The running watch asks it on every
  reading, and the shutter asks it of its fresh reading; the burned-in stamp then names the reading kept,
  with that reading's own time (`stampFix`). **A warm receiver's reading is never overruled**, so the
  photo's reading changes only in the one shape that produced the Faw Bahari photo.
- **The receiver is held warm while any capture screen is open** — the validation steps, Add a place,
  Capture location and the out-of-list entry (`useLocationWarmUp`, `location-receiver.ts`) — so the
  satellites have usually locked before the camera opens. It starts only where `permissions.query`
  already answers "granted": a warm-up never asks the rep for anything.
- 🔴 **It never holds the shutter, never refuses a photo and never tells the rep** (Golden Rule #1): it
  only chooses between readings the camera already had. A forced retake and a location retake were
  offered the same night and declined; never re-propose either.

### What the board says now

The panel told this case as *"The pin and the photograph's own reading are 10.1 km apart"*, named the
pin as *"the one that disagrees"* because the place's kept point and the photograph counted as two
readings, and closed on *"Usually: One of the two readings being the phone's cached position explains
most of these.."*. Now:

1. **A pin and a photograph further apart than anybody travels in the seconds between them say so.**
   Each reading is granted the accuracy it claimed, and only the distance left over is timed against
   the detector's own `MAX_TRAVEL_KMH` (150): *"…10.1 km apart, but were taken only 5 seconds apart —
   closer in time than anyone can travel that far, so one of the two is not where the phone was."* Two
   loose readings whose circles meet, an unrecorded gap, or a reading with no accuracy figure claim
   nothing (`fasterThanAnyoneTravels`).
2. **The ordinary cause is the phone's first network reading**, with a cached position beside it.
3. **On a place case the kept point is the photograph's reading, and the sentence says so**, so a copy
   never reads as a second witness against the pin. It still names the pin as the one that differs and
   still refuses to say which is wrong.
4. **`Usually:` joins its causes as sentences.** Joined as a list it printed *"these.."*, *"these. and A
   picture"*, and turned the *", and so does"* inside one cause into *" or so does"*.

### Considered and not done

Making the night check accept either reading, as the visit door does since 21 October, and having the
story name the reading the visits support. His 13 October rule is that the visits are measured against
the photograph, so a visit at the pin on a place like this one is still filed, weakly, and is his to
settle; the door and the night check deliberately answer different questions.

### Proof

`tests/phoenix-crm-photo-reading.test.ts`, on his case's own readings: the rule, the camera's two call
sites and its stamp, the warm-up on every capture screen, and the board's sentences. Three assertions
were broken on purpose and fired on their own headlines — the five seconds in the sentence, the
two-cause `Usually:` line, and the kept-point clause — and the file was restored byte-identical
(SHA-256 compared) before the suite went green again.

## Where the code is


| What | Where |
| --- | --- |
| The rule, pure and testable | `src/lib/phoenix-crm/integrity-settlement.ts` |
| The board, the gate, the two mutations | `src/lib/phoenix-crm/server/integrity-board.ts` |
| The button | `src/components/crm-integrity/integrity-settle.tsx` |
| The routes | `app/api/admin/phoenix-crm/integrity/{settle,reopen}/route.ts` |
| The page | `app/(admin)/admin/phoenix-crm/integrity/page.tsx` |
| The migration | `supabase/migrations/20261009190708_phoenix_crm_integrity_settlement.sql` |
| The three readers that need only the yes/no | `server/integrity-board.ts` (the weekly scan), `src/lib/rep-ranks/server/compute.ts`, `server/behaviour.ts` |
| Pinned by | `tests/phoenix-crm-integrity-settle.test.ts` |
| The nightly silent pass (roster, cadence, coverage, shared venues) | `src/lib/phoenix-crm/server/silent-detectors.ts` |
| Its four pure judgements and the five weak flags | `src/lib/phoenix-crm/location-integrity.ts` |
| The four filers it writes through | `src/lib/phoenix-crm/server/location-integrity.ts` |
| The full-day leave read | `getFullDayApprovedLeaveMap`, `src/lib/attendance/working-days.ts` |
| The subject-kind list the board derives from | `INTEGRITY_SUBJECT_KINDS`, `src/lib/crm-integrity/integrity-case-story.ts` (re-exported by `server/integrity-board.ts`) |
| The board's filters, stories, map, presets and row mapping | `src/lib/crm-integrity/integrity-{board-filters,case-story,case-map,settle-presets,board-rows}.ts` |
| The board itself | `src/components/crm-integrity/integrity-board-view.tsx` |
| Settling several cases with one reason | `settleManyIntegrityCases`, the LAST function in `server/integrity-board.ts` |
| Its route, and the filtered XLSX export | `app/api/admin/phoenix-crm/integrity/{settle-many,export}/route.ts` |
| The two widened CHECKs | `supabase/migrations/20261012210000_phoenix_crm_silent_detectors.sql` |
| The visits measured against the photograph | `visitsAgainstThePhotographSentence`, `src/lib/crm-integrity/integrity-case-story.ts` |
| The ninth detector — a visit against the photograph of its place | `runVisitPhotographGap`, `server/silent-detectors.ts`; `judgeVisitAgainstPhotograph`, `location-integrity.ts`; `fileVisitPhotographGap`, `server/location-integrity.ts` |
| Its CHECK | `supabase/migrations/20261013150000_phoenix_crm_visit_photograph_source.sql` |
| The place it was JUDGED against, which is not always the visit's own | `anchorPlaceIdOf`, `server/integrity-board.ts` |
| Whose visit it is — the rep, or the manager on his own single visit | `personOnTheVisit`, `location-integrity.ts` |
| Why a manager's own visit has no rep at all | the `kind === "single"` branch of `resolveVisitParticipants`, `scope.ts` |
| The one list of reading labels the loader names its readings from | `CASE_READING_LABELS`, same file |
| Which camera reading becomes the photo's — the cold-reading rule | `laterReadingOverrules`, `src/lib/phoenix-crm/photo-reading-rules.ts` |
| The receiver held warm on every capture screen | `useLocationWarmUp`, `src/components/phoenix-crm/location-receiver.ts` |
| A pin and photograph no one could travel between in time | `fasterThanAnyoneTravels`, `src/lib/crm-integrity/integrity-case-story.ts` |
