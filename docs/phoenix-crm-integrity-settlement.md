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
again, to a verdict that does not carry the flag* — stays true of every row in it. A withdrawn case
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
the wrong kind. A place reading `match` leaves the nightly backlog, so nothing would ever have
re-read those four: without this, the board would have gone on showing a flag whose own evidence had
already been replaced.

`judgeLaterSignboardReading` compares the reading against the case's **`created_at`, never
`captured_at`**. The capture predates every nightly read by construction, so judging against it
withdraws every case at once — which would read as the detector being wrong about all of them. A
missing or unparseable date leaves the flag standing: an unreadable reading is not a contradiction.

It is pure, and it lives in `location-integrity.ts` rather than in `server/integrity-board.ts`,
because a test importing the server module would pull in `getSupabaseAdmin` — the same reason
`readIntegritySettlement` is a separate module (§1).

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
