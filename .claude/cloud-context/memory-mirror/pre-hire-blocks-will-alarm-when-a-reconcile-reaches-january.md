---
name: pre-hire-blocks-will-alarm-when-a-reconcile-reaches-january
description: "The 202 cleared pre-hire visit stamps replay as AUTOMATIC blocks, so the first wide reconcile reaching Jan-Mar 2026 will mark the CRM sync degraded — expected, not a regression."
metadata: 
  node_type: memory
  type: project
  originSessionId: edc71556-4013-4eca-9919-93ac229cd4c4
  modified: 2026-08-28T09:04:02.729Z
---

On 2026-08-28 the employment-window rule shipped (PR #2531, squash `a4f72bb2`): a saved CRM mapping
can no longer credit a visit dated outside the mapped person's hire/leave dates. The historical
damage was then cleared in production — **202 rows across 27 people, holding 11 real doctor calls**,
all set to nobody. Verified by id: 202 of 202 cleared, 0 still stale, 0 moved to a wrong person.
Uncredited real calls went 2,347 → **2,358**, exactly the 11, and 86,652 of 89,010 calls (97.35%)
remain credited.

**The part that is not derivable from the code: replaying all 202 through the live resolver returns
202 AUTOMATIC blocks and 0 settled ones.** An automatic block increments
`blocked_pre_hire_attributions` and flips the sync to degraded. Nothing about it is actionable:
these sit on name-stripped accounts whose identity the CRM admin erased at resignation (see
[[crm-resigned-slot-reused-for-new-hire]]), so no override can ever be recorded for them.

**THE DEEP SWEEP IS WEEKLY AND ITS WINDOW ROTATES — corrected twice on 2026-08-28, both times for
guessing a schedule instead of reading one.** First this file said the alarm was a future event
awaiting "the first wide reconcile"; then, after seeing a single January run, it said the sweep runs
"every morning" and fires daily. Both wrong, and the second was the worse error — it was written
from **one** observation.

What the run table actually shows. There are two wide shapes, and only the second matters here:

- A **rolling 10-day** window (`today-10 → today`), every 3 hours at 06:00/09:00/12:00/15:00/18:00/
  21:00 Cairo. Routine, and it never reaches January.
- A **deep ~30-day sweep, roughly WEEKLY**, whose window rotates to the stalest month rather than
  advancing: 07-12 (Jun), 07-19 (May), 07-26 (Apr), 08-02 (Apr), 08-09 (Jul), 08-16 (Jun), 08-23
  (May 25→Jun 24), **08-28 (Jan 01→Jan 30 — 8,355 rows, 42 pre-hire blocks)**. Gaps are 7 days
  except the last, which was 5.

So the January window is swept **once every several weeks at best, not daily**, and the next deep
sweep (~4 September) will almost certainly pick a different month. **To verify the pre-hire side you
must trigger a `manual_backfill` on the January window deliberately** — that trigger exists in the
run table's history — or replay the window offline. Waiting for it to recur on its own is not a
plan.

The lesson, now paid for twice in one day: **read `ireports360_visits_sync_runs` for the windows and
cadence actually recorded before predicting when any of these counters will move.** One run is a
sample, not a schedule.

**Do not "fix" it by re-crediting anybody, and do not chase it as a new incident.**

**Revised 2026-08-28 by PR #2539, which cut the expected number.** A whole-table scan (126,410 rows)
found **266** counted blocks in total: **261 pre-hire** and **5 post-exit**. #2539 stopped counting
blocks on rows that record the ABSENCE of work — public holiday (`-5`) and casual leave (`-6`) — so
**86** of the pre-hire ones are now silent and **175 will still fire** across Jan–Mar (155 campaign,
11 regular, 5 meeting, 3 training, 1 annual vacation). So expect **~175, not 202**, and it is still
expected and still unactionable. The counting rules now live in a pure `countBlockedAttributions`
(`src/lib/crm/sync.ts`) pinned by `tests/crm-block-counting.test.ts`.

**The prediction was 31, and a deliberate backfill CONFIRMED it — 31 on the nose.** Replaying that
window (2026-01-01 → 01-30, the same 8,355 rows) offline through the live resolver gives **44**
counted pre-hire blocks — 31 campaign, 12 public-holiday, 1 casual-leave — so #2539 silences 13 and
the run should report **31**. A `manual_backfill` on 2026-08-28 at **11:57:19 Cairo** recorded
exactly that: `pre_hire=31, post_exit=0`, against **42** from the same window that morning. The
morning run read 42 rather than 44 because it fired at 04:26 UTC, **before** #2531 deployed at
07:42 UTC; the employment-window rule then added the other 2 by refusing an override and letting an
automatic tier block instead. Post-exit in that window is 0 every way it has been measured.

**That backfill changed no data, and the reason it was safe is the part to keep.** 8,355 fetched,
8,355 upserted, **0 deleted**, 0 skipped, in 18 seconds; before and after identical at 8,355 rows /
6,626 attributed / 1,729 unattributed / 111 agents. But the morning's sweep of the same window had
deleted **137** rows, so the prune is real — it took nothing here only because the mirror already
matched the vendor exactly (8,355 == 8,355, 0 rows unsynced). **Check that equality first, and write
a before-image to disk, before any backfill whose window the prune can reach**: a pruned row cannot
be re-fetched, and `rows_deleted` tells you afterwards, which is too late.

**A watcher on `ireports360_visits_sync_runs` MUST filter `status = 'success'`.** The row is
INSERTed at run start with every counter at zero and UPDATEd at completion, so a watcher keyed on
`started_at` alone reads the in-flight row and reports `rows_fetched=0, pre_hire=0`. On 2026-08-28
that produced a false "predicted 31, got 0" alarm three seconds into the run that finished at 31 —
an in-flight row is indistinguishable from a genuine zero unless you check the status.

That same PR cleared the separate post-exit standing alarm, which had marked every run "with
warnings" since 27 Aug: 27 August was a public holiday and iReports360 sprays a marker across every
account including deactivated ones (168 markers, 168 slots, 0 real calls company-wide). Each sat on
a slot whose last real call is the day its holder left. **Silencing markers cannot hide a genuinely
reused slot** — such a slot also emits the successor's real calls, and those still count.

**VERIFIED IN PRODUCTION 2026-08-28.** #2539 merged as `eeb5e6bc` (11:32:36 Cairo) and Railway served
it at **11:35:04**. On the identical window (`2026-08-27 -> 2026-08-28`, 171 rows) the counter reads:
**47 runs from 06:04:13 to 11:34:05 at a flat 5**, then the very next run at **11:35:20 at 0**. Same
window, same row count, nothing else changed — so the fix is proven by the counter itself, not by
inspection.

**That counter was 6, not a constant 5, and the sixth was never identified.** It read **6** on every
run from 2026-08-27 evening through **04:57:52** Cairo on 08-28, then a flat **5** from **06:00:09**
onward — a step that predates #2531's 07:42 UTC deploy, so the code did not cause it. Most likely
the hourly prune dropped a re-saved plan entry (see
[[ireports360-reissues-a-new-plan-entry-id-when-a-rep-re-saves-a-day]]). The whole-table scan an hour
later found exactly **5**, all markers, so **#2539 covers today's 5 and should drive it to 0** — but
if it lands on 1 rather than 0, that sixth shape is the thing to go and find, not a regression in
the skip.

Rollback before-image for the 202 rows was written to the session scratchpad, not the repo, so it is
gone once that directory is cleared — the clear is effectively one-way now.

Related: [[crm-parity-two-problems-set-and-attribution]] — this was the ATTRIBUTION half; row-set
drift is a separate problem and this changed nothing about it.
