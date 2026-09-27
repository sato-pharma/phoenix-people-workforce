---
name: staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones
description: "How to sweep the memory store for stale claims: sweep by CLAIM not by filename/topic — the claims that bite are infrastructure/status assertions buried inside memories about a FEATURE, read when a session is NOT being careful. Six angles (dead infra, frozen in-flight status, frozen module phase, drifted figure, dead file pointer, and the reviewer's own filter), the 3-bucket triage, and 🔴 fix the DESCRIPTION not just the body — the description is the only text recalled with no file around it."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b974beb4-54ef-40e3-a9b5-e4abda597572
  modified: 2026-09-26T02:52:36.828Z
---

When this repo's infrastructure reverses — Cloud Run→Railway, scheduled deploys→instant-on-merge, `main`
unprotected→protected, a Supabase ref dying — someone sweeps the memories. **Those sweeps kept being scoped
by TOPIC, and that is why they kept missing the claims that matter.** A topic-scoped sweep fixes the files a
session reads when it is already *thinking about deployment* — precisely when it is being careful. It misses
the same false claim sitting in a memory about excuses, or CRM filters, or a sales import, read while the
session is NOT thinking about infrastructure. Confirmed across four sweeps: the identical wrong sentence
("Ships on the 2-hourly prod deploy cron, not on merge") survived in a feature memory after being struck in
the deployment memory beside it.

## The method: sweep by CLAIM, triage into three buckets

Grep the assertion itself across EVERY file (a dead project ref, `gcloud run`, `vercel.app`, a deploy
cadence, a required-check count), then triage each hit:

1. **Present-tense assertion** → correct it in place. **This is the dangerous bucket.**
2. **An outstanding action** (`Still needed:`, `How to apply:`, `awaiting`) pointing at dead infra →
   **RETARGET it, do not just annotate** — it is a live TODO aimed at nothing. Keep the principle the line
   was teaching (e.g. "never print a secret"); only the mechanism died.
3. **Dated past-tense record** ("verified live at vercel.app", "check:harden green, 447 tests") → **LEAVE IT
   ALONE.** Rewriting history to match current infra destroys the record and teaches nothing; strike through
   and date the correction instead of deleting the original.

Bucket 3 is ~90% of hits and none of the risk. 🔴 **Do NOT measure a sweep by how many files it changed** —
a healthy sweep touches few. **Verify each replacement against LIVE state, never against `AGENTS.md`, the
ledger, or the file itself** — a ledger/doc/memory is not live state (`gh pr view <n> --json state,mergedAt`
settles a PR, `pg_class`/`information_schema.columns` settles a table, the filesystem settles a worktree).
Related family — a ledger/doc/memory is not live state: [[list-migrations-reports-ledger-not-reality]],
[[railway-merge-is-the-production-deploy]], [[local-validation-gates-are-gone-ci-is-the-gate]],
[[railway-is-prod-cloud-run-workflow-is-dead]].

## The six angles, each with its own vocabulary

**1 · Dead infrastructure asserted present-tense** — a dead Supabase ref, `gcloud`/Cloud Run or Vercel as a
LIVE target, a deploy-cron cadence, a required-check count, `strict:true`. 🔴 **A string can be TRUE — never
blind-replace.** `2-hourly` names the deploy cron in one file and the live Windows scheduled task that
restarts the attendance agent in another; a regex sweep that doesn't READ each hit corrupts a true fact while
fixing a false one. The dangerous residue is live config pointing at a dead console (secrets "set on the
production Cloud Run service") — it sits in files a session opens *while doing the thing*, so retarget it to
Railway variables on `phoenix-people-workforce`/`production`.

**2 · In-flight STATUS frozen mid-flight** — "PR #NNNN open (not merged)", "Built, NOT committed", "still
needs approval", "awaiting the owner's ruling". Every one was true the hour it was written; the defect is the
TENSE, not the content, so no lookup table of dead things finds it. Sweep the PHRASES —
`not (yet) committed`, `not yet applied|merged|deployed`, `still needs|pending`, `awaiting|pending approval`,
`PR #\d+ .{0,40}open|not merged` — then resolve each against LIVE state. 🔴 **A stale in-flight line ages
into an INSTRUCTION**: "do not change either mapping" / "needs separate approval" are imperatives that, once
the situation resolves, start telling sessions to UNDO the resolution (one said two alias conflicts were
"awaiting ruling, do not change either mapping" after the owner had ruled and both were changed — following
it would have restored the very conflict the audit existed to find; another said a payroll migration still
needed approval while the table was live on production paying 14 real people).

**3 · Module PHASE frozen** — "DESIGN PHASE, no code yet", "BUILDING", "BLOCKED on X". The thing is now live
and serving; the description tells a session it doesn't exist, so it rebuilds it or reports it missing. Sweep
phase phrases together with the status phrases of angle 2. 🔴 **A phase-stale description can hide a stale
NUMBER** (a "DESIGN PHASE, 42 fixed areas" memory for a design that shipped and now holds 50) — when a design
memory turns out to have shipped, re-check EVERY figure in it against production, not just its status.

**4 · A drifted FIGURE** — a count of live entities with NO date anchor, positioned as "this is how many
there are" (not an identifier, price, threshold or a *dated* measurement, which are stable/history). Sweep
the description AND `MEMORY.md`. 🔴 **The direction matters more than the delta.** Under-reporting is the
UNSAFE error — quoting "34.8% coverage" when it is 83.1% invites a rebuild of something that works. **Stale
by DELETION is the worst shape:** a memory names a table, the pipeline moved, and the now-empty table reads
exactly like a resolved risk — **when a memory names a table, re-check the table still holds the data before
trusting a zero from it.** A count whose headline moved one way while the risk moved the other (reps "never
paid" rose 13→18 while the truly-unpaid fell 4→2) is worse than useless — split it the way the rule needs
(by hire date). **Anchor a drifting figure as a magnitude** ("~90+ reps, 500+ addresses"), don't chase exact
counts every month.

**5 · A dead POINTER** — a file path a memory tells a session to go read. A path is not a claim about the
world, so no assertion sweep finds it. Extract every backticked repo-shaped path, unique it, `[ -e ]` each,
and keep only the FULLY-QUALIFIED misses (`src/ app/ tests/`); bare-prefix hits are relative fragments.
🔴 **A dead path in a "How to apply" INVERTS the rule it's attached to** ([[the-old-monthly-closing-export-is-never-touched]]
pointed at a premium-export module that never existed, so a session obeying "new capability goes beside it"
finds nothing and is pushed toward editing the original it must never touch — the real builder is
`src/lib/sales/closing-engine-fill.ts`, found from the route's own imports, never by guessing a name).
🔴 **A dead path that names a TEST is a WITHDRAWN GUARANTEE, worse than a broken link** — it reads "this is
covered, ship it" ([[portal-responsive-data-list-renders-every-row-twice]] cited a test deleted with its
board; the invariant is now enforced by nothing). Grade a dead test-pointer like a missing guard.
**MIGRATION paths get THREE verdicts and the filesystem cannot tell them apart:** ARCHIVED (check
`supabase/_migrations_archive/` — a pre-baseline migration usually lives there), APPLIED UNDER A DIFFERENT
FILENAME (the ledger version never matches the filename — production had 5 live `payroll_copilot_*` tables
whose migration file was gone), or NEVER APPLIED. Only `pg_class` distinguishes them; resolve every missing
migration against production. **A documented-but-absent table invites the worst repair** — re-applying its
migration bolts a write path onto a feature that already works via a derived path ([[system-issues-dashboard-gcp-supabase]]:
"documented as built" and "verified on staging" are both compatible with "absent from production").

**6 · The reviewer's OWN FILTER is the recurring defect.** A false 🔴 is more expensive than a stale figure —
a stale number gets re-measured, an alarm gets acted on. The rules the sweep applies to everything else apply
to its own findings:
- **A DEFECT is a claim too** — verify your own finding against production before publishing it (a "the guard
  is leaking" write-up was wrong on every point because it counted `geo_locations` alone instead of joining
  the live brick table, and misread an Arabic brick name instead of asking the brick table — the exact error
  in [[address-matching-beats-paid-ai-and-geocoding-hurts]]).
- **JOIN before you quote** — a count over a raw table is not a count over live entities.
- **READ THE WRITER before calling the write wrong** — an invariant may have been deliberately RELAXED with
  better reasoning than the original (the shared-pin guard was loosened on purpose; the code carried the
  reason in a comment).
- **Always use a POSITIVE CONTROL for a blank grep** (this repo's blank-result trap makes an unverified 0
  worthless), and **`| head` destroys the exit code** — count files, don't pipe to head.
- **Check the vocabulary** — casing (`line_code` is lowercase `cns`), the status name (`connected` not
  `linked`), the column, CRLF-vs-LF — before concluding a memory is wrong; a failing verification harness is
  a claim too.
- 🔴 **This store holds memories for MORE THAN ONE PROJECT** — `[ -e ]` from the Phoenix root is the wrong
  instrument for a memory about another repo (`E:\New`), and the failure is silent: a real path in another
  repo looks exactly like a deleted path in this one. Check which repo a memory is about before testing its
  paths.

## Two safety rules and two non-problems

- 🔴 **Fix the DESCRIPTION, not just the body.** The description is the only text recalled with NO file around
  it, so a session reads "PR #1000 OPEN+GREEN", believes it, and never reaches the paragraph below that says
  it merged. A correction appended under a stale description is a correction nobody reads — rewriting the
  description repairs the RECALL KEY, it is not rewriting history.
- **Assert `~~` count is EVEN in every file you touch** — an unclosed strikethrough swallows the rest of the
  file. It is cheap, and it is the only corruption this method can cause.
- **Relative dates are a non-problem here** — the store's "this month"/"last month" are payroll and product
  semantics, not dangling anchors; do not spend a pass on them.
- **Search the hyphenated IDENTIFIER, not the English name**, before concluding a feature doesn't exist
  (`notification-confidence` returned 0 hits for "confidence gate" though the page and four API routes exist).

Do NOT touch: `uncommitted`/`WIP` inside a durable LESSON (the word is the subject, not a status), a
`still PAUSED` that is an owner standing rule, an `awaiting` that is a UI tab label, or a `before building any
new UI…` imperative. Read the sentence before believing the hit. And re-verify a methodology memory's own
examples before citing them — including any ⚠ this file itself left open, which ages into a stale in-flight
status like any other.
