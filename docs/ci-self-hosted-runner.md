# CI on a self-hosted runner

Why this exists, how to turn it on, how to turn it off, and the rules that keep it safe.

## The measurement that motivated it

Measured 2026-09-27 against the live account and the Actions API:

🔴 **THE INVOICE IS THE ONLY AUTHORITY ON THE MONEY, AND MEASURED MINUTES MUST NEVER BE CONVERTED
INTO ONE.** On 2026-09-27 a session measured every job of the month, multiplied by GitHub's published
$0.008/min, and reported **~$559** for September. The owner's answer: *"I never paid this value. The
maximum value I paid is the September value"* — **$300.88, the highest Actions invoice he has ever
paid.** The invoice is real money; the derivation was arithmetic on top of an assumed rate and an
assumed allowance. **The invoice wins.**

**The gap is roughly 2x and is NOT explained.** Three candidate causes were tested and all three
failed, so do not re-run them: queue time inside a job's `started_at` accounts for only **2.6%**;
**zero** jobs of 25 September ran on a self-hosted runner (all 1,235 were GitHub-hosted); and
excluding zero-duration skipped jobs changes nothing. Even billing the raw unrounded wall clock
(2,615 min that day instead of 3,230) still lands well above the invoice. The rate that would
reconcile is ~$0.0043/min, almost exactly half the published Linux rate — which points at a plan
allowance, a spending cap or a discount that **cannot be read from here: the billing endpoints need a
`user` token scope no session has.**

🔴 **So the rule is: measure MINUTES, report MINUTES, and anchor every dollar to the invoice.** A
session that converts minutes to money will overstate it and be contradicted by the owner, who is the
only one who can see the bill.

| | |
| --- | --- |
| **September invoice — the anchor** | **$300.88** (owner, the most ever paid) · August $240.77 |
| Measured billable job minutes, 25 Sep, `ci.yml` | **3,230** (3,624 across all workflows) |
| `ci.yml` runs, 09-01..09-26 | **4,304** (2,657 `pull_request` · 1,647 `push` · ~8 dispatch) |
| Billable minutes per full run | **14** before #4527 · **10.9** after |
| **Owner's target** | **$60/month TOTAL** — not a $60 saving (owner, 2026-09-27) |

**The minute measurement is reproducible and internally consistent** — a model built from real
per-day run counts predicts 3,233 billable `ci.yml` minutes for 25 September against **3,230
measured**, and 3,628 across all workflows against **3,624**, 0.1% out on both. Trust it for
*ratios*, which is what it is for. Never for a monthly total.

14 billable minutes for 4m33s of wall clock, because **GitHub bills each job separately and
rounds every job UP to a whole minute** (measured on run `36277556391`: validate 273s→5,
typecheck 196s→4, test 139s→3, lint 50s→1, mobile 8s→1).

GitHub charges **$0/minute for self-hosted runners** — you pay only for the machine. That is a fixed
cost which does not climb with the commit rate, against a metered one that does.

🔴 **BUT CAPACITY IS SPENT IN RUNNER-SECONDS, NOT IN BILLABLE MINUTES, AND THE TWO ARE 35% APART.**
This document previously concluded that one ~$12 8 GB VPS "covers 37,610 outright" by comparing
billable minutes against a machine's wall clock. They are different quantities: GitHub's ceil-per-job
rounding inflates what it CHARGES above the work actually done, while a self-hosted box owes only the
work. Measured over every job of 25 September: **3,858 billable minutes against 2,850 runner-minutes
of real work — 35.4% of the bill is rounding.** That gap is exactly where the saving comes from; it is
also why the capacity sum must use the smaller number.

At September's average volume with post-#4527 per-run cost, real demand is **~1,650 runner-minutes a
day**. A 2-vCPU box supplies 1,440 a day *at 100% utilisation, serially* — which no CI runner reaches,
because a run wants its four jobs concurrent and peak days are twice the average. So the honest
requirement is **two to three boxes, not one**, and the ~$12 single-VPS figure was never achievable.
Two 4-vCPU instances give **8 concurrent job slots**, which is the shape that matters: ~4 slots
covers steady demand, so 8 leaves roughly 2x headroom and turns a 6-run burst from about half an hour
of queueing on three slots into about ten minutes.

🔴 **CORRECTED 2026-09-28 — THIS PARAGRAPH CARRIED THE COST AT ~€27/MONTH FOR THE PAIR, AND THE ORDER
TABLE BELOW SAYS ~€35.49 EACH.** That is **~€71/month**, a 2.6x understatement, in the one paragraph
someone would decide the purchase on. It is almost certainly the pre-increase price: Hetzner's rose
about 170% on 15 June 2026, which is why the order table already says to re-read rather than trust it.
**I could not confirm a current figure** — hetzner.com renders its prices client-side, so the public
page yields nothing readable, and the authenticated console is the only authority. **Read the price in
the console before buying; treat both numbers in this file as stale.**

The second figure was wrong in a quieter way. "~11,500 runner-minutes a day of headroom" is 8 slots x
1,440 minutes — the theoretical ceiling at 100% utilisation, which the sentence two lines above says no
CI runner reaches. Usable is more like 7,000-8,000, against demand of ~1,650. The conclusion does not
change; the word "headroom" for a ceiling is what made it read as spare capacity.

🔴 **AND THIS IS THE ONLY LEVER THAT REACHES THE OWNER'S $60/MONTH TOTAL.** Against the $300.88
invoice, $60 is an **80% cut**. #4527's per-run saving is 16.5%; driving re-pushes from 1.61 runs per
PR to a perfect 1.0 adds ~20% more; together they land near $190, not $60. **No combination of
pipeline tuning and push discipline gets there** — only taking the per-minute price to $0 and paying
a fixed machine cost instead, which two 4-vCPU boxes do at roughly half the target. Say that plainly
rather than offering another trim. 🔴 **But this is arithmetic, not a recommendation: the owner
refused that purchase on 2026-09-28 (*"I WILL NOT BUY THIS"*).** It stands as the reason $60 is out of
reach on metered minutes, and never as a case for buying the boxes.

**This is a separate lever from [#4527](https://github.com/Gawish-1997/phoenix-people-workforce/pull/4527)**,
which merges `lint`+`typecheck`+`test` into one job and cuts ~14% off every run. They compose:
fewer billable minutes per run, and those minutes billed at $0.

## Why the volume is what it is

The pipeline is already tuned close to its limit. **The spend is driven by how many times it runs,
and that is self-inflicted by how agent sessions ship.** Measured 2026-09-27:

| | |
| --- | --- |
| Pushes to `main`, 7 days | **338** (~48/day) — each a full CI run |
| PRs merged, 7 days | **≥100** (query capped at 100) |
| PRs touching **≤3 files** | **41%** |
| PRs changing **≤50 lines** | **23%** |
| Billing per shipped change | **~28 billable minutes** (≈14 on the PR + ≈14 on the merge to `main`) |

A three-file change costs the same ~28 minutes as a three-hundred-file one, because billing is
per-job-rounded-up, not per-line. `AGENTS.md` §0 records the shipping pattern — "~46 commits/day,
6.7 files per commit" — as a neutral fact about how this repo is run; at $0.008/minute it is also
the single largest line in the bill.

**The rule this produced** (owner, 2026-09-27: *"you make many prs and many merges you can wider the
contact of the pr to make less merges"*) is in `AGENTS.md` §6 under Git hygiene: batch related work
into one branch and one PR, and push fixups in fewer, larger commits — concurrency cancels
superseded PR runs, so two pushes a minute apart bill twice and verify once.

Still split when the parts need **separate approval** (a migration, a locked file, a protected rule)
or when one part is urgent and the rest is not. Never split merely because it reads tidier.

This composes with everything below: fewer runs, each cheaper (#4527), each billed at $0 (the
runner).

### 🔴 A feature arriving in instalments is still ONE feature — owner, 2026-09-29

*"batch the next feature into one PR, not six"*. This is the second ruling on the same bill, and it
exists because the first one did not bite: the rule above says **batch related work**, and a session
can satisfy it honestly on every single PR while still shipping a feature in six pieces — because
each piece really was one coherent change when it was asked for.

**The arc that produced it, measured.** The one-press seat hire, all on 2026-09-29:

| PR | Merged (Cairo) | Files | Lines |
| --- | --- | --- | --- |
| #4723 an open seat opens Add Employee already filled in | 12:12 | 10 | +454/-6 |
| #4727 the same one-press hire on every open report row | 12:22 | 4 | +97/-1 |
| #4731 the one-press hire on the portal page | 12:41 | 5 | +175/-10 |
| #4736 a seat hire can pick the candidate from recruitment | 12:54 | 5 | +529/-3 |
| **#4740 pins this very rule** | **13:31** | **3** | **+34/-1** |
| #4743 the SFE can download a CV from the seat popup | 14:41 | 1 | +58/-1 |
| #4746 a greyed "No CV on file" on a seat holding none | 15:18 | 4 | +334/-48 |
| #4748 carry a candidate CV onto an already-hired employee | 15:53 | 6 | +783/-5 |

🔴 **The rule was pinned at 13:31 Cairo and the splitting carried straight on through it** — three
more that afternoon, then five more that evening on the same offer→seat→hire chain (#4751 18 files,
#4761 11, #4772 1, #4783 4, #4787 5). **A rule in `AGENTS.md` did not change the behaviour**, which
is why the hook now names the specific shapes to hold: the same mechanism on another surface, a
follow-up named in the same breath, and a pin of a ruling just given.

**Why it keeps happening — two mechanisms, only one of them obvious.** The owner asks for surfaces
one at a time, because that is how the need occurs to him; each request genuinely reads as its own
small change. The second is avoidable and is the real defect: **a new PR gets opened rather than
widening one that already carries his `merge <n> when green`**, out of a misplaced reluctance to
touch an approved PR. That reluctance is now explicitly overruled — widening a PR his approval sits
on is allowed, provided it is said plainly and he is given the chance to re-confirm.

**What one merge actually costs, measured on #4787 rather than assumed:**

| Run | Billable |
| --- | --- |
| PR `ci.yml` (checks 5.40 → 6, validate 4.92 → 5, mobile 0.17 → 1) | 12 |
| PR secret-scan | 1 |
| `main` CI on the merge commit | 12 |
| **One merge of a 5-file PR** | **25 billable minutes** |

That confirms the ~28 figure above from live data, and it is per *merge* — the file count changes
nothing, because every job is rounded up to a whole minute.

🔴 **Every `secret-scan` row in this section and the next is a run that can no longer happen — read
them as history, not as today's bill.** #4787 merged 2026-09-29 17:05 UTC and #4800 took
`secret-scan` off `pull_request` at 19:14 UTC the same evening, so `security-scan.yml` now fires
only on its daily 05:17 UTC schedule and on dispatch. A pull request runs `ci.yml` and nothing else
(verified on #5005, 2026-10-01: one workflow run on the head). Subtract those minutes and the same
merge today is **24**, the branch below **38**, **50** in all. The point the measurement was taken
to make — the cost is per *merge*, not per file — is untouched.

🔴 **And the fixup half is worse than the merge half.** Every run on `codex/col-agreement`, the
branch behind #4787:

| Head | Workflow | Result | Billable |
| --- | --- | --- | --- |
| `6038b494f` | CI | **failure** | 9 |
| `b56dc2ab7` | CI | cancelled by concurrency | 5 |
| `c941994dc` | CI | **failure** | 12 |
| `dbc065145` | CI | success | 12 |
| (4 × secret-scan) | | success | 4 |
| | | **branch total** | **42** |

**54 billable minutes with `main`'s own run — for one 5-file PR whose clean cost is 25.** The
concurrency cancel worked exactly as the rule above promises, saving ~7 minutes on one push. But
**21 minutes went on two full red runs**, and both reds were defects a local run of the *one*
failing test catches in seconds: a test reading a property the type does not have (invisible locally
because the suite strips types rather than checking them), and a line shape the heredoc-backslash
sweep rejects. **Running the specific failing test locally is not "a local full validation" and is
not banned by §7** — it is the cheapest thing in this document.

**What counts as one feature**, operationally: if the next instruction is plainly the same mechanism
on another surface, a follow-up named in the same breath, or a pin of a ruling just given, it is the
same feature — hold it, and say in one line that you are holding so he can override. Splitting stays
right when the parts need **separate approval** (a migration, a locked file, a protected rule) or
when one part is urgent and the rest is not.

**Never convert these minutes into a monthly bill.** Doing that overstated September by roughly 2x;
the invoice is the only authority and the owner read it as **$300.88**. Measure minutes, report
minutes.

### 🔴 A roll-up must be merged before its members — measured 2026-09-30

AGENTS.md §6 already said not to merge a roll-up's members separately. What it did not say is how
long you have, and the answer turned out to be **about three minutes**.

**The arc, all on 2026-09-30, Cairo:**

| | |
| --- | --- |
| 12:59 | `rollup-prs.mjs` names #4910 + #4909 + #4907 — 3 merges → 1, ~56 billable minutes |
| ~13:16 | `--apply` builds it, #4911 opens, and **a comment is left on each member** warning it off |
| 13:17:55 | **#4910 merged separately** — 90 seconds later |
| 13:18:55 | **#4909 merged separately** |
| 13:2x | #4911's `validate` passes and `checks` goes red — on #4907's *own* typecheck, byte-identical on its own run |
| — | #4911 closed: one unmerged member left, so it replaced no merges. One CI run spent, none saved |

That morning #4814 had already gone the same way, four minutes after roll-up #4821 was built and
commented on. **Three members lost across two roll-ups in one day.**

**So the comment is a courtesy, not a guard.** Three sessions were each told in writing on their own
PR and each merged anyway — not carelessness: a session reads its PR as green and its instruction as
"merge it", and a comment is not something GitHub enforces. Nothing available makes it one.

**What follows, and why it is NOT "wait for green".** An earlier reading of this day put the window
at about ten minutes and concluded a roll-up should be built once its members went green. That is
backwards — by the time they are green they are minutes from being merged. Build it the moment the
tool names one and put it to the owner in the same turn; `--apply`'s own 25-minute members-checks
wait, added the same day, already covers the risk of building over an unfinished member, so there is
nothing left to wait for.

🔴 **And if the members land first, close the roll-up — never merge it.** It then replaces no merges,
and its files are byte-identical on `main`, which is the `carried` verdict: merging is an empty
squash paying a full `main` run to ship nothing. `--settle` is the right ending, and
`tests/rollup-prs.test.ts` §4b exists because the script once proposed rolling an already-carried PR
up a second time.

**The day did end with the mechanism working.** At 16:01 another session's roll-up, #4917, carried
two PRs cleanly and `--settle` closed the originals 55 seconds after it merged. The difference was
the members-checks wait landing in between.

### 🔴 The second shape: the member goes green INSIDE the wait, and the owner's approval is already in hand — measured 2026-10-01

Everything above is about a session merging a member it was told not to. This one is not
carelessness and no comment could have caught it, because **the roll-up PR did not exist yet**: it
was still inside `--apply`'s own 25-minute members-checks wait. Neither clause in AGENTS.md §6
reaches that window — one says *do not merge a member once a roll-up is **open***, the other says
*build it the moment the tool names one*. Between those two sentences there is a gap of up to 25
minutes, and the owner's approval lands in it by construction.

**The arc, 2026-10-01, Cairo:**

| | |
| --- | --- |
| 05:51 | `rollup-prs.mjs` names #5047 + #5043 — 2 merges → 1, ~28 billable minutes |
| ~05:52 | `--apply` starts; no roll-up PR exists yet, it is waiting on both members' checks |
| 05:52 | the session puts **#5047** to the owner, who answers `merge 5047 when green` |
| 05:55 | #5047 goes green; #5043 is still running, 23 minutes left of the wait |
| 05:56 | **#5047 merged** on that standing approval |
| 05:5x | the roll-up opens as #5048 carrying a member already on `main`; #5043 is merged separately anyway; #5048 closed as `carried` |

**Two merges where the tool had just offered one.** No work was lost and nothing broke — the cost is
purely the bill.

🔴 **The rule, and it is about what the session QUOTES, not about what the owner types.** Once
`--apply` is running, the next-step box must name **the roll-up**, never a member — and a member
going green first is the trigger to *wait*, not to merge. A session that has already quoted a
member's number holds the approval the moment that member goes green, so the only thing standing
between the tool's offer and two merges is whose number was put in front of him. This is the one
guard that works here, because it acts before the approval exists rather than trying to withdraw it
afterwards: the comment on a PR could not help, and neither could `--settle`.

**The honest trade, so nobody over-corrects.** Holding a green member for up to 25 minutes is not
free either — it spends the owner's turns, and his standing rule is that triaging PRs is never his
job. So hold it *silently*: say in one line that a roll-up is building and carry on, rather than
asking him to decide between the two numbers. If the wait expires without a roll-up, the member's
own merge is still there to put to him.

## 🔴 Where the money actually is — and why the run COUNT lies

**Counting runs gives the wrong answer, and a session acted on it.** On 2026-09-27 the owner was told
manual re-runs were "26% of the bill, ~$78/month" because they are ~26% of the *runs*. They are
**3.9% of the minutes**. The correction matters because the obvious cost lever — "stop re-running CI"
— is worth about **$12/month**, not $78, and chasing it would have cost more effort than it saved.

🔴 **AND A SAMPLE LIES TOO.** The shares below were first measured over 240 runs and were wrong by
enough to matter. These are counted from **every run of 09-01..09-26**, per event, with per-run cost
measured over a full day:

| trigger | runs | share of CI minutes | avg billable min/run |
| --- | --- | --- | --- |
| `pull_request` | 2,657 | **60.5%** | 12.8 |
| `push` to `main` | 1,647 | **39.5%** | 13.5 |
| `workflow_dispatch` | ~8 | **~0.0%** | 1.2 |

Dispatch is a **rounding error** — not the 3.9% a sample showed, and certainly not the 26% a run count
showed. September holds about eight of them in total.

🔴 **The trap that produced every wrong figure in this document: the Actions runs API caps at 1,000
rows and truncates the OLDEST silently.** Four separate wide queries came back with *exactly* 1,000
rows and looked like complete months. Count the rows; if the answer is exactly 1,000, narrow the
window and query again.

**`ci.yml` is 89.1% of the whole Actions bill** — 3,230 of 3,624 billable minutes across every run of
every workflow on 25 September, a full day rather than a tail of recent runs. Security Scan is 6.3% at
1.3 min/run, Synthetic Journeys 2.1%, everything else under 1.5% each. **Nothing outside `ci.yml` is
worth touching.**

Two more facts that close off the obvious ideas:

- 🔴 **1.61 CI runs per PR, and 1,652 PRs in 26 days — THE LEVER IS THE 1,652, NOT THE 1.61.**
  Counted over the whole month: 2,657 `pull_request` runs across **1,652 distinct branches**. The
  earlier "2.18 runs per PR" came from a 50-branch sample and overstated the re-push waste; on
  2026-09-27 the measured figure was **1.27**, close to the floor of 1.0. So push discipline is
  nearly exhausted as a saving: driving 1.61 to a perfect 1.0 would reclaim ~$103/month and demands
  that no PR ever gets a second push. **Sixty-four PRs a day is the actual cost driver**, which is
  what the ONE WIDE PR rule attacks — batching five narrow PRs into one saves four PR runs *and*
  four `main` runs, roughly ten times what a re-push costs.
- **`main` gets exactly one run per commit** — 51 commits, 51 runs, zero duplicates. No waste there.

🔴 **And `main`'s 39.5% is no longer waste at all — it is the price of the production deploy gate.**
Railway's Wait for CI reads the check suites on the pushed commit, so removing `push: main` from
`ci.yml` to save that ~$197 would silently un-gate production. See [deployment.md](deployment.md),
"The deploy gate". **That leaves the runner as the only lever that cuts the bill without cutting
safety** — which is the whole argument of this document.

### Reproducing the measurement

GitHub's own `/timing` endpoint returns `{"billable":{}}` while an account is payment-restricted, so
these figures were computed from per-job wall clock with **ceil-per-job** applied, the way GitHub
charges:

```bash
gh run list --workflow=ci.yml --limit 240 --json databaseId,event \
  --jq '.[] | "\(.databaseId)|\(.event)"' |
while IFS='|' read -r id ev; do
  m=$(gh api "repos/Gawish-1997/phoenix-people-workforce/actions/runs/$id/jobs" \
    --jq '[.jobs[] | select(.started_at != null and .completed_at != null)
           | ((.completed_at|fromdateiso8601) - (.started_at|fromdateiso8601)) / 60 | ceil] | add // 0')
  echo "${m:-0}|$ev"
done | awk -F'|' '{s[$2]+=$1; n[$2]++; t+=$1} END {for (e in s) printf "%7d min %5.1f%% %3d runs %s\n", s[e], 100*s[e]/t, n[e], e}'
```

The sample window is short — 240 runs was ~27 hours on that day. **Trust the shares, not a monthly
projection from them**, and anchor the money to the real invoice.

## 🔴 THE DECISION: the runner goes on Railway — owner, 2026-09-27

*"Railway's own compute maths came out around $95/month ok accepted."* So the host is a Railway
container, not the owner's laptop and not a rented VPS.

**The arithmetic, with its assumptions attached — this is an ESTIMATE, not a quote.** Railway's
published standard-compute rates, converted from per-second, billed on actual usage rather than
allocation:

| | rate | per month |
| --- | --- | --- |
| memory | $0.00000386 / GB / sec | **$10.14 per GB** |
| vCPU | $0.00000772 / vCPU / sec | **$20.29 per vCPU** |

Workload, corrected to measured runner-second demand rather than to billable minutes:
**~1,650 runner-minutes/day ≈ 835 busy hours/month** at September's average volume. At ~2 vCPU and
~4 GB while busy: ~$44 CPU + ~$44 memory + ~$8 idle across replicas ≈ **$95** — but that buys ONE
box's capacity, and the section above establishes the requirement is two to three. 🔴 **At ~$95 per
box Railway does NOT reach the owner's $60 total, and two of them are three times it** — a flat-rate
VPS does, which is why the comparison matters and why Railway's metered compute is the wrong shape for
this job even though it is the platform already in use.

🔴 **MEMORY WAS THE ASSUMPTION NOBODY HAD MEASURED, AND THE FIRST REAL ATTEMPT FAILED ON IT.** A
Railway-hosted runner rollout on 2026-09-27 (`CI_RUNNER=self-hosted`, set 20:01:18Z) failed `validate`
reproducibly on two different runners, in the Build step, with an identical signature:

    OS can't spawn worker thread: Resource temporarily unavailable (os error 11)
    fatal runtime error: failed to initiate panic, error 5, aborting

Runs `36346183612` and `36346466953`; the failing **jobs** inside them are `108695670880` and
`108696483287`. 🔴 **Those two were labelled "job ids" here until 2026-09-28, and that mislabel costs
real time: `gh api actions/jobs/36346183612/logs` returns EMPTY with no error**, which reads as "the log
expired" rather than "wrong id". A second job on that rollout printed every test as PASS and
then took `The runner has received a shutdown signal`, which is a replica cycling mid-job, not a test
failing. Rolled back with `gh variable set CI_RUNNER --body ubuntu-latest` at 20:04:38Z; set it
explicitly rather than deleting it, so the repo variables still read safe.

🔴 **THE HEADING ABOVE AND THE SENTENCE "SO THE ~4 GB FIGURE IS TOO LOW" WERE BOTH MINE, AND BOTH ARE
WRONG — MEMORY IS NOT IMPLICATED AT ALL.** I read `os error 11` as a memory/pids cap and passed that on
before looking at the rest of the log. The build **succeeds**; the abort comes afterwards, and the line
before it names the real cause:

```
✓ Compiled successfully in 40s
Collecting page data using 47 workers ...
OS can't spawn worker thread: Resource temporarily unavailable (os error 11)
```

`next build` sizes that worker pool from the CPUs it can **see**, which inside a container is the
HOST's count — 47 — not the container's allowance, so tokio asks for 47 threads against a far lower pid
limit and gets `EAGAIN`. **Nothing to do with memory, the image, or the code**, and more replicas would
split the same allowance. Memory therefore remains exactly as unmeasured as the table above says:
neither confirmed nor refuted. **Raising the container's memory would not have fixed this.**

🔴 **AND NO ENVIRONMENT VARIABLE CAN CAP IT.** `NEXT_CPUS` was set on the service and the next run
still printed `using 47 workers`. Read from the installed `next@16.3.3`, `dist/build/index.js:371`
takes the count from `config.experimental.cpus` alone. So the cap lives in `next.config.ts` behind
`PHX_BUILD_CPUS`, and `ci.yml`'s Build step passes it **only** when
`runner.environment == 'self-hosted'` — a GitHub-hosted build keeps the key absent and is byte-for-byte
its old configuration, because capping workers on GitHub's 4-core runners would slow every build here
to buy nothing. Pinned by `tests/next-build-cpu-cap.test.ts`, both guards proved by breaking them.

🔴 **A BROKEN RUNNER ROLLOUT TURNS `main` RED, AND THE DEPLOY GATE THEN CORRECTLY PINS PRODUCTION.**
That is the gate working, but it is invisible until somebody reads it, and Railway abandons the
withheld deployment at the two-hour mark with nothing turning red. On 2026-09-27 two commits were
withheld this way. **Never flip `CI_RUNNER` without watching the first `main` run to a verdict**, and
roll back on the first failure instead of debugging while production is held. Quote the range and the
assumption, never the $95 alone.

### Four constraints, each one evidenced

1. 🔴 **LINUX x86_64, NEVER WINDOWS — the day's most expensive lesson.** The `OMAR-GAWISH` runner was
   Windows/X64 and failed **all three jobs in 18–30 seconds**, because every `run:` step here is bash
   and GitHub's default shell on Windows is PowerShell: `set -euo pipefail` becomes
   `Set-Variable : A parameter cannot be found that matches parameter name 'euo'`. A Railway container
   is Linux, so this is satisfied by construction — it is written down anyway, because the next person
   to stand one up by hand on a laptop will hit it again.
2. **A SEPARATE Railway project, not a service beside production.** The safety rules below already say
   the host has repository-level trust and must be treated as production infrastructure; a runner
   executes whatever any workflow tells it to. The Phoenix project is also where cross-service
   `${{...}}` variable references are the documented pattern. And `superb-smile` demonstrated on
   2026-09-25 exactly what an extra project connected to this repo does when nobody is watching it.
3. **2–3 replicas minimum.** A runner takes one job at a time and the work is ~26.6 h per 24 h day, so
   a single runner queues behind itself — which from the outside is indistinguishable from the
   2026-09-27 startup-failure outage. Pro allows 42 replicas at 24 vCPU / 24 GB each, so this is a
   configuration choice, not a ceiling.
4. **The rollback stays ONE command:** `gh variable delete CI_RUNNER`, or set it back to
   `ubuntu-latest`. **Never hard-code `self-hosted` in a `runs-on`.**

### An open question nobody has settled

Railway now sells **Sandboxes** — in its own words, *"isolated Linux VMs for agents, builds, and
untrusted code"* — billed only while running, at roughly $50/GB-month and $50/vCPU-month while
active. That is the product literally designed for untrusted code, and for a bursty CI load it may
beat standard compute or be far worse, depending entirely on how the idle listener is billed. It
could not be settled from the pricing page, and it has not been guessed at. **Price it before
choosing standard compute, and record the answer here.**

### Who does what

Creating the Railway project and service is a **money move on a production surface — the owner's
dashboard click**, per the standard `docs/devices/headwind-rustdesk.md` §4 sets: *a session prepares;
it does not press.* What is ours is the last step only: flipping `CI_RUNNER` once the runner reads
**Idle**, and reverting it the moment anything queues. 🔴 **Do not flip it while zero runners are
registered** — since the `OMAR-GAWISH` deregistration there are none, and jobs do **not** fall back
to GitHub's: `main` runs would queue for ever rather than fail, which under the production deploy
gate means no deploy at all, silently, until Railway abandons it at the two-hour timeout.

## It is BUILT, and two of the three jobs already pass — 2026-09-27

The owner had it built rather than prepared, overriding this document's own "a session prepares, it
does not press". What existed:

🔴 **THE RAILWAY RUNNER PROJECT IS DELETED — 2026-10-01, at the owner's instruction. Nothing in this
section is infrastructure any more; it is the record of an approach that was tried and closed.** It
had been idle since its pool went down on 2026-09-27 (all three replicas `EXITED`, zero GitHub
registrations) while still billing **171.9 CPU units and 8,726 GB-hours** that cycle — more than the
production app's 110.6 / 1,351 — which is why it went. CI runs on GitHub-hosted runners plus the one
Hetzner box (§4's ruling); the box is a preview machine, and `phoenix-ci-ubuntu-8gb-nbg1-1` is the
only self-hosted runner GitHub has registered.

| | |
| --- | --- |
| Railway project | 🔴 **DELETED 2026-10-01** — was `phoenix-ci-runner` `d657a3c0-684c-4e83-88bc-ded47b32a00d` |
| service | `ci-runner` `f6a18a22-1434-4423-95d5-875b88928f9b`, image `ghcr.io/actions/actions-runner:latest` |
| region | EU West `europe-west4-drams3a` — **explicitly scaled there, see the trap below** |
| shape | 3 replicas, runners named `phoenix-ci-<RAILWAY_REPLICA_ID>`, labels `self-hosted,X64,Linux,phoenix` |

Three tested flips, each reverted on anything but success:

| job | result | against GitHub-hosted |
| --- | --- | --- |
| `mobile` | **success**, 33s | — |
| `checks` | **success**, 201s | ~254s hosted — **faster**, and this is the dominant job |
| `validate` | **failure**, 97s | the `Build` step only; steps 1–12 pass. Fixed above. |

🔴 **THE OWNER HALTED THIS TESTING UNTIL THERE WAS A PER-BRANCH SWITCH** — his ruling, typed in another
session's window on 2026-09-28 and relayed here, recorded because it *stopped* an action, which is the
safe direction to err in. The reason is below: a flip cannot be made safe by watching, only by scoping.

✅ **That condition has since been met.** The per-branch switch landed in #4594 (merge `9bde1c3a4`):
the repo-wide `CI_RUNNER` is gone, all six `runs-on` lines compute the runner, and self-hosted is
reachable only from a same-repo `ci-runner/<task>` PR. Verified on `main`'s own run for that merge —
`validate`, `checks` and `mobile` all on `ubuntu-latest`. **Arming it is still a separate decision
and still the owner's**; this file does not record whether the variable is currently set, because that
changes without a commit — read `gh variable list`.

### What the three flips actually established — 2026-09-28

| job | on the runner | against GitHub-hosted |
| --- | --- | --- |
| `mobile` | **success**, 33s | — |
| `checks` | **success**, 201–212s | ~254s hosted — **faster**, and it is the dominant job |
| `validate` | **failure** | `Build` fixed by the CPU cap; then the smoke test, cause below |

🔴 **ONE `validate` PASS ON THE RUNNER IS NOT EVIDENCE — run `36353275114` was docs-only.** Its head
`3dfc8fd8b` changes `docs/observability.md` and nothing else (verified: one file), so `ci.yml`'s
docs-only fast path skipped the build and the Playwright step entirely. The `checks` and `mobile` passes
are real; that one is not. **Check the head's file list before citing any green as progress.**

🔴 **AND THE SMOKE TEST'S CAUSE WAS THE INHERITED `PORT`, NOT ANYTHING ABOUT NEXT.** The runner inherits
its Railway service's whole environment, which sets `PORT=8080`; `next start` and the standalone server
both bind `process.env.PORT`, defaulting to 3000 only when it is unset — true on GitHub's runners, false
here. Measured inside the container: `printenv PORT` → `8080`, and `next start` → `Local:
http://localhost:8080  ✓ Ready in 93ms`. The server was healthy on a port nothing watched.

**Two wrong diagnoses were published before that one, and both are retracted in the code:** `::1`
resolution order (#4570 — changed nothing) and `output: "standalone"` (#4577 — the warning is advisory;
the server serves 93 ms after printing it). **#4577 is nevertheless the fix**, because its
`env: { PORT: "3000", … }` overrides the inherited 8080 — `webServer.env` is spread last over
`process.env` in playwright 1.63 — and #4579 corrects the stated reason. Pinned by
`tests/next-build-cpu-cap.test.ts`, including that the bound port and the polled port are the same
number.

**So the remaining work is not a flip.** It is the per-branch switch the owner asked for; until then
`CI_RUNNER` stays `ubuntu-latest` and the registered runners sit idle.

**Two traps this rollout paid for:**

- 🔴 **`ghcr.io/actions/actions-runner:latest` is BARE — no Node.js** — and `ci.yml` runs
  `Enable Corepack (pnpm)` **before** `actions/setup-node`, so step 4 dies `corepack: command not
  found` (exit 127). Solved in the container's start command (NodeSource Node 24, then
  `corepack enable`, logging `node v24.21.0 corepack 0.36.0` before it registers). That ordering
  assumption in `ci.yml` is invisible until an image without Node runs it.
- 🔴 **A NEW RAILWAY SERVICE IN THIS ACCOUNT IS CREATED IN `sfo`, NOT EUROPE** — the same default that
  put `superb-smile` in the US. `AGENTS.md` §3's "it must stay in Europe" therefore needs an
  **explicit** `railway service scale` on every new service, and the region map printed by the scale
  API is the only place it shows.

**While `CI_RUNNER` reads `ubuntu-latest`, the replicas still bill** — roughly $8/month in idle memory
for three. That is spend producing nothing, and parking them at 0 is a dashboard decision.

## 🔴 The safety rules

1. **PRIVATE REPOSITORIES ONLY.** A self-hosted runner executes whatever a workflow tells it to.
   On a **public** repo, anyone opening a fork pull request runs arbitrary code on the host.
   `phoenix-people-workforce` is private, so only accounts with repository access can trigger it —
   the case GitHub's own guidance considers acceptable. **If this repo is ever made public, remove
   the runner first.**
2. **Never on the owner's laptop.** `AGENTS.md` §5 records that the 16 GB machine already
   hard-freezes under a build plus a dev server. A CI runner there guarantees it.
   🔴 **This happened.** On 2026-09-27 a runner named `OMAR-GAWISH` (`self-hosted, Windows, X64`)
   was registered and online, and with `CI_RUNNER=self-hosted` it took the jobs — see rule 2b for
   what that did. Deregister it: `gh api -X DELETE repos/Gawish-1997/phoenix-people-workforce/actions/runners/<id>`,
   and on the machine `cd C:\actions-runner && .\config.cmd remove`. A registered runner is not
   idle — it competes for every job the moment the variable points at it.
2b. 🔴 **THE RUNNER MUST BE LINUX. A WINDOWS RUNNER FAILS EVERY JOB IN SECONDS, AND LOOKS HEALTHY
   DOING IT.** Every `run:` step here is bash; GitHub's default shell on a Windows runner is
   PowerShell, which cannot parse `answer() { … }` or `[ "$X" = "y" ]`. Measured 2026-09-27 on
   PR #4537: all four required checks failed in 11–25 s with `An expression was expected after '('`
   and `Missing type name after '['`, from
   `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.EXE`. Nothing reports "wrong OS" — the
   runner shows `status: online`, the checks simply go red, and the failure reads like a broken
   branch. **Under the production deploy gate this is far worse than a red PR:** every `main` run
   would fail in seconds, so Railway would withhold every deploy and then skip it at the two-hour
   timeout with nothing red to explain why (`deployment.md`, "The deploy gate", failure modes 1 and
   3). `scripts/setup-self-hosted-runner.sh` is an Ubuntu script and refuses anything else; the
   `runs-on` label must resolve to a **Linux x86_64** host, and a runner registered any other way
   must be deregistered rather than left online.
3. **The host has repository-level trust.** Anything in `.env` on that box, and any credential the
   workflows use, is reachable by any job. Treat it as production infrastructure: no shared logins,
   SSH keys only, firewall everything except SSH out.
4. **The registration token is short-lived** (~1 hour) and is never written to disk by the setup
   script. It is not a long-term secret, but do not paste it into chat or commit it.

## Turning it on

The workflows do **not** hard-code `self-hosted`, and since 2026-09-28 they do not read a
repo-wide `CI_RUNNER` either. All six `runs-on` lines — four in `ci.yml`, two in
`security-scan.yml` — are byte-identical and read:

```yaml
runs-on: ${{ (vars.CI_SELF_HOSTED != 'off' && vars.CI_RUNNER_LABEL != '' && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && startsWith(github.head_ref, 'ci-runner/')) && vars.CI_RUNNER_LABEL || 'ubuntu-latest' }}
```

**Self-hosted is opt-in PER BRANCH: push `ci-runner/<task>` and that PR runs on the label; every
other branch, and `main`, runs hosted.** Each condition earns its place:

| condition | why |
| --- | --- |
| `vars.CI_SELF_HOSTED != 'off'` | a one-word kill switch that does not require remembering the configured label |
| `vars.CI_RUNNER_LABEL != ''` | **nothing is baked in.** A job whose label matches no online runner does **not** fall back — it QUEUES, for ever, with nothing red. An unset variable therefore means hosted |
| `github.event_name == 'pull_request'` | **`main` can never be self-hosted.** main's CI *is* the production deploy gate, so a runner that fails or queues there stops shipping |
| `head.repo.full_name == github.repository` | same-repo only — a fork PR on a self-hosted runner is arbitrary code execution on our own machine |
| `startsWith(github.head_ref, 'ci-runner/')` | the opt-in is the branch **name**, so there is nothing to flip and nothing to remember to revert. It also cannot change mid-flight, unlike `vars.*`, which are re-resolved on every new run **attempt** |

🔴 **WHY THE LABEL IS A VARIABLE AND NOT `self-hosted`, MEASURED 2026-09-28.** `runs-on: self-hosted`
matches **every** self-hosted runner on the repo, so it can never mean "the box I provisioned" — and a
label that matches no online runner **queues for ever** rather than failing. When this switch was
written every runner here carried the same four labels (`self-hosted,X64,Linux,phoenix`), so nothing
could be targeted deliberately at all.

✅ **That has since been fixed at the owner's instruction (2026-09-28): the Railway replicas now also
carry `railway-eu`**, kept alongside their existing labels rather than replacing them, so nothing that
targeted them before broke. Verified live — three runners, all online, all carrying
`self-hosted,X64,Linux,phoenix,railway-eu`. **So `CI_RUNNER_LABEL=railway-eu` names that pool on
purpose, and the switch is provable end to end without new hardware.** A future Hetzner box takes its
own label and is selected the same way.

🔴 **Do not quote a runner COUNT from this or any doc.** It read **ten** and then **three** inside the
same hour on 2026-09-28: the Railway replicas register non-ephemerally, so stale registrations pile up
after each redeploy until someone clears them, and a session that had just written "ten" was stale
within the hour. Read `gh api repos/<repo>/actions/runners` and compare the label **sets**. Register a new host with its own extra label and name that label here:

```bash
# on the host, BEFORE running the setup script
export RUNNER_LABELS=self-hosted,linux,x64,phoenix,hetzner
```
```bash
# then point the switch at it — and note this does NOT turn anything on by itself:
# only a same-repo ci-runner/<task> PR is eligible
gh variable set CI_RUNNER_LABEL --body hetzner    # or railway-eu, which already exists
```

🔴 **DO NOT READ THE CURRENT SWITCH STATE FROM THIS FILE — read `gh variable list`.** These are
repository variables: they change without a commit, so any value written here is a snapshot that
begins rotting the moment it is written. This paragraph used to assert *"neither variable is set
today, deliberately"*, and it went false about twenty minutes later, when `CI_RUNNER_LABEL` was set
to `railway-eu` on the owner's instruction (2026-09-28T00:22:00Z). A session reading it would have
believed every job was hosted while `ci-runner/` PRs were already going to the replicas. The file had
been wrong about a live value twice that night — the other was the cost figure, corrected in #4607.

| what `gh variable list` shows | what it means |
| --- | --- |
| `CI_RUNNER_LABEL` **unset** | every job hosted, whatever the branch — the switch cannot fire at all |
| `CI_RUNNER_LABEL` **set** | a same-repo `ci-runner/<task>` PR runs on that label; `main`, dispatches, schedules and every other PR stay hosted |
| `CI_SELF_HOSTED=off` | kill switch, wins over everything, takes effect on a new run **attempt** |

✅ **A DATED MEASUREMENT IS SAFE TO WRITE DOWN HERE; A CURRENT VALUE IS NOT** — which is why the
evidence below stays and the state above does not. On 2026-09-28, **with `CI_RUNNER_LABEL` already
armed**, dispatch `36362005374` put `validate`, `checks` and `mobile` on `ubuntu-latest` while the
replicas sat idle, and PR #4599 took all four required checks on the replicas including the Playwright
login smoke test. Both arms of the prefix condition, demonstrated on real events rather than computed
from the expression. Those readings are true for ever because they carry their date; "the label is
set today" is not.

**Arming it is the owner's call**, and *the label existing is not the same thing as the switch being
on* — that sentence stays true whatever the variables happen to read today.

`scripts/setup-self-hosted-runner.sh` defaults `RUNNER_LABELS` to `self-hosted,linux,x64,phoenix` —
byte-identical to what the Railway replicas carry — so the override is the whole point. Deregistering
those replicas is **not** a prerequisite and does not work as one: the service re-registers a replica
whenever one cycles, so `gh api -X DELETE .../runners/<id>` is a loop, not a fix. Stopping that
project is the owner's dashboard decision.

`PHX_BUILD_CPUS` is unaffected — it gates on `runner.environment == 'self-hosted'`, which is true on
any self-hosted runner whatever its labels.

**The rollback is `gh variable set CI_SELF_HOSTED --body off`**, and because `vars.*` are re-resolved
on a new run attempt, `gh run rerun --failed` then rescues a stuck `ci-runner/` PR.

1. Provision a host — Ubuntu 22.04/24.04, **x86_64, 8 GB RAM minimum** (`ci.yml` runs typecheck
   with `--max-old-space-size=6144`, and the build peaks around 4 GB), ~40 GB disk.
2. Get a registration token: **Settings → Actions → Runners → New self-hosted runner**
   (`/settings/actions/runners/new`). 🔴 **That is a short-lived token, NOT a PAT** — this path stores
   no credential at all, which is why deleting the `phoenix-ci-runner` PAT on 2026-10-01 left it
   untouched. Only the retired Railway container pool needed a PAT; see the table under the
   2026-09-29 stand-down below.
3. On the host:
   ```bash
   git clone https://github.com/Gawish-1997/phoenix-people-workforce
   cd phoenix-people-workforce
   export RUNNER_TOKEN=...
   bash scripts/setup-self-hosted-runner.sh
   ```
   It installs Node 24 + corepack/pnpm, Playwright's **system** libraries (the browsers themselves
   are still downloaded and cached per run by `ci.yml`), registers the runner and installs it as a
   systemd service so it survives reboot.
4. Confirm it shows **Idle** at `/settings/actions/runners`.
4b. 🔴 **Confirm the OS before flipping the variable, and that NO other runner is registered** —
   this is the step whose absence cost PR #4537 a full red cycle on 2026-09-27 (safety rule 2b):
   ```bash
   gh api repos/Gawish-1997/phoenix-people-workforce/actions/runners \
     --jq '.runners[] | {name, os, status, labels: [.labels[].name]}'
   ```
   Every row must read `"os": "Linux"`. A `"Windows"` row will take the jobs and fail all of them in
   seconds, and `status: online` tells you nothing about whether it can run bash.
5. Point the switch at the label you gave it — **never at `self-hosted`**, which matches every
   self-hosted runner on the repo:
   ```bash
   gh variable set CI_RUNNER_LABEL --repo Gawish-1997/phoenix-people-workforce --body 'hetzner'
   ```
   This alone turns nothing on: only a same-repo PR from a `ci-runner/<task>` branch is eligible.
   `main`, dispatches, schedules and every other PR stay hosted.
6. Open a PR from a `ci-runner/<task>` branch and watch that run end-to-end before trusting it —
   including which machine took each job (section D below).

## Click by click — from nothing to a proven runner

Ported from PR #4583 (`codex/runner-label-guard`), which was closed once the per-branch switch landed:
its `CI_RUNNER` instructions were superseded, but this procedure was not, and it is the half that
matters when there is hardware on the desk. Reconciled with the switch, so the variable names here are
the live ones.

The numbered steps above assume a host that already exists and a shell that is already non-root.
🔴 **Hetzner's Ubuntu image logs you in as `root`, and `setup-self-hosted-runner.sh` refuses to run as
root** (`[ "$(id -u)" -ne 0 ] || die`) — so the procedure above stops dead at that line with the
servers already bought. **Step B2 is the missing step.**

🔴 **THIS ORDER WAS REFUSED AND THE SECTION IS KEPT ONLY AS COSTED RESEARCH — DO NOT ACT ON IT AND
DO NOT RE-PITCH IT.** The owner's answer on 2026-09-28 was *"I WILL NOT BUY THIS"*, about exactly this
pair at €70.98/month. It stays in the document because the price research, the region trap and the
root-login trap below all cost real work to establish and would otherwise be re-derived — not because
anything is pending. **Self-hosted CI already runs on the existing Railway pool** (the switch above);
nothing here is required for that.

**A — order (browser, `console.hetzner.com`), IF it is ever revisited.** Prices read from Hetzner's own
data 2026-09-28; they rose about 170% on 15 June 2026, so re-read them rather than trusting this table
later.

| field | value | why |
| --- | --- | --- |
| **Add server** | in the project, **Servers** → **Add server** | |
| Location | **Nuremberg (NBG1)** | EU. `sfo` is the default for a new service elsewhere in this account — not here, but check it |
| Image | **Ubuntu 24.04** | the script installs Node 24 itself |
| Type | **Shared vCPU · AMD · CPX32** — 4 vCPU, 8 GB, 160 GB, 20 TB | about €35.49/mo each. **NOT CPX31** — US-only, 3 TB, far dearer |
| Networking | leave **Public IPv4 + IPv6** on | the runner needs outbound only, but SSH in is how you set it up |
| SSH key | **add your public key** | without one Hetzner emails a root password, which is worse in every way |
| Volumes / Firewalls / Backups / Placement | skip | a runner holds no state worth backing up |
| Name | `phx-ci-1` | `RUNNER_NAME` defaults to `phoenix-ci-$(hostname -s)`, so distinct names give distinct runners — which is what makes step D readable |
| quantity | **2** if the console offers a count, otherwise repeat for `phx-ci-2` | |

**B — on EACH box.** B2 is the step the old procedure was missing.

```bash
# B1  from your machine, as root (Hetzner's default)
ssh root@<server-ip>

# B2  make a non-root sudo user and give it your key — the script REFUSES to run as root
adduser --disabled-password --gecos "" phx
usermod -aG sudo phx
install -d -m 700 -o phx -g phx /home/phx/.ssh
cp /root/.ssh/authorized_keys /home/phx/.ssh/authorized_keys
chown phx:phx /home/phx/.ssh/authorized_keys && chmod 600 /home/phx/.ssh/authorized_keys
exit

# B3  back in as that user
ssh phx@<server-ip>
git clone https://github.com/Gawish-1997/phoenix-people-workforce
cd phoenix-people-workforce

# B4  the label override — the whole point of the section above
export RUNNER_LABELS=self-hosted,linux,x64,phoenix,hetzner

# B5  a registration token, valid about ONE HOUR, from
#     /settings/actions/runners/new  (get a fresh one per box if the first expires)
export RUNNER_TOKEN=<paste>

bash scripts/setup-self-hosted-runner.sh
```

It installs Node 24 plus corepack/pnpm and Playwright's system libraries, registers the runner and
installs it as a systemd service so it survives reboot. It warns below 7 GB — a CPX32 reports 8, so
that warning appearing means you bought the wrong plan.

**C — arm the switch. 🔴 READ `gh variable list` FIRST — this step is only an *arming* if
`CI_RUNNER_LABEL` is unset.** If it already names another pool, the same keystroke is a **repoint**, and it
moves every opted-in PR off that pool in one write with nothing to warn you.

```bash
gh variable list                                  # what does CI_RUNNER_LABEL say NOW?
gh variable set CI_RUNNER_LABEL --body hetzner    # the label you gave the box in B4
```

This step said *"Two variables, and neither is set today"* until 2026-09-28, and it was false — the same
claim §L452 carried, surviving twenty lines further down after that one was fixed. It is the worse of the
two placements: L452 is read by someone **checking** state, this is read by someone **acting** on it, minutes
after paying for hardware. Which is the rule the whole file now works to — **a dated measurement is safe to
write down; a current value is not** — applied to an instruction rather than a description: do not tell the
reader what the variable is, tell them to look, and say what each answer means for the command underneath.

Then push a branch named `ci-runner/<task>` and open a PR from it. **Nothing else becomes
self-hosted** — not `main`, not a dispatch, not any other PR. Roll back with
`gh variable set CI_SELF_HOSTED --body off`, which takes effect on `gh run rerun --failed` because
`vars.*` re-resolve on a new attempt.

**D — prove it, and prove it on the right hardware.** A green run is not evidence on its own; read
which machine took each job:

```bash
gh api repos/Gawish-1997/phoenix-people-workforce/actions/runners \
  --jq '.runners[] | select([.labels[].name] | index("hetzner")) | "\(.name) \(.status) \(.os)"'
gh run list --workflow=ci.yml --limit 1 --json databaseId --jq '.[0].databaseId'
gh api repos/Gawish-1997/phoenix-people-workforce/actions/runs/<id>/jobs \
  --jq '.jobs[] | "\(.name) on \(.runner_name) \([.labels[]] | join(","))"'
```

Every job's `runner_name` must start `phoenix-ci-phx-ci`. **A `phoenix-ci-<uuid>` name is a Railway
replica**, which means the label selection did not hold — those carry `railway-eu` as well as
`phoenix`, so check the labels line too. 🔴 **And watch that first `main` run to a verdict**: `main` is
never self-hosted under the switch, but a red `main` for any reason makes Railway skip the production
deploy within minutes, and re-running it green does not resurrect it.

## Widening it — DONE, the owner's ruling of 2026-09-30

🔴 **EVERY SAME-REPO PULL REQUEST RUNS SELF-HOSTED NOW.** The owner widened it in his own words —
*"widen self-hosted CI to all PRs"* — and the `startsWith(github.head_ref, 'ci-runner/')` clause is
gone from all six `runs-on` lines. **`main`, pushes, dispatches, schedules and fork PRs are still
hosted**, and the two clauses that keep them there are load-bearing:

| clause | what it stops |
| --- | --- |
| `github.event_name == 'pull_request'` | `main` on a self-hosted runner. **`main`'s CI IS the production deploy gate** — a runner that fails or queues there stops shipping, with nothing red |
| `head.repo.full_name == github.repository` | a fork PR executing arbitrary code on the owner's box |

**Rolling back is the kill switch, never an edit to the expression:**

```bash
gh variable set CI_SELF_HOSTED --repo Gawish-1997/phoenix-people-workforce --body off
```

`vars.*` re-resolve on each new run **attempt**, so that returns every PR to hosted on its next
attempt and `gh run rerun --failed` picks it up. The branch-name clause could not be undone that way,
which was its original appeal — and is now moot.

### Why the 2026-09-28 refusal was right then and wrong now

That ruling was not overturned by argument; the measurement under it was an artefact. `checks` read
**324–339s** self-hosted against ~209s hosted, which reads exactly like slow shared vCPU. It was the
**ESLint cache, keyed by absolute path**: a cache written on `ubuntu-latest` at `/home/runner/work/…`
matched **not one file** in `/home/phx/actions-runner/_work/…`, so eslint re-linted all 6,597 files
**while the step logged a cache hit** — 168s cold against 4s warm, measured twice independently on
the host. #4844 scoped the key to the workspace. On the one genuinely CPU-bound step the box had been
winning the whole time: `tsc` **115s** here against **153–162s** hosted.

🔴 **Three other explanations were proposed the same day and all three were wrong** — shared-vCPU CPU,
a cold pnpm store, and a second runner stealing CPU. Each is refuted with its evidence earlier in this
file. **Read those before deriving a fourth.**

The older refusal rested on a different pool, too: it counted **four** required jobs queueing behind
three Railway replicas. Protection has since dropped to **two** required checks (`validate`, `checks`),
and the Railway pool is gone. Neither half of that arithmetic still describes anything.

### What is still true, and is a trade rather than a defect

🔴 **There are two runners and two required jobs, so one PR occupies the whole box and a second
concurrent PR queues behind it entirely.** In a busy hour that is slower than hosted. The owner widened
it knowing that; it is not a regression to report, and the fix is not hardware — **he refused the
two-CPX32 purchase on 2026-09-28 (*"I WILL NOT BUY THIS"*) and bought one box himself. Never re-pitch
it.** If depth ever matters more than the bill, the lever is another runner process on the existing
host, measured first: see the memory arithmetic above, because `tsc` alone peaks at 5.86 GB of 7.7 GB.

### One typecheck at a time — owner, 2026-09-30

*"fix the CI box so two PR typechecks never run at once."* The queueing above is per JOB, and
`checks` and `validate` are different jobs — so two PRs could still land one `checks` job on each
runner and run two `tsc` at once. Measured that morning: 4.1 GB and 2 GB side by side with the
preview server, 3.1 GB into swap. ci.yml's Typecheck step now takes a kernel lock
(`/tmp/phx-typecheck.lock`, `flock`) in the same shell as `tsc`, so the second one **waits** for the
first (~110s) while lint and the unit suite keep running. `scripts/remote-check.mjs typecheck` takes
the same lock, so a hand-run check queues behind CI too. The wait is bounded at 20 minutes and then
runs anyway with a warning, so a stuck holder cannot fail a PR by itself; on a GitHub-hosted runner
the lock is always free. Pinned by `tests/ci-typecheck-lock.test.ts`, which on Linux holds the lock
from another process and proves the step waits.

### remote-check: one tree per invocation — 2026-10-01

The lock above serialises `tsc`, and nothing else. Until 2026-10-01 every `remote-check.mjs`
invocation, from every session, also shared ONE directory on the box (`~/remote-check/work`) and one
branch (`remote-check`): push, `git checkout -f <sha>`, run. Two sessions at once therefore checked
out over each other mid-run. The box's own reflog shows it: `19442c382` checked out at 05:59:44
Cairo, `5d2bfaa24` over it at 06:01:25 while the first run was still going. The first run printed
`box head: 19442c382`, then failed its typecheck with `TS6053` on a test file that commit *has*, and
passed the unit suite with `2085 test files` — the other commit's count; CI ran 2,086 on the same
sha. Wrong in both directions, under the right header.

Now each run pushes to its own ref (`refs/remote-check/<run id>`), `git worktree add`s its own
directory under `~/remote-check/runs/`, and its EXIT trap removes both; a directory a hard-killed run
left behind is reaped after 6 hours. After the checkout, the install and every check it re-reads
HEAD, and a run whose tree is no longer its sha exits **3** and prints **NO VERDICT** instead of PASS
or FAIL. A fresh tree has no `.next/types`, so the typecheck now runs `next typegen` first, as
ci.yml does — the shared directory had been typechecking against whatever route types some earlier
commit left behind. The cost is a fresh `pnpm install` (hard links from the box's store) and a cold
eslint cache per run. `~/remote-check/work` is no longer used. The bash lives in
`scripts/remote-check-plan.mjs`; `tests/remote-check.test.ts` runs it for real against a throwaway
bare repo with two overlapping invocations on two commits.

### REVERSED the same day — PRs back on hosted, the box is previews only, 2026-09-30

The owner widened it in the morning and reversed it that evening, in his own words: *"put PRs back
on hosted and keep the box for previews only"*. `CI_SELF_HOSTED` went **off** — the kill switch, not
an edit to the `runs-on` expression, exactly as "The safety rules" requires. The expression is
UNCHANGED and still reaches every same-repo pull request, so one variable restores widening; the
"Widening it" section above stays as the account of how it is wired, not as a description of what is
running.

**It was reversed because the box could not carry it, and the measurement is the reason.** `tsc`
peaks at **5.55 GB** on a box with **7.7 GB**, so TWO concurrent `checks` jobs cannot fit. On
2026-09-30 two typechecks sitting at **4.6 GB + 1.3 GB** drove it **3,579 MB into swap**, and the
queue read **9 runs queued and 0 in progress** — CI had stopped rather than slowed, which is the
failure a shared box makes look like slowness. Capped to ONE runner (`phoenix-ci-nbg1-b` stopped,
masked and deregistered), the two required jobs then SERIALISE at **~305s against ~209s hosted**.
That is why hosted won: the box is faster per job and slower per PR, and a PR is what the owner
waits on.

🔴 **The runner self-updates and does not come back.** It upgraded **2.331.0 → 2.337.0**, exited
`no retry needed` with code **0**, and `svc.sh`'s generated systemd unit carries `Restart=no` — so
it read **offline** while every job queued behind the other runner, with nothing red anywhere to say
so. Both units now carry a `Restart=always` drop-in. **Never register a runner without checking
`systemctl show <unit> -p Restart`.**

What survives the reversal, and is why the safety rules above are not now dead letters: the
`github.event_name == 'pull_request'` clause is the ONLY thing keeping `main` hosted, and `main`'s CI
is the production deploy gate; the same-repo clause is what stops a fork PR executing arbitrary code
on his box; and the hardware refusal stands (*"I WILL NOT BUY THIS"*, of two CPX32s at
€70.98/month — he bought ONE box himself). The box keeps serving `phx-preview`.

## Turning it off

```bash
gh variable set CI_SELF_HOSTED --repo Gawish-1997/phoenix-people-workforce --body off
```

That is the kill switch and it wins over everything else, so it works without having to remember which
label was configured. `gh variable delete CI_RUNNER_LABEL` also does it, by making the label unset —
either way an eligible PR falls back to hosted rather than queueing. 🔴 **`gh variable delete CI_RUNNER`
is the OLD command and now does nothing**: that variable was retired in #4594 and no workflow reads it.

Because `vars.*` are re-resolved on each new run **attempt**, a run already in flight keeps the old
value — `gh run rerun --failed` is what picks the kill switch up. The next run goes back to
GitHub-hosted. Nothing else changes, no workflow edit, no PR. Do this
first and diagnose afterwards whenever the runner misbehaves — a queued job reports no status, and
a required check with no status blocks every PR.

### 🔴 The switch goes off BEFORE the host stops — never after

**Stopping the runner host first is the one order that breaks things, and it breaks them silently.**
`CI_SELF_HOSTED=off` sends every job back to `ubuntu-latest`. Leaving the switch armed while
`CI_RUNNER_LABEL` still names a pool with **no online runner** does NOT fall back: the job **queues
for ever**, reports no status, and a required check with no status blocks the PR with nothing red
anywhere to read. The label being *unset* falls back; the label being *set to a dead pool* does not.
Those two are a word apart in the section above and opposite in effect.

**The order, whenever the host is being stood down or moved:**

1. `CI_SELF_HOSTED=off`, and read it back from `gh variable list` — not from the command's exit code.
2. Confirm no `ci-runner/` PR is open or in flight. `vars.*` resolve when a run **attempt** is
   created, so a run already created keeps the armed value and still wants the pool.
3. Only then stop the replicas.
4. The registrations then sit in the repo's runner list as stale `offline` entries. Delete them by
   **id** — the Railway replicas register non-ephemerally, which is why this list has read ten and
   three inside one hour.

**Recorded 2026-09-29**, because that is the order the owner's stand-down followed: the switch was set
to `off` at 16:53 Cairo, on an idle pool — it had carried no CI at all since the two proof PRs
([#4599](https://github.com/Gawish-1997/phoenix-people-workforce/pull/4599) and
[#4601](https://github.com/Gawish-1997/phoenix-people-workforce/pull/4601)) on 28 September, while
still billing for idle memory. 🔴 **The Railway host itself was still running when this was
written — three replicas online — so nothing here says it was retired.** And this is a dated event,
never a statement of what the switch reads today: ask `gh variable list` for that, for the reason
[#4618](https://github.com/Gawish-1997/phoenix-people-workforce/pull/4618) exists.

### 2026-09-29 — the Railway host was stood down (stopped, NOT deleted)

Later the same day the pool itself went down. Verified state at the time of writing:

| | |
| --- | --- |
| Railway project | 🔴 **DELETED 2026-10-01** — was `d657a3c0-684c-4e83-88bc-ded47b32a00d`, `deletedAt: null` until then |
| Service | `ci-runner` `f6a18a22-1434-4423-95d5-875b88928f9b` — gone with the project |
| Deployment | `b6f0858b` — was `deploymentStopped: true`, `canRedeploy: true` |
| Replicas | all three `EXITED` — `1116628c`, `8f9e5a88`, `37e95625` |
| GitHub registrations | ids 32, 33, 34 deleted; `actions/runners` reads `total_count: 0` |

🔴 **UPDATED 2026-10-01: "retired" became DELETED.** The owner instructed it, and the project, its
service and its deployment are gone — so the paragraph that stood here, saying they "all still exist
and the deployment is redeployable", is no longer true. **Bringing a Railway pool back is now a
rebuild from the provisioning runbook above, not a redeploy**, and creating a project remains the
owner's dashboard click. Inventory taken before pressing: no volumes in any environment, the one
service reading `● Completed`, no runner registered with GitHub from it, and no code path referencing
it — only this document.

🔴 **AND `railway list` LISTED IT FOR MINUTES AFTER IT WAS GONE, IN BOTH PLAIN AND `--json` FORM.**
The first `railway delete -p <name> -y` succeeded, printing only its selection line; the listing then
still showed the project, a second delete answered `Project "phoenix-ci-runner" not found` with exit
1, and `railway status` on the linked directory answered **`Project is deleted.`** — which is the only
readout that told the truth. This is the volume-delete trap (AGENTS.md §2.3) with the signs reversed:
there the delete reports success and does nothing, here it reports almost nothing and works while the
listing lies. **Never conclude a Railway delete failed because the thing is still listed, and never
re-press on that basis** — read the object directly.

🔴 **The registration ids in that table are spent.** A replica registers non-ephemerally at
startup, so a redeploy mints NEW ids and the old ones never come back — never write an id from this
file into a command. Read `gh api repos/<repo>/actions/runners` at the moment you need one.

🔴 **THE TWO WAYS A RUNNER REGISTERS NEED DIFFERENT CREDENTIALS, AND ONLY ONE OF THEM NEEDED A PAT —
WHICH IS WHY DELETING THE `phoenix-ci-runner` PAT ON 2026-10-01 CHANGED NOTHING ABOUT THE RUNBOOK
ABOVE.** The two paths are not interchangeable and a session that conflates them either hunts a token
it does not need or rebuilds a pool it cannot authenticate:

| path | credential | state after 2026-10-01 |
| --- | --- | --- |
| **The manual runbook above** (a host you provision, `scripts/setup-self-hosted-runner.sh`) | `RUNNER_TOKEN` — a **registration token valid about ONE HOUR**, read off `/settings/actions/runners/new`. **No PAT, no stored secret** | **Unaffected.** Re-register the Hetzner box, or a replacement host, with a fresh token from that page and nothing else |
| **The Railway container pool** (`ghcr.io/actions/actions-runner:latest`, 3 replicas self-registering at startup) | a **fine-grained PAT in the service's own variables** — a replica boots unattended, so it cannot be handed a one-hour token by a human | **Gone twice over.** The project was deleted, and the `phoenix-ci-runner` PAT with it. Rebuilding that pool needs the owner to **mint a NEW fine-grained PAT first** — the old one cannot be recovered or re-read |

So: **re-registering a runner does NOT need a PAT. Rebuilding the Railway pool does, and the one it
used no longer exists.** `scripts/setup-self-hosted-runner.sh` dies with
`RUNNER_TOKEN is not set` and names the page to get one from — that message is the whole credential
story for the path this document actually recommends.

**Reading that project without relinking the CLI**, which matters because the primary checkout is
linked to `phoenix-headwind` and relinking breaks every other session's `railway run`:

```bash
railway status --project d657a3c0-684c-4e83-88bc-ded47b32a00d --environment production --json
```

`--project` requires `--environment` for both output modes. It is a read; it changes no link.

### 2026-09-30 — the Hetzner box is LIVE, and the switch points at it

The owner bought **one** CPX32 and the pool moved off Railway the same night. State at the time of
writing, read from the live APIs rather than from the order:

| | |
| --- | --- |
| Host | `ubuntu-8gb-nbg1-1` — CPX32, 4 vCPU, 7,740 MB RAM, 150 GB, `x86_64`, Nuremberg (`nbg1`) |
| OS | Ubuntu **26.04.1 LTS** (`resolute`) |
| Runners | **two on the one box** — `phoenix-ci-ubuntu-8gb-nbg1-1` and `phoenix-ci-nbg1-b`, both labelled `self-hosted,X64,Linux,phoenix,hetzner` |
| Services | one systemd unit per runner, `actions.runner.Gawish-1997-phoenix-people-workforce.<runner name>` — both enabled, active, surviving reboot |
| Switch | `CI_SELF_HOSTED = on`, `CI_RUNNER_LABEL = hetzner` |
| Toolchain | node 24.21.0, pnpm 12.8.1, git 2.53.0, Playwright system deps installed |

🔴 **8 GB of swap was added deliberately, and it is not optional.** `ci.yml` runs typecheck with
`--max-old-space-size=6144` against 7,740 MB of RAM. A runner takes one job at a time so nothing
competes with it, but 6 GB of heap inside 7.7 GB leaves no margin for the compiler's own
non-heap memory — and an OOM-killed typecheck prints nothing and exits non-zero, which reads
exactly like a code failure. `/swapfile`, `fstab`-persisted.

**Two things cost real time on the way in. Neither is a defect in this runbook; both are new.**

🔴 **A Hetzner server created without ticking an SSH key CANNOT BE REACHED WITH ONE AFTERWARDS —
not by adding the key to the project, and not by Rebuild.** The key is applied at creation only;
`Rebuild` takes an image and re-applies the keys *from creation*, of which there were none, so it
lands in the same hole. The project key read as present and correct the whole time — its
fingerprint matched the laptop's exactly — which is precisely what makes this hard to see. The way
out without deleting the server is **Rescue**: enable it, the box power-cycles into a network
Debian, mount the real root at `/mnt`, append the public key to `/mnt/root/.ssh/authorized_keys`,
reboot. 🔴 **Hetzner's console does NOT offer a key selector when enabling rescue — it issues a
one-time root password and clears it from the panel once the box has booted**, so capture it when
it appears. Confirm you are really in rescue from the wire, not the UI: port 22 answers
`SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u7` there, and the installed system answers as Ubuntu.

🔴 **NodeSource had no repository for `resolute` at all**, so `setup_24.x` left the box with no
Node and `setup-self-hosted-runner.sh` could not proceed. The script now falls back to the official
tarball and resolves the version from `nodejs.org` — see its Node section. **Expect this again on
the next Ubuntu release**: NodeSource lags a new codename by months, and the failure is quiet.

## What to expect after the switch

- **Cost**: metered Actions spend for this repo goes to ~$0. The VPS is the whole bill.
- 🔴 **STEADY STATE IT IS FASTER THAN HOSTED — `checks` ~145s against ~209s. NEVER JUDGE THIS BOX ON
  ITS FIRST RUNS.** The step that decides CI is the typecheck, and it is the step the box wins:

  | step of `checks` | box, steady state | GitHub-hosted |
  | --- | --- | --- |
  | `pnpm install --frozen-lockfile` | **0.5s** (pnpm store persists between jobs) | 11–14s |
  | `next typegen` | 1.7s | <5s |
  | `lint` (ESLint cache restored) | ~5s | 5–6s |
  | **`tsc --noEmit`** | **114s** | **153–162s** |
  | **job total** | **~145s** | **203–219s, mean 209s** |

  `tsc` measured directly on the host, cold (`--incremental false`, no `tsbuildinfo`), peak RSS
  **5.55 GB** — which is why the 6 GB heap stands and why the swap file is not optional.

  🔴 **THE OBSERVED JOBS SAID THE OPPOSITE — 324s, 327s, 339s — AND THE CAUSE IS THE ESLINT CACHE,
  NOT THE CPU, NOT A COLD STORE, AND NOT THE SECOND RUNNER.** All three explanations were proposed on
  2026-09-30 and all three are wrong; the row above marked "lint ~5s" is what the job gets only once
  `ci.yml`'s cache key carries the workspace. What was actually happening:

  | on the self-hosted `checks` job | | hosted |
  | --- | --- | --- |
  | **Lint** | **165s · 169s** | 5–6s |
  | Typecheck | **115s · 115s** | 153–162s |

  `.eslintcache` is a JSON object keyed by **absolute path**. Hosted runs write
  `/home/runner/work/<repo>/<repo>/…`; this box works in
  `/home/phx/actions-runner[-2]/_work/<repo>/<repo>/…`. So the restored cache matches **not one
  file**, eslint re-lints all 6,597 — and the step logs a **cache hit** while doing it, which is why
  nobody looked there. Two sessions measured it independently on the host: **168s / 165s with no
  usable cache, 4.16s / 4s with one that box wrote** (3,600,957 bytes). That 160s is the entire gap.

  🔴 **THE THREE WRONG DIAGNOSES, SO NOBODY RE-RUNS THEM.** *Shared-vCPU CPU* — refuted by the one
  pure-CPU step: `tsc` is **115s here against 153–162s hosted**, measured twice independently on the
  host (113.94s and 115s, peak RSS 5.55 GB / 5.86 GB). The box **wins** on CPU. *Cold pnpm store* —
  refuted by `install` already reading **0.5–3s** while `checks` still took 324s, and by three
  consecutive runs drifting only 339 → 327 → 324s, which is not a store filling. *The second runner
  stealing CPU* — refuted by attempt 1 of run `36652062486`, which ran `checks` **solo and
  sequential** and still took **339s**, slower than the concurrent runs. Concurrency changed nothing,
  and a runner was briefly removed on that mistaken basis before being restored.

  🔴 **THE COMPARISON BASIS IS THE WHOLE MEASUREMENT, AND IT WAS GOT WRONG THREE TIMES IN ONE HOUR, IN
  BOTH DIRECTIONS.** #4837 moved the unit suite from `checks` into `validate` on 2026-09-29T23:39Z, so
  **every run before that timestamp has a different job composition and is not comparable**, and a
  `push` run's `validate` additionally carries the build and the login smoke. One draft read
  "`validate` is roughly twice as fast" off pre-split or push runs (270–365s); another compared
  per-job self-hosted times against a whole PR's *wall clock* and got "2× slower"; a third blamed a
  cold store; a fourth compared observed jobs against **~145s, which was a projection assuming a
  working ESLint cache and not an observed job at all**, and removed a runner over the difference.
  **Filter to `event=pull_request` and to runs created after the last change to the job split — and
  never compare an observed number against a projected one without saying which is which.**

  🔴 **ONCE THE KEY LANDS, THE BOX WINS THE WAIT AND NOT ONLY THE JOB — BUT ONLY WITH BOTH RUNNERS.**
  Wall clock is `max(checks, validate)`: about `max(145, 160) = ~160s` here against hosted's
  `max(209, 157) = ~209s`. With one runner the two required checks serialise instead and the box
  loses. **The cache key and the runner count are one change; do not ship or undo them separately.**
- 🔴 **ONE RUNNER PROCESS TAKES ONE JOB, SO A SINGLE REGISTRATION SERIALISES THE TWO REQUIRED CHECKS.**
  The first run took **508s** that way (339s then 161s, back to back) — most of that 339s was the
  ESLint cache above, so read the 508s as the shape of the problem, not as its cost.
  A **second** runner registered on the SAME box fixes it — `RUNNER_DIR=$HOME/actions-runner-2
  RUNNER_NAME=phoenix-ci-nbg1-b` with the same labels, which the setup script supports as-is. **It
  fits**: with both jobs running at once the box's lowest available RAM was **1,180 MB** and swap
  use peaked at 67 MB, so the 6 GB typecheck heap needs no lowering. 🔴 **Expect a scheduling delay
  of up to ~90s before GitHub hands work to a runner that has just registered** — a job sitting
  `queued` beside an idle runner in that window is not a misconfiguration.
- 🔴 **A persistent runner keeps state between jobs**, which GitHub-hosted runners never do. That is
  where the speed comes from and also the one new failure mode: a stale `node_modules`, `.next` or
  generated type file can make a run pass that should have failed. If a result ever looks
  suspicious, clear `~/actions-runner/_work` and re-run before believing it.

## The typecheck is 75% of `checks`, and the 7.7× fix is not safe yet — 2026-09-30

`checks` is **209s hosted, and ~157s of it is `tsc`**. Lint is 5s behind a restored ESLint cache,
`next typegen` under 2s, install 11–14s. So anything that does not touch the typecheck cannot move
this job, and the wall clock of a PR is this job.

Measured on the Hetzner host, same checkout, same `tsconfig.json`, both cold:

| | time | peak RSS | diagnostics |
| --- | --- | --- | --- |
| `tsc` (TypeScript 5) | 114s | 5.55 GB | 0 |
| `tsgo` (`@typescript/native-preview` 7.0.0-dev.20260707.2) | **14.9s** | 6.24 GB | **3** |

🔴 **DO NOT MAKE `tsgo` THE TYPE GATE YET, HOWEVER TEMPTING 7.7× IS.** Its three diagnostics are all
`TS2871 "This expression is always nullish"` on one idiom —
`(lineId == null ? null : names.lines.get(lineId) ?? null) ?? area?.line ?? null` in
`src/lib/customer-360/service.ts` (×2) and `src/lib/verified-captures/distributor-codes.ts`. **They
are false positives**: `names.lines` is `Map<number, string>` and `lineId` narrows to `number`, so
the flagged expression is not always nullish. A preview compiler that rejects correct code will
reject more of it as the codebase grows, and each one is a red PR with a bogus reason on the check
that guards types for live payroll. Re-run this benchmark when TypeScript 7 ships stable; the
command is `./node_modules/.bin/tsgo --noEmit --pretty false` after
`npm i --no-save @typescript/native-preview`.

🔴 **A GLOBAL `tsgo` DOES NOT TYPECHECK THIS PROJECT — IT FAILS RESOLUTION AND LOOKS 15× FASTER.**
Installed with `npm i -g`, it resolved neither `next/link` nor `react/jsx-runtime` nor
`JSX.IntrinsicElements` and "finished" in 7.6s with thousands of `TS2307`/`TS7026`. That is the time
to fail, not a measurement. Install it into the project so module resolution has the right root.

🔴 **AND THE CACHE THAT WOULD MAKE `tsc` FAST IS ALREADY FORBIDDEN HERE.** `tsconfig.json` sets
`incremental: true` **and** `assumeChangesOnlyAffectDirectDependencies: true`, and on 2026-07-30 a
warm `tsc` in this repo returned **exit 0 with three live `TS2741` errors**. So restoring
`tsconfig.tsbuildinfo` from `actions/cache` would buy most of that 157s by trading away the
correctness of the one check that guards types. Do not propose it.
`typecheck-incremental-false-green`

## Do not re-attempt these

Recorded in `ci.yml`'s own comments with the measurements:

- `next build --turbopack` — a **no-op**; Next 16.2.11 already builds with Turbopack (175s vs 174s,
  byte-identical output).
- `.next/cache` — restored fine, **saved nothing** (148s warm vs 143s cold), and its entries reached
  97% of the 16.47 GB repository cache budget.
- Extending the docs-only fast path to `main` pushes — measured **4 of the last 200 commits (2%)**
  are docs-only. Worth roughly $2/month.
