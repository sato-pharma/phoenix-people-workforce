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
| The subject-kind list the board derives from | `INTEGRITY_SUBJECT_KINDS`, `server/integrity-board.ts` |
| The two widened CHECKs | `supabase/migrations/20261012210000_phoenix_crm_silent_detectors.sql` |
