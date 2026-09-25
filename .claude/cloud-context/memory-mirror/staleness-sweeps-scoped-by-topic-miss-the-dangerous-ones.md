---
name: staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones
description: "A staleness sweep scoped by filename/topic leaves the dangerous claims behind — the ones that bite are infrastructure assertions buried inside memories about something else entirely"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b974beb4-54ef-40e3-a9b5-e4abda597572
  modified: 2026-09-05T06:36:16.183Z
---

When this repo's infrastructure reverses — Cloud Run→Railway, scheduled deploys→instant-on-merge,
`main` unprotected→protected, `strict:true`→`false`, a Supabase ref dying — someone sweeps the
memories. **Those sweeps have consistently been scoped by topic, and that is why they keep missing
the claims that matter.**

Evidence, 2026-08-23. A prior sweep (2026-08-19) correctly banner-stamped ~9 files that are *about*
deployment — `prod-deploy-scheduled-not-on-push`, the `gcp-*` audits, `deploy-speed-levers-*`. Every
one got a clear SUPERSEDED block. But these survived untouched, because each lives in a memory about
a **feature**:

- `no-activity-report-…` — "**Ships on the 2-hourly prod deploy cron, NOT on merge.**" Exactly
  backwards; a merge now ships instantly.
- `excuse-module-excludes-dsm-rm` — a section headed "**Deploy-pipeline facts worth remembering**",
  every fact in it dead.
- `sales-consolidation-desktop-data` — "STAGING (`izhmxvgiktiafqusolot`) first, then prod w/ approval",
  naming a project that no longer resolves. A session following it finds nothing and is tempted
  straight to production.
- `hr-notification-emails-dropped-cloudrun` — an **open owner action** aimed at `gcloud`.
- `sos-dashboard-rebuild-…` — an outstanding smoke test on a decommissioned Vercel URL.

**Why it matters:** the topic-scoped sweep fixes the files a session reads when it is *thinking about
deployment* — precisely when it is already being careful. It misses the ones a session reads while
thinking about excuses, or CRM filters, or a sales import — when it is not.

**How to apply.** Sweep by **claim**, never by filename. Grep the assertion itself across every file
(`2-hourly|deploy window|NOT on merge`, a dead project ref, `gcloud run`, `vercel.app`,
`no branch protection`, `5 required`), then triage each hit into three buckets:

1. **Present-tense assertion** → correct it in place. This is the dangerous bucket.
2. **An outstanding action** (`Still needed:`, `How to apply:`, `awaiting`) pointing at dead infra →
   **retarget it**, do not just annotate — it is a live TODO aimed at nothing.
3. **Dated past-tense record** ("check:harden green, 447 tests"; "verified live at vercel.app") →
   **leave it alone.** Rewriting history to match current infrastructure destroys the record and
   teaches nothing. Strike through and date the correction instead of deleting the original.

Bucket 3 is most of the hits and none of the risk — 46 files mentioned the retired `check:harden`
and only ~6 needed touching. Do not measure a sweep by how many files it changed.

**Verify each replacement against live state, not against `AGENTS.md`.** A live `list_projects` on
2026-08-23 showed that `supabase-dual-project-schema` — a `reference` memory, the file you consult to
answer "which project is which" — named **two** refs as the pair and **both** were gone
(`izhmxvgiktiafqusolot` *and* `oaifhavixhdtwmseshff`). AGENTS.md only documents the first as dead.
Copying the doc would have left half the error standing.

Related: [[local-validation-gates-are-gone-ci-is-the-gate]], [[railway-merge-is-the-production-deploy]],
[[railway-is-prod-cloud-run-workflow-is-dead]], [[list-migrations-reports-ledger-not-reality]]
(same family: a ledger/doc/memory is not live state).

## 2026-08-27 sweep — the method works, and here are the two things that nearly broke it

Ran by claim across all 896 memory files. **342 claim-hits; 107 already correctly bannered; 62 flagged
as present-tense-and-unbannered; 17 corrections actually written across 15 files.** That ratio is the
point: **do not measure a sweep by files changed.**

**The topic-scoped failure reproduced exactly, in a matched pair.** `no-activity-report-…` was struck
through on 2026-08-23. Its twin `outstation-ticket-mandate-bypass-and-dead-policy-knobs` carried the
*same sentence* — "Ships on the 2-hourly prod deploy cron, not on merge" — unstruck, because that
sweep was scoped to deployment-topic files and this one is about outstation tickets. Grepping the
**claim** found it in seconds. The claim was also wrong on its own terms: `deploy-cloud-run.yml` moved
to a **4-hourly** schedule on 2026-07-26, so "2-hourly" was already stale before GCP died.

**TRAP — a "2-hourly" hit can be TRUE. Never blind-replace this string.**
`attendance-agent-crashes-at-logon-but-loses-no-attendance` says "the **2-hourly sync task** restarts
it on demand". That is the **Windows scheduled task**, not the deploy cron, and it is correct, live,
and 🔴 in the index. A regex sweep over `2-hourly` that does not read each hit will corrupt a true
fact while fixing a false one. Read every hit; the string is ambiguous across two unrelated systems.

**The dangerous residue clusters in memories about ACTIVE work, not old ones.** After the obvious
deploy-cadence fixes, what was left worth touching was **live config pointing at a dead console** —
WhatsApp secrets "set on the production Cloud Run service", the OpenAI key rotation procedure via
`gcloud secrets versions add`, `LOCATIONIQ_API_KEY` "added to both Cloud Run services". All three sit
in files a session opens *while doing the thing*, so the wrong target gets acted on. Retarget these to
**Railway variables on `phoenix-people-workforce` / `production`**, and keep the principle that the
line was really teaching (never print a secret) — only the mechanism died.

**Two more shapes worth knowing.** (1) *A stale "outstanding" claim is as dangerous as a stale fact.*
`weekly-sales-decumulation-plan` still read "NOT applied to prod. NOT pushed yet." — but production has
`cycle_month` + `week_number` on both tables, proven by querying `information_schema.columns` directly
(never the ledger). A session believing it would re-apply a shipped migration. (2) *An unclosed `~~`
swallows the rest of the file.* One correction here opened a strikethrough on a sentence that wrapped
to the next line; caught before writing. **Assert `~~` count is EVEN in every file you touch** — that
check is cheap and it is the only corruption this method can cause.

**Bucket 3 was ~90% of the hits and correctly left alone**: dated shipping records naming
`phoenix-workforce.vercel.app` or a `phoenix-hr-00127-ded` Cloud Run revision. Those are history and
rewriting them destroys the record.

**This file's own example list has aged.** `hr-notification-emails-dropped-cloudrun` is named above as
an unfixed open action aimed at `gcloud` — it was **rerouted to Railway on 2026-08-23**, and the action
now correctly says so. It remains genuinely open as an owner decision (who receives HR notifications),
which is a different thing from being mis-targeted. Re-verify the examples in a methodology memory
before citing them; they are claims too.

## 2026-09-04 sweep — a fourth confirmation, and the store is now structurally clean

Swept all 973 files by claim across 8 assertions (both dead Supabase refs, gcloud/Cloud Run as a
target, Vercel as a target, deploy-cron cadence, `check:harden`, the required-check count,
`strict:true`, `preview-smoke`). **125 hits already carried a correction banner and 73 were dated
records — the prior sweeps hold up.** Narrowing to dead infrastructure inside *imperative* guidance
cut 82 raw hits to 14, of which 13 were either already bannered `SUPERSEDED — history only` or were
a memory legitimately naming a dead ref because the dead ref is its subject.

**Exactly one genuine survivor, and it is this file's thesis again:**
[[attendance-agent-x86-com-requirement]] told a session the agent token lives in "Vercel prod" at
`phoenix-workforce.vercel.app`. The agent is **live**, the memory is filed under *the attendance
agent* rather than *deployment*, and it had **no banner at all** — it survived three sweeps for
exactly the reason recorded above. Corrected in place on 2026-09-04 against `Program.cs:74-76`,
which allows only `phoenix-hr.satopharma.com` and the two Railway hosts. Its x86/COM recovery was
**re-verified as still correct** and left untouched.

**Beware the reviewer's own regex.** A first pass reported 82 present-tense assertions; nearly all
were dated records whose line simply lacked a past-tense verb ("`check:harden` green, 436 tests"),
plus files whose banner sat further than 6 lines above the hit. **Two of the "broken links" it
found were a regex character class and a POSIX class**, not links. Widen the context window and
require an imperative before believing a bucket-1 count.

**Also repaired the same day, separately from any claim:** 15 permanently unresolvable
`[[wikilinks]]` — 4 slugs written with a `.md` suffix, 4 source paths and 4 doc sections wrapped in
link syntax, 2 slugs that had drifted, and one truncated with an ellipsis
(`[[closing-channel-rollup...]]`), which broke the link and the no-ellipsis rule at once. The 31
remaining unresolved links are deliberate forward references and were left alone; several of them
point at facts that live in `AGENTS.md` as hooks rather than as memory files, so they can never
resolve by design.

### The class every previous sweep missed: a DESCRIPTION frozen mid-flight

Sweeping by claim still missed a whole category, and it is the largest one found to date — **17
files corrected in a single pass, against the 1 the infrastructure sweep found in 973.**

The shape: a memory written while work was in flight says **"PR #1516 open (not merged)"**,
**"Built, validated, NOT committed"**, **"migration still needs separate approval"**, **"awaiting
the owner's ruling"**. Every one was true the hour it was written. Nothing about the sentence is
wrong, badly worded, or detectable by any test — it is simply **read in the present tense forever**.

**Why the earlier sweeps could not see it.** They looked for a memory asserting something false
about the system: a dead ref, a dead platform, a vanished path. Here the memory asserts something
that *was* true. The defect is the tense, not the content, so no lookup table of dead things can
find it. The search is instead: an in-flight status phrase, plus the absence of a resolution.

**Sweep it with the phrases, not the topics** — `not (yet) committed`, `not yet applied|merged|
deployed`, `still needs|requires|pending`, `awaiting|pending owner|pending approval`,
`PR #\d+ .{0,40}open|not merged`, `needs .{0,20}approval`, `ready to merge|will be applied`.
Then resolve each against LIVE state, never against the file: `gh pr view <n> --json state,mergedAt`
settles a PR in one call, `pg_class` settles a table, the filesystem settles a worktree.

**🔴 THE HALF THAT ACTUALLY BITES — fix the `description`, not just the body.** Of the 17, **12 had
bodies that already recorded the resolution in full**, sometimes in a dated section with commit SHAs,
while the `description` still said "open". The description is the only text recalled with no file
around it, so a session reads *"PR #1000 OPEN+GREEN"*, believes it, and never reaches the paragraph
below that says it merged. **A correction appended under a stale description is a correction nobody
reads.** So: append the dated record to the body per the rule above, and *rewrite the description* —
that is not rewriting history, it is repairing the recall key.

**What it was costing.** Three of the 17 were actively dangerous rather than merely wasteful:

- `automated-payroll-non-employees-and-exec-summary` said its production migration still needed
  approval. The table exists on production **with 14 rows** — real people being paid — so a session
  would either re-apply a live migration or tell the owner a working payroll feature is unusable.
- `weekly-module-audit-2026-08-15` said two alias conflicts were **"awaiting ruling, do not change
  either mapping."** The owner ruled the same afternoon and both mappings were changed. Following
  that instruction would have *restored the conflict the audit existed to find.*
- `system-issues-dashboard-gcp-supabase` describes a dashboard half-built on live GCP Cloud
  Logging, which is now dead infrastructure — so its empty panel reads as a bug to debug.

**A stale in-flight line ages into an instruction.** "Do not change either mapping" and "needs
separate approval" are imperatives. Once the situation behind them resolves, they do not become
merely wrong — they start telling sessions to undo the resolution.

**Two calibration notes for the next run of this sweep.**

1. **"awaiting" is a UI string as often as a status.** `actions-center-consolidation` matched on its
   own tab label, *"Awaiting my action"*. Read the sentence before believing the hit.
2. **Relative dates are a non-problem here — do not spend a pass on them.** All 8 hits for
   `this month` / `next month` / `last month` / `in 12 months` were payroll and product
   semantics ("restricted to this month's resignations", "vs last month", "carry to next month"),
   not dangling anchors. **0 genuine defects in 973 files.** The generic advice to convert relative
   time references to absolute dates does not apply to a store written this way.

One file resisted resolution and was marked as such rather than guessed:
`sos-dashboard-rebuild-2026-07-02` names migration `20260702160000`, and no migration in the repo
is dated 2026-07-01..03 at all. **Recording "this could not be verified, check production first" is
a better outcome than picking the likelier story.**

### Description quality: a negative result, and the one real defect under it

**Do not run a description-quality sweep expecting to find much. 90.5% of descriptions are already
claim-shaped**, and the audit's value turned out to be almost entirely in what it ruled OUT.

**Two classifiers in a row manufactured findings, and both times the fault was my own vocabulary.**
v1 scored 84 descriptions as pure LABELs by requiring a verb from a short list — it filed
*"Whoever manages iReports360 CRM **overrides** a resigned employee's account onto their
replacement"* as asserting nothing, because `overrides` was not in the list. v2 widened the list to
~200 verbs and the LABEL count collapsed from 84 to 4 — but v2 was still singular-biased, so plural
predicates (*"sessions **share** the primary working tree"*, *"three sources **disagree** for 7
reps"*) landed in a 93-strong FRAGMENT bucket that was mostly fine on inspection. **A count from a
hand-built linguistic regex is not evidence. Use it to shortlist, then read.**

**The real defect it exposed is narrow, and it is a second dialect of the in-flight-status problem
above.** The earlier sweep hunted `PR open`, `not committed`, `still needs approval`. It could
not see the other half of the vocabulary — a memory describing a MODULE'S PHASE:

    "DESIGN PHASE, no code yet"   "BUILDING"   "BLOCKED on brick coordinate coverage (61.3%)"
    "built 2026-07-05 (worktree, uncommitted)"   "with decisions + ship progress"

**All ten modules carrying one of those are now built and serving in production.** The description
tells a session the thing does not exist yet — so it rebuilds it, or reports it missing to the
owner. Sweep both dialects together: status phrases AND phase phrases.

**🔴 A phase-stale description can hide a stale NUMBER, which is worse.**
`area-unification-42-areas-design` said *"DESIGN PHASE, no code yet"* for a design that is live —
`au.canonical_areas` drives `au.line_area_map` in production. But it also carries **"42 fixed
areas"** in its title and description, and production now holds **50**. The phase error is merely
wasteful; quoting 42 as the live count understates the geography by eight areas. **When a design
memory turns out to have shipped, re-check every figure in it against production, not just its
status.**

**What NOT to touch, or the sweep does damage.** Three shapes match the same phrases and are all
correct:

- `uncommitted` / `WIP` inside a durable lesson — `parallel-session-swarm-hazard`,
  `prove-it-fails-never-git-checkout-the-fix`, `merged-pr-does-not-make-a-worktree-retirable`.
  The word is the subject of the rule, not a status.
- `still PAUSED` in `probation-email-controls-mod1-4` — that is the **owner's standing rule**,
  not stale work.
- `before building any new UI…` — an imperative that happens to contain the word.

**And one trap worth carrying:** searching for a module by its prose name found nothing.
`notification-confidence-gate` returned **0 hits** for "confidence gate" and I was one step from
reporting a live guardrail as missing — the code spells it `notification-confidence`, with a page
and four API routes. **Search the hyphenated identifier, not the English name, before concluding a
feature does not exist.**

**Total for 2026-09-04: 28 memory files corrected** — 17 in-flight statuses, 10 module phases, and
this method file. `MEMORY.md` was not touched at any point (19,521 bytes throughout), so no index
budget moved and the displacement rule never engaged: **every finding had an existing home, which is
what a healthy store looks like.**

### Figures: the sweep that changed real answers, not just wording

**A stale figure is the most quotable kind of stale memory.** A wrong phase wastes a session; a
wrong count gets read out to the owner as a fact about his company. Seven were wrong. The two
sweeps above found writing problems — this one found things that are no longer true.

**Sweep the description AND `MEMORY.md`, for a COUNT OF LIVE ENTITIES with no date anchor.** Not
every number: identifiers, prices, thresholds, versions and PR numbers are stable by nature, and a
*dated* measurement is a record that must never be rewritten. The target is narrow — a number
positioned as "this is how many there are".

**What actually moved, and why the direction matters more than the delta:**

| memory | recorded | live 2026-09-04 |
| --- | --- | --- |
| `brick-coordinates-are-geocoded-guesses` | 34.8% coverage | **83.1%** |
| `field-workforce-…-dispute-attendance` | 54 July candidates | **484**, still all Pending |
| `app-visibility-is-application-scoped-not-rls` | 238 service-role files | **359** |
| `rls-policy-without-an-authenticated-grant…` | 222 of 308 tables | **258 of 326** |
| `au-schema-is-the-org-sos-linkage` | 42 areas | **50** |
| `reps-who-never-appear-in-any-salary-record` | 13 reps | **18** — but the risk HALVED |
| `activity-events-hr-id-is-mixed-case` | 3% lowercase | **20%** |

**🔴 Two of these were stale in the dangerous direction — the one that makes you act wrongly.**

- `brick-coordinates` said coverage was **34.8%**. It is **83.1%**. Quoting the memory would have
  told the owner two thirds of his territory map is unusable when one sixth is. Under-reporting is
  not the safe error: it invites a rebuild of something that already works.
- `reps-who-never-appear` said **13 reps unpaid**. The count is now **18** — and the number of
  people who actually worked and were never paid fell from 4 to **2**. The headline moved one way
  while the risk moved the other, so the raw count is worse than useless: **it must be split by
  hire date against the newest batched month.**

**🔴 And one was stale by DELETION, which is the worst shape of all.**
`field-workforce-pending-deductions-dispute-attendance` told a session to check
`field_workforce_compliance_decisions`. That table now holds **0 rows** — the pipeline moved to
`deductions_candidates` + `deductions_decisions`. **An empty table reads exactly like a resolved
risk.** The risk is not resolved: 484 July no-activity candidates across 62 employees, every one
`Pending`, and no publication has ever been made. **When a memory names a table, re-check that the
table still holds the data before trusting a zero from it.**

**Anchor a figure rather than chase it.** `crm-contact-100000` said "99 reps across 511
addresses"; today it is 91 and 529. Nothing about the rule (*exclude the catch-all*) depends on
either. Rewriting exact counts that drift every month is a treadmill — restate them as a magnitude
("~90+ reps, 500+ addresses"), and the description stops going stale without losing its force.

**Do not report a figure stale until you have measured it the way it was measured.** Four
candidates were dropped for this, and two of them nearly became findings:

- `source_of_sales_customer_map.area_code` — the memory's 12,765 comes from re-resolving each
  ADDRESS against the new master. A `brick_id` join answers a *different* question (866). Not
  comparable, so not stale.
- `applying-for-is-derived` — "Applying for" is derived from **seven** sources at read time.
  `applied_for_job_title` is one of them (430 empty), never the answer.
- `cns-closing-35-areas` — read **0** until I noticed `line_code` is lowercase (`cns`). The real
  answer is 35 areas in 6 regions: **exactly right**.
- `telegram-reaches-only-two-accounts` — read **0 linked** until I used the correct status,
  `connected`. Exactly **2**: `a-9` and `B-10`. Exactly right, and the store already warns that
  [[connected is not linked]].

Three of those four false alarms were my own filter, not the data. **Check the vocabulary — the
casing, the status name, the column — before concluding a memory is wrong.**

**A verification harness can also cry wolf.** The patch script verified each edit by re-finding a
witness slice of the body; it reported FAIL on
`activity-events-hr-id-is-mixed-case-not-lowercase`, which was in fact patched perfectly. That one
file is **CRLF** while the rest are LF, and the witness was normalised on read (`split(/\r?\n/)`)
then compared against the raw file. Same family as the MSYS `\r` trap: **a failing check is a
claim too, and needs proving before you act on it.** `diff` against the backup settled it.

**Total for 2026-09-04: 35 memory files corrected** — 17 in-flight statuses, 10 module phases, 7
figures, and this method file. `MEMORY.md` moved for the first time all day, and DOWN:
19,521 → **19,513 bytes**, because the one index hook that was wrong ("13 reps have NO salary row")
was replaced by a shorter, truer one. The displacement rule was enforced in the script rather than
remembered — it refuses to write an index that grew.

⚠ **One correction could NOT be applied and is still live.** `AGENTS.md` §2.1 carries the same
"222 of 308 tables" figure, and it **auto-loads on every request**. It is a repo file and another
session was active in the working tree, so it was left untouched. **It still needs the owner.**

### 🔴 The sweep's own finding needs the sweep's own discipline

**I corrected six memories for stating things production disagreed with, then published a seventh
finding that production disagreed with.** Worth keeping, because the failure was structural, not
careless.

Re-measuring `brick-coordinates-are-geocoded-guesses` showed 93 centroid rows marked `success`
sitting on 43 shared pins, against a memory that said the code "cannot regenerate" a shared pin. I
wrote it up as 🔴 *the guard is leaking*, with a worst case of سنورس (Fayoum) stacked onto Damietta,
350 km apart. **Every part of that was wrong:**

- The rule was **deliberately relaxed** on 2026-08-02 — a pin is demoted only if it spans different
  AREAS or carries more than 4 bricks, because sibling bricks subdividing one district legitimately
  share a pin. The code carries the reasoning in a comment. **I diagnosed a defect without reading
  the writer.**
- The count came from `geo_locations` alone. **Joined to the live brick table it is 13 pins / 32
  rows, none violating the rule** — the rest are orphan rows whose brick no longer exists.
- سنورس there is `B207-17`, area **D26, Damietta**. I read the Arabic name, recognised a Fayoum
  town, and never asked the brick table — the exact error already recorded in
  [[address-matching-beats-paid-ai-and-geocoding-hurts]].

**Three rules come out of it, and they are the same rules the sweep applies to everything else:**

1. **A DEFECT is a claim too.** I checked "is this figure still true?" against production four times
   and dropped four candidates for failing it. I did not apply that test to my own finding.
2. **Measure the population the decision is about.** A count over a raw table is not a count over
   live entities. **Join before you quote** — the same discipline as the `active` brick filter and
   the `src` vs `src+app` grep scope earlier in this file.
3. **Read the writer before calling the write wrong.** The invariant had not broken; it had been
   replaced, on purpose, with better reasoning than the original.

**A false 🔴 is more expensive than a stale figure.** A stale number gets re-measured; an alarm gets
acted on. It was corrected in place the same session, before anyone read it — the section was
twenty minutes old and no decision had been taken on it, so replacing it beat appending a
contradiction underneath a red flag that a future session would read first.

## 2026-09-05 — the sixth angle: a POINTER is not a claim, and no previous sweep could see one

The five angles above all sweep **assertions** — a dead ref, a stale status, a phase, a figure, a
description. This one sweeps **pointers**: the file paths a memory tells a session to go and read.
A path is not a claim about the world, so nothing in the earlier method finds it, and a memory whose
every sentence is true can still send a session to a file that is not there.

**Method, and it is cheap.** Extract every backticked repo-shaped path from all 983 files
(`` `…/….ts|tsx|mjs|sql|css` ``), unique them, and test each with `[ -e ]` from the repo root:

    943 distinct paths named · 195 do not exist · 57 of those fully qualified (src/ app/ tests/)

Ignore the bare-prefix hits (`crm/…`, `notifications/…`) — those are relative fragments of longer
paths, not misses. **The fully-qualified set is the whole finding.**

Full triage: **66 (memory, dead-path) pairs across 44 memories.** Filtering to files carrying no
deletion/banner vocabulary anywhere left **12 to read by hand** — the other 32 had already recorded
the deletion. Of the 12, **9 were dated build or change records** (bucket 3, left alone), **1 was a
false positive** (below), and **2 were real.**

**The first real one, and it is this file's thesis for the sixth time.**
[[the-old-monthly-closing-export-is-never-touched]] — a 🔒 golden rule, in the index, quoted in
`AGENTS.md` §4 — carried a **How to apply** line pointing at `src/lib/sales/premium-closing-export.ts`,
which does not exist and appears never to have. The real builder is `src/lib/sales/closing-engine-fill.ts`
(`fillClosingEngine`, 1,893 lines), found from the route's own imports rather than by guessing a name.

**Why that one mattered more than a broken link normally would.** The rule says *never touch the old
export; new capability goes in the premium one beside it.* A session obeying it looks for the premium
module, finds nothing, concludes the "beside it" option does not exist — and is pushed toward editing
the original. **The dead pointer inverts the rule it is attached to.** The rule was perfectly worded
and perfectly wrong to follow.

### 🔴 The second real one is a WORSE shape: a dead path that claimed a GUARD

[[portal-responsive-data-list-renders-every-row-twice]] said the rule *"windowing is display-only —
search, sort, filter and the xlsx export must keep spanning the full `rows` prop"* was backed by
`tests/crm-doctor-coverage-pagination.test.ts`, which "has an assertion for exactly that."

That file was deleted with the Rep Doctor Lists board it covered (PR #2938) — correctly, since the
board went. **What went with it was the only test naming the invariant.** Measured:
**0 tests reference `PortalPagination`**, while **6 files under `src`/`app` still use it.** The rule
is now enforced by nothing. (11 tests match `PAGE_SIZE`; none was confirmed to assert the export
spans the full rows, and that count must not be read as coverage.)

**A dead pointer wastes a session. A dead pointer that names a TEST removes a session's reason to
check.** It reads as "this is covered, ship it". So when a sweep finds a dead path, ask what the
sentence was doing: naming a file to read is a broken link; naming a test is a **withdrawn
guarantee**, and it should be graded like a missing guard rather than a typo. Both survivors here
sat in imperatives — one in a **How to apply**, one in a coverage claim.

**Everything else was correctly handled history, and the store looks good.**
[[crm-month-over-month-does-not-compare-the-same-reps]] names three deleted files and carries a dated
banner naming PR #2938 — model bucket-3 work. `hr-approval-authority` and
`direct-order-request-module-build` name `src/lib/offers/approval-chain.ts` and
`computeRequiredApprovers`, both genuinely gone (**0 hits, against a positive control of 533 files for
`assertPermission`** — this repo's blank-result trap makes an unverified 0 worthless). Both are dated
change-records, so both were left alone.

### The richest seam was the one I nearly discarded: MIGRATION paths

138 of the 195 misses were not fully qualified and I dismissed them as relative fragments. **That
dismissal was 104/138 correct and would have buried the best finding** — check it, because this
file's own repeated lesson is that the reviewer's filter is the defect. Of the 34 that resolved to
nothing, ten were `supabase/migrations/*.sql`, and they split three ways:

- **8 were simply ARCHIVED.** Every one is dated on or before 2026-07-11 and sits in
  `supabase/_migrations_archive/pre-baseline-2026-07-11/`. A migration path that "does not exist" is
  usually this. Check the archive before calling one missing.
- **1 was applied under a different filename.** `20260706120000_payroll_copilot_tables.sql` exists in
  neither place, yet production carries **5 live `payroll_copilot_*` tables** with their indexes.
  Exactly §2.1's re-stamping: *the ledger version never matches the filename.*
- 🔴 **1 was never applied at all.** `20260711180000_resolved_issues.sql` — no file, no archive
  entry, and **`pg_class` returns nothing** for `%resolved_issue%` on production.

**So a missing migration file is worth THREE different verdicts, and the file system cannot tell
them apart.** Only `pg_class` can, which is why §2.1 forbids trusting the ledger. Resolve every
missing migration against production before writing anything down.

**The last one is the shape to fear.** [[system-issues-dashboard-gcp-supabase]] describes the
`resolved_issues` table as built, append-only, with `MAX(resolved_at)` reopen semantics — and it was
genuinely verified live *on staging*, which the memory says plainly. It never reached production.
Meanwhile the dashboard itself is thoroughly live (12 files) and computes resolution state in
`derived-status.ts`, reading only four tables, none of them a resolutions table.

**A documented-but-absent table invites the worst possible repair.** The instinct on finding one is
to re-apply its migration — which would bolt a write path onto a feature that neither reads nor
maintains it, next to a derived implementation that already works. **"Documented as built" and
"verified on staging" are both compatible with "absent from production".**

**Calibration for the next run of this angle.**

0. 🔴 **CHECK WHICH REPO THE MEMORY IS ABOUT BEFORE TESTING ITS PATHS.** The single false positive
   was mine, not the store's. [[new-system-decision-2026-08-17]] names
   `tests/law/plan-sheet-is-current.test.ts` and `npm run plan:build`, neither of which exists in
   Phoenix — because that memory is about **`E:\New`, a different repository**. Both exist there
   (the test is 22,679 bytes; `plan:build` is in that repo's `package.json`). **This store holds
   memories for more than one project, so `[ -e ]` from the Phoenix root is the wrong instrument for
   any of them** — and the failure is silent and confident, since a real path in another repo looks
   exactly like a deleted path in this one. Same family as the four false alarms recorded above:
   *three of those four were my own filter, not the data.*
1. **Test the FUNCTION as well as the file.** A rename moves the path but keeps the export; a
   deletion takes both. `git grep` the identifier before concluding a feature is gone — and always
   with a positive control, because a wrong pattern and an absent symbol are the same blank.
2. **`| head` destroys the exit code.** `git grep -l … | head` exits 0 whether or not anything
   matched, which reads as "found, but nothing printed". Count files instead.
3. **Weight by what the memory is FOR, not by how many paths it breaks.** The build records named
   the most dead paths and were the least dangerous. The one that mattered named a single path,
   inside an imperative, in a rule the owner had stated twice.

**Also resolved today, and it closes the ⚠ left open above.** The 2026-09-04 sweep could not correct
`AGENTS.md` §2.1's "222 of 308 tables" because another session held the working tree, and flagged it
as still needing the owner. It reads **"258 of 326, 2026-09-04"** as of today — fixed by someone in
between. **That flag had itself become a stale in-flight status**, the exact class this file was
extended to catch: a sweep's own leftover note ages into a task that no longer exists. **Re-verify an
outstanding ⚠ before acting on it, including one this file wrote.**
