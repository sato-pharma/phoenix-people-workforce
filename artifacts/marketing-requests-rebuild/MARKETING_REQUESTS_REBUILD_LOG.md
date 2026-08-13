# Marketing Requests — Rebuild Log

Branch `codex/marketing-requests-rebuild`, off `origin/main` @ `12d20d19`.
Written **during** the work, one entry per batch. The contract is
[MARKETING_REQUESTS_REBUILD_SPEC.md](MARKETING_REQUESTS_REBUILD_SPEC.md).

Nothing in this branch has been merged or deployed. Production carries only the four PRs listed in
§0 of the spec.

---

## Batch 1 — a refused request stops claiming people owe it work

**Priority 4** in the rebuild directive: *"When a request is terminally rejected, future irrelevant
approval steps should not continue presenting themselves as pending work… Do not destroy past
approval information."*

### Problem

Rejecting a marketing request left every later rung in the chain at `status = 'pending'`, and wiped
the record of any earlier return.

Live in production right now (read-only query, 2026-08-13):

| request | request status | rejected_at | seq | step | step status |
| --- | --- | --- | --- | --- | --- |
| MKT-REQ-20260811-FF5B0719 | rejected | 2026-08-11 11:23 UTC | 1 | CEO Approval | rejected |
| " | " | " | 2 | SFE Validation | **pending** |
| " | " | " | 3 | Marketing Review | **pending** |
| " | " | " | 4 | CEO Approval | **pending** |
| " | " | " | 5 | Finance Execution | **pending** |

Four of the nine approval-step rows in the entire database describe work that will never happen.
Every consumer that counts pending rungs — the nav badge (`getMarketingApproverBadge`), the approver
inbox, any future work queue — reads them as outstanding. `returned_at` and
`returned_step_sequence` are NULL on that row whether or not it was ever returned, because the
reject erased them.

### Root cause

Both defects sit in Branch A of `phx_decide_marketing_request_step`, the single write path for every
decision.

1. Branch A updated the request row and returned. It never touched the sibling step rows, so the
   chain kept whatever it had at submit time. The `CHECK` constraint has always permitted
   `'skipped'` — nothing ever wrote it here.
2. `returned_at = CASE WHEN p_decision = 'return' THEN p_decided_at ELSE NULL END` (and the same
   shape on `returned_step_sequence`) wrote NULL on **every** reject. A request that was returned,
   resubmitted and then refused kept no evidence the return happened.

Defect 2 was only safe to fix now: `marketing_request_events` (#2082) records every transition, so
the request row is no longer the only witness to its own history.

The detail page had been rendering these rungs honestly as "not reached" since #2079 — but that was
a plaster over the data, visible on one page while every other consumer read the raw status.

### Files changed

| File | Change |
| --- | --- |
| `supabase/migrations/20260813190000_marketing_reject_terminalises_chain.sql` | new — replaces the RPC body, plus an idempotent backfill |
| `src/lib/marketing-requests/service.ts` | reads `terminalised` off the RPC result and records the count in the decision audit entry |
| `src/components/marketing-requests/marketing-request-case-file.tsx` | the "not reached" badge now reads the row, not just the request status |
| `tests/marketing-reject-terminalises.test.ts` | new |
| `tests/run-tests.ts` | registers it |

### Migration

`20260813190000_marketing_reject_terminalises_chain.sql`

- `create or replace` on `phx_decide_marketing_request_step` — a reject marks every `pending`,
  non-CC rung `skipped` in the same transaction, captures the count via `GET DIAGNOSTICS`, and
  returns it as `terminalised`.
- `returned_at` / `returned_step_sequence` change from `ELSE NULL` to `ELSE <themselves>`, so a
  reject preserves them.
- An idempotent backfill closes out the rungs already stranded on rejected requests, scoped to
  `r.status = 'rejected' AND s.status = 'pending' AND s.is_cc = false`.
- The `revoke … from public, anon, authenticated` / `grant … to service_role` pair is restated,
  because a REVOKE on a default ACL also strips `service_role` in this database.

**Deliberately unchanged:** a **return** does not terminalise. A returned request goes back to its
requester and its later rungs are genuinely still ahead of it — `resubmitReturnedMarketingRequest`
walks them, so closing them out would break resubmission.

**Applied to STAGING** (`cifwmndunmlxjhyjugxa`) **and, on the owner's explicit approval,
to PRODUCTION** (`ozucdzovmcqvepbozvqf`) on 2026-08-13 — before any merge, because the Railway
deploy applies no migrations. Full evidence in "Production apply" at the foot of this log.

### Tests added

`tests/marketing-reject-terminalises.test.ts`, registered in `tests/run-tests.ts`.

Proved to bite: **22 of 22** deliberate breaks fired the intended assertion, and the files restored
to passing afterwards. The harness runs in Node and restores each file from its original `Buffer`,
because a previous PowerShell attempt at this re-encoded a source file and corrupted 113 lines.

```
baseline (nothing broken): PASS
FIRED RPC no longer terminalises on reject
FIRED terminalise no longer gated on reject (a RETURN would strand the request)
FIRED terminalise unscoped (would close out the whole table)
FIRED terminalise widened past 'pending' (would rewrite a decided rung)
FIRED terminalise stops excluding CC rows
FIRED terminalise also stamps decision_by (destroys the audit trail)
FIRED count no longer captured
FIRED count no longer returned to the caller
FIRED reject goes back to NULLing returned_at
FIRED reject goes back to NULLing returned_step_sequence
FIRED backfill dropped (live stranded rows stay stranded forever)
FIRED backfill no longer scoped to rejected requests
FIRED backfill no longer scoped to pending rungs
FIRED backfill stops excluding CC rows
FIRED the browser roles regain EXECUTE on the decision RPC
FIRED service_role loses EXECUTE (the revoke-on-default-ACL trap)
FIRED the replacement body silently drops the self-approval guard
FIRED service stops reading the count off the RPC result
FIRED audit log goes silent about the bulk status change
FIRED badge stops distinguishing a CC row from a rung the refusal closed out
FIRED badge stops distinguishing a self-approval skip
FIRED badge renders the bare status word again

restored: PASS
22/22 breaks fired the intended assertion, 0 did not
```

The **first** run of the test failed on its own baseline, and the failure was correct: an assertion
that the old `ELSE NULL` clause was gone matched the migration's own header comment, which quotes
that clause verbatim to explain it. The test now strips `--` comments before asserting, and asserts
that the stripper works — an assertion that can match documentation is not testing code.

### Before

Staging, same fixture shape as the live row, decided under the **old** body: a reject left the two
later gating rungs `pending`, reported no count, and NULLed `returned_at`.

Production today: the table above — 4 stranded `pending` rungs, `returned_at` NULL.

### After

Behavioural proof on staging against the body applied **from this migration file**, run inside a
transaction that was rolled back (no fixture survives):

| | B1-REJECT | B1-RETURN |
| --- | --- | --- |
| request status | `rejected` | `returned` |
| `returned_at` preserved | **true** | true |
| `returned_step_sequence` | **1** — the original, untouched | 2 — this return's own |
| `terminalised` reported | **2** | **0** |
| gating rungs still `pending` | **0** | **2** |
| gating rungs closed out | **2** | 0 |
| CC row left alone | 1 | 1 |
| already-decided rung intact | 1 | 1 |

A reject closes the chain and preserves the earlier return. A return terminalises nothing, so
resubmission still works. Neither touches the rung that was already decided.

The live body on staging was also re-read from `pg_proc` (not the migration ledger, which reports
intent rather than reality): terminalise present and correctly scoped, gated on reject only, count
captured and returned, both `returned_*` columns preserved, no `ELSE NULL` left anywhere, and the
self-approval guard from #2087 carried forward.

> Worth recording: the first `pg_proc` read showed the terminalise **absent** on staging. It was
> not — an earlier ad-hoc apply had put a whitespace-compacted variant there, so "applied to
> staging" was true of a different text than the file being committed. The file was re-applied
> verbatim and re-verified. Checking the ledger, or trusting the earlier apply, would have missed
> this entirely.

### Browser verified

**Not yet — queued for Batch 5, and stated here rather than skipped.**

The change is only visible in a browser once a rejected request's rungs actually carry `skipped`,
which needs the migration applied to whichever database the app is pointed at. Production has not
had it applied (owner approval pending), and `.env.local` points at production. Batch 5 runs the
local app against the **staging** database, where this is applied, and covers the rejected-request
Case File at 375 / 390 / 430 alongside the rest of the mandatory flows.

What is verified today is the layer underneath it: the data behaviour above, and the view logic
under test.

### Remaining risk

- **The production backfill is a bulk status change on live rows.** It rewrites 4 rows on 1 request
  — inventoried above. It is scoped to `status = 'rejected'` and `is_cc = false`, so no live
  request and no decided rung is in range, and it is idempotent. It still needs announcing before
  it runs, and it has not run.
- **`skipped` now means three different things** on an approval step: a CC row, a rung the requester
  was assigned to (#2087), and a rung a refusal closed out. The Case File badge separates them by
  `is_cc` and the presence of a decision note. Anything else reading `skipped` — the inbox, a future
  work queue — sees only "not actionable", which is correct for all three, but a consumer that wants
  to *explain* the status must make the same distinction. Batch 3's timeline reads
  `marketing_request_events`, which records the reason, so it does not have to infer it.
- ~~**No event row is written for the terminalisation.**~~ **Wrong — corrected during Batch 2.**
  Closing a rung out changes its `status`, and `marketing_request_steps_capture_event` fires on any
  status change, so the reject writes one `step_decided` event per closed-out rung
  (`pending → skipped`). Measured on staging:

  | kind | step | from → to | actor | note |
  | --- | --- | --- | --- | --- |
  | `step_decided` | CEO Approval | current → rejected | A-10 | not justified |
  | `step_decided` | Marketing Review | pending → **skipped** | A-10 | — |
  | `step_decided` | Finance Execution | pending → **skipped** | A-10 | — |

  That is better than the claim (the history is complete) but it carried a defect: those rows have
  `decision_by_hr_id` null, so the trigger falls back to `assigned_hr_id` and the actor is the
  **assignee**. Rendered naively the timeline reads "*A-10 skipped at Marketing Review*" — stating
  that a person skipped their own step when the refusal above them ended the chain. Fixed in
  Batch 2's headline builder, with a test.

---

## Batch 2 — every comment is visible, including the ones the step row cannot hold

**Priority 6** in the rebuild directive: comments must stop destroying history.

### Problem

`postMarketingAdvisoryComment` writes a reviewer's comment into ONE text column on their CC step
(`decision_note`). Posting a second comment replaces the first.

Measured on staging (rolled back), posting two comments an hour apart:

| source | text | at |
| --- | --- | --- |
| **the step row** | SECOND comment: withdrawn, the forecast justifies it. | 10:00 |
| event `step_commented` | FIRST comment: the budget looks high for this pharmacy. | 09:00 |
| event `step_commented` | SECOND comment: withdrawn, the forecast justifies it. | 10:00 |

### Root cause — and what it actually turned out to be

The first comment is **not** destroyed. `marketing_request_steps_capture_event` (#2082, live in
production) records every `decision_note` change as its own `step_commented` event, so both survive
in the database with their own timestamps.

The real defect is that **nothing read them.** Every surface — the Case File chain, the approval
screens, the reports — reads `decision_note` off the step row, which can only ever hold the latest.
A preserved comment nobody can see is indistinguishable from a destroyed one for anyone using the
app, so "the events table already exists" was not the fix.

That reframes the batch: the write is left alone, and the missing half — a reader — is built.

### Files changed

| File | Change |
| --- | --- |
| `src/lib/marketing-requests/case-file-types.ts` | `MarketingCaseFileHistory` / `…HistoryEntry`, `MarketingRequestEventKind`, and `history: CaseFileBlock<…>` on the case file |
| `src/lib/marketing-requests/case-file-service.ts` | `loadHistoryBlock` + the exported `marketingHistoryHeadline`; joins the existing parallel read batch |
| `src/components/marketing-requests/marketing-request-case-file.tsx` | renders "History and comments" under the approval chain |
| `tests/marketing-request-history.test.ts` | new |
| `tests/run-tests.ts` | registers it |

### Migration

**None.** The table, the triggers and the backfill all shipped in #2082. This batch adds no schema.

### Tests added

`tests/marketing-request-history.test.ts`, registered in `tests/run-tests.ts`. The headline builder
is tested **behaviourally** (real calls, real return values), the loader and the view by assertions
scoped to their own function bodies.

Proved to bite: **24 of 24** deliberate breaks fired the intended assertion; files restored to
passing.

Its first run failed its own baseline, again usefully: `!/entry\.kind\}/` matched
`${entry.kind}` inside the React **key**, which is never rendered — so the assertion would have
passed while the raw kind was printed on screen. Anchored to JSX child position (`>{entry.kind}`).
That is the third false-green assertion this rebuild has caught by breaking its own tests, and all
three were the same mistake: an unanchored regex matching code that is not the code under test.

### Before

The Case File had no history section at all. A reviewer's earlier comment existed in the database
and appeared on no screen in the application.

### After

A "History and comments" section under the approval chain, ordered oldest-first, with:

- every `step_commented` entry — so an overwritten comment is visible with its own Cairo timestamp
- a comment count taken from the events, the number the step row cannot give
- prose headlines, never a raw `step_commented` on screen (the owner's names-not-codes rule)
- **an unrecorded actor rendered as "not recorded", never as "the system"** — the substitution that
  turns a gap in the record into a false claim about who acted
- backfilled rows labelled "Reconstructed from the request's own rows", so a derived entry never
  passes as a witnessed one
- a coverage sentence stating events only begin on 13 Aug 2026, so a short list is never presented
  as a complete one
- a failed read rendered as `unavailable`, never as an empty timeline

**Defect found and fixed at the Batch 1/Batch 2 seam** (see the correction in Batch 1's Remaining
risk): a rung the refusal closed out is recorded as `step_decided → skipped` with no decider, so the
trigger attributes it to the **assignee**. Rendered naively that reads "*A-10 skipped at Marketing
Review*". It now reads "Closed out without a decision at Marketing Review", and names nobody.
Only visible because Batch 1's data change and Batch 2's reader met.

### Browser verified

**Not yet — queued for Batch 5**, with Batch 1, and for the same reason: the section is populated
from a database that has the events table, and `.env.local` points at production. Batch 5 runs the
local app against staging.

Verified today: the headline builder behaviourally, the loader and view under test, typecheck clean.

### Remaining risk

- **Comments posted before 13 Aug 2026 are genuinely gone** if they were overwritten — there was
  only ever one column holding them and no history to reconstruct from. The coverage sentence says
  so on screen rather than implying the list is complete.
- **The write is still last-one-wins on the step row.** Deliberate: `decision_note` is read by the
  approval screens and the reports, and appending into it would turn a single-comment field into an
  unbounded log for every existing reader. The events table is the history. If comments later need
  their own first-class surface (threading, replies, per-comment deletion), that is a table, not a
  wider text column.
- **Identical text posted twice writes no event**, because the trigger fires on
  `decision_note is distinct from`. Harmless — the record is unchanged — but it means the event log
  counts distinct comments, not submissions.
- **`request_deleted` events can outlive their request** by design (no FK), so a history query can
  return rows for an id that no longer resolves. The Case File only reaches this loader after the
  request itself has loaded, so it cannot be hit there today.

---

## Batch 3 — the tracking strip stops naming someone who is not holding the request

**Priority 2** in the rebuild directive: tracking is the module's headline failure.

The *timeline* half of this batch landed in Batch 2 (the Case File now renders the full event
history). What was left is the surface a requester actually looks at first: the one-line progress
strip on their own request list.

### Problem

`MarketingProgressStrip` printed, for every request it was handed:

```
Step 1/5 · Currently with: Finance Execution — <a named colleague>
```

including refused ones. On the live production refusal that names a rung Finance never saw and a
person who never received it, on a request that died on 11 Aug. It is the same false sentence
already fixed on the Case File, still being told on the list.

### Root cause

`MarketingRequestStepProgress` has seven fields — `approvedGatingCount`, `currentApproverHrId`,
`currentApproverName`, `currentStepName`, `returnReason`, `sequence`, `totalGatingSteps` — and
**no status**. The component could not tell a live request from a dead one, so it described every
request as live. Not a styling bug: the data it was given could not express the truth.

### Files changed

| File | Change |
| --- | --- |
| `src/components/employee-portal/marketing-approval-timeline.tsx` | `status` is now a **required** prop; "Currently with" is gated on it; `terminalSentence()` for finished requests; a link to the full record |
| `src/components/employee-portal/marketing-request-drafts.tsx` | passes `status` and `requestId` |
| `tests/marketing-progress-strip-status.test.ts` | new |
| `tests/run-tests.ts` | registers it |

`status` is **required, not optional**, on purpose: an optional prop lets a caller keep the old
behaviour silently, and a future caller would.

### Migration

**None.**

### Tests added

`tests/marketing-progress-strip-status.test.ts`. Proved to bite: **11 of 11** breaks fired the
intended assertion, files restored to passing. Assertions are scoped to a single component body —
`case "returned":` alone appears three times in that file (`pillClasses`, `dotClasses`,
`terminalSentence`), so an unscoped assertion would have matched styling code.

### Before

`Step 1/5 · Currently with: Finance Execution — <name>` on a request refused on 11 Aug 2026.

### After

- in flight → `Step 1/5 · Currently with: <rung> — <name>` (unchanged, and now only here)
- refused → `1/5 approvals · Refused — nobody is waiting on this`
- returned → `… · Returned to the requester for changes`
- approved → `… · Approved — no approvals outstanding`
- draft / active / anything unmapped → a readable sentence, database underscores stripped
- every row now offers **Open the full record** → `/marketing-requests/<id>`, so tracking leads to
  the case file instead of being the end of the road

### Browser verified

**Not yet — queued for Batch 5** with Batches 1 and 2, same reason: `.env.local` points at
production and Batch 5 runs the local app against staging. Typecheck clean; behaviour under test.

### Remaining risk

- **The strip is one of several tracking surfaces.** This fixes the portal request list. The nav
  badge and the approver inbox count rungs rather than describing them, and Batch 1 already made
  their counts correct by closing out dead rungs. A full IA consolidation is Wave 3 and is
  deliberately sequenced last, because the CEO was previously locked out of the Approval Inbox by
  exactly that class of change.
- **`currentStepName` can still name a rung on a request that is not in flight** — the field is
  computed from the step rows and the strip now simply does not print it in that case. Anything
  else reading `progress.currentStepName` directly has the same exposure; the Case File already
  guards it the same way.

---

## Batch 4 — /marketing-requests exists, and it is your work queue

**Priority 10** in the rebuild directive: a role-aware work queue with "Needs My Action".

### Problem

`/marketing-requests` **had no page at all.** The only route under it was
`app/marketing-requests/[requestId]/page.tsx`. So the parent of every notification deep link, every
"Open the full record" link added in Batch 3, and every hand-typed URL resolved to nothing.

Work itself lived on an approver inbox inside one shell, which a viewer had to already know to look
for. There was no single answer to "what do I have to do?".

### Root cause

Not a missing feature so much as a missing *surface*. The data layer was already complete and had
been for months: `getApproverPendingRequests(access)` returns three lists — the rungs assigned to
the actor, the CC rungs they may comment on, and the requests heading toward them (the last added on
the owner's instruction, 2026-08-04, because the CEO sits at the final rung and could be on the hook
for a request stalled three steps upstream that their inbox never mentioned).

Nothing rendered it at the canonical route.

### Files changed

| File | Change |
| --- | --- |
| `app/marketing-requests/page.tsx` | new — the work queue |
| `tests/marketing-work-queue-page.test.ts` | new |
| `tests/run-tests.ts` | registers it |

### Migration

**None.**

### Tests added

`tests/marketing-work-queue-page.test.ts`. Proved to bite: **13 of 13** breaks fired the intended
assertion, files restored to passing.

Its first run failed its own baseline: `/truncate/` over the source matched the page's **own
comment** explaining that nothing is truncated, so the assertion passed on prose while a real
`truncate` class could sit in the markup unnoticed. It now extracts the `className` lists and reads
only those. Fifth instance of the same mistake in this rebuild, and the reason every test here is
broken before it is trusted.

### Before

`GET /marketing-requests` → no route.

### After

A server-rendered queue at the canonical route, in three sections:

| Section | Contents |
| --- | --- |
| **Needs my action** | requests waiting on the viewer's own decision — headline, emphasised |
| **Waiting for my comment** | CC rungs open to them |
| **Coming to you** | requests heading toward them, with the age in days and the rung they are stuck at right now |

Every row opens the Case File. Cards at every width (the owner's rule: mobile never gets a table),
nothing truncated, Cairo timestamps, `force-dynamic` so a personal queue is never statically cached
and served to the wrong person.

**Role-awareness is by scoping, not by branching.** The page contains no role check at all — the
loader is actor-scoped, so a Medical Rep and a Finance Manager get different queues from the same
code. A role switch in the page would be a second, weaker gate that could drift from the real one,
and the test asserts none is added.

**A failed read renders as a failure**, in the page's loudest style, saying in words that it is *not*
the same as having nothing to do. A genuinely empty queue says the read succeeded and found nothing.
Those are opposite answers and the page never lets them look alike.

### Browser verified

**Not yet — queued for Batch 5** with Batches 1–3. The route compiles (the full `check:harden`
build emitted it) but has not been opened in a browser.

### Remaining risk

- **This does not yet replace the existing approver inbox**, it stands beside it. Retiring the older
  surface is IA consolidation (Wave 3), deliberately sequenced last, because the CEO was previously
  locked out of the Approval Inbox by exactly that class of change.
- **Nothing links TO the queue yet.** `system-navigation.ts` is untouched, so it is reachable by URL
  and from the Batch 3 "Open the full record" trail, not from the sidebar. Adding a nav entry is a
  role-scoped change and belongs with the consolidation, not bolted on here.
- **The queue shows approval work only.** A requester's own drafts and returned requests still live
  on the portal list; folding those in is the same consolidation step.

---

## Batch 5 — browser + mobile verification — **DONE** (was blocked; the owner freed the slot)

The directive requires browser verification at 375 / 390 / 430, and says audit-era excuses are no
longer accepted. This is not an excuse: it is two measured, external blockers, each with a one-line
unblock the owner controls. Batches 1–4 were completed in full first.

### Blocker 1 — the single dev server slot is held by another session

`AGENTS.md` §5: *"One dev server at a time, ever"* — the laptop's RAM is soldered at 16 GB.

Measured 2026-08-13:

| | |
| --- | --- |
| port 3000 | **IN USE**, PID 19476 |
| that process | `next dev --turbopack --port 3000` running from **`F:\Phoenix Workforce\_wt-do-onephase`** |
| its parent (12868) | **alive** — a live session, not an orphan |
| free RAM | 5.8 GB |

That worktree is another session's (outstation expenses). Killing it is the exact class of
cross-session damage `AGENTS.md` §5 exists to prevent, and starting a second dev server breaks an
explicit machine rule. Neither was done.

Probing it confirms it is not serving this branch: `GET /marketing-requests` returns **500** there,
because that worktree does not have Batch 4's page — the route this branch adds.

**Unblock:** stop the `_wt-do-onephase` dev server, then this branch can take the slot.

### Blocker 2 — there is no staging service-role key on this machine

The directive says to point the local app at staging. It cannot be pointed there:

- `.env.local` in this worktree resolves to **production** (`ozucdzovmcqvepbozvqf`)
- the staging service-role key exists only as the GitHub Actions secret
  `STAGING_SUPABASE_SERVICE_ROLE_KEY`
- reading Supabase **project secrets** is explicitly outside the standing Supabase authorization
  (`AGENTS.md` §8) and needs an explicit go

`.env.staging.rls.example` is a template and carries no key.

**Unblock:** either supply the staging service-role key for a local `.env.staging`, or approve
applying the Batch 1 migration to production, after which production itself shows the `skipped`
rendering.

### What can be verified without either unblock, and what cannot

Once the dev-server slot frees, a **read-only** pass against production (page loads only, clicking
by text, never a decision or action control, no writes) covers:

- Batch 2's history section — production already has `marketing_request_events` (#2082) with its
  backfilled rows
- Batch 3's tracking strip on the live refused request
- Batch 4's work queue at `/marketing-requests`
- all three widths, 375 / 390 / 430

It cannot cover **Batch 1's `skipped` rendering**: production has not had that migration applied, so
its refused request still carries four `pending` rungs. That path exercises the pre-migration
fallback arm instead — which is worth seeing, but is not the same thing.

### Standing verification note

Everything in Batches 1–4 that does not need a browser has been verified and is recorded above:
staging behaviour inside rolled-back transactions, live `pg_proc` reads, 748 tests passing, four
break-it harnesses (22 + 24 + 11 + 13 = **70 deliberate breaks, all firing the intended assertion**),
and a full `check:harden` green end to end including the Next build.

---

## Production apply — `20260813190000_marketing_reject_terminalises_chain.sql`

Applied to **production** (`ozucdzovmcqvepbozvqf`, resolved via `list_projects`, not from a pasted
ref) on **2026-08-13**, on the owner's explicit approval. Applied **before** any merge, because the
Railway deploy applies no migrations.

`check:harden` was green end to end on this exact tree immediately before the apply (748 tests, lint,
typecheck, Next build), and the migration file has not changed since it was committed in `9da4cfce`.

### Pre-state, captured for hand rollback

Production has **PITR off** — 7 daily whole-database snapshots only — so the exact rows were recorded
before the change rather than relied on being recoverable.

| step id | seq | step | status before | updated_at before |
| --- | --- | --- | --- | --- |
| `e27f017b-9914-4de6-ad42-d569011f72cb` | 2 | SFE Validation | `pending` | 2026-08-11 11:12:09.817081+00 |
| `74729631-5978-43aa-a568-b8ef711218c7` | 3 | Marketing Review | `pending` | " |
| `32e4363b-6c59-49f4-8810-7c0b4b7b0fe8` | 4 | CEO Approval | `pending` | " |
| `10bc8e51-0ec8-4411-b85b-9a20875787ae` | 5 | Finance Execution | `pending` | " |

All four on `MKT-REQ-20260811-FF5B0719`; none decided, none CC. To reverse by hand: set those four
ids back to `status = 'pending'`, and restore the previous function body (the pre-change version is
`20260813170000_marketing_refuse_self_approval.sql`).

Controls recorded before: 9 approval-step rows total, 5 decided, 0 CC, 0 pending non-CC rungs on any
**non**-rejected request. The live function did not yet terminalise, and already carried the
self-approval guard.

### Post-apply verification — read from `pg_proc`, not the migration ledger

| check | result |
| --- | --- |
| terminalise present and correctly scoped | **true** |
| gated on reject only | **true** |
| returns the `terminalised` count | **true** |
| preserves `returned_at` | **true** |
| no `ELSE NULL` left anywhere | **true** |
| self-approval guard (#2087) survived the replace | **true** |
| `anon` / `authenticated` hold EXECUTE | **false** |
| `service_role` holds EXECUTE | **true** |
| rungs closed out on rejected requests | **4** |
| rungs still `pending` on rejected requests | **0** |
| rungs already decided | **5** — unchanged |
| total approval-step rows | **9** — unchanged |
| pending non-CC on non-rejected requests | **0** — unchanged |

Production and staging function bodies are **byte-identical**:
`md5 = f6926cb1be1f5c16d3ded3282306c4a1`, 5811 bytes. The behaviour proved on staging inside
rolled-back transactions is exactly what production now runs.

### Announced side effect

The backfill sets `updated_at = now()`, and the `marketing_request_steps_capture_event` trigger
(#2082) fires on that status change — so production also gained **4 append-only `step_decided`
events with `to_status = 'skipped'`, dated 2026-08-13** rather than the 11 Aug refusal. Confirmed: 4
written. They are correct about when the rows changed, cannot be edited or deleted, and their
`actor_hr_id` falls back to the rung's **assignee** because a terminalised rung has no decider —
which is exactly why Batch 2 renders them as "Closed out without a decision" and names nobody. This
was stated before the apply, not discovered after it.

### The database is now ahead of the deployed app, deliberately

PR #2089 is not merged, so production still runs the pre-Batch-1 application code. That is safe: the
RPC's extra `terminalised` jsonb key is simply ignored by the currently deployed service, and the
four rungs now read `skipped` instead of `pending` — which every existing consumer already treats as
"not actionable". No deploy is required for this migration to be correct on its own.

### Resolution — verification run 2026-08-13

The owner stopped the `_wt-do-onephase` dev server, freeing the single slot. Blocker 2 (no staging
key) became moot: the migration had by then been applied to **production**, so production itself
shows the real `skipped` rendering.

**Method.** This branch's dev server on :3000, with a read-only dev-auth proxy on :3001 injecting
`x-phoenix-role: Marketing Manager` / `x-phoenix-hr-id: A-9` (the browser pane cannot set headers).
The proxy **refuses every method except GET/HEAD/OPTIONS**, so no form post or prefetch could reach
production data even by accident, and refuses WebSocket upgrades rather than relaying them.

Browsed as **A-9, Hossam Mohamed Reda AboElftouh (Marketing Manager)** — the requester of the live
refused request.

#### `/marketing-requests/a43a439d…fe74` — the refused request

All four rungs below the refusal render **NOT REACHED**, reading the real `skipped` status the
production migration wrote — not the pre-migration fallback:

| rung | assignee | renders |
| --- | --- | --- |
| 1 · CEO Approval | Dr Anwar Gaweesh | **REJECTED** — "no request for conviban", 11 Aug 2026, 14:23 |
| 2 · SFE Validation | Khaled Mohamed Ali Bedair | **NOT REACHED** |
| 3 · Marketing Review | Hossam Mohamed Reda AboElftouh (YOU) | **NOT REACHED** |
| 4 · CEO Approval | Dr Anwar Gaweesh | **NOT REACHED** |
| 5 · Finance Execution | Ahmed El Maraghy | **NOT REACHED** |

Header reads `0 of 5 approvals` with **no** "now with …" — the in-flight guard holding on a terminal
request. Lifecycle sentence: *"Refused. No money was committed, and nothing here counts towards
company spend."*

#### History and comments — 8 events

The four backfilled rows are labelled **"RECONSTRUCTED FROM THE REQUEST'S OWN ROWS"**. The four
written by today's production backfill read:

> **Closed out without a decision at SFE Validation** — 13 Aug 2026, 07:07

and the same for Marketing Review, CEO Approval and Finance Execution. **Not** "Khaled Mohamed Ali
Bedair skipped at SFE Validation" — the Batch 1/Batch 2 seam defect, confirmed fixed against real
production data. The coverage sentence states events only begin on 13 Aug 2026.

#### `/marketing-requests` — the work queue

Renders all three sections. A-9's queue is genuinely empty (production holds one refused and one
approved request, so no pending work exists anywhere), and it says so correctly:

> *"Your queue is empty. This is a read that succeeded and found nothing — if a request should be
> here, it is assigned to somebody else rather than missing."*

The failure wording (`could not be read`) is **absent**, which is the distinction the page exists to
preserve.

#### Measured at every width

| | 375 | 390 | 430 |
| --- | --- | --- | --- |
| horizontal overflow | **0 px** | **0 px** | **0 px** |
| elements wider than viewport | 0 | 0 | 0 |
| "not reached" badges | 4, single line | 4, single line | 4, single line |
| badges wrapping to 2 lines | none | none | none |
| request code `MKT-REQ-20260811-FF5B0719` | — | 1 line | — |
| tables on the queue at mobile | — | — | **0** |
| CSS `text-overflow: ellipsis` / line-clamp | — | — | **0 elements** |
| literal `…` on screen | — | — | **none** |

Console: the only errors are HMR WebSocket failures, caused by the proxy refusing upgrades by
design. **Zero application errors.**

No screenshot of the approval chain is included: the Browser pane stopped compositing frames
part-way through, so `screenshot` timed out. The DOM measurements above test the same claims more
directly than an image would, and one 375 px screenshot of the history and customer sections was
captured before that.

Both servers were stopped afterwards, returning the single dev-server slot.

---

## Batch 6 — the browser roles lose write grants on the marketing config tables

Audit item **0.2**, the last outstanding security finding.

### Problem

Six marketing config tables grant `INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` to **both
`anon` and `authenticated`** in production. Nobody wrote those grants: Supabase's default privileges
hand the full set to every new table in `public`, which is why all six match exactly.

All six have RLS on with exactly one policy — a permissive **SELECT-only** policy (`polcmd = 'r'`)
for `authenticated`. So INSERT/UPDATE/DELETE are inert today: RLS is on, no policy covers those
commands, and a command with no permissive policy is denied.

**TRUNCATE is not covered by RLS at all.** No policy can stop it; the grant is the only control.
This repo already learned that once — `marketing_request_events` refused UPDATE and DELETE via row
triggers and `truncate` still emptied it on staging, because TRUNCATE fires no row triggers.

### Measured, not assumed — and it corrected the ticket

Becoming the `anon` role on staging with the default grant restored, inside a rolled-back
transaction, and attempting the truncate on each table:

| table | inbound FKs | result |
| --- | --- | --- |
| `marketing_control_settings` | 0 | **TRUNCATE SUCCEEDED — 8 rows to 0** |
| `marketing_review_routing` | 0 | **TRUNCATE SUCCEEDED — 3 rows to 0** |
| `marketing_distributors` | 2 | refused — `0A000`, referenced by a foreign key |
| `marketing_products` | 1 | refused — `0A000` |
| `marketing_request_types` | 1 | refused — `0A000` |
| `marketing_workflow_steps` | 1 | refused — `0A000` |

Only **two** of the six were actually emptiable. The other four are saved by an inbound foreign key
rather than by any deliberate control — a protection that vanishes the day someone drops that FK.

Note the audit item named **`marketing_request_types`**, which turns out to be one of the protected
four. The real exposure was on two tables it never mentioned. Fixing this from the ticket rather
than from measurement would have closed the wrong thing and reported it as done.

### Honest severity

**Defence in depth, not a remotely exploitable hole.** PostgREST exposes no TRUNCATE verb, so
holding the public anon key is not enough to fire one — it needs something genuinely running as
`anon`/`authenticated` against Postgres directly, such as a direct connection or a SECURITY INVOKER
function called on their behalf. The grants are simply wrong, cost nothing to remove, and their
presence is what would turn a future mistake into data loss.

### Files changed

| File | Change |
| --- | --- |
| `supabase/migrations/20260813210000_marketing_config_tables_revoke_browser_writes.sql` | new |
| `tests/marketing-config-grants.test.ts` | new |
| `tests/run-tests.ts` | registers it |

### Migration

Revokes `INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` from `anon` and `authenticated` on
all six. **`SELECT` is deliberately left alone** — each table has a read policy someone wrote on
purpose, and a repo-wide search confirms every reader is server-side, with no client component
referencing any of the six.

The revoke names `anon` and `authenticated` **by name and never PUBLIC**: revoking PUBLIC on a
default ACL also strips `service_role`, which would break every server path in the module. That trap
has bitten this repo before, so `service_role` grants are re-asserted afterwards as well.

**Applied to STAGING only.** Production apply is a protected action and needs explicit approval.

### Verified on staging

Grants after the revoke, across all six: `anon` TRUNCATE/DELETE/INSERT **false**, `authenticated`
TRUNCATE/UPDATE **false**, `authenticated` SELECT **true**, `service_role` SELECT/INSERT/DELETE
**true**.

Then behaviourally, actually assuming each role inside a rolled-back transaction:

| scenario | outcome |
| --- | --- |
| `anon` TRUNCATE `marketing_request_types` | refused: `insufficient_privilege` |
| `anon` DELETE `marketing_request_types` | refused: `insufficient_privilege` |
| `authenticated` SELECT | still permitted — read path intact |
| `service_role` SELECT | still works — the revoke-from-PUBLIC trap avoided |

### Tests added

`tests/marketing-config-grants.test.ts`, registered in `tests/run-tests.ts`. Proved to bite:
**10 of 10** breaks fired the intended assertion.

Two harness lessons worth keeping. Two of the first breaks were **shadowed** — they edited a line
the per-table assertion already pins, so the earlier assertion fired and the one under test never
ran; rewritten to *add* a bad statement, which is what a real regression looks like. And one
assertion was genuinely too loose: `/protected four|saved by an inbound foreign key/` passed on the
surviving arm after the caveat was deleted. An alternation is only as strong as its weakest arm; it
now pins one specific phrase.

### Browser verified

**Not applicable** — this changes database grants only, with no user-visible surface. The read path
it must not break is covered behaviourally above.

### Remaining risk

- **The default ACL is unchanged**, so the *next* table created in `public` will inherit the same
  full grant set. Fixing that is an `alter default privileges` change affecting every future table
  in the database, well outside this module, and deliberately not bundled here.
- **Two of the four FK-protected tables could become truncatable** if their referencing FK is ever
  dropped. After this migration the grant is gone, so that no longer matters — which is the point of
  removing it rather than relying on the accident.

### Production apply — 2026-08-13

Applied to **production** (`ozucdzovmcqvepbozvqf`) on the owner's explicit approval. `check:harden`
was green end to end immediately before (749 tests, lint, typecheck, Next build) and the migration
file is unchanged since commit `f6d3ad34`.

**Pre-state, for hand rollback.** All six tables held the identical set for all three roles —
`DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE` — which is Supabase's default ACL
verbatim, confirming nobody wrote these deliberately. Reversal is one statement per table:
`grant delete, insert, references, trigger, truncate, update on <table> to anon, authenticated;`

**Post-apply grant bits**, all six tables:

| role | privilege | after |
| --- | --- | --- |
| `anon` | TRUNCATE / DELETE / INSERT / UPDATE | **false** |
| `authenticated` | TRUNCATE / DELETE | **false** |
| `authenticated` | SELECT | **true** — kept on purpose |
| `service_role` | SELECT / INSERT / UPDATE / DELETE | **true** |

**Behavioural verification on production**, inside a rolled-back transaction. Refusal-only: no grant
was restored, so nothing could succeed and no TRUNCATE lock was ever taken — the privilege check
rejects before any lock is acquired.

| scenario | outcome |
| --- | --- |
| `anon` TRUNCATE `marketing_control_settings` (the one that emptied on staging) | refused: `insufficient_privilege` |
| `anon` TRUNCATE `marketing_review_routing` (likewise) | refused: `insufficient_privilege` |
| `authenticated` DELETE `marketing_request_types` | refused: `insufficient_privilege` |
| `authenticated` SELECT `marketing_request_types` | still permitted — read path intact |
| `service_role` SELECT `marketing_workflow_steps` | still works — the revoke-from-PUBLIC trap avoided |

No data was read into, written to, or removed from any table. Staging and production now carry the
same grants.

**This migration needs no deploy.** It changes database privileges only; no application code depends
on it, so it is complete and correct on its own whether or not PR #2089 ever merges.
