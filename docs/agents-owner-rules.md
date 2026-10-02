# Standing owner rules — the full account

This is the detail behind the hooks in [AGENTS.md](../AGENTS.md) §4. **The hook there is the cue;
this file and the memory files it names are the fact** — the same split `MEMORY.md` states in its own
first line, applied one level up, and the same split [agents-session-traps.md](agents-session-traps.md)
made for §2.1.

**Why the detail lives here and not in `AGENTS.md`.** `CLAUDE.md` pulls `AGENTS.md` in via
`@AGENTS.md`, in full, on every single request, so every byte of it is fixed context occupancy paid
on every turn. That is the right home for a one-line rule, which has to be seen *before* a session
knows it needs it. It is the wrong home for a multi-paragraph incident write-up, which is only wanted
once a session is already looking. §4 stood at 19,533 bytes — 19.1% of the file and the largest
section never trimmed — of which the Delta (3) account alone was ~4,700.

**The rules themselves did not move.** Every owner decision is still stated in `AGENTS.md` §4, in the
owner's own terms, together with the memory slug behind it. What moved here is the evidence: incident
narratives, PR numbers, production measurements, verification detail, and the relocation history
explaining why a given rule came to sit in `AGENTS.md` at all.

**Every memory slug stayed in `AGENTS.md` deliberately.** `scripts/memory-index-reachability.mjs`
resolves a memory as reachable only when its slug appears backticked in `AGENTS.md` — it does not
scan `docs/`. Of §4's 21 slugs, 17 are also carried by `MEMORY-ARCHIVE.md`, but **four exist nowhere
else** and would have been orphaned by a careless move:
`mailbox-monitor-app-password-entry-is-three-underscores-never-phoenix`,
`nsm-outstation-expense-is-never-held`,
`the-ceo-is-not-a-district-and-a-picker-is-not-wider-than-its-viewer`, and
`turbify-cannot-issue-app-passwords-centrally-owner-stays` — the four relocated on 2026-08-29, which
by design never had an index line. **Do not move a slug out of `AGENTS.md` into this file.**

**Nothing below was rewritten.** The body is the verbatim §4 text as it stood at `61dfcee48`,
including every measurement, date, PR number and owner quotation.

---

## 4. Standing owner rules

These are the owner's own decisions, stated across many sessions. They are not suggestions.

**How to answer**

- Reply in **English always**, regardless of the language he writes in.
- Report every time in **Africa/Cairo** local time, never raw UTC.
- Show **human-readable names**, never raw codes or IDs, in both UI and chat.
- **Never truncate text with an ellipsis and never let text wrap** to multiple lines in the UI.
- When asked for N recommendations, give only the ones grounded in a real confirmed need. **Never
  pad a list to hit a number.**
- End every reply with a single recommended next step.

**How to take work**

- When he says he will list several requests, **log each as a task and wait for the go-ahead** —
  do not start implementing while the list is still being given.
- **Ask when the answer changes the outcome; decide when it does not.** He has asked both for
  "as many questions as needed to get it right" and for far fewer interruptions — the resolution is
  that scope, business rules, and data-correctness questions are always worth asking, while
  permission to do obvious low-risk work is not.
- **Ask business-fact questions as an XLSX with dropdowns, not in prose** (his rule, 2026-08-03,
  after classifying 16 Arabic-named bricks this way). Whenever the doubt is "which of these does
  each of these belong to" — bricks to areas, areas to regions, people to seats, products to lines —
  build one row per item with a locked data-validation list of the allowed answers, send the file,
  and read the answers back. He fills it and returns it. This applies **everywhere in the repo**, not
  just Source of Sales. Include whatever context makes the call easy (current value, recent sales)
  and a free-text Note column. Never guess an item to avoid asking, and never hand back a list of
  items for him to answer in chat.
- Take ownership. Automate the work rather than returning a checklist he has to execute.
- **"continue verifying" means RESUME the paused Source of Sales audit — never restart it**
  (relocated from `MEMORY.md` 2026-08-28 together with its index line; the checkpoint hook itself
  stays in the index as `sos-deep-audit-paused-checkpoint`). The phrase — also "continue the
  verification" / "continue the audit" — is a standing instruction. **Why it matters:** 20 finder
  agents completed on 2026-08-09 and produced **247 findings** across 101+ files plus live production
  forensics. That phase is the expensive, irreplaceable half, and **he stopped the run specifically
  to save usage**, so silently re-running the finders repeats the exact cost he was avoiding. Read
  `…\.claude\projects\F--Phoenix-Workforce-phoenix-workforce\sos-audit-2026-08-09\CHECKPOINT.md`
  first, load the scope file (default `scope-mapping-normalization-ai.json`, 58 findings; wider is
  `scope-mapping-normalization-calc.json`, 159; the other 88 are parked in `deferred-findings.json`,
  **not dropped**), then run `resume-verify.js` via `Workflow({ scriptPath })`. **Never
  `resumeFromRunId`** — it is same-session only and run `wf_2a126511-113` is gone. Write survivors
  back as a NEW file and update `CHECKPOINT.md`; never overwrite the inputs. Treat every finding as a
  lead rather than a fact — early verification killed ~14% (10 of the first 71). The folder is
  read-only, carries a `DO-NOT-DELETE.md`, and is mirrored at
  `F:\Phoenix Workforce\_audit-vault-sos-2026-08-09`; both sit OUTSIDE the work tree so `git clean`
  and `repo:doctor --fix` cannot reach them — never move them inside the repo.
  `continue-verifying-resumes-sos-audit`

**How to build**

- **Before building any new UI, inspect the sibling pages in that module and match their exact
  design identity.** Never invent a one-off look.
- Admin shell: **desktop shows full tables/dashboards, mobile never does** — mobile gets cards.
- **One production deployment per task.** Bundle all phases into one PR; do not deploy per step.
- Use the **`gh` CLI** for all GitHub operations, not the GitHub MCP tools.
- Before wiring any email recipients, **ask who receives it**.

**Product rules that must not be "fixed" back**

- No payslip on any overview/landing page for any role — not the amount, not even the month label.
- 🔒 **A CRM account label is `[Name ]( Area / Line )`, and `E`/`F` are RETIRED line codes.** Owner's
  explanation, 2026-08-28, given after a session sent him a 19-row sheet asking who made the calls on
  accounts he could have dismissed at a glance. The grammar is fixed: whatever sits between the
  brackets is the **area**, the single letter after the final `/` or `-` is the **line**, and a
  person's name — when present — sits **before** the bracket, styled `First.Last`
  (`Mayar.Elmorsy ( Mahalla / E )`). Lines were renamed: **`E` was the antibacterial/anti-infective
  line and is now `A`; `F` was Pedia and is now `P`.** `A`, `C` and `P` are the live codes. **An
  account still ending in `/ E` or `/ F` is therefore an old-naming placeholder and must never be
  treated as an open question** — nobody will ever be hired into a retired line code. Keep and
  resolve `A`/`C`/`P`; drop `E`/`F`.
  **The CRM admin never deletes an account.** When a rep resigns he **deactivates it, strips the
  person's name, and keeps the area** — which is why so many of these labels are a bare territory —
  then **clones** the account to a NEW one for the next hire into the same area, line and position.
  So the old account holds the leaver's real history under a nameless label, and the identity is
  **unrecoverable from the CRM**: the admin erased it. Verified in production 2026-08-28 — all **8**
  old→new pairs succeed cleanly with **zero** overlap, the successor's first call landing 34 to 155
  days after the predecessor's last while the seat sits vacant (e.g. `( Mahalla / E )` last call
  2026-03-11 → `Ashraf.Maged ( Mahalla / A )` first call 2026-04-14). Name-stripping is measurably
  concentrated on the dead codes: **39%** of `E` and **38%** of `F` accounts have no name, against
  21–24% of `A`/`C`/`P`.
  **Cloning is safe; RENAMING is what corrupts numbers.** A clone gives each holder their own
  account. The 2026-08-28 slot-1391 incident was the other shape — one account handed over and
  relabelled, so iReports360 rewrote 1,136 of the leaver's calls under the joiner's name. That is
  what `resolveEmployeeAttribution`'s employment-scoped override tier exists for; see
  `tests/crm-override-employment-scope.test.ts`.
- Marketing Manager is hidden from the portal Incentive tab; GPM still sees it.
- The Organogram / AU seat model is the source of truth for org-structure and vacancy data.
- All SoS sales, historical and future, attribute to **today's** geography — never as-was.
  **His words, and true in practice — but it is not the mechanism, and reading it as one is the
  trap.** `au.f_monthly_attribution` and `au.f_monthly_achievement` resolve an area's region
  through `au.f_line_area_map_asof(period_end)`: the map as it stood at the END of the month
  being computed, never at the run date. It only looks like today's geography because almost no
  `au.line_area_map` row has ever been closed, so the as-of lookup returns the single open row
  for every period. Close a row and it does what it says — which is precisely how the Delta (3)
  entry directly below leaves July and August resolving to the OLD regions. Verified on
  production 2026-08-28 by reading `pg_get_functiondef`, and again on 2026-08-29 when the dated
  pair went in. **Never quote this line as a reason a dated change is unsafe — read the
  function.** Full account: `attribution-is-period-aware-asof-not-todays-geography`.
- **Delta (3) territory move — LIVE, dated 2026-09-01, applied as a migration 2026-08-29.** The
  five areas (`D11` Qalubeya, `D24` Sharkia 1, `D25` Sharkia 2, `OT2` Suez, `OT9` Ismailia) now sit
  on a correctly dated PAIR: the pre-split row closed at `effective_to = '2026-09-01'` and a `D3`
  row open from that date under `SEAT-AIF-DM-D3`. Verified on production the day it was applied —
  July and August resolve `D11=OT, D24=D2, D25=OT, OT2=OT, OT9=OT`, September and October resolve
  all five to `D3`, on both the closing's view and `au.f_line_area_map_asof()`. **Nothing is owed on
  1 September** — the date does the work, so do not re-apply, re-date, or "finish" anything.
  **It took two attempts, and the reason is the part worth keeping.** The move first went in by
  hand on 2026-08-28, directly in production, with no migration file and no ledger row. It was
  verified with `au.f_line_area_map_asof()` and called safe "by construction" — **but that is not
  the resolver the closing uses.** The Monthly Closing calls `loadLineOperationalRegions()`
  (`src/lib/sales/closing-organogram-regions.ts`), and it was wrong in TWO independent ways, either
  of which alone would have mis-stated August:
  **(1) it dated on the run date.** It filtered against **the day the closing is RUN**, not the
  month being closed, and neither call site in `monthly-distributor-import.ts` passed a period at
  all. Because the closing golden rule below means August cannot publish before 1 September, every
  possible August run date would have resolved all five areas to `D3`. Fixed by #2608
  (`d3871a69`): the loader takes the period and resolves at the month END.
  **(2) it could not see the closed half of the pair.** `au_v_line_area_map` filters
  `effective_to is null`, so a superseded row is invisible to the app. While a move is still in the
  future the closing therefore sees NEITHER half — the old row has an `effective_to`, the new one
  has not started — and `applyOperationalRegions()` silently leaves the area on its **geographic**
  region. Reproduced on staging: through the old view, August resolved to **nothing** for all five.
  Nothing errors; the number just moves. Fixed by #2613 (`13d0b33d`), which added
  `public.au_v_line_area_map_all` — the same view without the filter, `service_role` only — and
  pointed the closing at it. **Additive on purpose:** every other caller stays on
  `au_v_line_area_map` and keeps answering "who owns this area today", so the owner's
  today's-geography rule still governs them. Measured a no-op on live data before and after: 3 of
  150 rows are closed and no `(line, area)` has more than one row, so all twelve 2026 month-ends
  resolve identically either way.
  **So the resolver gap named here until 2026-08-29 is CLOSED, in both directions**, and a
  forward-dated geography change is now safe to leave live across a closing. `#2613` also made the
  row choice deterministic (latest `effective_from` covering the date, not whichever row PostgREST
  returned last) and rebuilt the region filter list after the winners settle, so a superseded
  district cannot linger in the picker.
  **The rollback pre-image is still there and should stay:**
  `delta3_defer_backup_20260829.line_area_map_pre`, 10 rows, the state either side of the
  2026-08-29 deferral. Nothing else was ever touched — the SoS side never carried a Delta (3)
  region or area, and `au.direct_region_allocation` has no `D3` row.
  One caution the older bullets here carried that is still true on its own: nobody knows WHEN the
  August closing itself will publish — it waits on distributor data, not a calendar date, so
  1 September is not a deadline to report as missed.
  **Two things this move did NOT touch, both still open:** the recruitment map's area menus
  (`src/lib/recruitment/inbound/whatsapp-classify-place-hints.ts`) still list these five areas under
  Delta (1)/(2) — a known, separately-tracked residue (see that file and
  `docs/recruitment-inbound-intake.md`). And the weekly/monthly **plan** region picker
  (`src/lib/weekly-planning/regions.ts`) never had "Delta 3" in its approved region list at all —
  unlike the sales map, that picker has no as-of awareness, so it was silently blocking the Anti
  Infective NSM from planning against these areas today, weeks before the sales split takes effect.
  Fixed 2026-08-28 in that file.
- 🔒 **THE CLOSING GOLDEN RULE — a closing is never done or sent during the month it covers.**
  Owner's rule, stated 2026-08-28, in his words: *"no closing is ever done or sent during the
  month. Closing after the month closes."* The closing for `YYYY-MM` becomes publishable on the
  **first day of the following month, Africa/Cairo time** — 1 September for August, not one day
  earlier, and December's opens on 1 January of the next year. Preparing a running month is
  fine and necessary (import, review, correct, preview); **releasing** it is what is forbidden,
  because publishing notifies every sales and product manager, arms the CEO's Source-of-Sales BI
  report, and a sent mail cannot be recalled by unpublishing. Enforced, not merely written down:
  `src/lib/sales/closing-period-gate.ts` throws, `publishClosing` calls it before it writes, and
  `tests/closing-period-gate.test.ts` — registered in `tests/run-tests.ts`, so it runs in the
  required CI `test` check — pins both the arithmetic and the fact that the publish path
  still calls the gate. **`unpublishClosing` is deliberately NOT gated** — it is the recovery
  path, and a recovery path that stops working when you need it is not one. Do not "fix" this
  back, do not add an override flag, and do not offer to publish a running month "just to see".

**More of the same relocation, the same day and for the same reason — §4.1 below carries the cliff
mechanics in full.** These seven index lines went the way the eight marketing hooks did: `MEMORY.md`
had crossed 24,400 bytes again, and compression was spent (zero em-dashes, zero trailing whitespace
and zero double spaces left; two prose passes freed 888 bytes against a 2,400-byte shortfall). Every
rule below is an owner **decision** rather than a measurement — decisions do not rot the way counts
do — so each belongs in a file that auto-loads in full. Each names the memory file holding the full
account, under `C:\Users\satoh\.claude\projects\F--Phoenix-Workforce-phoenix-workforce\memory\`.

- **Every weekly report and export MUST set `excludeUnmapped`** — an unmapped SKU double-counts
  against the real product it belongs to. **An export must MATCH the screen**: a sheet or a column
  may never be dropped silently because it cannot be filtered — label it instead (owner rule
  2026-08-26). And the Weekly **Summarized Report's LAYOUT AND SCOPE are LOCKED**, learned over many
  rejected iterations.

  **The "do not restyle it" half was lifted by the owner on 2026-09-05**, asking for the house
  identity after every other export had it: *"do the summarized report too"*. The conversion changed
  INK ONLY and was proved to, by dumping the workbook's structure — every sheet, merge, column width,
  row height, number format, alignment and cell value — before and after, and diffing. **877
  structural lines, and the only difference was the eyebrow**, which had read "PHOENIX WORKFORCE ·
  WEEKLY SALES" and now names the company. The 109 assertions in `tests/weekly-summary-report.test.ts`
  pass unchanged.

  **The layout and scope halves still stand and are not up for revisiting.** The design judgements in
  that file's own palette note survived the palette change intact — one dark anchor per block, the
  header light rather than a second band, bars desaturated under the type — because every one of them
  is about WEIGHT, which is what the house format cares about too. What changed is which colours
  express it.
  `unmapped-products-must-never-reach-a-report` ·
  `an-export-must-match-the-screen-never-different-data` · `weekly-summarized-report-owner-rules`
- **The system FLAGS an expense; it NEVER auto-rejects one.** Owner rule 2026-08-09: every failed
  check flags the claim for the Super Admin, who decides. **Never auto-publish a deductions month**
  either, and never approve a batch on your own initiative — CRM-derived detections run around 80%
  accurate, so the order is always recommend, the owner confirms, only then publish. And **a
  same-day check against the CRM reads zero because visits are entered through and after the
  working day** — never report that as a measured zero.
  `system-flags-expenses-never-rejects` · `never-auto-publish-deductions-owner-confirms-first` ·
  `dv-evidence-window-same-day-submits`
- **CRM visit types `-5` (Public Holiday) and `-6` (Casual Leave) are WORKING days, never absence.**
  Owner rule 2026-08-21, independently re-verified the same day including which map is actually
  load-bearing. `-4` is the only real leave type, and only **FWC** reaches salary.
  `public-holiday-and-casual-leave-are-working-days`
- **The Ready-sheet >25th full-pay waiver is for genuine RESIGNATIONS only** — terminated and
  inactive leavers stay prorated with zero allowances. **A regional employee travelling TO Cairo
  earns no outstation per-diem** (live in production, #2160 — do not undo). **DSM and Medical Rep
  titles auto-provision their real role**, and the title-governance guard was DELIBERATELY relaxed
  for exactly those two — do not restore the blanket-`Employee` assertion.
  `resignation-full-pay-rule-is-resignation-only` ·
  `cairo-trip-no-per-diem-allowance-live-prod-2026-08-15` ·
  `field-force-provisioning-live-and-guard-relaxed-2026-08-14`
- **Social-insurance Form 1 prints exactly as the Authority issues it** — page 2 carries nothing
  Phoenix wrote, and the whole form is duplex. `government-form1-prints-exactly-as-issued`
- **The organogram XLSX carries a Mobile column**, by the owner's explicit override of §4's
  work-fields-only export rule on 2026-08-23. It is fetched at export time: do not remove it, and
  do not "simplify" it onto the row. `organogram-export-carries-the-mobile-by-owner-override`
- **The public Territory Management preview link must NEVER display or offer the line** — it is
  pinned to Pedia server-side (owner rule 2026-08-14). **The organogram CHART and the employee
  detail popup read two different sources**, so adding a per-person field to the chart means editing
  the seat report's select, not the directory. And **the one-press WhatsApp button STAYS on the CEO
  and NSM rows** — the owner was asked directly on 2026-08-23 and said keep it; do not add
  rank-based suppression. `territory-preview-link-must-never-show-the-line` ·
  `organogram-chart-source-is-au-seat-model-not-directory` ·
  `whatsapp-button-on-leadership-rows-is-an-owner-decision`

**Four more owner decisions, relocated 2026-08-29 for the reason §2.2 gives.** `MEMORY.md` measured
**23,797 bytes — 603 from the 24,400-byte loader cliff** — with every compression lever already spent
(zero em-dashes, zero trailing whitespace, zero double spaces), so no trim could have freed the 1,797
bytes it was over budget. All four are owner **decisions** rather than measurements, and decisions do
not rot the way counts do, so each belongs in a file that auto-loads in full. Two of them are the
mailbox-monitoring pair, which nothing else in this file covered. Each names the memory file holding
the full account, under
`C:\Users\satoh\.claude\projects\F--Phoenix-Workforce-phoenix-workforce\memory\`.

- 🔴 **The CEO is NOT a district, and a picker is never wider than its viewer.** Owner ruling
  2026-08-28, on two faults found together on Doctor Coverage. The org walk climbed all the way to
  `AA` and presented the entire board's scope as the CEO's own assigned doctor panel — he holds no
  such list — while the cached, company-wide filter tree offered a Medical Rep the names of all ~73
  reps. **The data was never over-served; the damage is the opposite** — an EMPTY board, which reads
  to a user as "you covered nothing" rather than as a bug, and so gets reported as a data problem.
  Pass the viewer's scope to the PICKER as well as to the query, and never roll an org tree up to its
  root. `the-ceo-is-not-a-district-and-a-picker-is-not-wider-than-its-viewer`
- 🔴 **An NSM's outstation expense is NEVER held.** Owner rule 2026-08-28, in his words: *"once
  submitted, once accepted."* The workload gate could never have cleared for him in any case — a
  National Sales Manager has no CRM visits for it to match against — so the hold was structural
  rather than a judgement anyone had made. **NSM only.** It does not extend to the three photo-waived
  roles, and every other role still waits for a human. `nsm-outstation-expense-is-never-held`
- 🔴 **An NSM's SAME-DAY RETURN outstation allowance is 300.** Owner rule 2026-09-03, given as
  the settlement of `OUTSTATION-31` — a data-quality hold that had sat unresolved because nothing in
  the repository could derive the figure. The trip was Ali Mohamed Ali Elsayed (`A-12`, National
  Sales Manager), Cairo to مركز طنطا by train on 2026-03-31, out and back the same day
  (`expense_date` = `to_date`). The legacy row carried `allowance = 300` with `travel_cost`,
  `meeting_amount` and `other_amount` all zero, yet `total = 240` — the components did not add up, so
  the mirror flagged it. **The 240 was the error, not the 300.** Reconciling the other way — trimming
  the allowance to match the total — is exactly what a session reaching for arithmetic will do, and it
  would have quietly underpaid him by 60. The total was corrected to 300 on 2026-09-03 under a guarded
  `WHERE` that also required the row to be unimported to payroll, so nothing was double-paid.
- 🔴 **The mailbox-monitor app-password entry is `imap`, never "Phoenix".** Owner rule 2026-08-28
  set this to `___` — three underscores — so that an employee generating an app password on their
  own mailbox could not tell what it was for; the monitor UI must never print the word Phoenix
  anywhere in that instruction. **Amended 2026-09-07: the name is now `imap`.** The owner hit it
  himself while connecting his own mailbox (`omar.anwar@satopharma.com`) for a vacation-request
  audit — **Yahoo/Turbify rejects an app-password name made only of underscores**, so the entry
  will not save. That made the rule unfollowable for every mailbox, not just his, and the UI stated
  it as *"three underscores — nothing else, no other label"*, so an employee obeying it literally
  had no way forward and no reason to suspect the instruction itself.

  **The discretion is the part that matters, not the specific string.** `imap` was chosen over
  `mail` and `sync` because it reads as an ordinary mail-client entry, tells a monitored employee
  nothing, and is accepted by the name field. If it ever has to change again, the test is the same:
  neutral, accepted by Yahoo, and never the word Phoenix.
  `mailbox-monitor-app-password-entry-is-three-underscores-never-phoenix`
- 🔒 **Turbify CANNOT issue app passwords centrally — the owner is STAYING, so do not re-pitch a
  migration.** There is no API and there never was one (a session claimed otherwise and was wrong):
  they are created browser-only, from inside each individual mailbox. That makes employee mailboxes
  **unmonitorable at scale**, and it is SETTLED — he was costed roughly $420/month for 60 seats on
  2026-08-28 and answered *"NO LEAVE ME AS I AM NOW."*
  `turbify-cannot-issue-app-passwords-centrally-owner-stays`

- 🔒 **Scope runs downward only — an employee never sees his own manager, nor anyone at or above his
  own rank.** Owner 2026-09-04, dictated: *"Rasha is the product... is the direct manager for Ahmed.
  Never an employee sees his direct manager. You see yourself and your scope down — downgrading, not
  upgrading."* Asked how far the cut should reach, he answered: *"remove dsms rsm and peer pms too."*

  **What was wrong.** `resolveDoctorCoverageScope`'s `line` basis is line MEMBERSHIP — everyone
  carrying that line id — which is neither up nor down. Measured in production 2026-09-04, Product
  Manager **B-155**'s scope held **57** people: 41 medical reps, 10 District Sales Managers, 2
  National Sales Managers, a peer Product Manager, a Regional Sales Manager, and **A-8, his own
  direct manager**, who has **57 real CRM visits** of her own.

  **The dangerous part is that it looked fine.** Signed in as B-155, neither board showed her — Reps
  Plans carries a medical-reps-only filter that runs BEFORE scope, and the KPIs board (which has no
  such filter) simply had no plan row to build for her. Two accidents, not a rule: the moment she
  files a plan, or a new board lists agents without that filter, a manager appears inside her own
  subordinate's view. **Never read "she isn't on the board" as "the rule is enforced".**

  **The fix, in two independent cuts, both in the resolver** — which IS the security boundary:
  1. the viewer's whole **management chain**, walked up `managerHrId` and counting
     `pendingManagerReplacementForHrId` as an ancestor. Identity-based and **title-blind**, so it
     still catches a manager whose title is misspelt or off the ladder.
  2. a **seat-rank ladder**, keeping only seats ranked strictly BELOW the viewer's own.

  **Why a ladder and not a list of banned titles.** The `line` basis serves all three of
  `LINE_ROLES`, and a District Sales Manager is upward from a Product Manager but **downward from a
  National Sales Manager**. A flat DSM/RSM/peer-PM blocklist would have deleted an NSM's own reports
  and handed him *"No active employees are recorded on your product line"* — `finalizeAgents`' empty
  state, indistinguishable from a data fault. Same failure shape as
  [[the-ceo-is-not-a-district-and-a-picker-is-not-wider-than-its-viewer]]. For the same reason **the
  viewer is never excluded from his own scope**: an NSM is not strictly below himself.

  Ranks (order only): Medical Representative 1 · District Sales Manager and Product Manager 2 ·
  Regional Sales Manager and Group Product Manager 3 · National Sales Manager 4. Both vocabularies
  are listed, because the app ROLE ("Medical Rep", "District Manager") and the employee JOB TITLE
  ("Medical Representative", "District Sales Manager") differ. The viewer is ranked by his **role**
  (the live `AccessContext`, never client input); everyone else by their job title.

  **An unranked title is EXCLUDED from a line scope**, deliberately: 12 head-office seats carry a
  `line_id` in production — the CEO, HR, Finance, QPPV, R&D, even "Buffet" — so "unknown means field
  force, keep them" would put the CEO inside a Product Manager's scope. It costs nothing: lines 1–3
  are the field lines and every title on them is ranked, while line 4, which holds those office
  seats, has no line-scoped viewer on it at all.

  **The ladder runs on the `line` basis ONLY.** A team scope is already provably downward, being
  walked out of the org tree, and ranking it would drop a report whose title sits off the ladder (an
  Admin Assistant under a DM) out of his own manager's board. The chain cut runs on both.

  Measured effect on the live directory: B-155 **57 → 42** (himself + the 41 medical reps), A-10
  **33 → 25**, GPM A-8 **24 → 22** (loses the NSM and the RSM, keeps her PMs and the field force),
  and all three National Sales Managers **unchanged** at 33 / 34 / 24. Pinned by
  `runDoctorCoverageScopeTests` in the required CI `test` job, including a runtime assertion
  that every `LINE_ROLES` entry is ranked — an unranked one does not error, it silently restores the
  wide pre-2026-09-04 board. `scope-runs-downward-only-never-your-own-manager`


## Relocated from AGENTS.md — 2026-09-01

Verbatim, unabridged. The cue — and every memory slug — stays in `AGENTS.md`; the account
lives here. Two sessions relocated this same content concurrently on 2026-09-01 and both appends
landed, so each rule was written out twice under three "batch" headings; the copies were verified
to carry no fact this section lacks, and were merged into this one on the same day.

### 🔒 The fits-the-screen golden rule — never a horizontal scroll

Owner 2026-09-01, who asked for it as a golden word and said it twice in one breath: *"never make
horizontal scrolling. Must fit in the same screen... always mobile friendly and desktop friendly."*

Content must **fit**, not sit behind a sideways drag nobody performs. He asked for an Address column
that was **already there**, off-screen behind 1120px of `min-width` — which is the whole argument for
the rule. So **`overflow-x-auto` over a `min-width` floor IS the bug, not the fix.**

- **A board bound by this rule must NOT use `PortalDesktopTable`** — that primitive hard-codes
  `overflow-x-auto` and a 980px floor, i.e. the scroll being forbidden. Render
  `<div className="hidden md:block">` + `<table className="w-full table-fixed">` + a `<colgroup>`
  instead, as `src/components/crm/reps-list-tables.tsx` does.
- **Fit by MERGING columns, not by shrinking type.** He retired two columns by moving grade and
  phone under the contact name in the same cell.
- **This does NOT relax the no-ellipsis rule: WRAPPING is the permitted answer** (`break-words`,
  `align-top`). Vertical space is free; horizontal space is not. The older "never let text wrap" was
  aimed at ellipsis-style truncation, and he has now explicitly asked for stacked wrapping cells, so
  the golden rule governs where the two collide.
- **Measure, never guess.** `table-fixed` percentages clip silently — a 9% column cut "Pharmacist" by
  4px with no visual warning. Check `el.scrollWidth > el.clientWidth` across `main` at desktop **and**
  at 375px.
- **That check has two blind spots, and both certify a broken page.** It sees only what *scrolls*, so
  anything **clipped** is invisible to it. A nav panel hung 97px off a 375px screen with `main`
  reading 375/375 throughout (2026-09-01, PR #2902). The second is the same mechanism without the
  popover: an `overflow-hidden` container whose children are `whitespace-nowrap`. Measured
  2026-09-02 on `/employee-portals` as a Medical Rep, the Stars of the Fortnight band held its title
  and its "View board" link on one unbreakable row — the link's right edge at **399px against a
  363px `main`**, the bar reading `…AUGUST 1-15, 2026VIEW BOA`, a winner's name cut mid-word — while
  `document` and `main` both measured a clean 375/375, because clipped content contributes nothing
  to `scrollWidth` (PR #2912). **So walk the children's rects against `main`'s right edge, not just
  the scroll widths** — and discount anything `aria-hidden="true"` or `alt=""`. The identity card's
  `/brand/identity-watermark.png` reaches 413px on purpose; a decorative bleed inside an
  `overflow-hidden` box is the intended design, not a violation.
- **The INVERSE trap: `main` overflowing while the DOCUMENT reads clean is content CLIPPED AWAY,
  not scrollable — and that is worse than a scroll.** Measured 2026-09-05 on `/sales/vs-target` at
  375px: `main = 526/375` while `document = 375/375`. Reading that 151px as "reachable by dragging
  sideways" is the mistake — nothing scrolled, so two of the six Performance breakdown tabs
  ("District Managers" 78px past the clip edge, "Products" 151px past) were simply **unreachable on a
  phone**, with nothing on screen suggesting they existed. A Super Admin could not switch the
  breakdown to those levels at all. **The tell that separates unreachable from merely-cut is
  `own = 0`** on the overflowing element: `scrollWidth - clientWidth` of zero means the whole control
  sat past the edge rather than being internally truncated.
- **The cause of that was one token, and it is the reusable half: `shrink-0` pins a wrapper to its
  max-content width, so a `flex flex-wrap` row inside it is INERT at every viewport.** `flex-wrap`
  only wraps when its container is narrower than its content, and `shrink-0` guarantees it never is.
  **Adding `flex-wrap` cannot fix such a row — it already has it**; let the wrapper narrow instead
  (`max-w-full`, not `shrink-0`) and let the header itself wrap. Same edit dropped
  `whitespace-nowrap` from the card title, which sits in a `min-w-0` box where nowrap could only ever
  clip rather than wrap. `SectionCard` in `src/components/sales/target-visuals.tsx`, PR #3140, pinned
  by `tests/section-card-header-fits-a-phone.test.ts`.
  **A static harness built for this certified nothing and was thrown away** — it modelled four tabs
  where the page renders six, so its BEFORE case read a clean 375/375 and reproduced no defect. Same
  void-harness shape as the 1280px one in `tests/admin-filename-cells-never-ellipsise.test.ts`:
  a harness that does not reproduce the defect cannot certify the fix. The measurement that counted
  was the real page at 375px — after: `main = 375/375`, six tabs on two lines, every one inside the
  clip edge, with 1280px and 768px unchanged at six tabs on one line.
- **Prefer to fix it where the text is, not where the box is.** Removing `whitespace-nowrap` was the
  whole fix above; the header additionally takes `flex-wrap` plus `basis-full sm:basis-auto` on the
  title so a phone gives it the full row and desktop is untouched. `tests/early-birds-fortnight-card-wraps.test.ts`
  pins it by shape and bans `truncate` / `text-ellipsis` / `overflow-x-auto` in that file, so the
  next overflow there cannot be "fixed" with one of them.
- **A native `<select>` is the one control this rule cannot fix.** It never wraps its selected
  option, and you may NOT shrink it on a phone: `app/globals.css` RULE 3 floors every form control at
  `max(16px, 1em)` below 768px, because iOS Safari zooms the page in on a smaller one and leaves it
  zoomed. A smaller class is therefore inert — measured, `text-xs` and `text-sm` both compute to 16px
  at 375px — and would reintroduce that defect if it ever applied. Print the full value somewhere
  outside the control instead.
- The admin sidebar's own scroll is by design and out of scope.

`never-horizontal-scroll-always-mobile-and-desktop-friendly`

### 🔒 The square-edge golden rule — why `globals.css`'s own sweep is not coverage

Owner rule 2026-09-04, *"no round or semi-round corners, anywhere"*. The hook is in
[AGENTS.md](../AGENTS.md) §4. This is the account of the part that keeps catching sessions out: the
app **already** has a wholesale square-corner sweep, and reading it as coverage is what let three
separate breaches ship.

The sweep is two rules in `app/globals.css`, one per shell:

```css
.admin-shell [class*="rounded"]          { border-radius: 0 !important; }
.employee-portal-shell [class*="rounded"] { border-radius: 0 !important; }
```

It is genuinely broad — it squares `rounded-full` pills, chips, badges and dots without touching a
single component file. But it matches **a Tailwind class, on an element**, and that sentence contains
both of its blind spots.

**Blind spot 1 — a hand-written `border-radius` on a plain class name.** The selector needs a
`rounded*` substring in the element's `class` attribute. A component that writes its own CSS does not
have one. Found live 2026-09-05 in the payroll dashboard's 293-line `<style>` block:

```css
.phoenix-glow-bar { border-radius: 18px 18px 6px 6px; }
```

on `<div className="phoenix-glow-bar w-16 max-w-full transition-transform duration-200">`. No
`rounded-*` anywhere in that class list, so the sweep never matched, and a repo grep for rounded
*utilities* cannot find it either — it is not a utility. An 18px top on a bar chart, in a shell whose
rule says bars are square.

Measured under the real cascade (RULE 1 lifted verbatim from `globals.css`, the dashboard block
compiled out of the `.tsx`, the bar carrying its actual class list): with the declaration present the
bar computes `18px 18px 6px 6px` while a `.rounded-xl` card beside it computes `0px`. Same page, same
sweep, `ruleOnePresent: true` — one element reachable, one not.

**The corollary, which stops a false positive.** A radius on a selector that *does* carry a `rounded`
hook is dead rather than broken:

```css
.payroll-dashboard-surface .rounded-xl.border.bg-card { border-radius: 20px; }
```

The element necessarily has `rounded-xl`, so the sweep matches it and wins on `!important`. Measured
at `0px`. So the invariant to pin is **"every radius must sit on a selector the sweep can reach"**,
not "no radius in the file" — pinning absence forces dead declarations out on a false pretext and
makes the rule read as arbitrary.

**Blind spot 2 — scrollbars, which no element-level rule can EVER square.** A thumb is painted on a
`::-webkit-scrollbar-thumb` **pseudo-element**; the sweep sets a radius on the **element**. Nine
`999px` pills were riding on that on 2026-09-05: six rules in `globals.css` (admin sidebar and window
thumbs, portal sidebar track and thumb, horizontal-scroll track and thumb), two utilities in
`expense-report.tsx`, one in the payslip document.

**This is the trap, and it is worse than blind spot 1 because it audits as handled.** The Tailwind
form is written on the element:

```tsx
className="… md:block [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300 …"
```

That class attribute **contains the substring "rounded"**, so `[class*="rounded"]` matches, the sweep
fires, and it squares the div — whose corners were never the problem. The thumb keeps its `9999px`.
Anyone auditing by searching for `rounded-` utilities and confirming they sit inside a shell ticks
this one off as covered.

`getComputedStyle` cannot read a scrollbar pseudo-element, so the measurement is taken two other
ways: the CSSOM (20 scrollbar rules parsed, 0 carrying a radius, against 8 with `999px` restored) and
pixels at 7× magnification of the *rendering* — identical CSS, `transform: scale(7)` on the container
— where the control bar is an unmistakable capsule and the fixed one has square ends. A 10px bar
cannot be judged by eye at 1×, and judging by eye is what the rule forbids.

**The third surface: an iframe'd document never loads `globals.css` at all.** The hiring-pack paper
editor renders each paper in an iframe and injects its own stylesheet, which is how
`border-radius: 2px` sat on the dashed box around every editable field until 2026-09-05 — 37 fields
on a contract, each measured at 2px. One declaration rounded six affordances, because `outline`
follows the element's own radius: the live, hover, focus, selected, saving and dry-run rings.

That one was removed rather than rewritten to `border-radius: 0`, deliberately. An uploaded company
template brings its own stylesheet, and forcing a corner square from the editor would make the
preview differ from the paper it prints — the one thing that screen exists to rule out.

**How these are pinned.** `tests/admin-shell-palette-scope.test.ts` covers both blind spots: the
reachability invariant on the payroll dashboard's stylesheet, and a scan of all of `app/` and `src/`
for scrollbar radii in *both* forms (a raw declaration inside a `::-webkit-scrollbar*` rule, and a
`[&::-webkit-scrollbar-*]:rounded-*` utility), parsing only files that mention a scrollbar at all.
`tests/hiring-pack-paper-editor.test.ts` covers the iframe stylesheet.

All three stylesheets live inside a `.tsx` as template literals, and this repo's test runner is
`node --experimental-strip-types`, which refuses a `.tsx` outright (`Unknown file extension ".tsx"`).
So each is **lifted and compiled with `new Function`** rather than grepped — the source text and the
bytes the browser parses are two different things — and each lift is guarded against returning empty
or a truncated prefix by asserting on both the first and last rule it should contain.

Each of those tests also carries its **control permanently**: it re-runs its own scan with the
offending declaration spliced back in and requires the exact expected hit. A detector that quietly
stops matching looks identical to a clean codebase, which is the failure mode this whole rule keeps
falling into.

**Still deliberately out of scope**, so a later sweep does not read them as misses: the login page's
`9999px` glow and ember decorations sit outside both shells, and the payslip document's own radii are
document ink, governed by the house document identity standard rather than the shell rule.


### 🔒 A pharmacy is NOT a contact — a CRM contact count is `PM` + `AM` only

Owner 2026-09-01: *"You will not count the pharmacies as contacts. So everyone should have contacts
and pharmacies. The contacts is divided into AM and PM, and the pharmacies are separate."*

The CRM's three `list_type`s are **two things**: contacts (`PM` + `AM`) and pharmacies (`Pharmacy`).
Adding all three prints one number that matches no rule he has, and inflates the very figure the
90–120 rule judges. On the rep this was caught with, "157 contacts" was really **114 contacts and 43
pharmacies** — a 38% overstatement.

- **Never put `rows.length` beside the word "contacts".** Route every printed size through one
  splitting helper — `describeMix` in `src/components/crm/reps-list-tables.tsx`.
- **Keep pharmacies out of any percentage denominator.** PM and AM are the two halves and total 100%.
- **Give the pharmacy count its own tile.** He said everyone *should have* both, so a rep with
  pharmacies and no doctors is a real finding, not an empty list.
- **A field named `contacts` that holds pharmacies is the trap.** `RepsListGroup.contacts` was
  renamed `.rows` the same day for exactly that reason — the next session reads the field name and
  reprints the bug.
- Say **"Pharmacist"** for a row's list-type label, **"Pharmacies"** when naming a count.

`a-pharmacy-is-not-a-contact`

### 🔒 The call rate is never averaged — AM against 2, PM against 10, reported apart

Owner 2026-09-04: *"The call rate is two AM accounts. This is the optimal, and ten PM accounts. I'm
seeing now that you are putting the call rate out of six. No. Never. This two and this ten. Don't
never get average."* Asked how he wanted it shown, he answered: *"Show both as separate. AM alone,
PM alone."*

A medical rep's perfect day is **2 AM accounts and 10 PM clinics** — two standards, five times apart
in size. Until this date the KPIs board carried one score per rep, verified AM + PM calls over
`working days × 12`, and its own code comment argued **for** the blend on the grounds that averaging
two percentages weights a 2-call target equally with a 10-call one. That was an argument against one
particular way of combining them, answered by combining them a different way. He overruled the idea
itself.

He is right about what it hides. A rep who does his 2 morning accounts and nothing after lunch reads:

| Method | Reads |
| --- | --- |
| Averaging the two percentages | 50% — half a day's work |
| Both slices over one denominator (what shipped until 2026-09-04) | 2 of 12 = 17% |
| **What is true** | **100% AM, 0% PM** |

Neither combined figure says the true thing, which is that the morning was perfect and the afternoon
did not happen. A live August rep made the same point in the other direction: at `0.87 AM · 9.40 PM`
he blended to about 86% — an excellent-looking month — while his mornings barely happened. He now
reads **43% AM, 94% PM**, and the board says *"the morning is not producing the calls it should."*

- **No combined figure exists anywhere.** Not `callRateAttainmentPct` on a row, not on the team
  totals, not as a band, not as a sort field, not as a URL param. Deleting the field is what keeps
  one from being printed again — a rule that lives only in a comment gets re-derived.
- **`amAttainmentPct` and `pmAttainmentPct`** are each verified calls over what *that* target asked
  for across the same working days. `amBandOf` / `pmBandOf` band them apart; a single band would be
  the banned average wearing a colour.
- **Two flags, not one** — `below-am-target` and `below-pm-target`. The two failures are different
  jobs with different conversations behind them.
- **Four podium leaderboards** — coverage, frequency, AM, PM. The best morning and the best afternoon
  are usually different people.
- **Never print the pair with a slash.** `1.63 / 6.57` is what he read as *1.63 out of 6.57*, and it
  is what started this. The separator is `1.63 AM · 6.57 PM`; column headers are **"Of 2"** and
  **"Of 10"**.
- **The verdict sentence names which half is short**, never "the working day" — merging them in prose
  puts back in one sentence exactly what the numbers stopped doing.

Pinned by `runKpiAttainmentAndIdentityTests` in `tests/kpis-filters.test.ts`, which asserts 100% AM /
0% PM on that rep **and** that no combined field exists on the row at all. It runs in the required CI
`validate` job. Shipped in
[#3068](https://github.com/Gawish-1997/phoenix-people-workforce/pull/3068), live as `28fb7a40d`.

### 🔒 AM · PM · Pharmacies — a pharmacy is never counted among the PM doctors

Owner 2026-09-21, while the Private Calendar was being recoloured: *"let's put this a golden goal
system wide. Anything that have number of visits count … never … count pharmacies with p.m.
doctors."* Every figure that counts CRM visits is three figures reported apart — **AM**, **PM** and
**Pharmacies** — and a pharmacy visit is counted in Pharmacies only.

**Why a count that reads `ampm` alone is wrong.** The vendor tags a pharmacy visit with a period like
any other visit. Between 2026-08-01 and 2026-09-20, 1,827 pharmacy visits carried `PM` and 426
carried `AM`. A count that buckets on the period files every one of them among the doctors, so a
rep's PM figure looked like doctors seen when part of it was pharmacy counters.

**What a pharmacy visit is — one test, in one place.** `isPharmacyVisitRow` in
`src/lib/crm/visit-count-buckets.ts`: the visited contact's speciality is a pharmacy, or the visit is
the contact-less `-30` field visit and the rep's comment reads as a pharmacy (the same test the
call-rate board already used, `classifyVisit(...).label === "Pharmacy Visit"`). A comment on any
other visit type never routes it — a regular visit is judged by its contact. The helper is pure, so a
client component imports it as readily as a server service. **Never write a second copy** of the
test; a second copy is how the next screen drifts.

**Where it applies, as of #4169:**

| Surface | What changed |
| --- | --- |
| Private Calendar | key figures, the team snapshot and the download count AM · PM · Pharmacies |
| Double Visit Analytics | KPI band, manager summaries, role rollups, weekly trend, the balance insight, the workbook, the period filter |
| Double Visit Report and the DV planner | the Period column reads "Pharmacies", its filter and summary metrics, the PDF and the workbook |
| Employee 360 | the visit split and a Pharmacy visits tile beside AM and PM |
| The executive field-activity bar (SFE field analytics) | a third segment; the header reads AM · PM · Pharmacies |
| Phoenix KPI rules (after the CRM cutover) | a pharmacy call is the pharmacy lane even when the contact sits on the rep's AM or PM list |
| The outstation trip workload (#4185) | capture, submit, the approval screens, the payroll expense mapping and the expense dashboards read AM · PM · Pharmacies. Owner ruling, 2026-09-21: pharmacies are field WORK, so a pharmacy-only trip is `matched`, never "no activity". `pharmacy_workload` is NULL — shown as "not counted separately", never 0 — on a trip stamped before the split, a hand-typed workload or an Excel import. No pay formula reads it, and `decision.ts` stays pharmacy-blind (pinned by `tests/outstation-trip-workload-pharmacies.test.ts`). The Excel expense template and the held-requests hand entry are still AM · PM only. |

| The Business Review (2026-09-26) | the last surface that called a pharmacy a doctor. Its "Doctors reached" read 7,364 for July 2026 with **1,030 pharmacies inside it** — one in seven — and its single "Visits" figure folded in 1,680 pharmacy calls. Owner: *"everything full detailed"*, so the split reaches the KPI tiles, every area / district / line / company table, the role and people rows and the workbook, as ONE merged `AM · PM · Pharmacies` cell rather than three columns (which keeps the fits-the-screen rule). Customers are split the same way and the total is labelled **Customers**, never Doctors. The read adds `ampm` + `speciality` to its projection and gets the `-30` comment from a second narrow query. 🔴 It also excludes the **catch-all contact** for the first time — every other CRM surface already did. |

Two deliberate differences in how an **unmarked** period is treated: the calendar and the Business
Review file an unmarked visit under PM so every visit lands in exactly one figure and the three
always sum to the total; Double Visit Analytics and Employee 360 keep an unmarked visit out of all
three, as they always had. A pharmacy is a pharmacy in all of them.

**Not yet converted — each needs its own change, never a quiet fold-in:**

- The Phoenix native CRM manager reports — native lists are AM and PM only, so a pharmacy reaches them
  only if one sits on a doctor list.
- The native pilot KPIs, the compliance labels, and the CRM Master AM/PM filter.

**Never** join the three with a slash — the separator is the middle dot, as for the call rate above.
Pinned by `tests/visit-count-golden-rule.test.ts` (and the pharmacy fixtures in
`tests/double-visit-analytics.test.ts` and `tests/double-visit-report-export.test.ts`), which run in
the required CI `test` job.

### 🔒 The August / Delta (3) golden rule

Owner 2026-08-29, who said "golden rule, no negotiation" twice in one breath: *"The closing of August
will not include Delta three, but starting from September closing, it will include Delta three ...
whenever I publish it, whenever I do it, it does not contain Delta three."*

**This is already enforced — do not rebuild it.** Verified live 2026-08-29 at four levels:

1. `closingRegionsAsOfDate("2026-08")` returns `2026-08-31` from the PERIOD STRING alone. The loader
   takes the period as a REQUIRED argument precisely because it once defaulted to `new Date()`.
2. `au.f_line_area_map_asof` windows on `effective_from <= p_asof and (effective_to is null or
   effective_to > p_asof)`, called with `v_period_end`.
3. Production returns **no `D3` row at all** as of `2026-08-31`, and all five as of `2026-09-30`.
4. `runClosingPeriodDatingTests` pins both months **and proves it discriminates**, by re-resolving at
   run dates `2026-09-01`, `2026-09-15` and `2026-10-03` and asserting each would have wrongly
   credited August's sales to Delta (3). It is registered in `tests/run-tests.ts` and runs in the
   required CI `test` job, so breaking it turns a PR red.

**Never resolve closing geography at the run date**, and never offer to publish August "now that the
move is live" as though the date were a problem — the date is the mechanism.

### 🔒 The old monthly closing export is frozen

Owner 2026-08-31, the second time in two days: *"The old monthly closing sheet don't mess it.
Anything we will do will be aside it."*

That covers the route, the workbook, its sheet set, its layout and the black **Export XLSX** button —
no restyle, no refactor, no "obviously right" fix. It is the auditor's file: people already forward
it and reconcile against it, so a second format is additive while a changed first format invalidates
every copy in circulation. New capability goes in the **premium** export beside it.

The one thing that legitimately spans both is the shared `runExport` that makes each button post the
on-screen filter — keeping that shared is what stops the old one diverging from the screen, and
`tests/sos-ui-truth.test.ts` pins it. `the-old-monthly-closing-export-is-never-touched`

### 🔒 The premium closing workbook FILLS the `.xlsm` engine — it never rebuilds one

The engine is the `Data` sheet's two Excel Tables (`SalesData`, `AreaBook`) plus `PickList`, which
drive 3 pivots **by table name**, 2 slicers, and the `Rep Card`'s 120 INDEX/MATCH formulas. A
from-scratch server-side workbook throws all of that away and leaves dead text that looks nearly
identical — which is exactly what shipped on 2026-08-30 and had to be undone.

**Never round-trip the workbook through ExcelJS**: loading and re-saving silently destroys the
pivots, slicers, tables and VBA. Rewrite the data parts inside the zip and leave every other part
byte-identical.

**Ship the template EMPTY**, never pre-filled with a real month — a filler that skips a sheet then
hands someone another line's real numbers under the right heading, and wrong-but-plausible is far
worse than blank. `premium-closing-export-fills-the-xlsm-engine-never-rebuilds-it`

### 🔴 A password reset does NOT revoke a Turbify mailbox — the app passwords survive it

Yahoo keeps every third-party app password alive across a password change, so a reset locks a leaver
out of the WEB mailbox and nothing else: each phone and Outlook client they ever configured keeps
sending and receiving company mail, and **the control panel shows nothing wrong** — no screen lists
live app passwords and there is no API to ask.

**Both steps are required** — reset AND delete the app passwords, or delete/suspend the mailbox
outright. `forwarding` and `retained` leave it fully alive.

**Never tell the owner (or write in a UI) that a reset closes a leaver's mail access.** A reset-only
mailbox is worse than an untouched one, because it manufactures a false belief that the door is shut
— and that was his own first framing of this work, so it is precisely the gap.

Tracked in `public.mailbox_offboarding_tasks`, where the `revoked` rule lives in plpgsql so no page
can call a reset-only mailbox closed. A row is an **attestation** — a named admin said they did a
step — never an observation, because Phoenix cannot see Turbify.
`a-password-reset-does-not-revoke-a-turbify-mailbox`

### 🔒 The CRM account label is `[Name ]( Area / Line )`, and `E`/`F` are RETIRED line codes

Between the brackets is the **area**; the letter after the final `/` or `-` is the **line**; a name,
when present, sits **before** the bracket as `First.Last`.

**`E` (anti-infective) became `A`; `F` (Pedia) became `P`.** `A`, `C`, `P` are the live codes, so an
account still ending `/ E` or `/ F` is an old-naming placeholder and **never an open question** —
nobody is hired into a retired code.

**The CRM admin never deletes an account.** On a resignation he deactivates it, strips the name,
keeps the area, then **clones** a new one for the next hire. The leaver's history therefore sits
under a nameless label and the identity is **unrecoverable from the CRM**.

**Cloning is safe; RENAMING is what corrupts numbers.** A relabelled hand-over rewrote 1,136 of a
leaver's calls under the joiner's name — which is what `resolveEmployeeAttribution`'s
employment-scoped override tier exists for (`tests/crm-override-employment-scope.test.ts`).

### The Delta (3) territory move — LIVE, dated 2026-09-01, applied as a migration 2026-08-29

The five areas (`D11` Qalubeya, `D24` Sharkia 1, `D25` Sharkia 2, `OT2` Suez, `OT9` Ismailia) sit on
a dated PAIR — the pre-split row closed at `effective_to = '2026-09-01'`, a `D3` row open from that
date. **Nothing is owed on 1 September**: the date does the work, so do not re-apply, re-date, or
"finish" anything.

The resolver gap that made this dangerous is **CLOSED in both directions** — #2608 dates on the
period, not the run date; #2613 added `public.au_v_line_area_map_all` so the closing can see the
superseded half. A forward-dated geography change is now safe to leave live across a closing. Keep
the rollback pre-image `delta3_defer_backup_20260829.line_area_map_pre`.

Nobody knows WHEN the August closing publishes — it waits on distributor data, not the calendar, so
1 September is not a deadline to report as missed.

**The recruitment side is now CLOSED.** PR #2665 (commit `65652ac34`, live in prod 2026-08-29)
overrides the five areas to Delta (3) in the WhatsApp apply-flow area menu via
`recruitmentAreaRegionOverrides` (`candidate-region.ts`), so picking Delta (3) shows them and Delta
(1)/(2)/Others no longer do; the region map and hints were already correct (#2509).
`recruitmentAreaRegionOverrides` is **PERMANENT** — it is what shows the five under Delta (3) in
recruitment, not a temporary shim to retire.

**The SALES geography is DELIBERATELY LEFT ALONE — owner chose this 2026-08-29 (Option A)**,
reversing an earlier note that said to repoint it. `au.canonical_areas.code_region_code`, its twin
`source_of_sales_areas.region_code`, and the stamped `source_of_sales_fact_rollup.region_code` all
still file the five under the old districts D1/D2/OT and **STAY there**. The anti-infective → Delta
(3) move is carried ENTIRELY by `line_area_map` (dated, anti-infective only), so no geographic
repoint is needed for sales — geography and per-line territory are decoupled BY DESIGN, exactly as
the GZ6/Beni Suef split established (Beni Suef kept geographic GZ while operating UE-2 on
anti-infective).

**Do NOT repoint `code_region_code`** after the closing: repointing canonical ALONE diverges it from
the region the sales rows carry, and the seat-scope prefetch (`portal-sos-dashboard.ts` →
`seat-area-scope.ts`) fetches a DM's rows by that region — a divergence that can silently hide a
district manager's own sales.

### 🔒 Delta (3) is ANTI-INFECTIVE ONLY — owner-confirmed 2026-08-29

All five areas move to `D3` on `anti_infective` in September. **On CNS and Pedia they do not move at
all**: `D11` stays Delta (1), `D24`/`D25` stay Delta (2), `OT2`/`OT9` stay Others, in BOTH months. So
a sweep that finds these five "half-migrated" across lines is reading the **CORRECT** state — never
extend the move to CNS or Pedia to make the map look consistent.

### 🔒 Ismailia and Suez are ONE area on Anti Infective Delta (3) — owner, 2026-09-19

In his words: *"Ismailia and Suez, one area … not separate areas."* From **2026-09-01**, `OT2` (Suez)
and `OT9` (Ismailia) are ONE area named **"Ismailia and Suez"** on the Anti Infective line, in the
organogram, closing, targets and weekly reports. Delta (3) had been opened with one rep for both
governorates, but only Suez carried the seat and the target, so the organogram read "Suez" alone.

How it is built — the Pedia Fayoum + Beni Suef precedent, not a re-key of sales data:
`CLOSING_AREA_MERGES.anti_infective` (`fromPeriod: "2026-09"`) folds `OT9` under `OT2`; migration
`20260919213858` puts both open Delta (3) `au.line_area_map` rows on `SEAT-AIF-REP-OT2` (so a hire
occupies both together) and relabels the seat "AIF Ismailia and Suez rep". Sales, bricks, customers
and targets stay on the two codes. The recruitment vacancy picker and vacancy report read the same
rule (`vacancyAreaName`). **July and August are untouched — Suez and Ismailia stay separate in Others;
the DATE is the mechanism.** Recruitment place geography (Suez and Ismailia as two places for
candidates and CV folders) is deliberately unchanged. Pre-image tables:
`au.bak_20260919_ismailia_suez_line_area_map` and `au.bak_20260919_ismailia_suez_seats`. Pinned by
`tests/anti-infective-ismailia-suez-one-area.test.ts`.

### 🔒 The closing golden rule — a closing is never done or sent during the month it covers

In his words: *"no closing is ever done or sent during the month. Closing after the month closes."*

The closing for `YYYY-MM` becomes publishable on the **first day of the following month, Africa/Cairo**
— 1 September for August, not a day earlier. Preparing a running month is fine and necessary;
**releasing** it is what is forbidden, because publishing notifies every sales and product manager,
arms the CEO's BI report, and a sent mail cannot be recalled by unpublishing.

Enforced, not merely written down: `src/lib/sales/closing-period-gate.ts` throws and `publishClosing`
calls it before it writes, pinned by `tests/closing-period-gate.test.ts` in the required CI
`validate` check.

**`unpublishClosing` is deliberately NOT gated** — it is the recovery path, and a recovery path that
stops working when you need it is not one. Do not add an override flag, and do not offer to publish a
running month "just to see".

## 4.1 Marketing customer, venue and licence validation (relocated from `MEMORY.md` 2026-08-28, then from `AGENTS.md` 2026-09-01)

- 🔒 **Venue validation is GPS + a live picture ALWAYS — and leg 3 (the registered code, else the
  licence) is a PHARMACY rule ONLY.** Owner rule 2026-08-26, **amended 2026-08-29**: *"Nursery does
  not have distributor code or license. So nursery, they are validated by location and live photo,
  and then it's approval depends on the admin."*

  Both of leg 3's routes are pharmacy-trade documents, so a venue outside that trade is judged by no
  route at all — `resolveVenueIdentityRoute` answers **`admin`**, never `none`. Demanding the licence
  anyway is a **permanent refusal worded as an instruction**, and it stranded a real held order for a
  nursery carrying a 20 m pin and a live photo.

  **Do not over-apply the amendment:** a codeless PHARMACY is still refused, the code route is still
  closed to a nursery (a code that RESOLVES for one is the forgery signature), and `match` is now
  refused for one — it would attach another business's real code.

  The licence is a **fallback identity route**, *never* evidence in its own right. Direct-order desk
  only (#2434), **not** marketing — and when marketing wires leg 3, scope it by venue type or it
  repeats this from scratch.

  **`nursery` is the venue type for ANY venue with no distributor account, and that is the OWNER'S
  OWN FILING** (2026-08-29): *"it is a clinic that only takes direct orders from the company. It
  doesn't have a pharmacy that has a code. So it is the same situation exactly as a nursery. I am the
  one who told him to submit it like this."* So a clinic filed as a nursery is **correct, not a
  data-quality defect** — never "fix" one, never flag it in a sweep, and do not add a third venue
  type. The register reading `Nursery` for a clinic is expected. The vocabulary is not about what the
  venue IS; it is about whether a distributor vouches for it.
  `venue-validation-rule-gps-photo-then-code-or-licence`

- 🔴 **A WHOLESALER / MAKHZAN is NEVER shown as a candidate NOR validated as a venue, in BOTH the
  direct-order and the marketing-request flows.** Owner rule, 2026-09-22, emphatic — *"never never
  never"*, after he saw a distributor's own warehouse offered as a matchable venue. A makhzan is not
  an end customer; validating one mis-credits its sales to a warehouse instead of the shop that sold
  the medicine.

  **There is no wholesaler flag anywhere in the data** — venue types are only `pharmacy` / `nursery`
  (`src/lib/venues/venue-type.ts`) and no reference table carries a customer-type column. The monthly
  closing already answers "is this customer a wholesaler" **by name**, in
  `src/lib/sales/customer-channel.ts` (`isStoreCustomer`), and the guard reuses that module's exported
  primitives so the two can never disagree and so every owner pharmacy-override (مخزن الطرشوبى is a
  real pharmacy, عابدين فارما is a chain) applies to venues automatically. The guard lives in its own
  venue-only module, `src/lib/venues/wholesaler-venue-guard.ts`, which **imports** those primitives and
  **never edits `customer-channel.ts`**, so the closing's published numbers are left exactly as they
  are. The one enabling change there was to export the existing private `matchesAnyName` as a pure
  `nameMatchesAnyKeyword` — no behaviour change, and `tests/sales-customer-channel.test.ts` stays green.

  **Two tiers**, owner decision the same day, asked in chat as multiple choice and answered *"block
  certain, flag فارما"*:

  - **HARD-BLOCK — `isCertainWholesalerVenue(name, code?, distributorCode?)`.** The unmistakable
    warehouses: a name containing مخزن (makhzan) or جملة (wholesale), the medicines trade phrase
    (لتجارة وتوزيع الأدوية…, via `matchesTradePhrase`), El Qema / QM (a wholesale-only distributor,
    `isWholesaleOnlyDistributor`), the EPDA «م - » warehouse prefix (`matchedStorePrefixes`), the
    owner's named-wholesaler roster (`STORE_OVERRIDE_NAMES`), or a code-keyed store ruling
    (`isStoreOverride`). These are dropped from **every candidate picker** and **refused at every
    validation write path** with one shared message. Pharmacy protectors win first, so a real pharmacy
    named like a warehouse (مخزن الطرشوبى) is never blocked.
  - **FLAG — `suspectedWholesalerFlag(name)` / `suspectedWholesalerNote(name)`.** The ambiguous store
    words on their own — a bare «X فارما / Pharma», الشركة, الجمعيه, تريد. A field venue branded
    "Pharma" is often a **real retail pharmacy**, and the owner's standing rule is that a false
    positive must never *silently refuse* one. So these are **never** hard-blocked; the desk shows a
    visible "suspected wholesaler" warning and the human decides. The system flags, it never
    auto-rejects — the same discipline the AI evidence check already follows.

  **Why مخزن and جملة live in the venue guard and not in `customer-channel.ts`.** The closing's rule is
  calibrated on distributor customer files and is deliberately conservative: it excludes bare جملة
  («ايه ام جروب الجمله» was ruled a pharmacy there) and treats the **plural** مخازن as a government
  depot — a "never a store" word, a protector. This guard is about field-visited **venues**, a
  different population, where a venue literally named «مخزن X» or «X جملة» is a warehouse. The singular
  مخزن and جملة are added **above** the shared primitives, never inside them; the government plural
  مخازن stays a protector, matched separately.

  **Deliberate scope note — the Super-Admin duplicate-merge picker is NOT filtered.**
  `listMarketingVenueMergeCandidates` (the tool that retires a duplicate marketing venue onto a
  survivor) still lists wholesalers on purpose: hiding them there would remove the only way to retire
  an existing wholesaler row, which contradicts flagging existing ones. Every *validation* picker and
  write path is guarded; the merge/cleanup tool is not.

  **Blast radius on production (measured read-only, `ozucdzovmcqvepbozvqf`, 2026-09-22).** Direct
  orders: exactly **one** human-validated certain wholesaler — `مخزن نيو سيتي` (trusted + verified);
  the owner unwinds it on its own screen (nothing auto-un-validates). Marketing: **zero**
  human-validated wholesalers — four certain trade-phrase names and three suspected «X فارما»/الجمعيه
  names all carry only `system_validated` links (no human looked), so the guard simply blocks the
  certain ones going forward and flags the suspected ones. Pinned by
  `tests/wholesaler-venue-guard.test.ts`, wired as its own `runTest` line in `tests/run-tests.ts`.
  `wholesaler-makhzan-never-shown-or-validated-as-a-venue`

- 🔴 **Marketing pharmacies are TERRITORIAL, and a NULL `area_id` makes one invisible.** Seeded rows
  carry no area and so appear nowhere at all. **Owner rule: the REGISTERED CODE beats live GPS.**
  `seeded-marketing-pharmacies-have-no-area-and-are-invisible`

- 🔴 **A licence verdict is PERMANENT and has no correction path.** It is write-once at approval: the
  write gate requires the caller to hold the request's *current* approval step, and once the request
  is decided that step stops existing — so not even a Super Admin can correct a wrong verdict, and it
  is then displayed indefinitely on a register. **Ask the owner before the first one is recorded.**
  The counts live in the memory file deliberately, because a hook whose content is a number is one
  that will one day be wrong. `a-licence-verdict-is-permanent-and-has-no-correction-path`

- 🔴 **`system_validated` means NO HUMAN LOOKED.** The admin register never blocks on it, and the
  screen is **Super Admin only** — not SFE. `marketing-system-validated-means-no-human-looked`

  **A person's Approve writes `admin_approved` — owner decision 2026-09-17, asked in chat as
  multiple choice.** Until then `approveCustomerPharmacyLink` (the Approve button on Customer
  Pharmacy Mapping, open to the Super Admin and the CEO) moved a pending link to `system_validated`,
  and only an `Approved: ` / `Approved by ` line in `validation_notes` told a human ruling from the
  evidence gate. He was offered reusing `sfe_validated` (no migration) and chose a new status
  instead, because every `sfe_validated` link then was a desk entry — 11 direct, 6 siblings that
  inherited a desk status in the 2026-09-08 code backfill — and reuse would have mixed his rulings
  with them. The status is LINK-only (the database check on `marketing_customers` and
  `marketing_pharmacies` does not allow it), and every reader that decides "validated" for a link
  takes it from `LINK_STATUS_PRECEDENCE` in `src/lib/marketing-requests/code-link-reach.ts`, with
  `CUSTOMER_PHARMACY_VALIDATED_STATUSES` in the mapping module pinned equal to it by a test. At the
  time of the change the button had written **0** approvals in production, so nothing needed
  relabelling; any approval made before the deploy is found by its note stamp and is his to decide,
  never a SQL relabel.

- 🔴 **A venue's evidence was WRITE-ONCE, writable only at insert** — fixed in #2352. **AREA governs
  both sight and reuse; never backfill ownership.**
  `marketing-venue-evidence-was-writable-only-at-insert`

- 🔴 **The badge read a FROZEN note, never the live evidence** (#2354). EITHER half reaching
  `complete` clears it, so setting both halves is a no-op.
  `marketing-badge-read-a-frozen-note-not-the-live-evidence`

- 🔴 **A duplicate merge STRANDS the desk validation on the retired row.** The links move; the
  `validation_status` does not — so the surviving row sits `pending` and is invisible in every
  dropdown. Repair it with hand SQL, not code.
  `a-duplicate-merge-strands-the-desk-validation-on-the-retired-row`

- 🔴 **The screen that SHOWS a badge is not the screen a rep can OPEN.** The portal Customer
  **Database** is Super Admin + SFE only — a 403 for the medical reps — while the capture path is
  `/validation`. Check the gate before wiring any `actionUrl`.
  `the-screen-that-shows-a-badge-is-not-the-screen-a-rep-can-open`


## Relocated from an orphaned memory — 2026-09-04

The memory file `not-every-distributor-uploads-every-month` was written on 2026-09-04 and never
given an index line, so no session loaded it. `pnpm run repo:doctor` reported it as the repository's
only orphan. It is an owner rule about how a number is read, so it belongs in §4; the hook is there
and the account is here.

### 🔴 Not every distributor uploads every month — "N of 17 missing" is never a finding

**The rule, stated by the owner on 2026-09-04:** it is not a concept that every distributor uploads
every month. The big feeds are monthly — he named **Ibn Sina, overseas (PS), epda and EGD**. The
rest send when they send.

**So counting a month's uploads against the full distributor list and reporting the shortfall is a
false alarm** — and it is the shape a session produces naturally: 17 distributors in July, 4 in
August, *"14 missing"*, which reads as a broken month when nothing is wrong. The denominator is the
defect. A list of distributors is not a list of obligations.

**Measure the every-month set instead.** Group `source_of_sales_import_batches`
(`status = 'validated'`) by distributor and period, keep the distributors present in **every** prior
month, and ask which of those are absent. On 2026-09-04 that was **12 every-month distributors
(Jan–Jul), 2 already in for August, 10 outstanding worth roughly 6.6M EGP** of typical monthly
import value — Marcyrl 2.55M, Ibn Sina 1.64M and Direct (Company) 1.50M being 5.7M of it. That is a
real, rankable answer that names what to chase; *"14 of 17"* was not.

**Cadence: files land across the first two weeks, not on the 1st.** July's seventeen arrived between
2 and 12 August. A thin upload count in the first week of the following month is **mid-collection,
never lateness** — do not raise it as one. The closing follows the last file, not the calendar: the
closing golden rule (§4) sets the *earliest* publishable date, not the actual one.

**Two distributors have simply stopped and are not missing files.** `chimipharm` last appeared in
May, `EPDA-BULK` in June. EPDA-BULK averaged 4.83M/month, and EPDA-Pharmacies came in for August at
12.0M against its own 2.83M average — consistent with one feed folding into the other, but
**unconfirmed**. Never read a stopped feed as an outstanding one, and do not report the fold as
established until the owner confirms it.

**Why the two big figures are not comparable.** A month's import value of roughly 60M collapses to a
~10M tracked-line rollup, because Head Office is deliberately absent from both the weekly and the
monthly tracking (see the Head Office golden rule) and only CNS, Anti Infective and Pedia are
tracked. Quoting import value beside closing value as if one should equal the other is a second way
this data produces a false alarm.

`not-every-distributor-uploads-every-month`

## A rejection notice is never sent automatically — owner decision, 2026-09-05

**What he said.** Phase 6 of the ATS plan named the rejection notice as *"the real gap and the one
with reputational weight"* — 97 candidates rejected and never told. The work was built up to the
point of a recipient list, both sheets were sent to him for sign-off, and his answer was one line:

> i dont want to auto send rejection notice

No qualifier, no "not yet". It was asked as a direct question and answered plainly, so it is
settled. **Do not re-pitch it**, and do not treat the 97 as a backlog with a missing send path.

**Why the code went the same day.** The rule is what matters, but a rule that leaves working
machinery behind does not survive: the next session finds `planRejectionNotice`, sees a finished
function with tests and no caller, and reads that as unfinished wiring rather than as a decision.
That failure mode was hit twice in this same session — an orphaned "Application link" button whose
route was never written, and an ATS offer stage that records an offer and sends nothing. So
`src/lib/recruitment/rejection-notice.ts` and `tests/recruitment-rejection-notice.test.ts` were
deleted rather than left dormant.

**What was deliberately kept, and why it is not a leftover.** One export from that module had a
consumer: `isBatchActor`, which tells an automated sweep apart from a person by the `ops:` prefix on
`ats_candidate_status_events.actor_hr_id`. It now lives in `src/lib/recruitment/batch-actor.ts`
under a name that says what it does, with `tests/recruitment-batch-actor.test.ts` registered in
`tests/run-tests.ts`.

It is load-bearing. The screening throughput trend shipped hours earlier without it and read **138
decisions for the week of 08-29 against a true 73**, because `ops:non-egyptian-reject-20260828` had
rejected 65 candidates in one pass — telling the owner his backlog had shrunk by 69 when it had held
level at −4. The same artefact reached the hiring-analytics plan, where "email converts at 50%
against WhatsApp's 16%" was really 23% against 18% once the sweep came out. Five mutants were run
against the new suite before merge and all five failed with their own headline message, including
both pins on the live fix in `candidates.ts`.

**Two traps a future session should not walk into.** The batch marker exists ONLY on the status
event — all 65 swept candidates carry a NULL `ats_candidates.status_changed_by_hr_id`, so a caller
reading the candidate row concludes "not a batch" and is wrong about every row that matters. And the
match is on the `ops:` PREFIX, never on a sweep's full name: pinning the name would pass the next
batch straight back into the numbers with nothing to show that it had.

**The two sheets he was sent stay.** `xlsx/Rejection notices - decide who gets one.xlsx` (18 by
email) and `xlsx/Rejection notices - WhatsApp.xlsx` (14) are in `xlsx/`, which git does not track and
cannot recover. They are a record of what was asked, not a pending job.

## Section 4 was trimmed to its floor — 2026-09-01

**What was done.** §4 (with §4.1) went from **14,264 → 13,995 bytes, −269 B (1.9%)**, and a further
**−130 B** came out of §0 where two §4 rules were stated a second time. `AGENTS.md` total −399 B.

**Nothing was reworded that carries a rule.** Every one of the fourteen edits removed a date, a PR
number, or connective filler. Verified mechanically against `origin/main`: **50 bullets before and
after, 10 🔒 markers, 11 🔴 markers, 14 slugs, 30 memory files still reachable — all unchanged.** A
sweep of the imperative vocabulary (`NEVER`, `never`, `Never`, `must`, `do NOT`, `DELIBERATELY`,
`LOCKED`, `ONLY`) found **no count changed anywhere in the section**.

**Every owner quotation was kept verbatim** — *"golden rule, no negotiation"*, *"The old monthly
closing sheet don't mess it. Anything we will do will be aside it."*, *"NO LEAVE ME AS I AM NOW."*,
*"once submitted, once accepted."* Those are the authority behind the rules they sit in; only the
date stamp in front of them went.

**The dates and PR numbers removed are all recorded in this file**, checked before each cut:
2026-08-03 (XLSX-with-dropdowns), #2608/#2613/#2665 (Delta 3 resolver and recruitment), 2026-08-29
(the August golden rule), 2026-08-31 (the frozen closing export), 2026-08-28 and the $420/month
figure (Turbify — the figure was **kept** in `AGENTS.md`, only the date went), #2160 (the Cairo
per-diem), 2026-08-23 (the organogram Mobile column), 2026-08-26/2026-08-29 (venue validation),
#2434, #2352, #2354 (§4.1). §4's own preamble already says incident narratives, PR numbers and
production measurements live here, so this is the section's stated rule applied to itself.

**Load-bearing dates were NOT touched.** The Delta (3) bullet keeps *"LIVE, dated 2026-09-01,
applied as a migration 2026-08-29"* and *"nothing is owed on 1 September"*, because there the dates
**are** the mechanism — the move sits on a dated pair and the closing gate resolves on the date, not
the run time. The same reasoning kept every threshold a session judges against.

**The two §0 duplicates.** §0's calibration paragraph repeated two rules that §4 states as bullets:
*"Reply in English always, whatever language he writes in"* (§4, How to answer) and *"Never hand
back a list of manual steps you could have executed yourself"* (§4, How to take work — *"Take
ownership. Automate the work rather than returning a checklist he has to execute."*). §4 is the
canonical home for a standing rule, so the §0 copies went and the §4 bullets stayed. Reach is
identical — the whole file auto-loads — so this cost scannability in the narrative section only.

**§4 has no structural fat left**, the same finding as §2.1. It is 50 bullets in 13,995 bytes, ~280
each, and the length is real: these are compound rules with the counter-case attached ("do this, and
here is the thing that reads like a reason not to"). That counter-case is the part that stops a
session undoing the rule, so it cannot be cut. The measured yield was 1.9%, and a third of the total
came from two duplicates rather than from wording. **Do not run another editing pass over §4** — the
remaining bytes are the rules themselves, and the cost of blunting one of them is far higher than
the context they occupy.

### A wrong distributor code is a typo, not a rep gaming you — measured 2026-09-29

He asked it in his own words, after two captures were held on a governorate mismatch:
*"انا عايز اعرف دلوقتي الغلطات دي في الكود ولا الريب بيشتغلني"* — are these bugs in the code, or
have the reps found the hole and started working me? The answer is the code, and it is measured
rather than reasoned.

**The distances refute gaming outright.** Every validated customer↔pharmacy link carrying GPS on
both sides, 127 of them:

| | metres |
| --- | --- |
| median | **23** |
| p90 | 272 |
| maximum | **1,069** |
| over 2 km | **none** |
| within 100 m | 102 of 127 |

A rep attaching a big-selling pharmacy that is not really his doctor's would show up as distance.
There is none. Nor is anyone farming one shop: the most any pharmacy is attached to is **3**
customers, and those are hospital pharmacies (Tabarak, مستشفى فيكتوريا) that genuinely serve many
doctors.

**Both incidents were the right shop and the wrong number.**

- **Samaa Shalaby, 2026-09-29** — typed Ibn Sina `443359` (احمد عبدالشافى, Haram/Faisal, Giza) and
  meant `442359` (اسعد جديدة, ناحية نشوة, الزقازيق). **One digit.** Her clinic and her pharmacy
  were **18 m** apart, both in Sharqia.
- **Taha AboElftouh, 2026-09-23** — typed POS `1510270`, a real pharmacy in شربين، الدقهلية, while
  standing at house 75 of his doctor's own street in 6th of October City, the doctor at 74.
  **59 m.** The right code was `0001575484`.

**The root cause is the capture flow, not the person.** The code is typed free-hand from memory,
and it is verified only *after* the save and only at governorate level — so a slip has no chance of
being caught at the one moment the rep could still fix it. Two things shipped that night:

1. **The GPS-ranked code picker** (#4797) — candidate codes ranked by the rep's own position, area
   tier first then governorate, **nothing filtered out**. The right code now ranks first instead of
   being remembered. Ranking the governorate tier goes through the canonical `resolveGovernorate`,
   because Google answers in English and the reference import is in Arabic — a first attempt scored
   Samaa's own correct capture as "elsewhere".
2. **The 4 km hard block** — his own figure. A tighter proposal was put to him and he refused it in
   three words, *"no it block many"*, then chose 4 km from the options.

🔴 **The block would have caught neither incident, and that is the point.** It exists to stop a
venue being linked to a customer on the other side of the country; it is not, and must never be
tightened into, a control on the wrong-code class — the picker is what addresses that. **Where a
rep genuinely could hide is a code that resolves to nothing**, so no sale can ever be attributed to
it; that is the set worth auditing, not the geography.

**And the reporting rule that falls out of it:** before calling any code mismatch suspicious,
measure the customer↔pharmacy distance. A shop metres from the doctor is a typo on a real visit,
whatever the code says. His own standing rule on the integrity board applies here too — a false
positive accuses a real person of fraud, which is worse than a missed catch.

### The marketing code resolver runs once, at capture, and nothing re-runs it

`phx_resolve_marketing_pharmacy_codes` resolves a distributor code against the sales master **at the
moment the rep saves**, and there is no path that revisits it. The verdict is frozen there.

**Measured 2026-09-29.** Ibn Sina `421993` («صيدليات لايف - د/ احمد علي حسين», Kafr El-Dawwar):

```
code row resolved   2026-08-24 12:34:50  ->  "unresolved"
master learned it   2026-09-18 22:28:25      25 days LATER
```

The rep's code was correct the whole time — the master holds `IS 421993` = «احمد على حسين»,
«ش صلاح الدين مركزكفرالدوار», the same street he captured on. It simply read untrackable for a
month. Seven code rows were in that state, four of them inert import rows. **So any count of "codes
whose sales cannot be traced" is inflated by rows that became traceable after their one resolution**
— an earlier report of 16 was really 12, and reporting the raw number as a problem acts on an
artefact.

**Three things a repair must not do.**

1. 🔴 **Never mass re-resolve.** A code the master knows may belong to a *different* shop: `1536256`
   («صيدلية زمزم») resolves to «ايمن فايز / المهندسين», so a blanket sweep would attach that capture
   to someone else's sales.
2. 🔴 **Read `validation_notes` before touching a row — `unresolved` can be a signed human verdict.**
   `0001570071` («خالد السيد موسى») carries Khaled Bedair's (SFE Manager, A-2) investigation of
   2026-08-26, proven with Pharma Overseas invoices `9114638229` and `9118278169`: the pharmacy has
   no 2026 trading, so the row is `manual_approved` / `unresolved` **deliberately**, and its area
   `D12` is retained on purpose because it describes the venue's GPS. Re-resolving it overwrites a
   person's considered decision with a value that note rejects. That instruction was given and
   refused on those grounds, and the refusal was right.
3. 🔴 **Re-resolving writes `mapped_*` only — moving the venue's own `area_id` is a separate act**,
   and the master's area can contradict the capture's GPS (`IS 421993` maps to `AB1` Alex East while
   the shop is in Kafr El-Dawwar, Beheira — he filed it `AB5` on the GPS). **When the venue moves,
   the doctor moves with it**, or you have created the split you were closing.

Re-resolve a single row through the system's own function, never a hand-written mapping:

```sql
select * from phx_resolve_marketing_pharmacy_codes(array['<code row id>']::uuid[]);
```

## The offer letter design is frozen — owner decision, 2026-09-05

Asked directly, having been shown both letters rendered from the live code, and answered:
*"donot change in offer design"*.

### What was put to him

A house-identity sweep had just moved the payslip and the deduction exports onto
`SATO-DIS-2026-01 v1.0`, and the offer letters were the obvious next candidate. They are
measurably off that standard, and the deviation is not subtle:

| | Offer letters | House standard |
| --- | --- | --- |
| Palette | `#0b86be`, `#8ed4ef`, `#111820`, `#9ab6c7` | `#0A527D`, `#0A6BA6`, `#1482C2` |
| Mark | `sato-pharma-logo-on-light.png` (raster) | the vector, since 2026-09-05 |
| Corners | a `border-radius: 50%` initials disc | square everywhere |
| Ink | 6 painted areas (classic) and 7 (executive): navy bands, a filled table header, tinted rows, a gradient divider | lines and type, plus one 6% tint |

`house-identity.ts` even names them in its own docstring — *"the job-offer letters were on a
different blue entirely"* — which reads as a known deviation waiting to be tidied up.

### Why the answer was no, and why that is right

**The classic template reproduces a letter he SIGNED.** Its description in
`builtin-templates.ts` is "the signed Dr Samaa letter". Its look is not an artefact of how the
code grew; it is a document that went out under his name and was accepted.

**The executive template's navy bands ARE its design.** It is described as "the Ultra Premium
letter — navy bands, tinted salary table, welcome band". The ink rule's first act would be to
delete exactly those three things, which is not a cleanup — it is removing the premium look from
the premium letter.

An offer is also the one document in this codebase whose reader is a STRANGER. The contract, the
payslip and the deduction exports are read by people who already work here; an offer is read by a
candidate deciding whether to. The owner has already ruled once on that basis — offers speak as
Sato Pharma and never as Phoenix (`src/lib/offers/identity.ts`) — and this is the same judgement
applied to the design.

### The hazard this section exists to stop

The house identity is deliberately written as a company-wide standard, and its own comments flag
the offer letters as off it. A future session doing a sweep will find them, read that line as a
TODO, and "finish the job" — reversing an owner decision while believing it is enforcing one. The
rule in `AGENTS.md` §4 is the stop, and it is phrased as a boundary on the standard rather than as
an exception to it: **the house document identity does not reach `src/lib/offers/`.**

Nothing was changed. `git status` over `src/lib/offers` and `app/api/offers` was empty at the end
of the session that asked.

## Down town stays in the El Qema Qalubeya split — owner ruling, 2026-09-07 (SUPERSEDED)

🔴 **REVERSED THE NEXT DAY. Down town (`CA5`) is now OUT of the El Qema split on Pedia — see "The
warehouse split (تقسيمة المخازن) — owner ruling, 2026-09-08" below, and its "Amended the same day"
subsection.** On 09-07 the owner ruled Down town INTO the Cairo split because the divisor is AREAS and
not reps. On 09-08, shown that the Pedia organogram files Down town under Others, he confirmed it comes
out with the rest; the divisor is still areas, there are simply fewer of them. `AGENTS.md` §4 and
`src/lib/sales/store-sales-city-split.ts` both carry the current rule, and
`tests/qema-warehouse-split.test.ts` pins it.

**Kept, not rewritten, and worth reading anyway.** This section is a dated record of what was decided
and measured on 09-07 — the 8,768-unit reconciliation below is still the evidence that El Qema's
customers are its warehouses. What changed is only where Down town's share goes. Read it as history;
do not act on its title.

The hook lives in `AGENTS.md` §4 beside the El Qema rule. This is the account, and it exists
because **the evidence a future session will find points the wrong way**.

### What was measured

His August 2026 Pedia manual closing was reconciled against the Phoenix closing on 2026-09-07.
Both sides held El Qema at exactly **8,768 units** — his file labels those customers `POS`, but the
rows carry El Qema's own customer names and split out to 8,768 against 4,312 for true overseas,
which are Phoenix's two figures to the unit.

The one structural disagreement was the Qalubeya warehouse `الفرسان بنها جملة(ت2)`, 4,532 units:

| | Divisor | Per area | Down town |
| --- | --- | --- | --- |
| His manual sheet | **6** | 755.333 | **excluded** |
| Phoenix | **7** | 647.43 | **included** |

His six were Qalubeya, Heliopolis, Nasr City, Cairo East 1, Cairo East 2 and Cairo West. The effect
on the closing was large and localised: Down town read **30 units** on his sheet against **1,011** in
Phoenix, with the other five Cairo areas each about 167 units higher on his side, and Qalubeya 158
higher. Those six differences sum to exactly what Down town was short — one number moving, not six.

### Why Down town is the tempting one to drop

`CA5` is the only Cairo area with **no Pedia rep seat at all**. The other five hold a seat with no
occupant. The rule as originally written only said the divisor is areas *"even when the seat is
VACANT"* (`حتى لو فيها فاكانت`), and a seatless area is not a vacant one — so a session comparing
Phoenix against the owner's own spreadsheet would read Phoenix as over-spreading and "correct" it to
six, reversing a decision rather than fixing a defect.

### The ruling

He was shown the gap and the reason, and ruled for seven:

> down town should be included because we split in reference to areas not actual reps

So the divisor is AREAS whether the seat is vacant **or does not exist**. He also confirmed the same
day, on the decision sheet, "Use the Phoenix answer" for this question and marked all 35 El Qema
rows "Phoenix is right — I will fix my sheet". The correction is to his file, not to the system.

### What holds it

`tests/qema-warehouse-split.test.ts` (named `qema-qalubeya-split.test.ts` until the rule was
replaced on 2026-09-08) carries the `CA5` assertion forward, naming it — so removing Down town fails with an explanation rather than
just going red. Both run in the required CI `test` job.

## El Qema leaves no trace in a closing detail — owner ruling, 2026-09-09

> I want the El Qema to be shown in the achievements only, never show in details, never show in
> details… at the end of the day they should never appear, never anyone know that these sales are
> from Al Qimma, but they appear in their total and achievements but not in the details. No any
> traces for Al Qimma detail. Never anyone know. I don't know how you can do it, but never.

Two questions were put to him and answered the same day.

**How far does it go?** Hidden from everyone, kept underneath. No sales manager, rep, product
manager or auditor sees El Qema in the closing detail, the Store Split sheets or any export. The
import batch and the raw rows keep the true source, readable by Super Admin alone. He chose this over
stripping it at import, which would have ended any reconciliation against El Qema's own invoices and
stopped a future El Qema rule from ever reaching a past month.

**What do the columns say instead?** Blank. He was shown that an empty column in a full sheet is
conspicuous and invites the question, and chose it over a neutral code anyway.

### The one thing that was declined

He offered a third way: *"you can mix them between distributors and change the distributors and sign
them by any sign"*. Relabelling El Qema's invoice lines as Ibn Sina or EGD puts false records into
the monthly closing, which is the auditor's file by his own standing rule. A supplier reconciling
their own invoices against it would find quantities that do not exist, and the discrepancy would land
on the wrong company. It is also irreversible: the true source would be gone. He was told this and
chose the blanking option instead, so the decline is settled rather than open.

### Why placement is the whole difficulty

Both mistakes are silent, and they fail in opposite directions.

| Mistake | What happens | What you would see |
| --- | --- | --- |
| Masked too early | the split stops recognising El Qema, so its rules do not apply | different numbers, no error |
| Masked too late, or not at all | the identity reaches a screen | correct numbers, broken rule |

So `loadMonthlyClosingDetails` masks BY DEFAULT, and `revealSource: true` is passed by exactly one
file: the closing export route, which computes the split from those rows before writing them and
masks again on the way into each workbook. Everything else either runs as `scope: "system"`, which
reveals by scope, or renders, and a render must never reveal.

The Store Split sheets need their own treatment because a split entry carries no distributor at all
— it is grouped per customer and product. Masking the rows first would fold every El Qema customer
into one blank-coded entry AND stop their split rule applying. So the split is computed from the real
rows and the answer is masked by client code.

`tests/closing-source-mask.test.ts` pins the exact list of files that reveal, so adding one is a
deliberate act somebody has to justify rather than a habit. Proved red by flipping the loader's
default.

### The standard workbook's distributor sheets keep the money under `—` — owner, 2026-09-14

The Data sheet was clean, but the sheets built from the closing COMPARISON were not. A CEO's Pedia
August 2026 download — built from production data and read cell by cell — named El Qema on
Distributor Comparison (20 cells), Rankings & Mix (7), Summary & Insights (3, including "El Qema
leads the line with 69.9% of value (EGP 2,367,360)"), Gaps & White-Space (2), Source Coverage (1) and
the hidden-not-protected Calc sheet (84 rows starting `QM`). The comparison and coverage loaders took
no viewer at all, so nothing could have masked them.

He was asked: remove El Qema from those sheets completely (their totals fall short of the Closing
Matrix by its value), or keep its money under a blank distributor (totals and shares stay exact, an
unnamed distributor holds most of Pedia). **He chose keep the money, no name.** El Qema's leaves are
relabelled `—` — distributor code, customer code and customer name — after the scope and before the
assembly, so every insight, mix label and Calc row is written with `—`. Both comparison loaders and
`loadMonthlySourceCoverage` now REQUIRE a viewer, so a new caller cannot forget. This is a different
answer from the detail rule's removal, for a different surface; neither is a precedent for the other.

### Still open

The Source of Sales dashboard's distributor breakdown and the import batches list were not covered by
this change. The batches list is Super Admin only already; the dashboard breakdown has not been
checked and may still name El Qema.

## The three bands, the صعيد pass and the lead guarantee — owner ruling, 2026-09-09 evening (CURRENT)

This is the live El Qema rule. Every El Qema section below it is history, kept dated and unrewritten.

He restated the whole thing from scratch, in Arabic, unprompted, and when asked whether to keep any
of the existing rules alongside it he answered **"remove any current rule and implement those"**,
then **"start it now"**.

> نظام توزيع القمه الموحد — 3 خطوات بالترتيب
>
> الخطوة الأولى: اي مخزن اقل من 200 علبه حتي 200 علبه يقسم علي مندوبي المحافظة
>
> الخطوة الثانية: اي مخزن من 201 حتي 999 — 50% يقسم علي مندوبي المحافظة والكلام ده ينطبق علي
> القليوبية (القليوبية + القاهرة)، 50% الاخري تقسم علي باقي الجمهورية بالتساوي
>
> الخطوة الثالثة: اي مخزن من 1000 علبه فما فوق يقسم علي مندوبي الجمهوريه بالتساوي وليس Others
>
> بالنسبه لتقسيم القمه للصعيد: هناخد كل البيع اللي محسوب للصعيد و نعيد توزيعوا 50% منه لكل
> محافظات الصعيد بالتساوى، وال 50% الباقيه يوزع علي الجمهورية مع الحفاظ على منطقة القليوبية
> الاولى و الثانية طنطا لابد ان يكونوا اكبر نسبة contribution

The band is judged on ONE warehouse, ONE product, for the whole month, in the area the closing books
it in — `warehouseSplitKey`. Not per invoice line, and not per customer across two areas.

### The صعيد pass, and the two things about it a reader gets wrong

Everything the bands credit to Upper Egypt is pooled. Half returns evenly across the Upper Egypt
areas, half spreads over the country.

🔴 **It TAKES money out of Upper Egypt.** Nine areas hold the pool before the pass and share half of
it after, so an Upper Egypt area lands BELOW an ordinary away area. Reading the rule as a top-up for
Upper Egypt is the misreading to expect, and the test asserts the direction so acting on it fails.

🔴 **"الجمهورية", not "باقي الجمهورية".** He wrote the second half as THE republic, where step 2 says the
REST of it. An Upper Egypt area is therefore in both halves. Reading it as "the rest" would move
money out of the region the sentence exists to protect.

🔴 **It runs in EVERY band, including the first.** "كل البيع اللي محسوب للصعيد" — all of it. A
100-pack Minia warehouse is a step-1 sale that step 1 alone keeps inside Minia; the second rule then
takes it national. That is his second rule acting on the first rule's output, not a contradiction.

### 🔴 Upper Egypt cannot be read from August's region codes

On Pedia the `UE` operational region holds only Minia 1-2, Assuit 1-2, Sohag 1-2 and Qena 1. **Fayoum
(GZ6) and Beni Suef (UE9) sit in the GIZA region** until the Upper Egypt split dates in on
2026-09-01 — and he named both, by name, as Upper Egypt on the same morning
(*"look fayoum bani suef and all upper egypt regions"*). A region-code read drops exactly the two
areas he was thinking of, silently.

`UPPER_EGYPT_AREAS` therefore carries the same membership the August / Upper Egypt golden rule pins
for UE-1 and UE-2, and `upperEgyptAreasFor` widens it with any UE-prefixed region the organogram
holds, then subtracts Others. **Nine areas in August** (Qena 2 and Luxor are parked in Others),
**eleven from September**, with no code change on the day. Aswan is not Upper Egypt for this rule.

### 🔒 THE LEAD LADDER — Qalubeya first, Tanta and Mahalla level behind it

> مع الحفاظ على منطقة القليوبية الاولى و الثانية طنطا لابد ان يكونوا اكبر نسبة contribution

Asked which areas he meant, he chose **Qalubeya (D11), Gharbia 1 / Tanta (D14), Gharbia 2 / Mahalla
(D15)**.

🔴 **THIS WAS BUILT ONCE AS A REPORT AND HE REJECTED THAT, IN THOSE WORDS.** The first build
implemented the bands and the صعيد pass, measured the three at ranks 22, 20 and 21, and put the gap
back to him as a question. His answer was *"didn't I tell the fuck out of you that those three areas
Tanta, Mahalla and Al-Yubayya should be the biggest contribution in all areas"*. **"لابد" is a
requirement.** An outcome he states is a rule to enforce, not a finding to report — and he had
already said it once inside the ruling itself, so it was said twice before it was built.

**How it works.** After the bands and the صعيد pass the named areas are lifted onto a LADDER and
everyone else is scaled down pro rata to pay for it. Qalubeya takes one **2%** step more than Tanta
and Mahalla, and those two take one step more than the highest other area. Within a tier the members
are level, so Tanta never sits behind Mahalla.

🔴 **"QALUBEYA NUMBER 1" IS A SECOND RULING, AND IT COST A ROUND TRIP TOO.** The first build put
all three on ONE figure, which satisfied "they must be the biggest contribution" but left the display
order to the sort — so Qalubeya read THIRD of three at the same percentage. He answered in two words:
*"Qalubeya number 1"*. A tie is not a rank.

🔴 **IT CANNOT LIVE IN `splitTargetsFor`, AND THE ARITHMETIC IS WHY.** A plan is one customer's
sale; contribution is the month. A per-row floor is infeasible on a small plan — a 150-pack
Alexandria sale divides across three areas, and no three OTHER areas can each hold more than the
largest of three shares of one. So the guarantee runs once over the finished landing, per line and
per product. Per product because a unit total means nothing across products, and leading product by
product implies leading on the line, since Σ max ≥ max Σ.

🔴 **THE STEP IS A FIXED POINT.** Paying the three shrinks the area they have to beat, so
taking 2% of the field as it stood BEFORE the move overshoots — measured on August it landed them
5.4% clear when he asked for a very small scale. The shipping code iterates to the fixed point; the
test solves the same equation as algebra, which is a genuinely different derivation:

    need = P·(T·S − ΣL) / (P + T·S),   S = Σ k^(n−t)·m_t   over tiers t of size m_t

⚠ **THE DETAIL SHEET AND THE IMPORT PREVIEW DO NOT SHOW IT**, and that is correct rather than a
bug: both describe one customer's sale being divided, and a month-level adjustment is not a property
of any one sale. The Matrix, the attribution net and the closing all carry it.

⚠ **A lead area parked in Others is dropped from the guarantee rather than lifted.** Others
take nothing is his rule too, and it is the older of the two.

### August 2026, measured

8,768 packs and 2,367,360 EGP over 38 areas, landing exactly, with **no area going negative** — the
Fayoum and Suez negatives the ladder produced are gone. The band mix by packs: **1,164** in step 1,
**960** in step 2, **6,644** in step 3.

| | Contribution | Note |
| --- | --- | --- |
| **Qalubeya** | **3.599%** | rank 1, one step clear of the pair below |
| **Tanta, Mahalla** | **3.528%** | ranks 2 and 3, level, one step clear of the field |
| Alexandria × 3 | 3.459% | led at 3.565% before the ladder |
| Cairo × 5 | 3.136% | |
| Upper Egypt × 9 | 1.987% | every one identical, Fayoum and Beni Suef included |
| Ismailia | 0.274% | in Others: keeps its own 24 packs, receives nothing |

Without the guarantee the same book put Alexandria first at 3.565% and the three named areas at
ranks 22, 20 and 21 — Qalubeya on 2.630%. **Qalubeya's own 6,644 packs buy it nothing**, because
every one of them is band 3 and step 3 pays every area the same. That is why the guarantee exists
and why no weighting inside the bands could have replaced it.

### ⚠ Why the 75/25 was never the answer to the lead requirement

It only ever applied in bands 1 and 2, and Qalubeya's sales are band 3, so re-adding it moves
Qalubeya by nothing worth measuring. Reaching for it when the three are not on top is the obvious
move and it does not work.

### What this removed, all of it his, none of it a bug to restore

| Rule | Given | Removed by |
| --- | --- | --- |
| The priority ladder, four rungs one 2% step apart | 09-09 afternoon | this ruling |
| Qalubeya + Cairo weighted 60/40, then 75/25 | 09-07, 09-09 | this ruling |
| The Upper Egypt pool (Fayoum - Beni Suef as one member) | 09-09 morning | #3606, and replaced here by a different shape |

⚠ **Neither the pool nor this pass preserves "fayoum-banisuef one region."** They are two areas
taking two shares; the closing folds them into one row downstream for display only. Under the صعيد
pass they land on identical numbers anyway, which is as close as the evening rule gets to the
morning one.

### 🔴 A display fold corrupted the attribution net, and it was not this rule

Pedia shows Fayoum (`GZ6`) and Beni Suef (`UE9`) as one row, and `loadMonthlyClosingDetails`
delivers that by rewriting a Beni Suef row's `sheetAreaCode` to `GZ6`. Inside the closing it is
self-consistent, because the matrix folds the same pair. `au.monthly_attribution_rollup` does NOT
fold — it keys on the real area — so a net built from folded rows charges Beni Suef's whole book OUT
of Fayoum while attribution credits Beni Suef its own base. **Fayoum landed at −24.95 units on a
base of 64** on 2026-09-09.

It predates this rule and merely stayed positive: under the priority ladder Fayoum's net was
−29.44 against the same base. Fixed with `keepMergedAreasApart`, passed by exactly the two
attribution-net builders and pinned by `tests/merged-area-attribution.test.ts`. **Any future merged
pair will do the same thing** — a fold made for a screen must never reach a net keyed on the real
area.

### Where the numbers live

`WAREHOUSE_NATIONAL_SPLIT_THRESHOLD_QTY`, `WAREHOUSE_NATIONAL_SPLIT_FLAT_QTY`,
`WAREHOUSE_NATIONAL_SPLIT_HOME_FRACTION`, `LOCAL_BLOCK_OVERRIDES`, `UPPER_EGYPT_AREAS`,
`UPPER_EGYPT_HOME_FRACTION` and `redistributeUpperEgypt` in
`src/lib/sales/store-sales-city-split.ts`, pinned by `tests/qema-warehouse-split.test.ts`.

🔴 **The صعيد pass is a WEIGHT ON THE PLAN, never a pass over the split loop.** Five surfaces read
that plan — the Matrix, the attribution net, the Detail sheet, the import preview and
`isSplitEligible` — and a redistribution applied in the loop would have been invisible to four of
them. That is the exact shape of the Matrix-versus-Detail disagreement this module's header warns
about. The Detail sheet also stopped re-deriving the band from a quantity of its own, because once
the redistribution runs no quantity implies the answer.

🔴 **The test derives every expected share TWICE.** `referenceQemaShares` is a second reading of his
words sharing no code with the engine. Three earlier versions of this rule shipped with tests that
asserted the engine against itself. Proved red on three mutations: the "rest of the republic"
misreading, the 75/25 put back, and Upper Egypt read from region codes alone.

## The unified distribution (نظام توزيع القمه الموحد) — owner ruling, 2026-09-09 morning (the FIRST statement of the bands)

ℹ **Superseded by the priority ladder for one afternoon, then restored, and the restored version is
the section at the top of this file.** Kept as the dated record of how the bands were first put and
what was measured then. Where this and the top section disagree, the top section wins — the
difference is the صعيد pass, which did not exist yet, and the 75/25, which no longer does.

He restated the whole thing as three ordered steps, unprompted:

> نظام توزيع القمه الموحد — 3 خطوات بالترتيب
>
> الخطوة الأولى: اي مخزن اقل من 200 علبه حتي 200 علبه يقسم علي مندوبي المحافظة
>
> الخطوة الثانية: اي مخزن من 201 حتي 999 — 50% يقسم علي مندوبي المحافظة والكلام ده ينطبق علي
> القليوبية (القليوبية + القاهرة)، 50% الاخري تقسم علي باقي الجمهورية بالتساوي
>
> الخطوة الثالثة: اي مخزن من 1000 علبه فما فوق يقسم علي مندوبي الجمهوريه بالتساوي وليس Others

| Band | Quantity, month total per product | Where it goes |
| --- | --- | --- |
| 1 | up to 200 | the local block only |
| 2 | **201 to 699** | half the local block, half evenly over the rest of the country |
| 3 | **700 and above** | flat: every area in play takes an identical share, origin included |

⚠ **THE THIRD BOUNDARY MOVED FROM 1,000 TO 700 ON 2026-09-10**, in his own words: *"201 to 699
… 700 and above"*. Only the boundary moved — the three steps, the Qalubeya + Cairo block, the صعيد
pass and the lead ladder are all untouched. **His Arabic above still reads 999 and 1000 and is left
that way on purpose**: it is a dated quote of the 2026-09-09 ruling, and this file keeps his words
rather than a tidied version of them. The constants are the live rule.

🔴 **ON AUGUST 2026 IT CHANGES NOTHING, MEASURED.** No warehouse-and-product month total lands
between 700 and 999 — the book's key quantities are 4,532, 1,056, 1,056, 480, 480 and then nothing
above 120 — so the band mix stays 1,164 / 960 / 6,644 packs and every area lands where it did. The
move bites from September onward. Do not re-run August's backfill expecting a difference.

### The Upper Egypt block — added and WITHDRAWN the same day, 2026-09-09

🔴 **DO NOT REBUILD IT.** For a few hours on 2026-09-09 an El Qema warehouse anywhere in the
organogram's Upper Egypt region treated the whole region as its governorate above 200 packs, the same
shape as Qalubeya reaching Cairo. He asked for it (*"the rule will be the same as cairo + qalubeya but
for upper egypt"*), answered the two questions it raised, saw the numbers, and then said to take it
out. It shipped as PR #3581 and was reverted by PR #3582 the same day.

It is written down here for one reason: the request, the two answers and the measured effect are all
in this file's history, and a session reading them without this paragraph will conclude the rule was
lost in a bad merge and restore it. It was not lost. It was withdrawn.

What it did while it was live, on August Pedia: Sohag 1 and Sohag 2 gave up 171.43 packs each, the
other five Upper Egypt areas took 54.86 each, and every remaining area gained 2.29 because the
national half divided over 30 areas instead of 35. The production split net was backfilled under it
and backfilled again without it; the pre-images of both are in `sos_backup_20260909`.

His two answers still stand as statements of intent should he ever ask for it again: the block would
apply **only above 200 packs**, not at every step; and its membership would come from the organogram,
not from the `UE*` area codes, so Beni Suef would be outside it while Pedia files that area under
Giza. Neither answer is the reason he removed it.

### The two questions that were put to him, and his answers

Both change the numbers, and his message could be read either way on each, so neither was guessed.

**Does the origin governorate still take an equal share at band 3?** Answered yes, one equal share
like everyone. Band 2 says باقي الجمهورية, the REST of the country, against a privileged home half;
band 3 drops باقي entirely and says مندوبي الجمهوريه بالتساوي. So a 5,600-pack Benha product
leaves Qalubeya with 151.35 packs, the same as Aswan, not with 2,800.

**Below 201, does Qalubeya still mean Qalubeya + Cairo?** Answered yes, at every step. He named the
Cairo block only in step 2, but it is a definition of what مندوبي المحافظة means for a Qalubeya
warehouse, not a band of its own. This is also what the system already did.

### What band 3 does to the August book, measured

Every figure below is Pedia, August 2026, with Pedia's real Others set of 12 areas, so 37 areas are
in play and the local block for Benha is 6.

| Quantity | Band | Local share each | National share each |
| --- | --- | --- | --- |
| 200 | 1 | 33.333 | none |
| 700 | 2 | 58.333 | 11.290 |
| 999 | 2 | 83.250 | 16.113 |
| 1,000 | 3 | 27.027 | 27.027 |
| 5,600 | 3 | 151.351 | 151.351 |

El Qema's largest August product line is 5,600 packs of Lacto Advanced 1 out of Benha. Under band 2
Qalubeya kept 466.67 of it; under band 3 it keeps 151.35.

### The trap this rule sets

Band 3 looks like a continuation of band 2, and implementing it that way is silent: the totals still
reconcile, every sheet still balances, and the only symptom is that the origin governorate holds
several times what it should. `tests/qema-warehouse-split.test.ts` therefore checks the number of
DISTINCT shares rather than comparing against expected figures, because a test asserting "the home
share is X and the away share is Y" passes just as happily on the wrong answer with the right X.

The second trap is that two call sites compute this. `splitTargetsFor` builds the plan the Closing
Matrix applies, and `storeSplitDetailRows` rebuilds the same arithmetic for the Store Split sheet.
While the fraction was the constant 0.5 they could each hold their own copy and stay correct, and a
comment in the detail sheet said reading it off the away-block size was what kept them aligned. That
stopped being true the moment the fraction began to depend on the QUANTITY. Both now call
`warehouseHomeFraction`, and the detail sheet judges the band on the same month aggregate the split
judged, not on its own per-origin subtotal.

## The warehouse split (تقسيمة المخازن) — owner ruling, 2026-09-08

**This replaces the Qalubeya→Cairo rule of 2026-09-07 outright.** That rule was one day old. He
opened with "we will change the concept of the qema distribution into تقسيمة المخازن" and then gave
the rule in two halves:

> اولا — اي مخزن لحد 200 علبة per product يوزع علي مندوبين المحافظة وليس له علاقه بتوزيع الجمهورية
>
> ثانيا — اي مخزن فوق 200 باي كميه يوزع 50 % علي مندوبين المحافظة وباقي ال 50% يوزع علي باقي
> الجمهورية بالتساوي ماعدا مندوبين نفس المحافظة اللي اتطبع فيها الاوردر

So, per warehouse, per product, per month: up to 200 packs stays inside the governorate and has
**nothing to do** with the national spread; above 200, half stays in the governorate and half divides
evenly across every other area in the country, with the origin governorate excluded from that half.

### What this reverses, and why each reversal is asserted (TWO ROWS SUPERSEDED)

🔴 **Rows 1 and 3 of the table below were wrong within the day and are kept only as a dated record.** Cairo IS a privileged destination for a Qalubeya warehouse and Qalubeya does NOT hold one area: the 09-07 Cairo block was never retired, and the local block is seven areas (six once Others removes Down town). Read "The unified distribution" below, which is current.

Three properties of the 2026-09-07 rule are now false. Each was load-bearing in the old test, so each
is asserted in the new one in its inverted form — otherwise a session reading the older account in
this file would "restore" them as bugs:

| 2026-09-07 | 2026-09-08 |
| --- | --- |
| Cairo is the destination | Cairo is 6 areas of 49, taking the same share as Aswan |
| One way — Cairo never reaches Qalubeya | Symmetric: a Cairo warehouse over 200 reaches Qalubeya |
| Qalubeya gives up six sevenths | Qalubeya keeps half, and holding one area it keeps all of that half |

What did **not** change, and is re-pinned because a rewrite is when it gets lost: the divisor is
AREAS and not reps, so Down town (`CA5`) still takes a share; every El Qema customer is a warehouse;
and a pharmacy or hospital never becomes one because El Qema invoiced it.

### Scope — asked, and answered narrowly

He was asked whether the 200-pack rule runs on every distributor or only El Qema, and answered:

> any warehouse only in el qema distrbutor .. consider el qema distbutor not warehouse and the
> customers in it vare the warehouses golden rule

Two things at once. The rule is **El Qema only** — "اي مخزن" is scoped by that sentence, not open —
and El Qema is a *distributor whose customers are warehouses*, never a warehouse itself. That second
half is what `WHOLESALE_ONLY_DISTRIBUTORS` already encoded; the threshold set is kept separate
(`WAREHOUSE_THRESHOLD_DISTRIBUTORS`) so a future wholesale-only distributor does not inherit the
national spread silently.

### 🔴 The threshold is the month's total, never one row

The single trap in implementing this. One customer and one product arrives as several rows — several
bricks, several invoices. Judged per row, three 100-pack rows read as three sub-threshold orders and
**nothing leaves the governorate**; judged on the aggregate they are a 300-pack month and half the
money goes national. Neither answer errors, and the split preserves each line's total, so the
publication drift check — which compares units — cannot see the difference. `warehouseSplitQtyByKey`
sums first, keyed on distributor, customer, line, closing area and product. Breaking that threading
deliberately turns the new test red at "so all three rows go national together", 1 area against 49.

The key carries the AREA as well, because one client code can name two venues in two governorates
(see the EP-PHS case). Without it, one venue's volume could push another venue's small order across
the country.

### The universe is `AREA_CITY` — 49 areas

Main Store (`OTMS`) and retired `OT3` are outside it, which is what keeps the national half from
draining into a bucket with no rep, no DM and no target. That exclusion already existed for the city
split; the national half simply inherits it.

### Measured on August 2026, El Qema's real book

41 customer×product rows, 8,768 packs, 1,888,898.40 EGP. Only **five** rows are above 200 packs, and
three of them are the two Benha warehouses in Qalubeya. Run through the new rule (units preserved to
1.8e-12, value to 5.1e-9):

| Area | Before | Under the 2026-09-07 rule | Under this rule |
| --- | --- | --- | --- |
| `D11` Qalubeya | 6,656 | 950.86 | **3,344.21** |
| each Cairo area | 0 | 950.86 | **123.42** |
| `UE5` / `UE6` Sohag | 1,032 / 0 | — | 345.21 each |
| every other area | 0 | 0 | 79.42 floor |

34 of the 41 rows move. The 7 that do not are all sub-threshold orders in one-area governorates —
Qalubeya, Fayoum, Beni Suef and Ismailia — where "the governorate only" means "exactly where it is".

Qalubeya's rep therefore ends the month with **3.5× what the rule it replaced would have given him**,
and Cairo with about an eighth. Nothing about the LINE total moves: the split relocates units, it
never creates or destroys one.

### Amended the same day — Others take no share, and El Qema is Pedia only

Hours after the rule above shipped, he added two things:

> look u will follow the eu organogram of pedia line and exclude in distrbution the areas in others

**"EU organogram" is not a typo and not new.** It is already this closing's source of truth — the
owner ruled on 2026-08-07 that Pedia and CNS must follow it (`CLOSING_ORGANOGRAM_REGION_LINES`), and
the code comment there even names the consequence: it puts areas like Kafr El-Sheikh 2 under Others.
So "the areas in others" resolves exactly to `operational_region_code = 'OT'`, which the closing
already loads per line and per month.

**Others is per LINE and is not a geography.** Measured on production 2026-09-08 at the August
period end:

| Line | Areas in Others |
| --- | --- |
| Pedia | 13 — `CA5`, `D17`, `UE8` and the ten `OT` areas |
| CNS | 15 — `D17`, `GZ3`, `GZ6`, `UE8`, `UE9` and the `OT` areas |
| Anti Infective | 15 — `CA5`, **`D11` Qalubeya**, `D17`, `D25`, `GZ7` and the `OT` areas |

Down town sits in Cairo on the map and in `OT` on the Pedia organogram. Qalubeya is a district of its
own on Pedia and an Others area on Anti Infective. Neither can be derived from an area code, which is
why the set is loaded from the organogram and handed to the split rather than written down beside
`AREA_CITY`. An empty set means "split as before" — a caller whose organogram read failed must never
silently strip areas out of a distribution.


**The Others set is PASSED IN, never derived.** `loadOthersAreas` reads it from the organogram, per
line and per month, and hands it to `splitTargetsFor`; the split module itself is pure geography and
must not infer membership from an area code, because a seat being created or filled flips it the same
day. An EMPTY set is the safe direction and means *split as before* — a caller that could not read
the organogram must never silently strip areas out of a distribution.
### 🔴 This reverses the Down town ruling of 2026-09-07, deliberately

On 09-07 he ruled Down town INTO the Cairo split — *"down town should be included because we split in
reference to areas not actual reps"* — against his own six-way manual sheet. On 09-08 he was asked
in those words whether excluding Others takes it back out, shown that it reverses the previous day's
call and what it moves, and answered **"Yes, exclude it with the rest of Others"**. The divisor is
still AREAS and not reps; there are simply fewer areas. The Pedia universe drops from **49 to 37**.

A session that re-derives the 09-07 reasoning will reach "Down town should be in" every time, so the
test asserts its exclusion with the reversal attached.

### 🔒 El Qema is Pedia only

Asked what happens when a warehouse's own governorate is an Others area — real on Anti Infective,
where Qalubeya itself sits in `OT` — he answered: **"QEMA IS PEDIA ONLY GOLDEN RULE"**. The question
cannot arise. Their entire book is Lacto Advanced 1 and 2, both Pedia.

`WAREHOUSE_THRESHOLD_LINES` gates the rule on the line as well as the distributor, so an El Qema row
arriving on any other line falls back to the plain city split. That is also what keeps this change
away from **August Anti Infective, which was published and announced on 2026-09-07** — the rule
cannot reach a line it is not scoped to, so the published month is protected by construction rather
than by a period gate someone has to remember.

The defensive fallback stays anyway: **the origin is never excluded from its own sale.** An area is
barred from receiving a share of somebody else's money, never from keeping what it sold itself —
without it, a warehouse sitting in an Others area would have a home half with nowhere to go.

### 🔴 The Cairo + Qalubeya rule was never replaced — 2026-09-09

**"we will change the concept of the qema distribution into تقسيمة المخازن" does NOT mean the 09-07
rule is gone.** It was read that way, the Qalubeya→Cairo targets were deleted, and Cairo went to
zero. He said so in one line:

> YOU ARE NOT APPLYING THE CAIRO AND QALUBEYA RULE + THE NEW RULE

Both. Together. They compose cleanly because they answer different questions:

| Rule | Question it answers |
| --- | --- |
| Cairo + Qalubeya (09-07) | what counts as **LOCAL** for this warehouse |
| The 200-pack split (09-08) | how the sale divides between local and the rest of the country |
| Others excluded (09-08) | which areas may **receive** anything at all |

So El Qema's Qalubeya local block is **Qalubeya plus the six Cairo areas** — Benha sits on Cairo's
edge and supplies it — and the 200-pack rule then works on that block exactly as it works on any
governorate. Without it Qalubeya is a ONE-AREA governorate, so a Benha warehouse keeps the whole
local half itself and Cairo receives nothing, which is the state he rejected.

`LOCAL_BLOCK_OVERRIDES` is keyed `DISTRIBUTOR|ORIGIN AREA`, so it stays El Qema's alone and one-way:
there is no `QM|CA*` entry, so a Cairo warehouse treats Cairo as its own block and never reaches
Qalubeya.

**Cairo is not paid twice.** The national half is every area the LOCAL block does not already hold —
tested on the block, not on the city — so the six Cairo areas take a local share and are absent from
the national one.

### Measured on Benha, August 2026

الفرسان بنها جملة(ت2), 4,532 packs of Lacto Advanced 1, booked in Qalubeya:

| | Areas | Each |
| --- | --- | --- |
| Local half (2,266) | 6 — Qalubeya + Cairo, less Down town as Others | **377.667** |
| National half (2,266) | 31 | **73.097** |

Across El Qema's whole August book the effect is Qalubeya 6,656 → **569.38** and each Cairo area
0 → **622.18**, with the 8,768-pack total preserved exactly. Qalubeya falls because it now shares the
local half with Cairo instead of keeping all of it — that is the 09-07 rule doing its work, not a
regression.

**A sub-threshold order still reaches Cairo.** The Cairo rule has no threshold of its own; only the
NATIONAL half is gated at 200. A 120-pack Benha order spreads across the seven-area block and goes
no further.

### 🔴 Scope of the exclusion — it is a LINE rule, and shipping it narrow was wrong

**Every warehouse on Pedia, whoever sold it.** Not El Qema's alone.

It shipped scoped to El Qema first, on the reading that the conversation was about El Qema's
distribution and that widening it would move other distributors' money in a month about to be
published. That reading was wrong, and his own words already said so — *"the EU organogram of **pedia
line**"*.

Measured on August Pedia the next day, through the closing's own code path:

| Source | Packs arriving in Others areas |
| --- | --- |
| El Qema | **0.000** |
| every other distributor | **79.667** — Down town 44.167, Kafr El-Sheikh 2 35.500 |

He replied **"NOT APPLIED EL QEMA RULE"**. The El Qema half was applied perfectly; what he was
looking at was Down town and Kafr El-Sheikh 2 still holding numbers, put there by EP-PHS, IS-S and
PS. An area in Others receives nothing on this line, whoever sold it.

**Two rules arrived in one sentence and they have different scopes.** `WAREHOUSE_THRESHOLD_LINES` +
`WAREHOUSE_THRESHOLD_DISTRIBUTORS` answer *who spreads nationwide* — El Qema, on Pedia.
`OTHERS_EXCLUDED_LINES` answers *where nobody may receive* — the Pedia line, every distributor.
Collapsing them back into one predicate restores exactly the state he rejected, so the test asserts a
**non-El-Qema** Cairo warehouse skipping Down town while taking no national half.

CNS and Anti Infective are untouched: the exclusion is gated on the line, and August Anti Infective
is published.

### What holds it

`tests/qema-warehouse-split.test.ts`, in the required CI `test` job, plus the neighbouring
`import-split-preview`, `attribution-store-split-net` and `store-split-detail-report` suites, which
all had to be moved onto the new geometry. `planShares` carries one running remainder across both
blocks rather than concatenating two `evenShares` calls — measured, the naive version returned
699.9999999999993 for 700 into 1 + 48, and the matrix is asserted to sum back bit-exactly.

## The automated payroll exports keep the Phoenix look — owner decision, 2026-09-08

### What happened

PR #3177 rebuilt all four payroll exports onto the SATO house identity on **2026-09-05**. On
**2026-09-08** the owner asked for "the previous salary template, the phoenix identity one" in the
automated payroll. That was read as the salary UPLOAD template at `/api/payroll/template`, and PR
#3486 matched the automated payroll sheets to it — grid, widths, even-row zebra, subtotals. It
merged and shipped at 12:51 PM Cairo the same day.

He then exported the July full sheet, said it still came out with "the whity blue template", and
attached his own export — `Automated-Payroll-July-2026-full(3).xlsx`, written **8 Aug 2026, 2:32 PM
Cairo** — with the words *"i want this"*.

**The misread is worth recording, because the wording invites it.** The upload template is itself
white-and-blue: it wears the house identity like every other company document. "The phoenix identity
one" does not mean the house identity applied by the Phoenix app — it means the **Phoenix app's own
brand**, the black-and-orange sheet that existed before 5 September. The two readings differ by
exactly one word and land on opposite palettes.

### What settled it

The attached file, not the conversation. Its palette is decisive and unambiguous:

| | attached file (8 Aug) | what was live (8 Sep) |
| --- | --- | --- |
| typeface | Calibri | the house font |
| fills | `FF000000` black, `FFFDE7C7` amber, `FFF8FAFC` zebra, `FFDCFCE7` / `FFFEE2E2` execution and held, `FF166534` | none but the 6% house tint |
| type | `FFF97316` / `FFF8B56B` Phoenix orange, `FF334155` slate | house deep / blue |

No house blue anywhere. Asked directly whether that was the look he wanted back, he chose to restore
it and exempt these exports from the house standard the way the offer letter already is.

### What was restored, and what was NOT

Restored to the pre-#3177 Phoenix look: `exports/sheet.ts` (the HR run sheet, Part 1 and Full),
`exports/finance-sheet.ts` (the locked finance downloads, which wrap it) and
`exports/step-template.ts` (the per-step wizard templates).

**Left on the house identity: the published batch download (`salary-batch-workbook.ts`) and the
payslip renderer.** He was offered the wider option — Phoenix across the whole payroll pack — and
did not take it. So the split is per-EXPORT, not per-module, and `payroll-sheet-style.ts` is still
the house module those two share. PR #3486's changes to it were reverted rather than kept, because
they were made against the wrong target and he never asked for the batch download to change.

**FAB and CIB were never in scope** — they are literal bank-execution artifacts and were left alone
in the earlier decision the same day.

### The two things that are not palette

Restoring a file wholesale from before a rebuild silently reverts everything else that landed since.
Two such things were re-applied by hand, and both are pinned:

1. **The held row's NOTE.** The Phoenix look carries "held" as a red fill and red type and by
   nothing else — which is exactly what the house rebuild had called out, because a fill survives
   neither greyscale, nor a range copied into another workbook, nor a reader who cannot see it.
   `publishToPayslips` filters `!onHold`, so a held row is dropped at publish with no
   `salary_record` written. The note is words, is invisible until hovered, and costs the look
   nothing. The cover's per-person "Held · <hr id> … Reason:" rows (from `82aed3da7`) were kept for
   the same reason.
2. **The step template's cell LOCKING.** The pre-2026-09-05 file's own doc comment claimed "locked
   identity + context" and locked nothing; `cell.protection` and `sheet.protect` arrived with the
   house rebuild. The upload parses editable labels only, so an edit to a context or recommendation
   column is accepted by the sheet and then silently thrown away. The existing
   `payroll-export-house-identity` test caught this reversion, which is why it is worth keeping that
   suite pointed at the step template.

### The hazard this section exists to stop

`house-identity.ts` says every company document wears `SATO-DIS-2026-01`, and the ink rule forbids
filled areas. A session sweeping for documents not yet on the standard will find these three files,
find filled black bands in them, and "finish the job" — reversing an owner decision while believing
it is enforcing one. `tests/payroll-phoenix-look.test.ts` fails on ANY house colour appearing in
these workbooks, and runs in the required CI `test` job, so the sweep goes red instead of
shipping.

## §4 hooks trimmed to their cue — the full text, verbatim (2026-09-07)

`AGENTS.md` auto-loads in full on every request; this file does not. Nine §4 rules had grown to
carry their own evidence inline — run ids, pre-image table names, counts, dates, the owner's words
at length — which is exactly the material this file exists to hold. The hooks in `AGENTS.md` were
trimmed to the cue and now point here.

**Nothing below was ever in `docs/` before this commit.** Checked at the time: not one of
`wf_b7ad5542-d94`, `wf_2196360f-a88`, `sos-remeasure-2026-09-06`,
`plan_audit_backup_20260905.dm_fabricated_ceo_approve`, `.dm_human_ceo_approve`, `441164`,
`import-duplicate-guard.ts` or the 126,321-row figure appeared anywhere under `docs/`. The
`AGENTS.md` bullet was their only record, and two of them name the production pre-image tables that
are the recovery path for 50 deleted rows. They are reproduced here **verbatim, in full**, before
the trim — so the trim removes bytes from the auto-loaded file and removes no fact from the repo.

### AGENTS.md §4, line 368 as it stood on 2026-09-07

- 🔴 **"continue verifying" — THE SOURCE OF SALES AUDIT IS FINISHED, END TO END. There is nothing left to resume.** 247 raw findings → calc remainder (run `wf_b7ad5542-d94`, 2026-09-04: 97 of 97 judged, **82 confirmed**) → deferred 88 (run `wf_2196360f-a88`, 2026-09-05: 83 distinct defects, **58 confirmed**, 12 refuted, 13 low unverified, **0 unjudged**). **140 confirmed defects**, in `sos-report-2026-09-04.md` and `sos-deferred-report-2026-09-05.md`, both in BOTH vault copies. ⚠ **Every earlier file in that folder still describes work in progress and they are FROZEN INPUTS, correctly never rewritten** — `CHECKPOINT.md`'s top says *"STOPPED… 11 verdicts of ~194"* (its 2026-08-31 state) and `RESUME-2026-09-04.md` ends with the deferred 88 outstanding. **Read `RESUME-2026-09-05.md`, the newest, which records the completion.** A session that reads an older one restarts a finished audit — that has happened **twice**, and this rule is the only thing standing between the next session and a third. **The findings are now a FIX backlog, not an audit backlog**; the audit is closed. If he asks for verification work here, he means acting on those 140 — but 🔴 **RE-MEASURE FIRST: THE LIST IS STALE.** A fix campaign on 2026-09-04/05 closed many of them, **all three criticals included**, and the old headline that stood in this line — `pnpm sos:direct-cleanup` deleting 10,789,398 EGP behind a FALSE backup banner — **was fixed by #3206** (`src/lib/sales/direct-cleanup-safety.ts` now carries `assertBackupCoversCascade` and a `LIVE_DIRECT_VINTAGE_FROM` guard), so do NOT quote it as live. Re-measured 2026-09-06 against `origin/main`: **14 closed by a PR whose subject IS the finding, 84 still stand (file untouched since its report), 37 need a code check (file touched by an unrelated fix), 5 are since-rewritten DB objects.** That triage is `sos-remeasure-2026-09-06.md` in the vault — **start from it, never from the two reports.** Standing rules unchanged: never restart the 20 finder agents, never `resumeFromRunId`, never overwrite the inputs — **write a NEW file.**

### AGENTS.md §4, line 373 as it stood on 2026-09-07

- 🔒 **THE FITS-THE-SCREEN GOLDEN RULE — never a horizontal scroll, always mobile AND desktop friendly.** `overflow-x-auto` over a `min-width` floor IS the bug, not the fix, so a board bound by this rule must NOT use `PortalDesktopTable`; render `<table className="w-full table-fixed">` with a `<colgroup>`. **Fit by MERGING columns, never by shrinking type; WRAPPING is the permitted answer** and the ellipsis ban is untouched. **Measure, never guess** — `scrollWidth > clientWidth` over `main` at desktop AND 375px. **That check is BLIND to anything CLIPPED rather than scrolled — a POPOVER, or any `overflow-hidden` BAND holding `whitespace-nowrap` — and certifies the page while content hangs off the side**: a nav panel sat 97px off a 375px screen, the Stars of the Fortnight header 36px past `main`, both with every reading a clean 375/375, because clipped content adds nothing to `scrollWidth`. **And the INVERSE trap: `main` overflowing while the DOCUMENT reads clean is content CLIPPED AWAY, not scrollable — UNREACHABLE, not merely dragged to**, with `own = 0` on the overflowing element as the tell. Cause and cure are one token: **`shrink-0` pins a wrapper to max-content, so a `flex flex-wrap` row inside it is INERT at every viewport** — adding `flex-wrap` cannot fix what already has it; let the wrapper narrow instead. Inside such a container measure the CHILDREN's rects, and discount anything `aria-hidden`/`alt=""`: a decorative bleed is MEANT to cross the edge. For anything absolutely positioned, measure the OPEN element's own rect; and place it with `clampPanelToViewport`, since BOTH edges are in play and narrowing cannot fix an anchor's position. A native `<select>` is the one control this cannot fix and may NOT be shrunk. `never-horizontal-scroll-always-mobile-and-desktop-friendly`

### AGENTS.md §4, line 375 as it stood on 2026-09-07

- 🔒 **THE SQUARE-EDGE GOLDEN RULE — no round or semi-round corners, anywhere.** Owner rule, 2026-09-04. Cards, buttons, tags, inputs, bars, avatars and badges are all square. **`tokens.css` CONTRADICTS this** — it ships `--phx-radius-xs/sm/lg/xl/pill` and calls `--phx-radius: 4px` "the default for cards, inputs and buttons", so the default is the bug and a session copying a sibling component inherits it silently. **Measure, never eyeball**: count elements whose computed `border-radius` is not `0px` — a rounded corner at 4px is invisible in a screenshot and survives review. A pill (`border-radius: 999px`) is the loudest breach and reads as house style because the token exists. 🔴 **`globals.css`'s own sweep is NOT coverage — it has two blind spots and a third surface it cannot reach at all.** `.admin-shell [class*="rounded"]` (and its `.employee-portal-shell` twin) matches a **Tailwind class on an ELEMENT**, so it never sees a hand-written `border-radius` on a plain class name, and it can **never** square a `::-webkit-scrollbar` pseudo-element. The scrollbar case is the trap: `[&::-webkit-scrollbar-thumb]:rounded-full` puts the substring "rounded" in the class attribute, so the sweep MATCHES, squares the div whose corners were never the problem, and the thumb keeps its pill — it audits as handled. The third surface is unreachable by construction: an **iframe'd document never loads `globals.css`**, which is how the paper editor rounded every editable field. Pinned by `tests/admin-shell-palette-scope.test.ts` and `tests/hiring-pack-paper-editor.test.ts`.

### AGENTS.md §4, line 386 as it stood on 2026-09-07

- 🔴 **THE SYSTEM NEVER AUTO-APPROVES A PLAN — a DM's weekly plan is submit → NSM (or RSM if applicable) → HR acknowledge, with NO CEO stage.** Owner 2026-09-05, asked and answered twice: *"the system never auto approve a plan"*, then *"in district managers plan remove the step of ceo approval make it nsm or rsm if applicable then the hr ack"*. He was offered a SYSTEM ACTOR for the step and **rejected the premise** — the objection is the approval EXISTING, not its label. So `SYSTEM-AUTO-HR-ACK` on the ACKNOWLEDGEMENT stays, while a system-signed APPROVAL is forbidden; a session reading only "drop the CEO" will re-add a cascade and believe it complies. **Never implement "skip a stage" by writing a decision row FOR the skipped stage — let the transition carry it.** The cascade wrote a second `ceo_approve` ~0.1s later under the approving MANAGER's own identity, so three NSMs appeared to have approved as the CEO. **A DM plan now carries NO `ceo_approve` row AT ALL — all 50 deleted from PRODUCTION, in TWO passes: 42 machine rows 09-05, then the 8 GENUINE human ones 09-06 on his "remove the 8 too". Pre-images `plan_audit_backup_20260905.dm_fabricated_ceo_approve` (42) and `.dm_human_ceo_approve` (8). After: `ceo_approve` on DM plans 0, DM plans with NO approval left 0, `manager_approve` unchanged 50, non-DM `ceo_approve` untouched 55 — the CEO stage still works for every other role. Do NOT undo, and do NOT read a DM plan's missing CEO row as data loss.** ⚠ The 50 were NEVER one population: 42 machine (sub-second, same actor as the manager approval), **7 genuine Super Admin decisions made 7–18 HOURS later**, and 1 genuine CEO — so classify by GAP and ACTOR before any sweep. They were removed in TWO passes for that reason — the machine rows on evidence, the human rows only on his explicit say-so: **never delete a human decision on the same predicate that catches a fabricated one.** `the-system-never-auto-approves-a-plan`
- 🔴 **THE ONE DM CHAIN WITH A REAL SECOND STAGE — the DMs reporting to Hany Saad (`PD-0001`): submit → Hany → Ali Mohamed Ali Elsayed (`A-12`, NSM) → HR auto-acknowledge.** Owner 2026-09-20, with Ali able to read those DMs' plans at every status and period, history included. It is policy data in `src/lib/weekly-planning/second-approver.ts`, keyed by the MANAGER (add another manager there, never compare ids inline). No migration: the stage rides `manager_approved → final_approved` (the `ceo_approve/return/reject` actions), and the decide RPC never checks the actor, so the application gates it on Ali's IDENTITY (`assertSecondApprover`), not on `weekly_plans:approve`. The manager stage no longer passes `p_bypass_ceo` for these plans, so a Hany-DM plan cannot skip Ali; the CEO has NO turn on them (his pending count and export exclude them). The header's `ceo_decision_*` columns then hold ALI's real decision (`resolvePlanCeoDecision` shows it only when he wrote it). Every OTHER DM plan is unchanged — the rule above stands. Pinned by `tests/dm-plan-second-approver.test.ts`.

### AGENTS.md §4, line 397 as it stood on 2026-09-07

- 🔴 **A PUBLISHED AND ANNOUNCED MONTH IS NEVER CORRECTED, however wrong it is.** Owner 2026-09-07, refusing a fix that was measured, line-neutral and required by *his own* earlier ruling: *"donot fix any already published an announced month implement this to be considered in the upcomings."* So the trigger is PUBLISHED-AND-ANNOUNCED, **not "is the fix justified"** — being able to prove the number wrong is not an exception, and a session that re-derives the justification will reach "we should fix it" every time. A late ruling is a rule for UPCOMING months. `monthly_closing_locks` enforces it on `source_of_sales_import_rows` and `source_of_sales_fact_rollup` (every insert/update/delete, **including migrations and direct SQL**) — **treat a lock as his decision, never an obstacle to route around**; unlocking needs him to say so about that specific month. `never-fix-a-published-and-announced-month`

### AGENTS.md §4, line 398 as it stood on 2026-09-07

- 🔒 **THE CITY RULE ALWAYS WINS — except EZ, Office, and El Qema’s Qalubeya.** Owner 2026-09-07, asked directly whether he wanted to override the even city share for a named customer: he does not. A wholesaler's sales spread evenly across the areas of its OWN city and that is the answer, even when its goods demonstrably left the city. **Do NOT reintroduce a per-customer apportionment override**, and do not read the 441164 (ريونيون) history in git as unfinished work — its hand-split lived in the fact ROWS, a re-import erased it on 2026-08-09, and a live sweep of all 323,952 rows on 2026-09-06 found ZERO re-booked rows, so the route it used matched nothing before it was removed. TWO exemptions survive, and NEITHER is a per-customer override. `evenSplitApplied` (the even-split registry, EZ) is arithmetic not judgement: a customer the DATABASE already distributed must not be distributed twice. **El Qema’s Qalubeya** is keyed by DISTRIBUTOR plus ORIGIN AREA and runs one way — a different axis from the per-customer override this rule forbids, which is why it does not breach it. See its own hook below. **Office needs no entry** — its rows carry no customer, so `isStoreCustomer` is false, and `loadMonthlyClosingPartsWithStoreSplit` passes the `office` grid through unsplit.

### AGENTS.md §4, line 399 as it stood on 2026-09-07

- 🔒 **EL QEMA (`QM`) — its QALUBEYA sales split across Qalubeya PLUS all six Cairo areas. ONE WAY, EL QEMA ONLY.** Owner 2026-09-07, both halves asked and answered: *"one way only, only for el qema"*. A warehouse IN Qalubeya reaches Cairo; a warehouse in Cairo reaches Qalubeya NEVER, and the same Qalubeya warehouse sold through any other distributor does not split at all (Qalubeya is a one-area governorate). **This is why it canNOT live in `AREA_CITY`** — city membership is symmetric, so moving `D11` into "Cairo" would silently start paying Qalubeya a share of every Cairo wholesaler from every distributor, and the drift check would not see it (it compares UNITS; the split preserves them). It lives in `DISTRIBUTOR_SPLIT_TARGETS`, keyed `DISTRIBUTOR|ORIGIN AREA`, pinned by `tests/qema-qalubeya-split.test.ts`. The origin keeps its own share — seven areas, not six. **The divisor is AREAS — a vacant seat or NO seat** (*"حتى لو فيها فاكانت"*). **Down town (`CA5`) has no Pedia seat and STAYS IN** — owner 2026-09-07, *"we split in reference to areas not actual reps"*, ruling against his own SIX-way manual sheet. Dropping it reverses that; the test names it.

### AGENTS.md §4, line 410 as it stood on 2026-09-07

- 🔒 **SCOPE RUNS DOWNWARD ONLY — an employee never sees his own manager, nor anyone at or above his own RANK.** Owner 2026-09-04, twice: *"You see yourself and your scope down — downgrading, not upgrading"*, then *"remove dsms rsm and peer pms too."* A `line` basis is line MEMBERSHIP, which carries no direction, so it put B-155's own manager (A-8, **57 real CRM visits**) inside his 57-person scope, and **nothing rendered her but accident** — so the stop lives in `resolveDoctorCoverageScope`, never in whichever board remembers to filter. **TWO cuts: the management chain (identity-based, title-BLIND) and a SEAT-RANK ladder — strictly BELOW the viewer, so a DSM is out for a PM and in for an NSM.** A flat blocklist of DSM/RSM/peer-PM cannot express that and would hand an NSM the module's EMPTY STATE, which reads as a data fault; for the same reason **the viewer is never excluded from his own scope.** **An UNRANKED title is excluded** — 12 head-office seats carry a `line_id`, the CEO among them. Ladder applies to the `line` basis ONLY: a team scope is already downward. `scope-runs-downward-only-never-your-own-manager`

### AGENTS.md §4, line 419 as it stood on 2026-09-07

- 🔴 **IS-S 2026-04 and 2026-05 ARE THE SAME FILE, this is KNOWN, and the owner is LEAVING IT — do not "repair" it.** Both batches are `Monthly_Sales_by_Client_for_SATO_PHARMA_(PAS)20260603015619.xlsx`, 1,141 rows, **349,266.46 EGP each**, both `validated`. So **one month is counted twice and the other was never loaded**, and the filename's own timestamp (20260603) says it was downloaded in June. March (399,890.48) and June (396,038.78) are distinct files — the pair stands out precisely because those don't match. **Owner's decision 2026-09-05: leave BOTH pending, he is checking with Ibn Sina.** Do NOT void either batch, do NOT re-run the import, do NOT pick the likelier month — **the evidence that would settle it is gone**, because the legacy commit route erased the invoice date on 126,321 rows across 2026-04..06 (~90% of each month). **Quoting IS-S for 2026-04 or 2026-05 quotes a doubled figure**; say so rather than reporting either month clean. A future upload of that same file is now refused at the confirm step (`import-duplicate-guard.ts`), which does NOT touch the two rows already there.


## 🔒 The premium-polish golden rule — owner ruling, 2026-09-08

**His words, verbatim:** *"remove this rule 'NO MORE PREMIUM POLISH' and any thing current in system
or wiull be built consider gomode premium polish gpolkden rule"*.

This **reverses his own ruling of 2026-09-05** — *"NO MORE PREMIUM POLISH ... flat"* — which shipped
as **#3114 (`feat(ui): flatten the three shared primitives`)**. Depth is the default again, for what
already exists and for anything built from here on.

### What #3114 had removed, and what came back

| Surface | Flattened 2026-09-05 | Restored 2026-09-08 |
| --- | --- | --- |
| `adminPanelClassName` | border only | two-layer contact + ambient shadow |
| `adminSoftPanelClassName` | border only | the same pair, lighter |
| `adminInsetPanelClassName` | border only | an **inset** shadow — it is recessed, so it must not also float |
| `adminHeroSurfaceClassName` | flat `#000` | three-stop diagonal + `0_28px_80px` drop shadow |
| hero decoration | three layers **deleted, exports and all** | grid overlay + orange glow + amber glow, re-exported and re-rendered |
| `adminHeroAccentBarClassName` | solid orange | transparent→orange→transparent gradient |
| kicker / chips / primary action | flat | orange glow, `backdrop-blur`, orange drop shadow |
| `pageHeaderRailClassName` / `RuleClassName` | solid | the vertical and horizontal gradients again |

### 🔴 The trap: two rules were flattened in ONE commit, and only one was reversed

**The square-edge golden rule (2026-09-04) is untouched and still binding.** #3114 removed the
`rounded-[18px]` / `rounded-full` radii **and** the depth in the same diff, so the obvious move —
`git show 862ac767e^:src/components/admin/admin-design-tokens.ts` and restore it — brings round
corners back under cover of a ruling that says nothing whatever about corners.

Depth returned; the radii did **not**. Inside the admin shell a radius is inert anyway
(`.admin-shell [class*="rounded"] { border-radius: 0 !important }`), but the employee portal renders
these same tokens with nothing zeroing them — which is exactly how one token produced two different
looks before, and the stated reason the radii were dropped. Both things hold at once: **sharp
corners, real depth.** The two hero glows are the visible proof of the compromise — they were
circles, they are squares now, and at a 90–100px blur nobody can tell.

### Scope — the system UI, and not the three locked identities

It does **not** reach:

- **the offer letter** (`src/lib/offers/`) — FROZEN by his 2026-09-05 *"donot change in offer design"*;
- **the house document identity and its ink rule** — company paper, `SATO-DIS-2026-01 v1.0`;
- **the automated payroll exports** — Phoenix black-and-orange by his 2026-09-08 ruling, pinned by
  `tests/payroll-phoenix-look.test.ts`.

Widening "anything current in system" across those would reverse three separate owner decisions in
one sweep, each of which he made deliberately and two of which are pinned by tests. If he wants the
documents restyled too, that is a fourth decision and he should be asked for it by name.

### Where it lives

One module: `src/components/admin/admin-design-tokens.ts`, read by `AdminPageHero` (131 pages),
`PremiumHero` (the module pages), the KPI board, the resignations board and both route skeletons —
so the language cannot drift page to page. `AdminHeroFrame` in `admin-design-system.tsx` is the only
call site of the three decorative layers.

**No test pins flatness**, then or now — `tests/admin-shell-palette-scope.test.ts` pins the *corners*,
which is why the square-edge half survived the reversal untouched and must keep surviving it.

## 🔒 The weekly attendance review: released by the owner, answered by the employee — owner ruling, 2026-09-15

**This replaces the 2026-09-08 ruling** ("no one is notified, silence means nothing, only me sees
it"). A session reading git history will find that silent build, and before it a 48-hour
auto-confirm and a three-channel notifier: **all of those are superseded decisions, not unfinished
ones.** Do not restore any of them.

He set the new rules on 2026-09-15, first in his own words and then by choosing from options:

> "before pumping notications to employees i must approve this to happen and when the notification
> goes … it asks deduct from saley or from avbalanvce if available"

### 1. Nothing reaches an employee until he releases the week

The daily job (`app/api/cron/attendance-weekly-digest`, 06:23 and 13:23 Cairo) brings every started
week of the review month up to date as **`awaiting_release`** and **sends nothing** (section 5). The week then waits on the admin page
**Attendance › Weekly Attendance Review** (`/attendance/weekly-review`), which lists every
employee's flagged days by name.

**He chooses the days (same day, second decision).** In his words: "I want to be able to select the
week I want. And in the week I select … I can mark on the days that I want them to be deducted. … I
want full control." His answers, chosen from options:

- **The week picker** lists every started week of the **review month**, the running one included,
  with its days up to yesterday. Last month's weeks, and any older week still waiting for release or
  answers, stay listed so none is stranded (`listReviewWeeks`). **Refresh** (`buildReviewWeek`, route
  `build`) brings a started week of this month or last month up to date at once and sends nothing. A
  trial-run week is read-only.
- **Only the flagged days can be ticked, and every day starts UNTICKED.** An unticked day is
  **cleared at release and never deducted**.
- **A ticked day's days can be edited, down or UP** ("Raise too"), more than 0 and at most 3 per day
  (a typo guard). `detected_days` keeps what the report found; `deduction_days` is the figure the
  employee sees, the balance charge takes and payroll approves.

Ticking goes through `phx_attendance_mark_digest_line` (`markDigestLine`), which locks the week and
refuses once it is released, in a trial run, or on a day already answered. Release goes through
`phx_attendance_release_digest`, one call per employee: under the same lock it writes a `removed`
settlement for every unticked day, then opens the week, or voids it when nothing is left (nobody is
told), or settles it when only days answered before the release step remain. Releasing with nothing
ticked therefore clears the whole week and notifies nobody. "Remove this day" is gone.

**Release refuses a stale page** (2026-09-17). The page sends the days it shows (`seenLines`). When a
day waiting now is not among them at the same figure, nobody at all is released: `staleReleaseLines`
checks every employee first, and `phx_attendance_release_digest` checks again under the row lock
(errcode `40001`). The daily job adds days to a waiting week, and without this check a day that
arrived after the page loaded would be cleared on release, unticked, without him ever seeing it.

**A cleared day is never charged, and that needs a record.** The `removed` settlement is what the
month-end bridge turns into **Do Not Take Action** on that day's fingerprint deduction, and
`recordDecision` then refuses to approve it. Without the record, the deduction would stay Pending
and payroll could still take it.

**A changed figure reaches payroll.** When a day's `deduction_days` differs from `detected_days`,
the bridge approves the month-end deduction at the Super Admin's figure (`payrollDaysForSettledLine`)
and passes `allowAboveDetected`, the one path allowed above the detected days. `recordDecision`
carries a raised figure forward on a later plain Decide instead of throwing.

**Release refuses when the public holiday calendar or leave requests cannot be read**
(`loadAnswerWindow`). Without them a holiday, or a day the employee is on leave, would count as a
working day inside the answer window, and the deadline would come early. Nothing is released in
that case. **A Google Calendar outage counts as unreadable** (owner, 2026-09-16,
`holidayCalendarReachable`). Company and fixed-date public holidays still load during an outage,
so a month with 1 May, for example, used to read as connected while both Eids, Islamic New Year,
the Prophet's Birthday and Coptic Easter were missing. The deadline is counted on the employee's
own attendance policy's weekly days off (`resolveActiveAttendancePolicy`), not a company-wide
default.

**Bringing a week up to date keeps his work** (2026-09-17, replacing the one-shot build and its
undo). `phx_attendance_sync_digest_days` runs once per employee, in one transaction, under the digest
row lock that a tick and a release take, plus an advisory lock per employee-week. It adds a new
flagged day **unticked**. It refreshes the figures of a day still waiting: a day whose days he changed
keeps his figure, and the tick is kept either way. It takes off a waiting day the report now clears,
such as an approved excuse, leave or a corrected punch. It never touches a released, answered or
cleared day, and never adds a day already in another digest of that employee. A day the report does
not return at all is left alone, because a missing row is not proof the day is clean. When every
waiting day of an employee is cleared, the digest goes too. An employee who fails does not stop the
others: the failure is named, and the daily job returns 500.

**One piece of work on a week at a time** (`withWeekBuildLock`, risk review 2026-09-16, widened
2026-09-17). The daily job, a Refresh click and a Release of the same week queue in the server
process. A release checks the days against the page and then releases them, and a refresh running in
between would add a day after the check. Production runs one replica. Across two (briefly, during a
deploy) the database is the guard: both functions lock the employee's week, and the release refuses a
day the page did not show.

**A week mixing trial and real employees** releases the real ones only. The page says how many trial
employees are skipped.

Only the Release click notifies anyone, and only `releaseWeek` in
`src/lib/attendance/digest-service.ts` sets `released_at`. The employee page and API return released
weeks only (`listMyDigests` filters `released_at is not null`). The review page, its list API and
the dispute inbox are gated by `canReviewDisputes` (Super Admin or the reviewer list), failing
closed. **Ticking days, refreshing a week and releasing it are the Super Admin's alone**
(`canManageWeeklyReview`), checked in the mark, refresh (`build`) and release routes (403) and again inside
`markDigestLine`, `buildReviewWeek` and `releaseWeek`. A named dispute reviewer sees the page
read-only, with no ticks, Refresh or Release button, and decides disputes. The reason: leaving a day
unticked waives a colleague's deduction with nobody else looking, and a release notifies
every employee, and "i must approve this" names him. The employee page is self-scoped: any employee
sees their **own** released weeks, and nobody else's.

**A trial-run week (`dry_run = true`) can never be released.** The service refuses it, and so does
the write itself (`.eq("dry_run", false)`). The migration
`20260915210000_weekly_digest_release_and_balance_choice.sql` voids **every** trial-run digest
that nobody answered, whatever its week. On production on 2026-09-15 that is exactly the 31 Aug–6
Sep week (6 digests, none answered), and `dry_run` is already off there, so no new trial weeks are
being built. The same migration moves every real week with a day still pending back to waiting for
release: on production that is the 7–13 Sep week, 7 employees. A day already answered under the
old rule keeps its answer. The one such day is 10 Sep on the owner's own digest, which he
confirmed; it reaches payroll as **Approved for Payroll**.

**Measured before the migration, production 2026-09-15, read-only:** no line is `disputed` (so the
new "a dispute carries its chosen method" check cannot abort it), and no real `open` digest is
without a pending day (so none is left `open` with no release stamp, which the release-shape check
would refuse to settle later). Re-measure both if the migration is applied on a later day.

**Deploy order:** apply the migration to production immediately before merging. The new code reads
`released_at`, `chosen_method` and the new functions, none of which exist until then. The old code
was never run against the migrated schema, so do not let the daily job fire between the two steps (it runs at 06:23 Cairo, from GitHub Actions).

**Deploy order for the day selection:** apply `20260915230000_weekly_review_day_selection.sql` to
production before merging its PR. The new code writes `detected_days`, reads `deduct` and calls
`phx_attendance_mark_digest_line` / `phx_attendance_release_digest`, none of which exist until then.
The migration is additive: the old code ignores the new columns, so the migration can go first
safely. Its backfill copies each line's days into `detected_days` (25 lines on production on
2026-09-15), and every line starts unticked.

**Deploy order for live weeks:** apply `20260917120000_weekly_review_live_weeks.sql` to production
immediately before merging its PR. It drops the 3-argument `phx_attendance_release_digest`, so the old
code's Release fails between the two steps: do not release a week in that gap. The daily job never
releases, and the new code calls `phx_attendance_sync_digest_days` and reads `release_round`, which do
not exist until the migration runs.

**A changed day reaches payroll only when month-end detected the same days** (risk review,
2026-09-15). The Super Admin's figure is a count of the days the weekly review detected. If the
month-end fingerprint deduction for that day detected a different number (`raw_value`, 2 decimals),
applying his figure would price it from another base, so lowering a day could charge more. The
bridge then leaves the deduction Pending, does not stamp the settlement, and alerts every run until a
person decides it (`editedDaysApplyToCandidate`). Ticking a day locks the week before the day, the
same order release uses, so the two cannot deadlock.

### 2. The notice: by email, Telegram and in-app

**Owner rule 2026-09-17, chosen from options ("Email the release and decision"), replacing
2026-09-15's "never email".** When the Super Admin releases a week, and when a reviewer decides a
disputed day, the employee is told by email to their own work address, by Telegram and in-app. The
old email guard (`attendance-digest-channel-guard.ts`) is gone. `attendance-digest-channels.ts`
now only names the module. Module `attendance_digest` keeps an explicit Telegram policy with full
content, because without one the unknown-module fail-safe would silently turn Telegram off.

- **Email goes before Telegram in the channel list, on purpose.** A permanent Telegram failure falls
  back to email only when email has not been tried yet. In the other order, an employee whose
  Telegram fails would be emailed twice.
- **The email goes to the employee's `work_email`, with their direct manager copied.** With no
  work address the email is skipped, and never redirected to the HR inbox. It uses the "general"
  email policy and template. The direct manager is CC'd because the notice names the employee as its
  subject, as for every email addressed to an employee. **The owner chose to keep that copy
  (2026-09-17, chosen from options: "Also CC direct manager")**, so a manager sees each deduction
  notice and dispute decision for their team. Like every automated email, it is BCC'd to the admin
  and mirrored to his Telegram.
- **The Telegram message reads as a letter.** Its paragraphs are kept and it has no
  "Module: Attendance digest" line in front (`telegramKeepsParagraphs`, this module only). Every
  other module's Telegram text is unchanged.
- **One day reads as that day** ("Attendance review — Wednesday 9 September", never "9 Sept to
  9 Sept"). A range of days keeps its range wording.

The release notice names the days, how many there are and the deadline. **It carries no amount**,
because Telegram is a lock-screen channel. One notice per release round (idempotency key
`attendance_digest:<id>:released`).

**Who counts as told (owner, 2026-09-17, chosen from options: "Only a real channel").** The release
stamps `notified_at`, which starts the answer deadline that ends in a salary deduction, only when
the notice reached the employee through a real channel (`releaseNoticeReached`):

- the email or the Telegram message actually went out, or
- the in-app notice reached someone with an active login who has signed in before. That is read
  from `app_sessions`, which only a real password or biometric sign-in writes. Supabase's own
  last-sign-in time is not used, because an Employee login does not open a Supabase session.

Anyone else keeps `notified_at` null: their days wait for HR and are never deducted for going
unanswered.

**Only a message that went out counts (risk review, 2026-09-17, before merge).** An email counts once
the mail provider accepted it. None of these count:

- **An email handed to the outbox to retry.** The notification system records it "sent", but it has
  not gone out. The outbox also files permanent blocks under a retry, such as an inactive "general"
  template or an address the recipient check refuses. `system.ts` flags the handoff
  (`queuedForRetry`), and `noticeReachedEmployee` refuses it.
- **A message held for quiet hours or waiting for a retry** ("pending", "retrying"). It has not gone
  out yet. A held Telegram message for someone with no linked Telegram, or a held email with no
  address, never goes out at all.

The in-app notice is never held for quiet hours, so someone who has signed in is still counted as
told at night. Counting too few only leaves days for HR; counting too many deducts salary from
someone who was never told. A later email bounce is not tracked back.

An email held for quiet hours counts as attempted (`emailAttempted`). Otherwise a held Telegram
message whose retries run out would fall back to emailing the person a second time.

**A leaver is never counted as told (owner, 2026-09-17, chosen from options: "HR decides, never
automatic", keeping the 2026-09-16 ruling).** The notice still reaches them by any channel that
works, but `releaseNoticeReached` returns false for anyone with no employee record or a terminal
employment status (`isTerminalEmploymentStatus`). Their days wait for HR in the final pay. The
recipient facts are read after sending. A failed read counts as not told, so the days wait for HR
and are never deducted automatically.

**The dispute decision is told the same way** (owner, 2026-09-15, chosen from options, and by email
too since 2026-09-17). When a reviewer accepts or rejects a disputed day, `reviewDispute` saves the
decision first and then calls `notifyAttendanceDisputeDecided`, by email, Telegram and in-app. The
notice names the day and the outcome. For a rejected day it says where the deduction is taken from
(salary or annual balance, as the employee chose), and when balance could no longer be used it gives
the real cause (`disputeSalaryFallbackText`). It carries **no amount** and does **not quote the
reviewer's note**, which is free text on a lock-screen channel; it only says a note is waiting on the
employee's page. One notice per decided day (idempotency key
`attendance_digest:line:<line id>:dispute_decided`). The decision deducts nothing on the answer,
so a leaver it reached counts as told there (`noticeReachedEmployee`). A notice that fails never
undoes the decision: the reviewer's screen says the employee could not be told by email, on Telegram
or in the app, and the decision still shows on the employee's weekly attendance page.

### 3. Per day, the employee chooses salary or annual balance, and then may dispute

- **Salary**, or **annual balance only**: the same number of days, and offered only when the
  balance covers the **whole** day (`balanceCoversDays`). A part-covered day is not offered, because
  the rest would fall on salary without anyone choosing that. No other leave type is offered.
- **Then** the page asks whether they want to dispute the day. No settles it on the chosen method.
  Yes records a dispute, with a reason and the chosen method, for the reviewer.
- A **rejected** dispute is charged to the method the employee chose. If that was annual balance and
  balance can no longer be used, it falls back to salary, and the record says the real cause
  (`disputeSalaryFallbackText`): not enough balance, the first six months, no hire date, or the
  month-end review had **already decided** the day, in which case that decision stands. If the
  balance merely **failed to read**, the ruling is refused with "try again", never settled to
  salary for good on a transient error. An **upheld** dispute charges nothing.

A balance-paid day is written to the immutable ledger **`attendance_annual_balance_charges`**. Both
balance readers count it: `approvedPaidDaysInPeriod` (JS) and `phx_apply_vacation_paid_approval`
(SQL). The settle RPC takes the same per-employee advisory lock as leave approval and re-checks the
balance under it. At month end the bridge closes that fingerprint candidate as **Do Not Take
Action**, so the day is never taken from both leave and pay (pinned in
`tests/attendance-digest-rules.test.ts`).

**Balance is refused once the day's month-end deduction has been decided or locked.** The bridge can
close the deduction only while it is still Pending and unlocked. If someone has already approved it
for payroll, or cleared it, or a publication has locked it, a balance charge would take the day
twice or spend leave on a day payroll never charges. So the option is greyed out ("already decided
in the month-end deductions review"), and the settle function refuses it under the lock (errcode
`55000`). The other order is guarded too: `recordDecision` refuses **Approved for Payroll** for a
fingerprint day that the weekly review has **paid from annual balance**, **removed before
release**, **cleared by an upheld dispute**, or still has **under dispute**
(`assertDayNotClearedInAttendanceReview`). The first three would charge a day the review said is
not charged; the fourth would pre-empt the reviewer. Trial-run weeks are ignored, because they
never reach payroll. A failed read refuses the approval. If a cleared day is still Approved for
Payroll (a race, or a decision made before these guards shipped), the bridge raises an alert
naming the cause every run and the daily job returns 500. The same happens when the bridge cannot
close a cleared day. A day that only needed salary, and could not be applied, is a warning.

**A day nobody has finished deciding cannot be approved either.**
`assertDayNotClearedInAttendanceReview` also refuses **Approved for Payroll** for a fingerprint day
still pending in a real week:

- **Waiting for release** (owner, same day, chosen from options: "Block until released"). The
  employee has not been asked, and the Super Admin may still untick the day. The refusal says to
  release that week on the Weekly Attendance Review page first, or to mark the deduction Needs
  Follow-up.
- **Released and not answered yet** (owner, 2026-09-16, chosen from options: "Block until
  answered"). The employee can still pay the day from annual balance or dispute it, and approving
  first would take that choice away. The refusal says to wait for their answer or for the answer
  deadline to settle the day, or to mark the deduction Needs Follow-up. A week released just before
  payroll closes waits about 2 working days. A day whose release notice failed waits until the
  employee answers, because the daily job settles only days the employee was told about.

**Except for somebody who has left** (owner, 2026-09-16, chosen from options: "HR decides"). A
leaver is never counted as told by a release notice (`releaseNoticeReached`, owner 2026-09-17), so
their answer deadline never runs, and a released day of theirs would refuse approval in their
**final** payroll for ever. So a day of a released week whose notice reached nobody
(`notified_at` null) stops blocking once the employee record says they have left — any employment
status outside active and on leave (`isTerminalEmploymentStatus`, the auth module's own test, read
by `employeeHasLeft`). HR decides that day at month end as it did before the weekly review existed:
approve it from the final pay, or record Do Not Take Action. Nothing is deducted automatically
without a notice, and the settle function still refuses annual balance for a day already decided at
month end (`55000`), so no day is ever charged twice. Anyone still with the company keeps the
block, because they can still answer; so does a week still waiting for release, which is still the
Super Admin's to untick. An employee record that cannot be read counts as still here, so the block
stays.

A day still pending when payroll closes is therefore not deducted that month. The bridge's own
approvals never trip this check: a fingerprint deduction covers one day, and the bridge approves a
day only once it has settled, when it is no longer pending. A trial-run week never blocks, because
it is never released. Like the other two reads, this one fails closed.

**The balance check reads every source of spent days.** On its own, the vacation calculator reads
the payroll Copilot's balance ledger fail-open (a failed read counts as zero). The review asks it
to read **fail-closed** (`failClosedLedgerRead`), in this period and in every earlier one the
carried-debt walk visits, and a failed read refuses balance. The service and the settle function
also re-sum leave requests, balance charges and that ledger themselves, and refuse balance if the
calculator saw less. **The calculator's used figure includes debt carried from earlier periods**,
so the check takes that debt out before comparing. Left in, 3 days of debt would hide 3 days the
calculator failed to see.

**A reviewer never rules on their own day.** Deciding a dispute on your own HR ID is refused, and
another reviewer or the Super Admin has to do it. The Super Admin is exempt, being
the last approver. Nothing in a trial-run week can be settled or have its dispute decided, whoever
calls, and the SQL enforces this too.

### 4. Silence past the deadline means salary

The deadline is **2 working days after the release day**
(`attendance_digest_settings.answer_working_days`, default 2). It is counted on the employee's own
weekly-off pattern and the holiday calendar, and the release day itself does not count. Each daily
run first settles every day still unanswered after its deadline as **`auto_salary`**, then applies
answers to payroll. This reverses 2026-09-08 rule 2 **on purpose**: that rule rested on "nobody is
told", and now everybody is told, with the deadline in the notice.

**Days on leave do not count** (owner, same day, chosen from options: "Pause for leave days"), and
**leave still waiting for approval counts as leave** (owner, 2026-09-16, chosen from options:
"Pending pauses too"). Someone on leave is not at work to answer, and a sick day is often filed
before anyone approves it. So a day of a leave request that is approved, waiting for HR assignment,
or pending with the manager or HR (`ANSWER_WINDOW_LEAVE_STATUSES`, read by `getLeaveDayMap`) is
skipped like a weekly day off or a public holiday (`countsTowardAnswerWindow`). A test holds the
waiting statuses equal to the vacation module's own in-flight set; a rejected or returned request
pauses nothing. Leave can be filed or approved after the release, so the deadline is worked out
again from the release day (`heldAnswerDeadlines`) before the daily job settles a week past its
stored date, and before an answer given after that date is refused. A later date is saved and the
days wait (`deadlinesMoved` in the job's result). **A deadline is never brought earlier:** the later
of the date the employee was told and the date worked out now holds (`heldAnswerDueDate`), and the
save only ever moves a stored date later, so a rejected or cancelled leave request, or a lowered
`answer_working_days`, never takes salary sooner. When the holiday calendar or leave requests
cannot be read, a Google Calendar outage included, the daily job settles **nothing** and returns
500, and an employee answering after the stored date is told to try again shortly. A calendar
that never yields a working day cannot hang
the count: after 1,000 days it returns the last day walked, later than any date a real count could
give. Measured on production, read-only, the night of 15–16 September 2026: all 551 leave requests,
whatever their status, and all 7 employees with a real digest store their HR ID upper-case and
trimmed, so the leave lookup's exact match misses none.

**Whoever works a later date out saves it** (`saveLaterAnswerDeadlines`): the employee's page, the
answer they file and the daily job all write it back, each guarded on the week still being open and
its stored date still being earlier, so every surface reads one date. Showing a date is a promise,
and the job settles on the **stored** one — a date only shown would be taken back the moment that
leave request is rejected, taking to salary a day the employee was told they still had. A date the
page cannot save is not shown either: the stored one stands. The job saves every date it moves
before it settles the first day of any week, and reads the stored date once more immediately before
settling each week, because minutes pass inside one run and the employee's page, or an answer of
theirs, may have saved a later one in between.

**The deadline runs only for someone who was actually told.** `notified_at` is stamped only when the
notice reached in-app or Telegram (`releaseNoticeReached`), and the sweep skips every week without
it (`deadlineApplies`). An employee whose notice failed still sees the week on their page and can
answer, but their silence is **never** turned into a salary deduction. The release screen says how
many could not be notified. A day the sweep fails to settle is reported, and the daily job returns
500.

**Answers are applied to payroll over three months: the current one and the two before it.** A
deduction candidate exists only after its month closes, and a dispute on a late-month day can be
decided well into the month after next. The bridge reads settlements page by page, so days skipped
as already decided or not yet built can never fill a capped read and hide newer answers.

### 5. Live weeks, calendar months and releases in rounds — owner, 2026-09-17

He reported the review as "not calculating deduction correct and not up to date", and asked for Nahed
Hattab's fingerprint deduction from 1 September. The per-day figures were right; the weeks were not.
There were four causes:

- A week was built once, at 06:23 Cairo on the morning after it closed. That is hours before that
  day's punches arrive, and the week was never looked at again, so a later punch, excuse or leave
  never reached it.
- The running week did not exist until it closed.
- The 31 Aug–6 Sep week was a void trial copy that could never be released.
- The review ran from the 24th to the 23rd, while month-end payroll runs by calendar month.

His answers, chosen from options:

- **"Show live, release any time."** A week is listed from its first day and holds the days up to
  **yesterday** (`reviewWeekWindow`). The review month is the month of yesterday
  (`currentReviewMonth`). He can release the days so far in the middle of the week. Days that arrive
  later wait for a **second release** of the same week (`release_round` 2, 3 and so on), and at most
  one real digest per employee-week waits at a time (`attendance_weekly_digests_one_awaiting_idx`).
  The notice names only the days asked about (`releaseNoticeRange`). The daily job runs at **06:23 and
  13:23 Cairo** (`.github/workflows/attendance-weekly-digest.yml`), and the afternoon run is the one
  that sees yesterday's punches. It covers every started week of the month, plus, for the first three
  days of a month, the last week of the month before (`reviewWeeksToSync`). It reads the fingerprint
  report once per run.
- **"Rebuild it as a real week."** Migration `20260917120000_weekly_review_live_weeks.sql` copies the
  trial digests (void, dry run, never released, with no settlement) and their days into
  `attendance_backup_20260917.trial_digests` (a dated schema of its own, never `public`), then deletes
  them. Refresh or the daily job fills the week again, waiting for release. Nothing is sent.
- **"1–30 September. Keep payroll as it is. From October the weekly review's weeks start on the 1st
  to match."** `digest-weeks.ts` cuts a calendar month into 1–7, 8–14, 15–21 and the 22nd to the month
  end. September 2026 is the one transition month: week 2 is 1–6 Sep, week 3 keeps 7–13 Sep because
  its real digests were already built on those dates, week 4 is 14–23 Sep and week 5 is 24–30 Sep.
- **"build starting from 1 august"** (same day, after the live weeks shipped). August 2026 is
  reviewed as an ordinary calendar month: 1–7, 8–14, 15–21 and 22–31 Aug (`FIRST_REVIEW_MONTH`). When
  he asked, August's 50 fingerprint days were all still Pending in month-end deductions and nothing
  was published, so an answer reaches the same candidate through the bridge and never charges twice.
  The daily job does not refresh August (it is not the review month): its weeks were built once on
  request. Refresh works on them through 1 October, while August is last month, and after that they
  stay listed while any day waits for release or an answer. Nothing before August 2026 is reviewed.
- **"Yes, keep ½ day."** The deduction rule itself is unchanged.
- **"i want every row to has a release beside it not only the full week but only every single
  employee so i can realse one employee and after release another"** (same day). Every employee
  waiting for release has their own **Release** on their row, with a confirmation that names them. It
  sends `digestId` and only that employee's days. `releaseScope` narrows the release to that one
  digest before any day is checked, cleared or told. The other employees keep waiting, and their
  ticks stay as they were. The week's button stays and releases **everyone waiting**. No migration was
  needed, because `phx_attendance_release_digest` already works one digest at a time. Asked the same
  day after a whole-week release cleared 12 unticked days he had meant to keep. Those days were
  restored by hand from `attendance_backup_20260917.w3_release_*`.

**Do not restore** the day-24 weeks (`latestClosedSettlementWeek`, `closedWeeksOfCurrentCycle`), the
one-shot build with its undo, or a week that appears only once it has closed. They are the superseded
design, not unfinished work.

### Known limitations (documented, not fixed)

- **A balance-paid day later cancelled by evidence** (for example, an approved leave or a proven
  fingerprint) keeps its balance charge. The ledger is immutable, and no refund path exists.
- **`recordDecision` does not take the per-employee lock.** A payroll approval and a balance charge
  landing within milliseconds of each other can both succeed. The bridge alert and the 500 catch it,
  and a person then sets the deduction to Do Not Take Action.
- **Carried vacation debt is not re-checked inside the SQL.** The service includes it, and the SQL
  re-checks requests, charges and the Copilot ledger.
- **The payroll Copilot's balance writes take no per-employee lock** (this predates the review). A
  Copilot settlement landing in the same instant as a balance charge is not serialised against it.
- **Page caps:** a release handles up to 1,000 digests, the review page lists up to 1,000, and the
  dispute inbox up to 200. Today's weeks are a few dozen.
- **A notice that failed is not re-sent.** The employee still sees the week and can answer, and the
  deadline never runs for them, but nothing tells them again.
- **A dispute decision notice that failed is not re-sent either.** The reviewer's screen says the
  employee could not be told, and the decision shows on the employee's page.
- **Leave filed after a day was settled does not reopen it.** Once the daily job has settled a day
  to salary, a leave request for that window filed later changes nothing. Leave filed before the
  settlement pauses the window even while it still waits for approval.
- **A day the report stops returning stays as it is.** Only a day the report returns as cleared is
  taken off. A day missing from the report keeps waiting, and a person unticks it.
- **A released day is never refreshed.** A later excuse, leave or corrected punch does not change
  what the employee was asked; the employee can dispute the day.
- **A stale page releases nobody.** When the daily job adds a day while the page is open, Release is
  refused for everyone until the page is reloaded.
- **The review page shows the stored deadline.** The employee's page and the answer path work a
  passed date out again and save it, and the daily job saves every date it moves, so the review page
  is at most one page load or one daily run behind — and never shows a date earlier than the one the
  employee holds for longer than that.
- **The daily job's re-read is not a lock.** A deadline saved in the milliseconds between that read
  and the settle that follows it is missed, and the day settles on the date just read. One replica
  runs the job, the window is a few milliseconds wide, and a day settled to salary is still the
  Super Admin's to set to Do Not Take Action at month end.
- **Leave more than 45 days ahead is read on a later run.** Each read covers today plus 45 days, so
  a longer leave moves the deadline again as its days come into range, always before the deadline
  can decide anything.
- **Raising `answer_working_days` also lengthens deadlines already running,** once their stored
  date passes. Lowering it never shortens one.
- **A Google Calendar outage holds release and the deadline until it passes.** While Google's
  holiday calendar cannot be read, release refuses, the daily job settles nothing, returns 500 and
  tries again on its next run, and an employee answering after the stored date is told to try again
  shortly, even when leave has moved their deadline later. A failed read is remembered for up to 10
  minutes (the holiday cache), so this can last that long after Google answers again. Until
  2026-09-16 an outage in a month with a company or fixed-date public holiday read as connected, so
  a release could count an Eid day.

### Settled later

Three follow-up questions, including the one this section used to hold, were put to him as options
on the evening of 2026-09-15, and three more on 2026-09-16 — two just after midnight, and one raised
by the risk review of those follow-ups later that day. He chose the recommended answer each time:

- **"Yes, in-app and Telegram"**: the employee is told how a dispute was decided (§2).
- **"Pause for leave days"**: days on approved leave do not count toward the answer window (§4).
- **"Block until released"**: month-end approval refuses a day of a week still waiting for release
  (§3).
- **"Block until answered"** (2026-09-16): month-end approval also refuses a day of a released week
  that the employee can still answer (§3).
- **"Pending pauses too"** (2026-09-16): leave still waiting for approval pauses the answer window
  as well (§4).
- **"HR decides"** (2026-09-16): a day of a released week whose notice reached nobody stops blocking
  month-end approval once that employee has left, so a final payroll is never held up by a question
  they were never asked (§3).

## A Google Calendar outage is not "no holidays" — owner decisions, 2026-09-16

Egypt's moving holidays — both Eids, Islamic New Year, the Prophet's Birthday, Coptic Easter /
Sham Ennessim — cannot be derived from a Gregorian rule. They exist only in Google's calendar. So
when that feed cannot be read, `national-holidays.ts` falls back to the company list plus the seven
fixed-date public holidays (7 Jan, 25 Jan, 25 Apr, 1 May, 30 Jun, 23 Jul, 6 Oct), and a month
holding one of those comes back **`connected: true` with a non-empty list** while every moving
holiday is simply absent and reads as an ordinary working day.

Every gate written against `connected` therefore passed straight through the outage. **`calendarReachable`
is the flag that tells the truth**, and a failed read is cached for 10 minutes, so an outage
outlives itself by that long.

**Checked read-only against production on 16 September 2026** (Railway DNS and network logs,
deployment `e2cfc46b`, nothing triggered): `calendar.google.com` resolved NOERROR at 01:21, 01:31
and 01:34 Cairo, each followed by real TLS traffic out on 443 that closed cleanly — the calendar was
reachable that day. Railway's log feeds are short-retention, so a later re-probe returning nothing
is a quiet feed, not an outage.

### The rule

**A path that can take money, or a day off a leave balance, REFUSES while `calendarReachable` is
false. A path that only shows something keeps working and says the calendar is degraded.** The
owner chose all four recommended options on 2026-09-16 ("1A 2A 3A 4A").

| Reader | Answer | Why |
| --- | --- | --- |
| Weekly attendance review — release, the daily deadline sweep, the employee's late answer | **Refuses** | An Eid counted as a working day inside the answer window brings the deadline early, and the day settles to salary. |
| Employee Day-by-Day report — **"Approved for Payroll"** | **Refuses** (1A/2A) | The day cannot be told apart from a public holiday and approving charges it. **Rejecting ("Do Not Take Action") stays open** — that direction costs nobody money. |
| ~~Automated Payroll part 2 — CRM leave~~ — **GONE 2026-10-01, and this is not a regression** | n/a | The reader this row described (`loadCrmLeaveDatesByCompact`, behind `computeVacationDeductionTotals`) refused correctly, then stopped being reachable at all when the owner made `scripts/import-crm-vacation-backfill.ts` the one path a CRM leave day reaches a balance by. Automated payroll no longer reads CRM leave or writes that ledger from anywhere, so there is no longer a path here to gate. **The protection did not move — it was already in front of the write that actually happens:** the importer calls `validateOfficialHolidayAdjacency` (its own row below), and the Field Workforce engine it reads still refuses on `calendarReachable === false`. Do not re-add a gate to automated payroll to "restore" this. |
| Payroll Copilot — holiday bridging | **Refuses** (1A) | Bridging *deducts* a day beside a holiday; computing the windows from half a calendar deducts the wrong day. |
| Live deductions connectors — CRM, DSM no-record, holiday bridge | **Refuses** (already did) | Same money, already gated on `calendarReachable`. |
| Leave filed next to a holiday (`validateOfficialHolidayAdjacency`) | **Refuses** (3A) | It would otherwise clear a request sitting right beside a holiday it cannot see. Its wording deliberately avoids the phrase *national holiday*, which the company-report approve route maps to its own adjacency message. |
| Company Vacation Report — the approve click | **Refuses** (2A) | Approving takes the day off the employee's annual balance for good, with no correction path once a later month is published. 409 `holiday_calendar_unreadable`. |
| Attendance analytics banner · monthly attendance summary · Company Activity Report (screen **and** workbook) · Head Office attendance calendar · the deductions/attendance reconciliation line | **Degraded, and says so** (4A) | Reading a month is not charging for it. Each now names what is missing rather than implying every holiday was lost. |
| The T-3 holiday confirmation reminder | **Records the outage** (4A) | It used to return an empty list, which reads as *nothing to confirm*. The moving holidays are exactly what needs confirming **and** exactly what an outage hides, and only a confirmed holiday survives the next outage as an override — so silence loses that holiday twice. It writes an error log; **it sends no notification and no email.** |

**Still deliberately degraded:** the vacation report's overlap *warnings* (`fetchHolidaysForRows`
in `src/lib/vacation/service.ts`) under-warn during an outage. They only weaken a nudge — no money
and no balance moves through them — so they were left alone rather than widen this change.

### The shape to reuse

`getConfirmedNationalHolidaysForPeriods(periods)` gathers several months at once, dedupes by
holiday id, and reports **both** flags as ALL-of: one unreadable month makes the whole span
unreadable. Each caller words its own refusal, because what it is refusing to do differs. Pinned by
`tests/holiday-calendar-outage-gates.test.ts`.

## The premium Monthly Closing wears its own executive look — owner decision, 2026-09-08

He sent a redesigned Monthly Closing workbook with a long brief, and the instruction was not "try
this": *"Treat this workbook as the OFFICIAL visual reference and design standard for all future
Monthly Closing files. Your task is NOT to invent a new design."* Navy `#0A1F33` and `#103A5C`,
corporate blue `#0B78B7`, a light-blue KPI band, an amber warning strip, Segoe UI throughout, and a
Contents page organised as five numbered sections rather than a list.

### It departs from three of his own locked rules, and he was told so before the work began

- **Square-edge.** The navigation buttons are rounded rectangles. The golden rule of 2026-09-04 says
  no round or semi-round corners anywhere.
- **The ink rule.** The look is carried by AREA: a filled navy title band, filled table headers,
  filled KPI panels — 136 filled shapes in the build this was measured on. The house standard's ink
  rule says colour is carried by lines and type, never by area.
- **The house palette.** Its navy is in no part of the Sato mark. The house palette is the four
  blues measured from the logo (`#0A527D`, `#0A6BA6`, `#1482C2` and the tint), and `#0A1F33` is the
  family that palette explicitly replaced.

He was shown all three, in those words, and answered: *"yes, keep the design, pin it with a test."*
So this is a per-EXPORT exemption, exactly like the automated payroll exports and the weekly NSM/DSM
book before it. The offer letters, the hiring pack and the published payslip renderer are untouched
by it and stay on the house identity.

### Why it needs a test rather than a note

Because it is the third time. `house-identity.ts` says every company document wears
SATO-DIS-2026-01 v1.0, so a session sweeping for documents not yet on the standard finds this
workbook, finds a rounded button bar and filled bands, and "finishes the job" — reversing an owner
decision while believing it is enforcing one. That has already happened to the payroll exports and
to the weekly book. `tests/closing-executive-look.test.ts` fails on any brand blue as fill or as
type, on the workbook's own three colours going missing, on every shape being square-cornered, on
the filled bands being stripped, and on the band heights being reset. It carries a positive control,
because every colour assertion passes on an empty string, and it was proved RED four ways — buttons
squared, fills stripped, a house blue painted in, and the warning strip reset to its old height —
each firing its own message rather than the suite merely going red.

### The reference file is a specification, not a template

⚠ The approved workbook **cannot be opened by Microsoft Excel**. It is written by a .NET OOXML
writer that puts its pivot cache outside `xl/` and uses absolute relationship targets; Excel refuses
it outright, repair mode included, and writes no recovery log because it never gets far enough to
repair anything. Verified against a control in the same Excel session, and relocating the pivot
cache into `xl/` and rewriting every reference did not fix it. Whatever rendered it for the owner
was not Excel.

So the design was ported into our own engine rather than adopted as a file. That is also the only
route that satisfies his own brief: the reference preserves the logic faithfully — 47 formulas, the
Rep Card dropdown, three pivots, two slicers, identical counts to ours — but a workbook nobody can
open cannot be the standard, and his brief ends *"Verify workbook opens normally in Microsoft
Excel."*

### What the port put in

`src/lib/sales/closing-executive-look.ts` carries the measured geometry for all seventeen sheets,
read out of the reference package rather than eyeballed off the four screenshots he sent, so it
covers the thirteen sheets he did not photograph. Row heights are stored as a design block plus one
repeated body height, so a month with more areas keeps its styling all the way down rather than
stopping partway.

Column widths are applied by APPENDING narrow overrides to each sheet's existing `<cols>`, never by
rebuilding the block. Rebuilding produced a workbook Excel refused to open outright, and
`check-workbook-integrity.mjs` called it CLEAN; bisecting sheet by sheet put it on Rep Ranking,
whose block carries `style="2"` on every entry and a catch-all out to column 16384, both of which
the rebuild dropped. Appending is also the shape the owner's own reference uses.

### The warning strip, which is the first thing the brief forbids

*"Warning must NEVER overlap buttons."* It did, on every sheet, for as long as the note has existed.
It was written to A2 because row 2 is empty in the template — but empty is not free: every
navigation button is a drawing anchored from row 2, so the buttons painted straight over it.

Raising the row does not fix it, which is worth knowing before someone tries. The buttons are
anchored from row 2 INTO row 3 (`+53,975` through `+6,350`), and a `twoCellAnchor` resizes with its
rows, so a taller row 2 yields a taller button with the same overhang. The note moved to row 3,
where the reference puts it, and `fitNavigationBand` clamps every band shape to end at the bottom of
row 2 — uniformly, so the buttons stay identical in height to each other, which is the other half of
the brief.

`tests/closing-engine-export.test.ts` gained the assertion whose absence let this ship: no shape on
Overview may reach the warning row. Every earlier check was about the note's TEXT, and the text was
always right; what was wrong was a drawing floating over it, which no cell-level read can see.

### Seeing it at all

`scripts/render-workbook-sheets.ps1` renders each sheet to PNG through Excel itself, because all
three of the documented ways of looking at a generated workbook lie (AGENTS.md §2.1). Four capture
combinations were measured before one worked — the file's header carries the table and the byte
floor that separates a real render from a blank page, since a blank render reads as an empty sheet.

## The weekly NSM/DSM export keeps the beige look — owner decision, 2026-09-08

### What happened

The owner said: *"THE WEEKLY SALES NSM/DSM TEMPLETE CHANGED TO BLUE I WANT THE BEIGE ONE."*

Two PRs put it there, three days apart, and neither asked:

- **PR #3242, 2026-09-05** moved four of the five weekly workbooks onto the house document identity
  (SATO-DIS-2026-01 v1.0). For this book it re-pointed every constant into the house blues, swapped
  Calibri for Aptos, and turned the three warm-grey fills — the column header wash, the soft group
  wash and the total wash — into rules, because the ink rule forbids filled area. Its own commit
  message called this book "already the quiet one" and treated the conversion as finishing a job the
  file had half-started.
- **PR #3303, 2026-09-05** then painted a Brand Blue header band on it — white type on `#0A6BA6`.

So the book a district manager prints went from warm grey and orange to white and blue.

### What is exempt, and what is not

Exempt: `src/lib/sales/weekly/nsm-dsm-workbook.ts`, the workbook behind the **NSM/DSM Export**
button on Weekly Sales. It is back on Calibri, `FFF3F1EE` / `FFFAF8F5` / `FFEBE8E3` washes,
the `FFF4F1EC` zebra, the `FFF6DCC4` warm heat marks, and the single `FFF97316` Phoenix orange
accent. The masthead strip names the app again instead of printing the standard's reference.

**Not exempt — do not convert these back.** The analyst BI workbook
(`weekly/export-workbook.ts`) and the batches workbook stay on the house identity; PR #3242's work
on them is untouched and `tests/weekly-export-workbook.test.ts` still passes unchanged. The split
is per-EXPORT, exactly as it is for the automated payroll sheets above. The distinguishing fact is
who reads it: this is the field manager's printed book, and the beige is what he recognises.

The Weekly **Summarized Report** was never in scope for either direction — its layout and scope are
locked, and the owner lifted its ink half himself on 2026-09-05.

### Measured on the emitted artifact, both ways

Same fixture, same seven sheets (`Summary`, `By area`, `By branch`, `By distributor`, `Ranked`,
`Stock`, `Details`) — only the ink moved:

| | `origin/main` (what he opened) | this change |
| --- | --- | --- |
| typefaces | `Aptos` | `Calibri` |
| fills | `FF0A6BA6` `FF1482C2` `FFDDE8F1` `FFF2F6FA` | `FFEBE8E3` `FFF3F1EE` `FFF4F1EC` `FFF6DCC4` `FFFAF8F5` |
| type | `FF0A6BA6` `FF0F766E` `FF1A1A1A` `FF5A6B7C` `FFB3261E` `FFB9C7D4` `FFFFFFFF` | `FF1A1A1A` `FF1E7A3C` `FF6B6B6B` `FFAAB0B6` `FFB3261E` `FFF97316` |

### Why this needed a test and not just a note

The exemption is invisible in the code. `house-identity.ts` says every company document wears the
standard; a session sweeping for documents that do not will find three filled washes here, read
them as the ink rule not yet applied, and convert them — reversing an owner decision while
believing it is enforcing one. That is exactly what #3242 did, and what happened to the payroll
exports before it.

`tests/weekly-nsm-dsm-beige-look.test.ts` builds the workbook, reads the colours back off the
emitted package, and fails on any of the four brand blues as fill or as type, on any typeface other
than Calibri, and on the standard's reference appearing in the masthead. It carries a positive
control first — an empty workbook would satisfy every "no house blue" assertion — and it was proved
RED in both directions before being trusted: swapping the zebra to the house tint fired *"the zebra
row must be the warm FFF4F1EC, not Brand Blue at 6%"*, and swapping Calibri for Aptos fired the
typeface assertion.

### One thing that is not palette

`workbook.creator` went back to the app name along with the rest of the revert. It is file metadata
in Excel's Properties dialog, not ink; if the company name is wanted there it can be set back
without touching anything this rule protects.

## The weekly BI export's design is locked — owner decision, 2026-09-08

### What he said

*"LEAVE THE weekly BI export AS IT IS PUT LOCK NEVER CHANGE ITS DESIGN."*

Said immediately after the NSM/DSM book was restored to beige — i.e. having just watched two PRs
(#3242, #3303) restyle a workbook he relies on without anyone asking him. The instruction is the
opposite of that one: the NSM/DSM book had to *change back*, and this one must **never change at
all**.

Note what it is not. He is **not** asking for the BI workbook to come off the house identity. It
wears SATO-DIS-2026-01 v1.0, that is what he is looking at, and that is the state being frozen. A
session that reads "beige" from the neighbouring rule and applies it here has inverted the
instruction.

### What is locked

`src/lib/sales/weekly/export-workbook.ts` and `src/lib/sales/weekly/export-kit.ts`. The kit is
imported by that builder and by **nothing else** — verified, not assumed — so freezing it freezes
this workbook and reaches no other module. That is what makes a lock at this level safe here and
what made the equivalent impossible for `sales-workbook-kit.ts`, which eleven modules share.

The locked surface, measured off the emitted package:

- the **23 sheets**, their order, and which two are hidden (`Data`, `CoverageHelper`)
- every **column width, row height, merge, freeze pane, autofilter and conditional format**
- the **style index on every cell** — so a re-styled column is caught even when no width moves
- the whole **style table** (`xl/styles.xml`) — every colour, font, border, fill and number format
- the **5 charts**, by the series type each declares

### What is deliberately NOT locked

**Cell values and formulas.** A corrected number, a fixed SUMIFS or a re-worded heading is not a
design change and must not need the owner's sign-off. This was proved, not asserted: re-wording a
sheet's subtitle leaves the lock green, while restyling a single header cell on the same sheet turns
it red and names `Pareto`.

The pivot's own mechanics — `refreshOnLoad`, the `tblWeekly` table source, cache integrity — stay
pinned separately in `weekly-export-workbook.test.ts`. Those are about the workbook opening on
current data, not about how it looks, and they must keep working independently of this lock.

### How it is held

`tests/weekly-bi-design-lock.test.ts` builds the workbook from `sampleDashboard()` — the same fixed
fixture `runWeeklyExportTests` uses, so no data change can move the pin — and compares a design
fingerprint. It runs in the required CI `test` job.

The fingerprint is stored as a readable table of one digest per sheet, plus one for the style table
and one for the charts, rather than a single opaque hash: a failure then says *which* sheet moved.
It was confirmed deterministic across two builds in one process and across two separate processes
before being trusted, because a flaky pin in a required check is worse than no pin.

Proved red four ways and green on the one that must stay green:

| change | result |
| --- | --- |
| the zebra tint moved (a polish sweep) | RED — style table |
| a sheet renamed | RED — sheet set |
| a sheet added | RED — sheet set |
| one header cell restyled | RED — layout, naming `Pareto` |
| a subtitle re-worded | **green**, correctly |

### 🔴 The failure mode this exists to catch

Re-pinning the digests to clear a red suite. That turns the lock into a rubber stamp, and it is the
move a session reaches for when it does not know the digests are an owner decision — the same
instinct that let #3242 restyle four workbooks while believing it was enforcing a standard. The
digests change only when the owner has said so about **this** workbook in the live conversation.

New capability ships **beside** this workbook, exactly as every new closing feature ships beside the
frozen monthly closing export.

## The weekly BI and NSM/DSM export designs are password-locked — owner decision, 2026-09-08

### What he said

*"look templete design never change unless set this paswword: …"* (the password itself is
not reproduced here — see below), and when asked which
templates, he named **the weekly BI export** and **the weekly NSM/DSM export**.

### Why a password and not just a test

Both designs were pinned earlier the same day, by literals living inside their test files. That is
real protection against an accidental restyle and **no protection at all** against the failure mode
it was written for: a session meets the red test and edits the literals until it goes green. The pin
and the thing guarding the pin were the same file.

Now the pins live in `src/lib/sales/weekly/export-design.pins.json`, and the only sanctioned way to
rewrite them is `scripts/weekly-export-design-unlock.ts --unlock`, which derives scrypt over the
supplied password and compares it against a committed verifier.

### What is committed, and what is not

`src/lib/sales/weekly/export-design.lock.json` holds a scrypt verifier — a random 16-byte salt and
the 64-byte derived key at N=2^17 — and nothing else. The password cannot be read back out of it.
The repository, its clones, its CI logs and every AI session that reads these files hold something
that can **check** the password and never one that can **supply** it. A plaintext passphrase in a
committed file was tried here on 2026-07-31 and removed for exactly that reason: it authenticated
nobody.

⚠ **The password was typed into a session transcript**, and it is derivable from the repository's own
contents — the company name plus the year. Both points were put to the owner before the lock was
armed, and he chose to proceed. Changing it needs no code change: `--set-password` asks for the
current one first, and the new one never leaves the terminal.

### What is locked

The sheet set with its order and visibility · every column width, row height, merge, freeze pane,
autofilter and conditional format · the style index on every cell · the whole style table · the
chart inventory.

**Not locked, deliberately: cell values and formulas.** A corrected number, a fixed formula or a
re-worded label is not a design change and must never need the owner's password to ship.

### One fixture, one fingerprint, both callers

`scripts/weekly-export-design-fixtures.ts` and `scripts/weekly-export-design-fingerprint.ts` are
shared by the test and the unlock script on purpose. If the two computed fingerprints even slightly
differently, a legitimate unlock would produce a pins file the test rejects — and a lock nobody can
open is as broken as one that never closes. The BI fixture reuses `sampleDashboard` from
`tests/weekly-export-workbook.test.ts` rather than restating it, for the same reason.

### Proved, not asserted

| break | result |
| --- | --- |
| BI zebra tint moved | RED — "the STYLE TABLE changed", naming the BI export |
| NSM/DSM beige zebra moved | RED — same, naming the NSM/DSM export |
| a sheet added to the NSM/DSM book | RED — "the SHEET SET changed" |
| wrong password to `--unlock` | refused, pins byte-identical afterwards |
| correct password, nothing changed | reports **"Nothing to re-pin"**, not a false success |

That last row matters: running the unlock in the primary while the edit sits in a worktree re-pins
unchanged source and prints success. Naming the drift — or its absence — is the tell.

The test also asserts the lock is **armed**. A missing verifier reads exactly like a working lock
from inside a session, which is the hazard the Office golden rule carried until 2026-09-05, when a
session reading the docs would have believed a password was in place while none was.

## Pedia's Upper Egypt splits in two, and August is frozen — owner decision, 2026-09-09

### What he said

> Upper Egypt will be divided, splitted into Upper Egypt one and Upper Egypt two. Upper Egypt one will be Fayoum as a separate area, Beni Suef as a separate area, Minya one, Minya two, Asyut one, Asyut two. Regarding Upper Egypt two, will be Suhag one, Suhag two, Qena 1 and Qena 2, Luxor, and Aswan in others. But golden rule, golden, golden, golden rule. August closing will be normally. The changes in sales will be starting from September.

Asked to confirm, he said it twice more, and widened it:

> this change will not affect anything in August but starting from September everything will be based on this distribution, every fucking thing ... in August closing it, this changes will not affect anything

> yes, this changes is only in Pedia, only in Pedia, only in Pedia. No, you will change everything, sales geography and organogram and everything. But you will pause August, August as it is. But after August you will change everything that needs to be changed.

Two answers came back as corrections, and both matter:

- **Luxor is NOT a separate area.** *"no, no, no. Luxor is with Qena 2 ... not a separate area. And Aswan is with others."* The first reading, Luxor as its own area with its own rep, was wrong.
- **The district managers are new hires.** *"The district managers of the two halves are new hired. After we make the splitting, I will add their data."* So both seats are created vacant.

### The shape

| District | Areas |
| --- | --- |
| Upper Egypt 1 | Fayoum, Beni Suef, Minia 1, Minia 2, Assuit 1, Assuit 2 |
| Upper Egypt 2 | Sohag 1, Sohag 2, Qena 1, Qena 2, Luxor |
| Others | Aswan, untouched |

Giza drops from 8 areas to 6. Others drops from 12 to 10. Pedia only.

🔴 **The region codes `UE-1` and `UE-2` already existed** — Anti Infective has run them since 2026-07-13 — so this is not a new shape, it is Pedia joining one the system already runs. **Their MEMBERSHIP differs per line on purpose:** Assuit sits in UE-2 on Anti Infective and in UE-1 on Pedia, and Fayoum is in Giza there. `au.line_area_map` is per line. A session that "aligns" the two reverses him.

### Why a dated pair, and why he did not need a snapshot table

He asked for one in plain words:

> at least you can save a snapshot of the current organogram, and this is a snapshot the qema will work on for August. Okay, and starting from September, it will read normally from the organogram.

The system already does exactly that, and more safely than a copy would. `closingRegionsAsOfDate` resolves the org chart at the **last day of the month being closed**, never at the day the closing is run, and `au.f_line_area_map_asof` uses the same predicate with `effective_to` **exclusive**. Closing the open rows at 2026-09-01 and opening the new ones on the same date puts August permanently out of reach of the change, whenever August is finally run, with nothing to remember on the 1st.

This is the Delta (3) shape — `20260829113500_anti_infective_delta_3_from_september.sql` — deliberately mirrored. A pre-image is kept in `au.bak_20260909_pedia_ue_split_line_area_map` and `..._seats` as well, but it is belt and braces, not the mechanism.

⚠ **August Pedia was NOT locked when this was written.** Only Anti Infective 2026-08 carried a `monthly_closing_locks` row, from 2026-09-07. So the dating was doing real work, not decorating a month already protected.

### The one number this moves

El Qema's rule spreads that distributor's Pedia book across the areas the line has except those parked in Others, and the exclusion keys on `operational_region_code = 'OT'` **alone** — never on `area_state`, never on `carries_target`. Qena 2 and Luxor leave Others here, so:

| El Qema divisor, Pedia | Areas |
| --- | --- |
| August | 37 |
| September | 39 |

**Luxor still takes a share even though it carries no target**, because the rule counts areas and not reps. That is not a defect. It is the same shape OT9 Ismailia rode into Delta (3) with: `other_permanent`, no rep seat, inside a real district.

### The seat caveat, which cannot be dated away

`au.seats` has `seat_id` alone as its primary key, so a seat **cannot** be forward-dated the way a map row can. The four new seats carry `effective_from = 2026-09-01`, but re-pointing the existing Upper Egypt rep seats to their new district happens the moment the migration is applied. That is chart metadata only — every number the closing produces comes from `au.line_area_map`, which is dated. Do not "fix" this by writing a second seat row; the primary key forbids it.

⚠ When he adds the two district managers, an `employees` insert auto-seats them and flips `line_area_map.area_state`, which is hashed into the attribution fingerprint. **Re-stamp after the hires.**

### Two things found on the way, neither fixed

- The `runTest` label for `runQemaWarehouseSplitTests` describes the 200 and 1,000 pack bands, which is correct again as of the 2026-09-09 evening ruling.
- `buildOperationalRegionMap` resolves overlapping rows to the **latest** `effective_from`; `au.f_line_area_map_asof` orders `effective_from asc` and so takes the **earliest**. The TypeScript comment claims the two match. No overlap is written by this migration, so nothing here depends on it, but they disagree and a future overlapping pair would resolve differently in the sheet and in achievement.

### How it is held

`tests/pedia-upper-egypt-split.test.ts`, in the required CI `test` job. Its headline assertion is the golden rule itself: August's El Qema distribution built **with** the September rows present is `deepEqual` to August's built **without** them. Proved red by dating the pair to 2026-08-01, the real failure mode.

### The Upper Egypt pool was deleted — owner, 2026-09-09

His pooling rule of that morning — *"look fayoum bani suef and all upper egypt regions, you will calculate their total and then redistribute on them the sales evenly, fayoum-banisuef one region"* — was replaced hours later by the priority ladder, which #3583 shipped listing the pool as one of the five rules it discards, and the pool was deleted in #3606. The evening ruling then brought a DIFFERENT Upper Egypt rule back; see the current section at the top of this file.

Deleted on his instruction after the removal was measured and put to him. `POOLED_BLOCK_REGION_CODE`, `POOLED_BLOCK_LABEL`, `isPooledBlockRegion`, `pooledBlockMembers`, `MERGED_POOL_MEMBER_CODE` and `levelAcrossPool` are gone, along with `tests/pooled-block-region-family.test.ts`. `levelAcrossPool` had no callers at all, in source or tests.

Proved a no-op before shipping: 144 cases — nine origins across both halves of the split, Others and Cairo, four quantities spanning the retired 200 and 1,000 bands, two distributors, both months — byte-identical before and after, down to the per-area weights.

⚠ **Neither the ladder nor the صعيد pass preserves "fayoum-banisuef one region".** Under the pool they were one member taking one share; under both later rules they are two areas taking two. That follows from his later choices and is not an oversight.

⚠ **`LOCAL_BLOCK_OVERRIDES`, the Cairo + Qalubeya rule, was unreachable under the ladder and was deliberately LEFT IN PLACE.** That decision paid off: the 2026-09-09 evening ruling names the block again in step 2, so it is live once more — without its 75/25 weighting.

## Fayoum and Beni Suef separate on Pedia from September — owner decision, 2026-09-09

His words: *"fayoum separate area and banisuef separate area but august closing not affected starting from september"*, and when asked why not October, *"why not septemvber?"*

It arrived with the Upper Egypt split and matches it: the organogram already gives Beni Suef its own area and its own rep seat in Upper Egypt 1 from 1 September. Starting the closing separation in October instead would have left the chart and the closing disagreeing for a whole month.

### How it is dated

`ClosingAreaMergeRule` gained an `untilPeriod` — the mirror of the `fromPeriod` that already existed, and for the same reason. A merge that STOPS rewrites a published month exactly as surely as one that starts. Pedia now reads `untilPeriod: "2026-08"`, so August and every earlier closing renders as it was sent.

🔴 **CNS IS DELIBERATELY UNTOUCHED.** Its merge was removed on 2026-08-30 at his instruction and put back from August on 2026-09-07, and he said "only Pedia" three times about this change. Ending CNS's merge too would reverse a two-day-old decision he has not revisited.

### The defect this surfaced

The target upload folded the area by **today**, not by the row's own month. Invisible while Pedia folded in every period; wrong the moment the merge gained an end date, because an August target uploaded in September would have been stored on Beni Suef, a row August's merged grid cannot render. The operator would have seen no target where he had just set one. `validateTargetRows` now folds on `row.period`.

### Why Beni Suef has no target

Every Pedia target since February sits on Fayoum alone: September is 988 units and 147,953.25 value on Fayoum, nothing on Beni Suef. That is the merge's own doing — the Targets grid keyed its rows, its edit box and its save on the folded code, so it saved Fayoum's number and never wrote Beni Suef's. Separating them is what makes both settable, and a single upload now stores two cells.

⚠ **The September split between the two is HIS to give.** The two obvious bases disagree almost exactly in reverse — the last separately-set targets (January and February) put Fayoum at 69%, while sales since February put it at 32% — and the sales series is untrustworthy here because one rep has covered both areas throughout, swinging hard and twice going negative on returns. Do not derive it.

## No distributor's bonus is counted from September — owner rule, 2026-09-18

His words, profanity left out: *"logged and published months, we can't touch them. So if you already calculated bonus in August … don't touch it. Starting from September, never a bonus in any … distributor is counted."* It restates what he said on 2026-09-07, the ruling that also took the discount factor out: *"we neglect the bonus and the value in any distributor sheet, we take the units and multiply by factory"* (quoted in `src/lib/sales/monthly-closing-details.ts`).

### The rule

- From the September 2026 closing on, a distributor's bonus (free goods) is never counted, as units or as value, in ANY distributor, not only El Qema.
- A row's PAID units always count. A bonus cell is never a reason to drop them: the sale is its units × the factory price, whatever the bonus column holds.
- August and every earlier published month keep exactly what they published, even where a bonus was counted. Never re-import, re-stamp or correct those rows to apply this rule ("A PUBLISHED AND ANNOUNCED MONTH IS NEVER CORRECTED", §4). The date is the mechanism.

### What the code does, measured 2026-09-18 on `main` at 29c45a7

- The monthly normalizer (`src/lib/sales/normalizer/engine.ts`) and the older monthly importer (`src/lib/sales/monthly-distributor-import.ts`) both set every row's `bonusQty` to 0, so no bonus UNITS reach a closing.
- The gap is the whole-row flag. A profile's `bonusColumns` makes the engine skip a row whose bonus cell is non-empty, as free goods. For EPDA's two books, bulk and pharmacies (`EP-BK`, `EP-PHS`: `is_bonus`, a 0/1 flag on a free-goods line) that is right. For El Qema (`بونص`), the column holds a bonus QUANTITY on a line that also carries paid units, so a filled cell would drop the paid units — the opposite of this rule. It has never fired: El Qema's August book had 64 rows, 8,768 packs, none ignored. The fix is PR #4028, opened the same day: El Qema's `بونص` stops being a skip flag, so paid units always import and the bonus adds nothing, while EPDA's flag stays.
- The weekly report keeps POS bonus units apart on a synthetic line with `qty: 0`, never priced. It is not a closing figure.

### The trap

The fix changes how a sheet is READ, so it reaches only uploads made after it ships. Re-importing an August sheet to "pick up" the new reading would restate a published month, which is exactly what he forbade. A published month keeps its rows as they were imported.

## NSM scope — owner rulings, 2026-09-20

An audit of Reps List, Reps Plans, KPIs and their related screens for Medical Rep, District Manager and National Sales Manager found one real inconsistency and three smaller ones. Each was put to the owner as multiple choice; his answers are the rulings below.

### What the audit found (live directory, read-only)
- **Medical Rep**: 0 of 67 active reps had a scope other than themselves. A rep opening Reps List is redirected to My List.
- **District Manager**: none of the 19 saw an other-line or senior person.
- **NSM**: KPIs, Reps Plans, CRM Master and Double Visit showed each NSM only their own line (Pedia 18, CNS 26, Anti Infective 23), but Reps List put the NSM in its company group and showed all 67.

### The rulings
- **Reps List**: an NSM sees only their own line (`doctor-list-roles.ts`, `LINE_ROLES`; PR #4126).
- **Planning Calendar**: the CNS NSM was the one NSM left on the unrestricted default; he now sees the Training Manager's plans plus all CNS plans, like the Anti Infective NSM (`calendar-service.ts`; PR #4126).
- **Declined-offer people**: `manager-scope.ts` counted everyone but resigned and terminated as active, so two District Managers showed one declined-offer person KPIs dropped. It now uses `isActiveLifecycleStatus` (`active`, `on_leave`) (PR #4126).
- **Direct-order venue picker**: scoped for NSMs too. It had been pinned to company reach so the Reps List change stayed narrow (PR #4128). The write check shares the scope, so a contact outside the NSM's line is refused as well as hidden.
- **Acting District Manager**: an account holding the District Manager app role with a Medical Representative title (one exists) sees exactly what a District Manager sees. Her own row is not shown to her. She reaches her two reps on KPIs and Reps List, and her NSM and the line's Product Managers reach her.

### What was measured and left alone
- Three active Anti Infective reps looked orphaned only because the check searched for DM or RM titles; an NSM sits directly above the acting DM, so nothing was invisible.
- The Product Managers and Group Product Manager on an NSM's Reps List are staff seats, not reps, and are not in the venue picker.

## 100% regular is the best case — owner rule, 2026-09-21

His words: "100% regular is the best case scenario. If the campaign is declining and the regular is inclining, this is the best case scenario."

### The defect it corrected
Employee 360's Campaign vs Regular section held every rep to a 71:29 "healthy band" and flagged anything under 15% campaign as "Campaign-starved" (and over 45% as "Regular-neglect"). Marian Samir, 91% regular with campaign falling from 100% in February to 1% by July, read "Campaign-starved" in amber. The period-over-period chip and the before/after row both coloured a RISE in campaign share green.

### The rule, as built (PR after #4177)
- **Verdict** (`campaignMixVerdictOf`): 0% campaign is "All regular · the best case"; under 50% is "Mostly regular"; 50% or more is "Campaign-heavy", the same line the KPIs board's `campaign-heavy` flag uses (`kpis-filters.ts`). No floor.
- **Direction** (`campaignMixTrendOf`): the first against the last month with productive visits, read on SHARES so a part month at either end cannot fake a move. A fall of 5 points or more is "Campaign falling, regular rising · the best direction"; a rise of 5 or more is flagged; anything smaller is steady.
- **Change indicators**: a fall in campaign share is the green direction on both.
- The company's same-month campaign share still shows beside each month as context, not as a target to match.

## Every reply opens with its next step, and always ends in words he can send — owner rules, 2026-09-07, 2026-09-15 and 2026-09-18

The 2026-09-07 amendment moved the next step to the TOP of the reply (the account is in the §4 text
below). The 2026-09-15 rule, *"it keeps me in a loop"*, changed what the line may say:

- The work is finished first.
- The line names what needs him: a decision, an approval, a click only he can make, or
  information only he has.
- **It ALWAYS ends in curly-quoted words he could send as-is.** When nothing needs him, it says
  what finished and quotes the next REAL action, named with its real target.

The words in curly quotes become his prompt suggestion — the ghost text in his input box is exactly
that span. On 2026-09-16 he typed a Claude-written line back because it had been offered as ghost
text, and the 2026-09-15 answer to that was to leave the line unquoted whenever nothing needed him.

**2026-09-18 retired that half.** The unquoted form meant an empty suggestion, so turn after turn his
box rendered `<no suggestion>`; he raised it twice in one session and then ruled: *"always put
something in the box"*. Only the EMPTY OUTCOME is retired. The loop ban was always about WHAT gets
suggested and it stands in full — never a re-check, a re-run, a status read, "continue", "check other
pending items", "polish again", or any closing word. When nothing needs him the quoted words name the
next REAL action, never filler and never work invented to fill the box
(`fix-means-fix-no-unrequested-work`).

The same day showed why the distinction is load-bearing: a Stop-hook check read a merge claim the
reply was QUOTING rather than making, and ordered a suggestion of `merge 3956 when green` for a PR
that did not exist in that session. A wrong target in his box costs him a turn exactly as an empty
one does.

AGENTS.md §4 kept "A reply that asks nothing of him needs none" until 2026-09-17. That contradicted
the user-level rule loaded into every session (`~/.claude/CLAUDE.md`), and a session reading §4 alone
would drop the line. §4 now carries the 2026-09-18 form.

## Golden rule #1 — the rep's app is easy, and it is blind — owner rule, 2026-09-26

Set after a general discussion of what a medical-rep CRM should be. He stopped the work to make this
a rule before anything else is built, and called it "golden rule number one". His words:

> "the CRM usage for him must be number one very easy very easy and very simple … number two never
> show the medical rep that this system is here to catch him, make everything silent to him. He does
> his normal work very easy very normally … never informed of any violation or any other thing. But
> every violation is then recorded in the admin and the SFE account. But never show a medical rep
> anything."

**It outranks every other Phoenix CRM rule.** Where a control and this rule collide, this rule wins
and the control moves out of the rep's sight rather than being softened or explained to him.

### The two halves

**EASY.** A planned visit is taps and a photo — never typing. (Since 2026-09-29: taps and ONE tap to
log it, with NO photo — see "The rep's flow rebuilt" below.) Nothing is asked twice. No field
exists that the server can derive, and today it derives the date (server clock), the place, the
brick, the area, the region and the visit type. Any new step in the rep's day is a change to his
working life and needs the owner's word before it ships, however reasonable it looks in a diff.

**BLIND.** Every integrity signal — the Android `mocked` flag, coordinate replay, impossible travel,
zero jitter, accuracy, coordinate precision, distance from the saved place, duplicate photo,
behavioural pattern — is recorded and readable **only by the Super Admin and the SFE Manager**. The
rep gets no warning, no badge, no padlock, no refusal, and no wording anywhere in his app that a
check exists at all. A flag never changes a number or a word on his own screens: his day must look
identical whether or not he tripped one.

### The boundary, which is the part that will be got wrong

The test is **whose work it is**, not whether the information is about him:

| His, and stays visible | Never his |
| --- | --- |
| His plan, his day, his list | Any integrity flag or its existence |
| His targets and his own standing | The distance between where he stood and the saved place, AS A JUDGEMENT |
| An approval **he** asked for (an off-plan visit he raised, a grade request) | A review opened **about** him |
| A refusal of something he submitted, in plain words | The reason a check fired |

An approval workflow he started is not policing and stays visible — he must be able to see that the
off-plan visit he raised is with his manager, or he will raise it twice. A review he did not ask for
is never shown.

### Two live collisions this rule creates, both put to the owner

1. **The "Far from the place" line on the rep's own visit.** Ruled KEEP earlier the same day — "it
   is honest help" — on the reasoning that a rep with a wrong saved place should be able to see it.
   Golden rule #1 says the opposite. **SETTLED 2026-09-29: he removed it.** The rep sees no distance
   at all; a wrong place is fixed by the Super Admin or the SFE Manager moving it (see "The rep's
   flow rebuilt" below).
2. **The integrity board's audience.** The 2026-09-25 rule made `/admin/phoenix-crm/integrity`
   **Super Admin only**, deliberately — "the fewer people who can open the board, the longer it keeps
   working". This rule adds the **SFE Manager**. That is a widening of an earlier decision, made
   knowingly, and is recorded here so no later session reads it as drift.

### What it does not license

It is not a reason to hide a genuine refusal. If a save is rejected because a required field is
missing, the rep is told plainly what to do — silence about *checks* is never silence about *his own
work failing*. And thresholds stay set so an honest rep cannot trip them: a false positive accuses a
real person of fraud, which is worse than a missed catch.

## The visit type, the off-plan approval and the monthly plan's due date — owner rulings, 2026-09-26

He described the whole cycle he wants a medical rep to live in and asked, first, whether it was
actually happening. Most of it was: the monthly plan, the field weeks derived from it, the live photo
and GPS, the validate-at-the-door step, and — already stricter than he expected — the impossibility of
back-dating a visit, since the phone never sends a date and the photo slot that does dies in two
hours. Four things were not, and these are the rulings that shaped them.

**The visit type comes first.** In his words: "he will have another button called unplanned visit …
when he choose unplanned visit a pop-up will appear … he will then type the name of the doctor he
wants", and "here what will replace the campaign in the old CRM is the unplanned visit". So Add Visit
opens on a two-way choice, and the choice decides which customers the picker offers at all. He also
asked for the old CRM's visit types to be audited — "don't mimic it, but understand it" — and the
thing the audit teaches is that the vendor jammed two different things into one table: a CALL (a named
doctor, a place) and a DAY ACTIVITY (a meeting, training, a health or sales day, admin work, leave —
no doctor at all). Phoenix already pays for that every day in `isFieldWorkVisit` and in the separate
`visit-type-meaning.ts` table. So Phoenix CRM splits them at the source: a visit is always a call, and
its type says only whether the call was planned. Day activities are a separate record and were
deliberately left for a later conversation, because whether one blocks the day's call rate is his
decision and has not been asked.

**The approval is his direct manager, then the SFE.** Asked whether it was any one of the three he
named, all three, or two stages in order, he chose two stages in order and left the manager's manager
out of the decision. A refusal at either step is terminal.

**A late monthly plan is accepted and stamped.** Asked what should happen to a rep who has not sent
the month by the last Thursday of the month before, he chose "accept it, stamp it LATE" over blocking
the Send button and over a silent reminder. So nothing refuses a plan after the date: `submitted_late`
is read from the server's clock at submit and shown on the rep's month and on the manager's board.

**The rep keeps seeing his own distance flag.** 🔴 **SUPERSEDED 2026-09-29 — he removed it; see "The
rep's flow rebuilt" below.** The place-vs-actual report he asked for is for the
district manager, SFE, the national sales manager and the Super Admin. Asked whether the rep should
therefore stop seeing "Far from the place" on his own visit, he chose to keep it — "it is honest
help". What is withheld from him is the comparison across a team, not the fact about his own visit.
That is the opposite call from the mock-location board (2026-09-25), which stays silent, and the
difference is real: a distance he can see lets him fix a wrong place at the door, while a fraud
detector he can see teaches the one person you caught what to defeat.

**The one thing most likely to be got wrong later**, and the reason two tests pin it: "planned" is not
"the customer is on a plan row". The rep owns his own draft plan and today is an editable day, so
plan-row existence alone would let him place the doctor at the door, save thirty seconds later, and
never be off plan — nobody would ever see an approval queue, the feature would look like it worked,
and the rule would be theatre. The test is a plan that reached `submitted` or `approved` before the
visit's server-issued `captured_at`. A DRAFT plan and a RETURNED plan are both still his to edit, so
neither is authority — deliberately narrower than `phoenix_crm_report_plan_vs_actual`'s `sent_days`,
where the day is already past and a returned plan was genuinely sent.

## The rep's flow rebuilt — owner rulings, 2026-09-29

He called Phoenix CRM "THE system" and said to forget the mess two weeks of layered features had made of
it. He narrated the old iReports360 CRM in two videos (as an admin and as a rep), explained the flow in a
long voice message, and answered twenty multiple-choice questions. The web app was rebuilt on those
answers; nothing below is a session's inference.

**Today** is the screen the app opens on: today's plan, AM and PM apart, each customer done or not, the
visits off the plan beside it, and the day's activity.

**The list.** No "Add visit" anywhere on it. A row has ONE action: Validate while the customer is not
validated, Open once he is. Validate is once and for good: a live signboard photo, the days and hours,
and two location readings — the Capture-location pin and the photo's own reading. On 2026-09-30,
after walking the screens, he made the two readings two ACTS: "a live capture photo with its own
location and a capture location button to capture the same location twice once by photo and the
other by gps". The camera no longer takes the pin; the **Capture location** button does, fresh. He
also ruled that day that **the visit comment is required**, typed or spoken. He chose the photo's
reading as the fixed point ("the photo + the location of photo is the more trustable"), the same day as
for marketing and direct orders. The location is resolved on the server into address, brick, area and
region and **the rep can never change it**; he first said only the system administrator may, then
widened it to the SFE Manager. Open shows the validation record; the days and hours stay editable, the
name and speciality can still be corrected (the 2026-09-22 ruling), and a customer may have several
clinics, each validated once and each fixed.

**Admission.** "Add new customer" and an out-of-list visit both leave the customer OUTSIDE the list: the
rep picks AM or PM by hand ("it is not AM because he entered it in the morning"), types the name and
speciality, validates on the spot, and then — his words — "they are not approving the visit, they are
approving this doctor to be added to the list … if dropped, then it goes to the archive … if they
approve, this is automatically added to his list and becomes a permanent customer". The district manager
confirms or changes the A/B/C grade (the one frequency uses) and sets a potential grade AA..BC, which he
was explicit "will not change anything in behaviour" — it is stored and shown only. SFE decides second.
Dropping a listed customer and bringing one back from the Archive take the same two steps; the SFE
manages the Archive.

**The visit.** The first choice is Planned · Unplanned · Meeting · Conference · Health day · Sales day ·
Training · Admin work · Travel. Planned offers today's SENT plan only. Unplanned is Out of plan (a reason,
the manager then SFE approve the visit, unchanged from 2026-09-26) or Out of list (above). The form keeps
Single/Double/Chain, products and samples, comment typed or spoken, objection and next step; the
pharmacy stock check becomes optional. **No photo, no date, no AM/PM picker: "Log visit" is one tap**,
the server stamps the time and the location is read silently. A visit is today's only, until 02:00 the
next morning ("maximum 2 AM — at 2:01 I cannot enter a visit I missed"); never a past or a future day.
A visit to a customer not validated yet waits and counts in its own month once he is; his earlier visits
then get their distance.

**Blind, absolutely.** Asked about the polite own-visit line he kept on 2026-09-26, he removed it: the
rep never sees a distance, a flag or a check. Managers, the SFE Manager and the Super Admin keep every
measurement on their own screens.

**The plan.** By month or by week, the weeks rolling into the month: the month on top as Week 1..N, a
week's days, a day's customers ticked in brick groups with its other activities on top. Filters: the
weekday a customer receives, brick, AM/PM, grade, speciality. Copy last month (Week N's weekday onto Week
N's weekday), copy last week, and copy a day from the same weekday one or two weeks back. A customer not
validated yet can be planned. The month is due the last Thursday of the month before; a week sent alone
the Thursday before it; late is accepted and stamped. The planning window now reaches the whole of next
month, which the old three-week window made impossible by the month's own due date. 🔴 **Superseded on
2026-10-01 by "Weekly only" below**: the rep plans one week, has no month send and no Copy last month,
and a sent week changes only by request.

**Hours never block a plan (2026-09-30).** Reviewing the plan as `TEST-AYA`, he saw "Does not receive on
Wednesday" and ruled: "never block, because the rep didn't add his time — add a column for timings but
never block". The hours are the rep's OWN entry and may simply be missing, so a tick places a customer on
any day and asks nothing: no reason prompt, no "Choose a reason" refusal on save (`plan-rules.ts`), no
problem that holds Save or Send (`plan-week-draft.ts`), and a copy places everyone on his weekday rather
than leaving the uncovered ones out. The day shows a **Days and hours** column of the customer's whole
week instead. The same evening he had the "Day full" word removed from every row, the "Not validated
yet" tag made small and inline, and the blank filled with the brick and address — the saved place's, or
iReports360's while the customer is not validated yet. A reason an older plan already carries is kept
and shown; a missing one is never shown as the rep's fault. **Do not bring the reason prompt back**, and
do not "improve" it into a soft warning on the rep's tick: the whole point is that a gap in the rep's own
data never stands between him and his plan. `tests/phoenix-crm-plan-never-blocked.test.ts`.

**The portal "+"** offers a rep "Add visit" and "Make weekly plan".

**What this supersedes:** "a planned visit is taps and a photo" (Golden rule #1's EASY half), "the rep
keeps seeing his own distance flag" (2026-09-26), and every one-step drop or bring-back.

**Left for the next PR, by his choice:** linking the same customer across reps, lines, marketing requests
and direct orders (the system suggests, the Super Admin confirms each link — nothing is merged or
reassigned), and the three reports he named from the old CRM: frequency per customer, the team calendar
("the most important"), and the tracking sheet.

## The Super Admin enters a record a rep MISSED — owner rulings, 2026-10-01

Asked how a missed visit should be handled, he answered in four messages: *"show it beside the miss, and
the system admin can enter a manual record for anyone, anytime, anywhere"* — *"no, the rep is responsible
for all his records, but if he missed a visit or a record, admin can enter it for him"* — *"I choose
planned or unplanned"* — and, for what the rep sees, *"marked as entered by admin"*.

**Who and where.** The Super Admin alone (`canEnterMissedRecords`, `territoryForMissedRecord` in
`src/lib/phoenix-crm/server/access.ts`) — not the SFE Manager, not a district manager, never a test
account. It is the SECOND real-data write he makes in Phoenix CRM, beside moving a validated place (a
third, HR's acknowledgement of a request to edit a sent week, came on the same day — "Weekly only"); with
test mode on it is a test entry like everything else he does there. The territory must have a rep (a
vacant seat has nobody to enter for) and, for a real entry, a line that has opened. He enters it on the
day's own page: the team calendar opens EVERY day that has begun for him, the empty ones included, and
the page carries an "Enter a missed record" panel (`missed-record-panel.tsx`).

**What it is.** A visit — any day that has begun, never one still to come; his time or noon; the
products discussed and a comment, both required as on a rep's own visit; and **planned or unplanned as
he chooses**, a required choice that only STARTS from the plan the rep had sent for that day. Planned
counts at once. Unplanned raises the same manager-then-SFE approval as a rep's own off-plan visit, with
his reason as its clarification, and the reviewing manager is told in-app and on Telegram, as for a
rep's. Or a day activity, on any past day. **It adds what is missing and never rewrites the rep's own
record**: one visit a customer a day (`already_visited`), and a day the rep recorded himself stays his —
the Super Admin changes or clears only what he entered.

**No location, by design.** He is not at the door, so the visit stores no reading at all
(`capture_source = 'admin'`; the `phoenix_crm_visits_location_source` CHECK allows a missing lat/lon
on that source alone). Never his own position, never a made-up point. So nothing that judges a rep reads
it as a capture: the location checks skip it — and their coordinate read no longer turns a missing
reading into 0°N 0°E, which would have shown the rep's next real visit as impossible travel — the
behaviour sweep leaves it out, and place-against-actual has no actual for it.

**The mark.** Every screen that shows it says "Entered by the Super Admin" — the rep's Visits tab, the
day page, the day's activity. It is read from WHO entered the visit (somebody who was not on it), never
from `capture_source`, which is a rep-blind column (`tests/phoenix-crm-blind-half.test.ts`).

**Taking one back** (owner, the same day: *"add a way to remove a missed visit I entered by mistake"*).
The day page draws "Remove this visit" on a visit HE entered, and only there; a second tap confirms it.
**The database decides which visit may go, from the row itself** (`phoenix_crm_admin_remove_visit`):
`capture_source = 'admin'` AND `entered_by_hr_id` = the person asking. A rep's own visit stays his record
whatever the screen sends (`not_entered_by_you`) — that is the same "the rep is responsible for all his
records" ruling, and it is not to be widened into a general delete. The gate is apart from entering
(`territoryForMissedRecordRemoval`): the Super Admin alone, but with no rep-in-the-seat or open-line
condition, so his own mistake stays his to take back after the rep has left the seat or the line has
closed again. **Nothing is lost:** production has no point-in-time recovery, so before one row is deleted
the visit, its off-plan approval and that approval's events are copied whole into
`phoenix_crm_removed_visits` (service role only, one row per visit, and the migration header says how
to put one back). Then the events, the approval and the visit go, in that order — they are the only rows
that point at a visit, and neither foreign key cascades — so an unplanned entry also leaves the
manager's and SFE's queues. A day activity is not removed this way — he clears his own from the same
panel, as before.

**And the notice goes with it** (owner, 2026-10-02: *"close the stale manager notice when an entered
visit is removed"*). The manager had been told to approve an off-plan visit; once the entry behind it was
gone his bell held a to-do that could never be done. `withdrawPhoenixCrmVisitNotices` runs after the
removal — never before, because the database is what decides whether the visit may go at all — and
archives every in-app notice whose event key names that visit: the manager's, the rep's own copies, and
the test-world ones, which carry their own keys. Both notice keys are built from
`phoenixCrmVisitNoticeKeyPrefix`, so a renamed key cannot leave one behind, and the LIKE prefix is
escaped because every key contains `phoenix_crm` and `_` is a wildcard. 🔴 **It is the ONE place that
writes ANOTHER person's archive state** — everywhere else that row is the viewer's own — and it earns
the exception only because the record behind the notice is gone, so it must always be called with a
prefix naming ONE visit, never a whole category. Archived, never deleted: the event rows stay for the
audit, and the hr id is written in the canonical lowercase form the bell reads by, or the write lands on
a row nobody queries. It swallows its own failures — a notice that cannot be withdrawn must not undo a
removal that already happened. 🔴 **A Telegram message already sent is NOT recalled**: it is on his
phone, nothing here reaches it, and only the in-app notice is withdrawn.

**And the same notice clears when he simply DECIDES it** (owner, 2026-10-02: *"clear the manager's
off-plan notice when he approves it too"*). Removal was only one way that notice went stale; the
everyday way is the manager approving or refusing the visit, after which his bell still said "approve
it". Phoenix CRM now joins the bell's existing stale-approval sweep beside vacation, excuse and weekly
plans: `unplanned_visit_waiting` is an actionable approval keyed by `visitId` (carried in the notice's
own metadata, like `requestId` and `planId`), and on each bell read `phoenixCrmVisitIdsAwaitingDecision`
answers whether that visit is still his. 🔴 **"STILL HIS", NEVER "STILL OPEN"** — at the SFE stage the
visit is still waiting but no longer on him, so `canDecideUnplannedVisit` is the one rule both the bell
and the Team tab answer from; a second copy of that rule is how the two would start disagreeing about
whose turn it is. 🔴 **The rep's own copies are NOT approver notices** — auto-archiving his
"approved"/"refused" lines would clear his record of what became of his visit. It fails OPEN
throughout: any error leaves the notice visible, because hiding a real to-do is the costly direction.
🔴 **The loader is a LEAF on purpose** (`server/awaiting-decisions.ts`, importing only `access`, `db`
and the pure rules): putting it in `unplanned.ts` would close the ring
in-app → unplanned → notifications → in-app, measured and real, and a cycle leaves whichever module
initialises second reading the other's exports as undefined.

Pinned by `tests/phoenix-crm-missed-records.test.ts` and `tests/notification-auto-archive.test.ts`; the database half is
`supabase/migrations/20261001044221_phoenix_crm_admin_entry.sql` (`phoenix_crm_admin_enter_visit`) and
`supabase/migrations/20261001055833_phoenix_crm_admin_remove_visit.sql` (`phoenix_crm_admin_remove_visit`).

## Weekly only — the rep plans one week, and a sent week changes only by request (owner rulings, 2026-10-01)

**What happened.** On Thursday 1 October the first wave of Delta (1) reps used the plan board, and the
owner came back from the session with: *"the plan is entered weekly only, weekly only, and I cannot enter
a week that passed or a week ahead; by default it opens on the week the plan should be entered in"*.
Production showed why. The board opened on SEPTEMBER — the first plannable month, because the week of 26
September still had Thursday 1 October open — so every rep had to find October himself; four of fourteen
pressed "Send the month" and were stamped late against a month due 24 September; one made an empty plan
for the week of 26 September; one saved sixteen times. And reps pressed the "Receives on" filter — a grid
of day buttons, the same square buttons as the Week and the Day pickers — believing it chose the day.

**The rulings, in his words where he gave them.**
- **One week, the coming Saturday's.** *"We are now Thursday, tomorrow will be Friday … when he is
  submitting the plan, he will submit the Saturday week plan."* `repPlanWeek(today)` is the week after
  the running one: Thursday 1 and Friday 2 October → Saturday 3 October; Saturday 3 October → the 10th.
  A week that has begun is never planned any more — unless he never sent it (next bullet); a week ahead
  is not open yet.
- **The week he is IN, never sent, is still his to send — late (owner, 2026-10-02).** The Phoenix CRM
  audit that night found the gap: a rep who missed the deadline was locked out of the week he was
  working, because `repWeekState` closed it the moment it began — so none of that week's visits could
  ever count as planned, and nothing on his board told him why. Asked how it should behave, the owner
  approved the recommended answer: he still sends it while it has a day left, the send is stamped late
  from the server clock like any late week, and his visits count as planned only from the moment he
  sends it (`phoenix_crm_save_visit` reads the send itself, so nothing visited before it is rewritten).
  His board opens on that overdue week first, and its note says when the visits start counting. A week
  before the running one never reopens.
- **One path.** Plan opens on that week's month, that week active and every other week greyed; its
  days; a day's customers; tick. The rep's own board has no month chooser, no month header, no "Send the
  month" and no "Copy last month". A manager reviewing from Team keeps his month chooser.
- **Filters are dropdowns, pickers are buttons.** *"The days filter … make it different from the filter
  you made for the days with which I choose the weeks, because they look alike."* Receives on, AM or PM
  and Grade became native dropdowns beside Brick and Speciality; Week and Day stay buttons.
- **No more take-back — a request instead.** *"REQUEST TO EDIT FROM DISTRICT MANAGER APPROVAL THEN SFE
  THE HR ACKNOWLEDGEMENT WITH EMAILS IN APP AND TELEGRAM FOR EVERY STEP."* Asked who HR is, he answered
  **himself** (Omar Gawish, B-10); asked when the week opens, **only after HR acknowledges**; asked who
  is told, **the next approver, the rep, the district manager and SFE**; asked whether the rep writes a
  reason, **"No, just the button."** One refusal ends it (a note is required, the rep reads it); a vacant
  manager chain starts at SFE; a request whose week passes is closed as expired.
- **The Delta re-send is on time.** Everything entered on 1 October in the old screen — real and test,
  plans and validations — was wiped once the new flow was live, and the reps sent the week of 3 October
  again on Friday 2 October. He ruled those *"not late: they sent on time"*, so that one week is due
  the Friday (`PLAN_WEEK_DUE_OVERRIDES` / `phoenix_crm_week_due_on`).
- **One pull request**, at his choice, over splitting the urgent half.

**How it is held.**
- The server, not the board, is the rule: `assertRepMayChangeWeek` (`server/plan-edits.ts`) runs before
  every save and every send, and `repWeekState` (`plan-rules.ts`) answers `plan` only for his one week,
  a week his manager RETURNED, a week an edit request REOPENED, or — since 2026-10-02 — the week he is in
  while he has never sent it (`runningWeek`, from `fieldWeekStart(today)`). No migration was needed for
  that last one: `phoenix_crm_save_plan` already takes any day from today on inside the week, and
  `phoenix_crm_plan_transition` refuses only a week whose Thursday has passed. A rep's `reopen` and his month send
  and take-back are refused with a sentence, so a screen one release behind is told what to press.
- `plannableWeeks` is unchanged and is now the REVIEWERS' window — the manager's week list, the overview
  counts and the daily plan report all read it. Never shrink it to the rep's one week.
- The edit chain is `phoenix_crm_plan_edit_requests` (manager_pending → sfe_pending → hr_pending →
  reopened · refused · expired) with its events table, `phoenix_crm_raise_plan_edit_request` and
  `phoenix_crm_decide_plan_edit_request`, whose HR step sets the plan back to draft and writes the plan's
  `reopened` event (with `edit_request_id`) in the same transaction, under the plan's own advisory lock.
  `phoenix_crm_plan_transition` was replaced with its live body: the due date comes from
  `phoenix_crm_week_due_on`, and a week sent again after an acknowledged edit KEEPS its first send's
  late verdict — a change his managers agreed to must never stamp a rep late. 🔴 **Lateness itself moved
  the next day: it is now `now() > phoenix_crm_week_deadline_at(week_start)` — 23:55 Cairo on that same
  due date, not the end of it. See "The deadline is 23:55 Cairo" below.**
- **HR's acknowledgement is the Super Admin's third real-data act** (`canAcknowledgePlanEdits`, beside
  moving a place and entering a missed record), and it is **B-10's alone**, compared as a person
  (`isSamePerson`, so his console login counts). Another Super Admin does not take that step.
- **The one Phoenix CRM notice that emails.** The module's email block stays; `phoenix-crm-channel-guard.ts`
  lets exactly four event types keep email — `plan_edit_waiting`, `plan_edit_moved_on`,
  `plan_edit_refused`, `plan_edit_reopened` — and strips it from everything else, the 06:55 digest
  included. `tests/phoenix-crm-email-block.test.ts` pins the list exactly.

  🔴 **IT WAS FIVE UNTIL 2026-10-02, AND THE FIFTH LEAVING IS A RULING OF HIS, NOT A TRIM.** The
  2026-10-02 Phoenix CRM audit built the daily pass that finally closes a request whose week has
  passed (`phoenix_crm_expire_plan_edit_requests` — until then `status = 'expired'` was reachable only
  when somebody DECIDED a request, and nobody decides one whose week has gone, so it sat on
  `manager_pending` for ever). He was asked, in chat and as a choice, whether that pass should email
  as it closes one, and picked **"in-app and Telegram only, no email"**. So `plan_edit_expired` moved
  off the email list and into `PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES`, where "only" is enforced on both
  axes exactly as his 06:55 digest ruling is. **The line the exception is actually drawn on is
  therefore a step a PERSON took:** the four that remain are a manager, SFE or HR pressing a button,
  while an expiry is a week running out, closed in a batch — the unprompted bulk mail he has ruled out
  standing. The policy row agrees with the guard (`policy.ts`), the pass names no channel of its own,
  and the four are re-pinned beside the new list in `tests/phoenix-crm-approval-notices.test.ts`.
- **While a week is reopened it is a draft**, so the day's visits count as off-plan until he sends it
  again — the same rule the planned-visit check has always kept (a plan that had reached review BEFORE
  the visit). The request form and the reopened note say so.

**What this supersedes:** "the month is due the last Thursday of the month before" and the rep's own
month send; "Take this week back"; the month-hopping "+ Make weekly plan" search; and "Copy last month"
on the rep's board. A month SENT before 1 October still shows its status and its reviewer's decision.

Pinned by `tests/phoenix-crm-plan-weekly-only.test.ts` and `tests/phoenix-crm-plan-edit-requests.test.ts`;
the database half is `supabase/migrations/20261002002251_phoenix_crm_plan_edit_requests.sql`.

## The deadline is 23:55 Cairo, and the rep is shown it — owner ruling, 2026-10-02

*"the deadline to submit the plan is thuersday 11:5pm and show themn this"*, and, once it was on the
rep's screens, *"show the 11:55 PM deadline on the Team tab's Due cell too"*.

**What was wrong.** `submitted_late` compared a DATE to a DATE — `v_today > phoenix_crm_week_due_on(...)`
— so the real cut-off was midnight and a week sent at 23:58 on its due Thursday was stamped on time. And
no screen named an hour at all: the rep was told which DAY his week was due and left to guess the time of
the one thing it is judged on. The second half of his instruction is the half that was missing.

**The rule, in one place on each side.**
- `phoenix_crm_week_deadline_at(week_start)` is the due date at 23:55 Cairo, built ON
  `phoenix_crm_week_due_on` so the hand-set overrides carry (the week of 3 October is due Friday 2
  October **at 23:55**). It is `STABLE`, never `IMMUTABLE`: `at time zone` with a zone NAME depends on the
  server's timezone rules, which an upgrade can change, and an immutable marking would let a plan cache
  an instant from before that change.
- `planDeadlineAt` / `planDeadlinePassed` (`calendar.ts`) answer the same question in TypeScript, from
  the zone table that ships with the code (`cairo-zone.ts`) and never from the reader's engine.
- `PLAN_DEADLINE_LABEL` is the wording — "11:55 PM", as he wrote it, never "23:55" — and
  `withPlanDeadline` is the one joiner. `planDueLabel` uses it with the long date for the rep's Plan and
  week panel; the **Team tab keeps its own compact date** ("Thu 8 Oct 2026 at 11:55 PM") because it sits
  in a row beside a dozen reps, and takes the deadline through that same joiner. Two date styles, one
  deadline — a reviewer and his rep can never read two different ones.

**The badge had to move with the stamp.** "Overdue" was `today > dueOn`, which in the five minutes
between 23:55 and midnight would have shown a week as not-yet-overdue while the server stamped that very
send late. It reads the instant now, from ONE `new Date()` per render so the month and every week on it
agree.

**The 23:55 that happens twice.** Egypt leaves DST at Cairo midnight on the last Thursday of October —
2026-10-29, itself a plan due date — so that wall time occurs at both 20:55Z and 21:55Z. Both sides
resolve it to the LATER pass, the forgiving one, so a rep whose own clock reads 23:55 is on time on
either. Postgres' answer was read back from production BEFORE the TypeScript was written rather than
assumed, and the two-pass offset solve in `planDeadlineAt` lands on the same instant by construction.

**What this does NOT change.** A late plan is still ACCEPTED AND STAMPED, never refused (2026-09-29) — a
rep who cannot plan cannot work, and the test asserts nothing in the submit branch raises over the
deadline. No due DATE moved, no `due_on` row was rewritten and no verdict already stamped changed: the
hour is a rule, not a stored value. The 12:57 and 17:57 reminders gained the hour ("It is due tonight at
11:55 PM") and are otherwise untouched — they never fire inside that five-minute window, so their
day-grained late flag stays accurate.

Pinned by `tests/phoenix-crm-plan-deadline.test.ts` in the required `validate` job; the database half is
`supabase/migrations/20261002122000_phoenix_crm_plan_deadline_2355.sql`. 🔴 **The two transition
assertions in `phoenix-crm-plan-weekly-only.test.ts` were moved onto that newer migration** — with
`create or replace`, only the newest file describes what runs, and left pointing at the older one they
would have stayed green while pinning a rule the database no longer has.

## The Business Review reads live — owner ruling, 2026-09-28

The Monthly Closing is the one source of truth for every sales and target figure, and every surface
must equal the **published** closing for that person and month. The Business Review pack is the
third carve-out from that rule, after Weekly Sales and Marketing ROI. It reads the **live** closing
engine — `au.f_monthly_achievement` — and not `phx_closing_publication_snapshot`.

### What was put to him

A run of Sales Review packs went out on the live engine. Before the last of them, the divergence was
measured on production (`ozucdzovmcqvepbozvqf`, read-only) and put to him in plain figures:

| Line · period | Drifted cells | Net effect | What it is |
| --- | --- | --- | --- |
| Pedia 2026-08 | 8 | **+191,226.30** (+1,402 units) | every one a DIRECT ORDER absent from the published snapshot |
| CNS 2026-07 | 309 | 0.00 | value moved BETWEEN areas |
| CNS 2026-08 | 283 | 0.00 | same — up to **±11,877** on a single area, nil on the line |
| Anti-Infective, Pedia 2026-07 | 0 | — | clean |

He was asked which basis the packs should use and answered: **"use the live one"**.

### Why both sides are correct, which is the part that matters

Neither number is wrong, and that is exactly why this needed a ruling rather than a fix.

- **The published snapshot is right about what was announced.** A published and announced month is
  never corrected, however justified the repair. That rule is not weakened by this one.
- **The live engine is right about what happened.** A direct order counts in the month Finance books
  it, and Finance booked those eight cells after August was published. The engine is also
  period-aware: it resolves an area's region through `au.f_line_area_map_asof(period_end)`, so a
  later territory move re-reads history correctly rather than freezing a stale geography.

A pack quoting the snapshot would therefore understate real money that was genuinely sold, and would
carry a geography the organogram has since corrected. A pack quoting the engine states what
happened. The owner reads these as a REVIEW — the pack says so on its own cover, "Review, not a
payout record" — so the live reading is the one that answers the question being asked of it.

### What this does not license

- 🔴 **It does not license republishing a month to make the two agree.** The Pedia gap is real money
  booked late; the fix is not to restate August.
- 🔴 **It does not license acknowledging the drift** (`phx_acknowledge_closing_drift`) to silence the
  status. The drift is information, and the acknowledgement is the owner's decision about a month.
- 🔴 **It does not spread to payout surfaces.** Incentive achievement, payroll and anything that pays
  somebody still read the published closing. The carve-out is the Business Review pack alone.
- It is not a fourth carve-out waiting to happen. A surface that wants one needs his word, as this
  one got.

## An offer letter with no candidate behind it is not a gap — owner ruling, 2026-09-28

His words: *"leave Esraa Awad and Taha Sheeba without ATS records"*.

### What was measured, and put to him

`ats_candidates.offer_id` shipped that day and 12 candidates were wired to their letters by hand. The
question was the remainder. Measured across all 27 production letters rather than the two that had
been spotted:

- **11 letters point at nobody**, because **nine people never entered the ATS at all** — Alaa Mohsen
  (three copies of one letter), Esraa Fotouh Mosaad, Mery Shenouda, Noha Farraj, Rehab Samir, El Sayed
  Rady, the owner's own Sheraton test letter, and the two below.
- **Two of those nine are active employees**: **Esraa Awad Hemida** and **Taha Sheeba Alhammed**, both
  Medical Representatives hired **01/10** on **accepted** letters. They were seated without passing
  through recruitment.

A session had first put "create the two records" to him as the open item. Measuring it properly
reversed the recommendation, and he confirmed the reversal.

### Why creating the records was refused

1. **It buys nothing.** They are employees, and an employee's messages are built from
   `employee-context.ts`, which never reads the candidate pointer. A start date wired through a
   candidate record would never be used for either of them.
2. **A record with no CV, no source and no application is a hollow row.** It then appears in the pool,
   the screening queue and every count as though somebody applied.
3. **The truthful state is "hired outside the ATS"**, which an empty pointer already says.

### What it costs, stated rather than hidden

Both hires are **invisible to source-of-hire reporting**, because that attribution runs off candidate
records. Creating rows now would not fix that either — it would add two *unattributed* ones. The cost
is accepted; it is not an argument for the backfill.

### The trap

This reads exactly like a data defect and it is not one. **A session "completing the funnel" here is
the defect.** The hook lives in `src/lib/recruitment/candidate-offer-link.ts`, next to the code that
would have to be written to get it wrong.

## An offer may be copied to anyone, with no reason — owner ruling, 2026-09-28

His words, asking for the feature: *"add option to CC or BCC in the job offer module"*, then *"and to
CC or BCC more than one recipient"*.

### What was put to him

An offer carries the candidate's salary, and the Sato Email Composer already refuses an outside address
typed by hand unless the sender writes a reason (`src/lib/sato-email/typed-policy.ts`). So he was asked,
as multiple choice, who may be copied: company addresses only (recommended), outside addresses with a
reason, or anyone with no reason. **He chose anyone, no reason.**

### What that means in the code

- `src/lib/offers/copy-recipients.ts` judges an address on its SHAPE only. It refuses nothing for its
  domain and asks for no justification. A bad address stops the whole send (never a partial send); a
  redundant one — the candidate's own address, or a CC repeated on BCC — is left off and said.
- Every copy is declared to the Recipient Assurance Guard as `externalRecipients`, because the guard
  otherwise blocks any address that is not an employee's — after HR has already pressed Send.
- Up to **10** copies, CC and BCC together. `offers/offer_letter` carries an `always` ceiling of 11 in
  the Notification Confidence Gate: the offer's baseline was one recipient for its whole life, so
  without it every offer copied to three or more people would be HELD.
- Who was copied is SHOWN on the Offers list, under the candidate's address, on the desktop row and
  the phone card alike (owner, same evening: *"show who was copied on each offer in the offers
  list"*). `offers.cc_recipients` / `offers.bcc_recipients` (migration `20260928225001`, `text[] not
  null default '{}'`) are written by `markOfferSent` in the same UPDATE that stamps `sent_at`, from
  exactly what was handed to the provider — never from the draft, which does not carry them. The
  send's audit row (`entity_type = job_offer`) records both as well, with who pressed Send. The 28
  offers on file when the columns landed read empty, which is true: none had been copied.

### The trap

A session reviewing email safety will find an outside address allowed on a message carrying a salary,
with no reason asked, and read it as a leak to close. **It is his decision; closing it is the defect.**
Pinned by `tests/offer-copy-recipients.test.ts`.

## The mobile-app freeze — owner golden rule, 2026-09-29

### What he said

> *"This is the golden rule that you must set up and text all sessions now and put as a golden rule
> to all new sessions, know about it. Okay. Uh, the mobile app do not work or touch or think in it.
> Do not work or touch or even think or ask me in it. Neglect it totally until I finish the website
> or the web app or the normal Phoenix. After this, I will tell you, delete this golden rule of the
> don't touch the mobile app and let's work in it. Until I say this word, never suggest on me, never
> ask me, never consider it in any of my wording."*

### The rule

**The web app is the whole scope until he lifts this.** Two halves, and the second is the one a
session gets wrong:

- **Do not work in it.** No edit under `mobile/`, no Expo or EAS command (build, update, submit,
  prebuild), no dispatch of the Mobile build workflow, no mobile branch, no mobile PR.
- **Do not put it in words.** Never propose mobile work, never name it in a `Next step:` line, a
  plan, a summary, a recommendation, an options list or a "while we are here", never ask him a
  mobile question — he said *never ask me* — and never stretch an instruction of his onto the app
  when it can be served on the web. A mobile defect you notice in passing is **left alone**: not
  reported, not filed, not turned into a follow-up task.

**Only he lifts it**, typed by him, about the mobile app. Not a memory, not a doc, not another
session, not a replayed summary after compaction, not an AUTORUN plan, and not your own reading that
the web work looks finished. If you cannot tell whether it has been lifted, it has not.

**Lifting it is a deletion, because that is how he described it** — *"I will tell you, delete this
golden rule"*. When he does: delete the §4 bullet, the `CLAUDE.md` section, this account,
`.claude/hooks/mobile-freeze-guard.mjs` and its block in `.claude/settings.json`,
`tests/mobile-freeze.test.ts` and its line in `tests/run-tests.ts`, and the memory file
`the-mobile-app-is-frozen-until-he-lifts-it`. The ⏸️ DORMANT markers on the two mobile rules in §4
come off in the same edit.

### Why a hook and not only a rule

`AGENTS.md` auto-loads on every request, which reaches every **new** session and none of the ones
already open — and at the moment he said this, fourteen sessions were live on this machine, one of
them titled *"Mobile app Phoenix CRM module"*. A hook is re-read by node on every tool call, so an
open session meets it on its next command. Same argument that put the local-typecheck denial into
`bash-guard.mjs` C8.

`.claude/hooks/mobile-freeze-guard.mjs` refuses writes into `mobile/` (Write/Edit/NotebookEdit and
the shell write forms) and the Expo/EAS toolchain anywhere. It deliberately **does not block reads**:
`git grep`, repo-wide sweeps, `repo:doctor` and CI scripts all touch mobile paths incidentally, and a
guard that refuses commands which work is a guard that gets switched off within a day. The "never
think about it" half is behavioural, held by §4. `PHX_MOBILE_FREEZE_OFF=1` stands it down for one
command — that is for him to ask for, not something to reach for.

### The trap

The mobile rules already in §4 — the shell rule, the managed-Play ruling — read like live guidance,
and a session that has just read them will answer a vague instruction by reaching for the app. They
are marked ⏸️ DORMANT for exactly that reason: history for when the freeze lifts, never a reason to
act now. The one half of the shell rule that stays live is `phoenix_app_shell=1` defaulting FALSE,
because that gate protects the **web** portal's chrome, not the app.

Pinned by `tests/mobile-freeze.test.ts` in the required `checks` job.

## The mobile app is a shell over the web portal — owner direction, 2026-09-29

> ⏸️ **DORMANT under the mobile-app freeze above** — read it when he lifts the freeze, not before.

### What he said, and what he was looking at

*"Make the app a shell over the web portal."* He had just looked at the native app wearing the
portal's colours over hand-drawn screens — one 310-line `mobile/src/components/ui.tsx` against the web
portal's 24 shared primitives and roughly 46,000 lines — and called it **"a poor awful app while the
web app is SaaS."** The resolution he chose is a shell, not a rebuild.

### The rule

**NEVER rebuild a portal screen natively.** A native copy of a portal module is a second
implementation of a payroll, leave or sales number, and two implementations of one figure is exactly
the drift `open-module.ts` and the domain-first rule exist to prevent. A module with no native screen
is opened as the production page itself.

**What is native, and stays native:** login, Phoenix CRM — camera, GPS, dictation, and the **offline
outbox**, because a web page cannot queue a visit with no signal — and Profile. Everything else is the
portal in a WebView.

### How it works (PR #4701)

- The **Home tab** and a single opened **module** both render through one component,
  `mobile/src/components/portal-web-view.tsx` (extracted from the old `module.tsx`). It mints the
  one-trip hand-off, pens navigation to this server's `/employee-portals` space, and rests on
  `credentials: "omit"` in `mobile/src/lib/api.ts` — the cookie-jar safety, pinned by
  `tests/native-web-handoff.test.ts`.
- **App mode, and why there is no double navigation:** the GET half of `/api/auth/web-session` sets a
  non-secret cookie `NATIVE_WEB_APP_SHELL_COOKIE` (`phoenix_app_shell=1`,
  `src/lib/auth/native-web-handoff.ts`). The portal server shell reads it and `EmployeePortalChrome`
  drops its own fixed header and bottom nav, and their spacers.

### The trap

🔴 **An ordinary browser never carries that cookie, and the gate defaults FALSE — the web portal is
byte-identical without it.** So the gate reads like dead weight to a session tidying up, and
"simplifying" it away strips the web portal's chrome for every browser user at once.

### What it knowingly traded

The old native Home showed a read-only cache of the rep's own numbers **offline**; a web page needs
signal, so that offline READ is gone. It is reversible in one file (`index.tsx`) if he asks. The
offline **WORK** — the CRM outbox — is untouched.

## The probation Day 30 / 60 / 75 emails — owner rulings, 2026-09-29

**The rule.** They go to **Yasmeena Elsafory (`HR-009`, HR Generalist)** alone, with **Omar Gawish
(`B-10`) on BCC** — his words: *"make probation module send the probation emails to yasmeena el
safory only cc omar.anwar after 30 and 60 and 75 days"*, then *"to her only bccc omar.anwar"*. BCC,
not CC, so hers is the only address the delivered mail shows.

**What was there before.** Nothing. The sweep was unwired on 2026-08-02 (#1624) and its module
deleted (#1626); the version that existed fanned out to ~8 stakeholders per milestone (CEO + HR + DM
+ NSM + SFE + the evaluator), which is what he cut. And Yasmeena had received **none** of the 334
historical milestone deliveries — every one went to the CEO, the owner and the manager chain, and
`HR-009` is absent from that table entirely.

**Why a separate notification type.** The `probation` policy is `enabled = false` (his toggle,
2026-07-19, reaffirmed 2026-08-13). It still governs the legacy per-manager probation reminders,
which are wired to the 5-minute notification cron, so flipping it on to deliver three milestone
emails would have restarted roughly 500 manager reminders a month. The milestones therefore carry
`probation_milestone`, their own admin toggle. **An older memory reading "probation email stays OFF,
do not re-enable" is about that policy, not these three.**

**The catch-up: asked for, held, released — all on 2026-09-29.** *"backfill any missings to her
now"*, then *"backfill to her only the current probations"*, then *"skip sending"* while he corrected
her own address (`yasmeen.elsafory@` → `yasmeena.elsafory@satopharma.com`, 12:18 Cairo), then
*"release the held probation milestones"*. A start-date constant held it in between and was REMOVED
on release rather than moved back — a dormant second cutoff beside the 2026-07-17 fresh start would
read as a live gate to whoever found it next. Released: **8 milestones, 6 people** — Mohamed Khaled,
Omayma Wael, Hanan Safwat and Adel Srour (Day 30); Mahmoud Abdelreheem and Gannatallah Amer (Day 30
and Day 60).

**Due = crossed AND still on probation**, not a grace window. The retired fan-out fired only within
7 days of crossing, because a catch-up there meant ~8 emails per milestone; with one recipient that
trade runs backwards and the window silently drops a milestone HR never saw. Nothing fires past day
90: a "Day 30 — early progress" notice for someone 150 days in is wrong information, not a late
email.

**Three defects this work uncovered, none of them in the new code.**

1. `filterResolvedProbationCases` documented case-insensitive HR id comparison — and compared that
   way — but FETCHED with an exact `.in()`. `probation_cases` holds the older cohort as `ai-0004`
   where `employees` holds `AI-0004`, so the employee row came back empty, the filter had nothing to
   filter on, and a **terminated** employee read as a live case. He would have been the first person
   this sweep emailed, three times over. The CEO probation dashboard carried the same hole.
2. The admin Email Notification Center is a client component that hand-copies the
   `EmailNotificationType` union; adding a type to the source and not the copy fails only Typecheck,
   a full CI cycle later. The two are now pinned together in the unit suite.
3. Every `app/api` route must appear in `src/lib/security/access-registry.ts`; the new cron trigger
   did not, and only the unit suite says so.

**The address is resolved live** from `employees.work_email` at send time, so a mailbox correction
needs no deploy. **Nobody else can reach the envelope:** both manager-CC enrichment paths fire only
when the SUBJECT is the primary To, and the To here is always Yasmeena.

**Left open, twice reported and not acted on:** 10 probation cases sit at day 102–152 still marked
`active` with no decision recorded, and 4 people in the 30–90 day band have already left (three
resigned, one terminated) yet still hold active cases.

`src/lib/probation/intelligence/milestone-emails.ts`, pinned by
`tests/probation-milestone-emails.test.ts`.


## Yasmeena is informed of every AV, and her landing page names who is off — owner, 2026-09-29

### What he said

*"in any av request on phx make yasmeena informed and make on her landing page appear on a vacation
today."* Two instructions in one sentence, about the same seat: Yasmeena Elsafory, `HR-009`, HR
Operations — the seat that administers attendance and leave.

### Informed, and why that is not an approval step

The obvious-looking implementation is to add `HR-009` to the vacation approval chain. It is wrong,
and expensively so: every name in `approval-flow.ts` receives an approval step row, an SLA clock, an
escalation schedule and Approve/Reject buttons, so putting her there would have made **every annual
vacation in the company wait on a third signature**. "Informed" is the opposite of that.

So the informed party lives in its own module, `src/lib/vacation/informed-recipients.ts`, read by one
dispatch function and nothing else:

- **One notice, on submit.** `dispatchVacationInformed` runs at the end of `dispatchVacationSubmitted`,
  after the chain's own notifications, never instead of them.
- **In-app, email and Telegram — all three** (owner, 2026-09-30: *"yasmine informed in app email
  telegram"*). It shipped on 2026-09-29 as in-app + Telegram, because §4 makes an email recipient a
  question rather than an inference, and the report on that PR said in as many words that the email
  was a judgement call waiting on him. He answered the next day, so the email is now his instruction;
  removing a channel from the set needs his word exactly as adding one did. **Pass no `email` block:**
  `recipientHrId` alone makes the notification layer resolve her own work address
  (`yasmeena.elsafory@satopharma.com`) and set `recipientMode: "candidate"`, and record
  `recipientAddressUnresolved` when it cannot. An empty `recipients` is the trap — the `general`
  policy's own recipient mode is the shared `hr_notifications` inbox, so a mailbox stands in for the
  person and the send is still logged a success. Module `vacation` maps to the `general` email type,
  which every other vacation email already uses, so no new toggle is introduced.
- **`normal` priority and no Telegram button.** A high priority says somebody must act, and a Review
  button offers a decision that is not hers.
- **Annual only.** It is the type he named. Sick, Emergency, Other and Compensatory keep exactly the
  recipients they had, and widening the list is a product decision rather than a tidy-up.
- **Never twice.** When she is already a recipient — she raised the request, or she sits in its chain
  — the resolver returns null. Matching is on `normalizeHrIdForAccess`, so `HR-009` and `HR009`
  collapse; `canonicalHrIdKey` alone only lowercases and both spellings occur in this data.
- **The link is her own address**, `/hr/leave-management/vacation-report`, the row her sidebar offers.
  `/admin/approvals/vacation/<id>` is the approver's decision surface.
- **Admin-RECORDED vacations are untouched.** `createVacationRequestAsAdmin` deliberately sends no
  notification at all — it is HR writing down a vacation that has already been decided, usually her
  own keystrokes — and it stays that way. Those absences still reach her through the panel below.

### The panel, and the one way it could lie

"On a vacation today" sits directly under "Your day" on `/hr/admin/hr-command-center`, above the
toolbar (which filters the company figures below it, not this). It is **approved** leave covering the
Cairo day, **every** vacation type, as **named people** with the reason, the day part and when they
are back — not a tile. He had already ruled on this page that it carried "too many key codes"; the
question a leave administrator has in the morning is *who*, and a figure cannot answer it.

The source is declared on the `time_attendance` FUNCTION, not on the seat, so a seat that holds no
attendance grant is never shown the company's absences — the page's own architecture, and what makes
`sourcesFor` the single answer to who loads it.

🔴 **A failed read renders NOTHING.** `onVacationToday` is `null` when the source did not load and an
array when it answered, and the panel draws nothing for null. Collapsing that to `[]` would put
"Nobody is on a vacation today." at the top of her morning on a day the query was broken — the
misleading zero AGENTS.md §7 forbids, in the one place it would be believed.

`tests/vacation-informed-hr.test.ts` pins both halves in the required `checks` job: the informed
recipient's identity, type scope, channels, priority and dedupe; that `approval-flow.ts` never names
her; the source's function placement; and the null-versus-empty rule at both ends.


## The seal a human presses, and the seal the desk ticks — owner instructions, 2026-09-29

Two instructions landed on the same day and read, at a glance, as though they contradict each other.
They do not, and a session that reads the first without the second will delete work the owner
approved a few hours later.

### What he said, in order

**The morning ruling.** *"remove the sato pharma stamp/seal from all hiring documents, leave it only
in job offers."* That is the rule in `AGENTS.md` §4: nothing in `src/lib/hiring-pack/` draws a seal,
`house-identity.ts` exports none, and the contract, clearance, custody receipt, renewal, worker form,
salary letters and all 19 HR papers render blank signature cells. The خاتم / خاتم الشركة / Company
stamp column HEADINGS stay, because they name where a human presses the real stamp.

**The evening request.** *"IN hr FORMS I WANT TO HAVE THE OPTION TO ADD THE SATO STAMP STEAL AND MY
SIGNATYURE AND BE ABLE TO MOVE AND DRAG THEM FREELY IN ANY FORM."* Then, when the first build made a
placed mark permanent: *"donot put the stamnp opermenent make able to add them freelty as i wantv"*,
and *"make it optionaol to choose for any form i want."* Shipped as #4771, with #4780 correcting the
marks-list wording and #4784 making the dialog open on what was ticked last for that same paper.

### Why they are the same rule

The morning ruling is about **who stamps the paper**, not about whether a seal may ever appear on
one. His own sentence for it: a pre-stamped document is a document NOBODY STAMPED. A renderer that
draws a seal by itself produces a stamped-looking paper that no person ever authorised, which is why
per-template flags, copying the offer's seal across, and every other automatic route stay refused.

A print-time mark is the opposite shape. It takes **two human acts** and renders without either:

1. He drags a **position** onto the paper in the layout editor — where the seal sits, not that the
   paper is sealed. Placing a `signature` mark is Super Admin only, gated server-side in
   `app/api/hiring-pack/document-fields/route.ts`, not merely hidden in the UI.
2. He **ticks that mark in the print dialog** for that run, beside the copy count and the address he
   already answers there. Unticked — which is how a paper with no history opens — it prints the blank
   cell exactly as the morning ruling requires.

So the default render is unchanged and `tests/hr-forms-house-papers.test.ts` still passes on it. The
seal is the desk's press, the same as the rubber one, with the placement recorded against a person.

### What it does not license

- **No automatic mark, ever.** Nothing may tick a box on the paper's behalf, infer one from the
  document type, or place a position from a default. `#4784` remembers the last tick **in session
  state only**, never storage, for exactly this reason: a tick that outlived the tab would be a
  standing instruction to stamp.
- **The signature is Super Admin's alone**, to store and to place, and the image lives in a private
  Supabase Storage bucket. A signature served as a static asset is a forgery kit.
- **The NDA stays hand-stamped** (his ruling the same evening, after it was measured). Its signing
  cells are 12mm against a 34mm seal, and rendered through Chromium at every height from 16mm to
  36mm the paper spills onto a second page — on a document that prints two copies for every new
  hire. There is no height that fits. Never place a mark on it and never offer to.
- **The stamp column headings still stay**, and the clearance clause still refuses the form until a
  real stamp is on it.

### The trap

`tests/hiring-pack-document-marks.test.ts` goes red if the mark vocabulary is removed, so the
feature cannot be quietly deleted in a tidy-up. But nothing stops a session from reading the §4 hook
alone, concluding that hiring papers must carry no seal mechanism at all, and proposing to rip it
out as a rule violation — which is why the hook now names this account.

## The UE Direct split is retired with the Excel-import direct orders — owner, 2026-09-30

**What he was asked.** A select-audit of the sales code found `au_v_direct_region_allocation`: the
code reads it, and no such relation exists in `public`. Behind it sits `au.direct_region_allocation`,
a real table holding one rule — Anti Infective, geographic region `UE`, weights **UE-1 2 / UE-2 6**
(25% / 75%). `loadDirectRegionAllocation` would read it and the allocator already prefers its weights,
but nothing calls the loader, so the rule has never moved a single number. He was asked whether to
wire it, and from which month.

**His ruling, in his own words:** *"No, this is previously. This is previously when we used the Excel
import direct order, but now direct orders are all from the system, from the direct order request. So
we'll never meet this situation again. And as you see, the last time was July. Starting from August,
you will not see this split again. So September don't split it, never."*

**He is right, and it is measurable.** A split only ever reaches a Direct row with a **blank area** —
`allocateDirectToOperationalRegions` passes an area-carrying row straight through — and blank-area
Direct rows ended with July. Measured on production that day through `phx_monthly_closing_direct`,
Anti Infective: **2026-07 → 8 of 8 rows blank · 2026-08 → 0 of 9 · 2026-09 → 0 of 14.** Every row
since August carries its own area and brick, written by `direct_order_request`. 2026-07 is published
AND locked, so the one month this could ever have changed can never be restated.

**So, permanently:** do not create the `au_v_direct_region_allocation` wrapper view, do not pass
`allocationWeights` at the closing's call site, and do not re-propose the split. 🔴 **A select-audit
WILL flag the missing view again** — the read genuinely names a relation that is not there. That is
expected and is not a defect to fix. Pinned by `tests/closing-organogram-regions.test.ts`, which
fails if anything calls the loader or passes the weights.

**One stale claim corrected the same day:** that test's comment said production held `UE-1 3 / UE-2 6`.
The live rows are **2 / 6**, and always were.

## An area is NOT per line — a rep sees only his own line's spend on his patch — owner, 2026-09-30

**What he said**, on `/employee-portals/roi-tracker`: *"the gharbiya 2 rep line pedia is seeing the
request of gharbiya 2 line cns — it doesn't mean that he is the same area that he see his line …
this is a fatal mistake."*

**The mechanism, and why the wording of the earlier rule hid it.** The ROI Tracker's territory route
(owner, 2026-09-18) was written as "every request whose target customer sits in the rep's own
`employees.area_id`", which reads as a complete bound and is not one. `public.areas` is keyed to the
Source-of-Sales **area code** and the live rows carry **`line_id` NULL** — the old per-line rows
(ids **76** `gharbia_1` and **77** `gharbia_2`, both `line_id = 3`) were deactivated on 2026-07-07
and replaced by `D14` **Gharbia 1 (Tanta)** id **1103** and `D15` **Gharbia 2 (Mahalla)** id **1104**.
So one area id is held at the same moment by every line's rep standing on that patch, and
`marketing_customers.area_id` carries the same id whichever line's manager raised the campaign.

**Measured on production 2026-09-30, before the fix.** Joining every active REP seat to every request
with a `pay_date` on the same area id: **82 rep × request pairs admitted, 46 of them (56%) another
line's campaign, reaching 28 of the 72 active reps.**

His own case is the narrowest possible demonstration. `D15` is held by exactly one active rep,
**B-158 Hassan Elsherbiny, Pedia**; its only request with a pay date is
`MKT-REQ-20260831-393D40C7`, raised by **B-120 Mahmoud ElHassanin, the CNS District Sales Manager**,
promoting a CNS product. His own Pedia DM (**B-154**) had raised nothing there — so the single row on
his tracker was another line's money. `D14` is the same shape with three reps on three lines
(`AI-0020` Anti Infective, `B-145` CNS, `B-170` Pedia): both the CNS and the Pedia campaign there were
shown to all three, and the Anti Infective rep saw two campaigns while his own line had raised neither.

**The rule.** The territory route is **area AND line**. `territoryRouteAdmitsRequest`
(`src/lib/marketing-requests/roi-report-scope.ts`) is the single pure decision, deliberately lifted
out of `getMarketingRoiReport`'s database closure — the area half on its own *looks* like a finished
rule, which is exactly how this survived twelve days. A request's line is the **union** of the
requester's seat line and its promoted products' lines; on production all 45 requests with a pay date
carry both and the two **never disagree**. An unestablishable line is refused, and a rep with no line
on his master record runs **no** territory route at all — never an area-only fallback, which is the
bug itself. A two-line request is on both lines, so either line's rep on that patch still sees it.
The requester (hierarchy) route is untouched, so nothing the chain already granted anyone is lost.

**One stale comment corrected the same day.** `roi-report-service.ts` said the employee master
"leaves `line_name` unset for ~all reps", which is why the route never consulted the requester's seat.
Re-measured: `employees.line_id` is set for **all 72 active reps and all 19 District Managers**,
agrees 1:1 with `au.v_org_tree.line_name`, and all four `public.lines` rows are active.

**What this does NOT touch, and must not.** `canSeeMarketingCustomer` and `canReuseMarketingPharmacy`
stay **line-agnostic** — that is his own 2026-08-19 ruling (a cross-line doctor is a "treasure"; a
venue is captured once for the whole area). A shared doctor is not a shared campaign: only the
**spend** is narrowed. The Coverage tab of the same page never ran the territory route, so the leak
never reached it, and its scope keeps both halves empty and inert.

**The visible consequence, stated so nobody later reads it as a new defect.** 82 pairs → **36**;
41 reps holding a row → **22**; **19 reps' ROI tab now renders empty**, because their own line has
spent nothing on their patch. That is the honest answer, so the empty sentence says so for a rep
rather than claiming there are no requests at all when there are 45.

Shipped in #4897. Pinned by `testTheTerritoryRouteIsAreaAndLine` in
`tests/medical-rep-marketing-scope.test.ts`, which runs in the required `validate` job and is built on
the production seats and area id so it reads as the incident.

## The 06:55 CRM daily digest — refused, then restored — owner, 2026-09-27 and 2026-09-28

**Refused 2026-09-27**, in his own words: *"donot create this digest i donot want it"* — typed before
a single message had ever been sent. **Restored 2026-09-28**, also in his own words: *"i want it in
app or telegram only"*, which is exactly how it had been built, so the restoration needed no change
to the delivery. `JOB_SCHEDULES`, `scripts/cronjob-sync.mjs`, the `docs/observability.md` row and
cron-job.org job **`8526396`** all carry it. The memory slug still reads *refused*; the memory file
corrects itself in its first line, and that is deliberate — renaming a slug orphans it.

### The durable rule, and the night that produced it

**A declaration and its cron job move in ONE sitting, never one without the other.** The two failure
directions are not symmetrical, and both are loud:

- A **declaration with no job behind it** reads to `job-heartbeat-assess` as a job that has STOPPED,
  and it alarms every Super Admin for ever — there is no state in which it settles.
- A **restored declaration with no `watchingSince`** alarms about the stand-down window it was never
  scheduled for, which is the retrospective half of the same defect.

That second one cost a night of **15-minute pages across 2026-09-27/28**, to every Super Admin, about
a digest that had not been scheduled at all. Pinned by `tests/phoenix-crm-daily-digest.test.ts` and
`tests/job-heartbeat-register.test.ts`.

## A customer is planned and visited before validation, and counted after it — owner, 2026-10-01

### What he said

> "when making a plan in phoenix crm the customer can be not validated normally and added to the plan
> normally also can normal log a visist with validation but not counted in kpis till validated"

Three clauses. The first two restate his ruling of 2026-09-22 — nothing about the list ever stops a
rep planning, and a customer carried over from iReports360 and not validated yet is planned and
visited like any other. Those were already true and already pinned
(`src/lib/phoenix-crm/plan-rules.ts`, `tests/phoenix-crm-plan-never-blocked.test.ts`), and the rep's
own screens already say so in words: `pendingListNote` reads *"… not validated yet — plan them and
visit them as normal. Validate each one at the clinic and its visits start counting."*

The third clause is the one that had a hole in it.

### Why the hole was structural, not anybody's slip

`phoenix_crm_countable_visits` calls itself *the ONE predicate for whether a visit counts*, and it
answered only **one** of the two halves of that question — the off-plan APPROVAL. The other half, the
customer's own admission to the list, lived nowhere in the view: it was re-typed by hand as
`join phoenix_crm_customers c on … and c.validated_at is not null` inside each of the four
`phoenix_crm_report_*` functions, and the view's own comment then said *"every report joins the
customer's validated_at"* as though that settled it.

It does not settle it for a reader that is a PostgREST `.from()` in TypeScript, because such a reader
has **no join to forget**. Two of them counted every visit, validated or not, and both are things a
manager reads as a rep's work:

| Reader | What it feeds |
| --- | --- |
| `server/team-calendar.ts` `loadVisitDays` | AM · PM · Pharmacies per rep per day — the tab he called "the most important" of the three reports |
| `server/exceptions.ts` `loadVisitTallies` | the exceptions board's AM/PM tallies over the rolling window |

So `phoenix_crm_report_visits_by_day` printed 0 for a Tuesday on which the Team calendar printed 3 —
two screens disagreeing about one rep's day with nothing to say which was lying. On the exceptions
board the failure is worse than a wrong number: it **removes** a row, because the board exists to
raise the territory whose count is low, so a rep whose whole window was visits to unvalidated
customers read as a rep who had worked.

**Measured on production, 2026-10-01, before and after.** The module is pre-rollout — 7 visits on
file, all test personas, and **13 of 9,219 customers validated** — so the two reads were `7`
(calendar, exceptions) against `2` (`phoenix_crm_report_visits_by_day`). After the fix the calendar
reads `2`. At rollout, with nearly every customer still unvalidated, the gap would have been almost
the whole of every early figure.

### The fix is a COLUMN, and deliberately not a filter

`phoenix_crm_countable_visits` gained `customer_validated` (migration
`20261001060500_phoenix_crm_countable_visits_validated.sql`, applied to staging and production that
day). No row leaves the view and the `where` is untouched.

Making it a filter would read tidier — *the one predicate, finally one thing* — and would break the
rep's own screens. `loadMonthVisitCounts` feeds the line **"3 visits saved here, not counting yet"**
beside a customer he has not validated; a view that dropped those rows would turn that honest
sentence into "No visits saved here yet" about visits he really made. With a column, each reader
states which question it is asking in one visible `.eq("customer_validated", true)`.

**The two readers that must NOT filter, and why:**

- `server/list.ts` `loadMonthVisitCounts` — it is counting what the rep SAVED, not what counts; the
  sentence above is its whole purpose. For a customer on the list the question does not arise:
  `phoenix_crm_customers_active_is_validated` makes `active` and validated one statement.
- `server/adoption.ts` `loadVisitFirsts` — the adoption board asks whether a territory has STARTED. A
  rep logging a visit to a carried-over doctor has plainly started; filtering would put him on the
  "never touched it" list for doing the work, and would look truest in the first weeks, when almost
  nobody is validated yet.

The anti-fraud path (`phoenix_crm_location_integrity`) still reads the raw table and judges every
capture, exactly as before.

### The trap

**A reader of the countable view that asks only "is it in the view" is asking half the question, and
the half it skips is silent.** The view's name and its own comment both invite that mistake. Pinned by
`tests/phoenix-crm-countable-visits.test.ts`, which now names every one of the six PostgREST readers —
the four that filter, and the two that must not **together with the stated reason they give**, because
a pin on the `.eq` alone cannot tell a deliberate omission from one nobody has noticed yet.

## The weekly plan's second wave — owner rulings, 2026-10-02

The first Delta (1) team planned the week of 3 October in the new weekly screen. The owner picked 19
improvements in one sitting and answered each business question in chat. Every ruling below was his
answer to a multiple-choice question. The code and its test hold the rule; this section holds the why.

### Reaching the rep about his own week

- **"Your coming week is not sent" goes to TEAMS THAT STARTED only.** That is the 06:55 digest's own
  rule (`territoriesOfStartedTeams`): a team is the territories under one district manager. A team still
  on iReports360 hears nothing, and every rep of a team that started hears it, including one whose own
  entries were wiped. The reminder runs at 12:57 and 17:57 Cairo, from the due day to the day before the
  week. The 17:57 tick tells whoever is STILL not sent a second time ("Yes, remind again"), in its own
  words. It goes to the rep and his district manager, in-app, by Telegram and to the phone, never by email.
  The cron-job.org job is `8562812`. Pinned by `tests/phoenix-crm-plan-reminder.test.ts`.
- **Phone push reaches every Phoenix CRM notice EXCEPT the 06:55 digest.** He ruled the digest "in app or
  telegram only" on 2026-09-28, and it stays that way. On the day: 16 of 74 reps allowed Phoenix push,
  and Telegram reached none.

### Days off

- **A public holiday from the company's confirmed calendar is a day off on the plan.** It is greyed,
  holds no list, is skipped by Suggest and every copy, and a save naming it is refused. The day comes
  from the confirmed calendar, never the official date: 6 October 2026 stays a working day and 8 October
  is the day off he moved it to.
- **A full day of the rep's own approved leave is a day off the same way.** A half day is not.

### The manager's review

- **The district manager's double-visit plan is INVISIBLE to the rep** ("Rep does not see it"). Only
  that district manager, the SFE Manager and the Super Admin read it, and nothing notifies anyone.
- **Coverage on the review counts VALIDATED customers only.** On the day, all 8,234 customers were still
  pending, so the panel says so plainly rather than counting iReports360 grades.
- **"Return one day" reopens ONLY that day ("Only that day").** The other days stay as sent: the server
  refuses changes to them, and the rep's visits on them STILL COUNT AS PLANNED until he sends the week
  again ("Still planned"). The visit save and the plan-vs-actual report both read the one-day return off
  the `returned` event's `returned_day`.

### The trap

**A whole-week return and a one-day return look identical in `phoenix_crm_plans.status`.** Both read
`returned`. A rule that asks only "is the plan sent" therefore turns a rep's untouched days off-plan
the moment his manager returns one of them. Every reader that decides "was this day on a sent plan" must
ask the event's `returned_day` as well.

## The second Phoenix CRM batch — owner rulings, 2026-10-02 (afternoon)

Right after the second wave merged (#5129), the owner picked ten more items and answered each open
question in chat as multiple choice. As above, the code and its tests hold each rule; this section
holds the why.

### Phoenix visits count on every other screen, from each team's start

- **"From the team's start".** Once a team is counted from Phoenix CRM, compliance, Reps List, KPIs,
  Business Review, Employee 360, Early Birds and the rest count its PHOENIX visits, weekly plans and
  recorded day activities, and its reps' iReports360 visits and plan entries from that day are ignored,
  so nothing is counted twice. Before the start, iReports360 stays the record.
- **"Only when I start it"** (his answer to the risk review, the same afternoon). Delta (1)'s three teams
  start on Saturday 3 October 2026, as he ruled. Every other team starts ONLY when the Super Admin presses
  **Start** on it in the "Teams counted from Phoenix CRM" panel on the CRM page, from the Saturday he
  picks — Saturdays only, the coming Saturday offered first, and **never before the first day of the
  current Cairo month**, so a collected or published month is never restated. Nothing else starts a team:
  not a plan, not a visit, not a trigger — every line has been open in the module since 18 September, so
  a stray draft or one visit must never drop a whole team's iReports360 days. **Stop** sends a team back
  to iReports360 from a Saturday under the same floor, and a start not reached yet is taken back whole.
  A stop sticks: only another Start, on or after it, counts the team again. Before he presses anything
  he reads what it does in words ("From Sat 10 Oct 2026, the iReports360 visits of these 6 reps stop
  counting and their Phoenix visits count instead"). The route is Super Admin only and asserts its
  permission before the write; the one writer, `phoenix_crm_set_team_start`, re-checks every rule and
  writes the audit row in the same transaction.
- **The notice.** The first time a rep sends a REAL weekly plan on a team with no start, the Super Admin
  is told once per team — in-app, Telegram and the phone, never email — naming the team (its manager,
  line and region), the rep and the week, with a link to the panel. A test-world send tells nobody, and
  the notice never fails or slows the send (`phoenix-team-start-notice.ts`).
- **"Yes, the whole team".** From the team's start the district manager's own iReports360 visits stop
  counting too, and his Phoenix visits count instead — the same seat-history rule as his reps', for
  exactly the days he holds the team's seat. His single visits carry him as the agent, the double and
  chain visits he makes carry him as the partner, as the vendor shape always credited a manager. Phoenix
  CRM records no day activity of a manager's own, so his meeting or training day within the start
  carries no record — the DSM no-record connector may raise it, as a candidate that waits for approval.
- **A team is the territories under one district-manager SEAT**, not the person, so a manager change
  or a vacancy keeps its start. `phoenix_crm_team_starts`, `crm_visits_unified`,
  `crm_plan_entries_unified`, `src/lib/crm/phoenix-team-starts.ts`. Pinned by
  `tests/phoenix-crm-visits-everywhere.test.ts`.
- **Only COUNTABLE Phoenix visits are served**, so an off-plan visit counts on these screens only once
  approved, exactly as inside the module. Deductions and allowances stay decided on their own screens.
- **What reads Phoenix for a started team, from its start:** every visit reader of the visits door; the
  PLAN readers — Reps List statuses, KPIs coverage and frequency, SFE doctor coverage, the Reps Weekly
  Plans tab and its plan actuals — through the plan door, where a day is planned when the rep had SENT
  that week as of that day, by the module's own rule (one-day returns included; a save is never a change
  of status); RECORDED day activities (meeting, conference, health day, sales day, training, admin work,
  travel) as the iReports360 worked-day codes, so a training day no longer reads "no activity"; and
  Early Birds, whose start and "#1 days" are the first countable Phoenix visit's capture time — a
  Phoenix visit is its own check-in there as in the call rate, named "First visit", never GPS.
- **"His first Phoenix visit is his start", and "each visit's silent location counts as a check-in on
  the SFE and manager screens. Never on the rep's own screens."** The SFE start times read a started rep's
  first countable Phoenix visit, through the same helper as Early Birds. The CRM Check-ins tab, GPS
  brick coverage, the integrity page, the managers' first-visit board, the rep-day drill-down, Field
  Activity and probation SFE evidence read each positioned Phoenix visit as that day's check-in — time
  and position only, never an integrity field — and his iReports360 check-ins after the start are
  ignored. Every check-in reader a rep can reach stays on iReports360: My Visits, Employee 360, the
  KPIs board, the outstation workload and claim validation, the Phoenix CRM List's pins and pharmacy
  search (src/lib/crm/phoenix-team-starts.ts lists them).
- **Still read from iReports360 only**, each its own decision for later: the manager's Early Birds
  decision line ("N GPS-verified"); a customer created new in
  Phoenix, who has no iReports360 contact id, so no per-doctor figure can name him; the CRM connector's
  leaver path (it does not check approved leave); a chain visit's senior manager (the vendor shape has
  one partner column); and owner decision 18, which keys on the global cutover date, not a team's start.
- **The company has no Training Manager**, so no rule here waits on one.

### What the field heard — the product and marketing managers too

- **"Yes, product managers too".** The Product Manager, Group Product Manager and Marketing Manager app
  roles hold `phoenix_crm: read` for ONE report: what the field heard about their OWN products
  (`resolveSalesAccessScope`, the rule Sales already uses), company-wide, never by area, territory or
  rep. Every other Phoenix CRM read answers them with nothing, because they hold no seat.
- **Counts only.** No report anywhere shows a "no objection" figure, a rate or a row per rep: that would
  be an honesty figure, and golden rule #1 keeps those out of every screen but the integrity board.

### The rep's visit asks

- **The rep may ask for a visit with his manager, with a product manager, or for a chain visit, for one
  customer.** These are the owner's own words, added to the batch: "the medical rep can request a double
  visit with his manager / product manager / or request a chain visit to a certain dr".
- **The product manager is "One the rep picks"**, from his line's product managers.
- **A chain visit is "DM + the manager above"**: his district manager and the next manager up visit with
  him, and both are told.
- **When the person asked accepts and picks a day, the rep sees it ("Yes, he asked")**, for example
  "Accepted, Tue 6 Oct". This is HIS request, so it is his to see. The district manager's own
  double-visit PLAN stays invisible to him, as ruled in the morning.

## A pharmacy call in Phoenix CRM — owner rulings, 2026-10-02 (late afternoon)

The hook is in `AGENTS.md` §4. This is the account, and it matters mostly because **three of the four
rulings REMOVE something**, and a removal is what a later reader restores by analogy with a doctor.

### What the feature is for

Phoenix CRM had no pharmacy a rep could visit. A pharmacy was a NAME he typed as stock feedback ON a
doctor's visit, which is why `day-detail.ts` says "a PHARMACY IS A DISTINCT NAME AND NOT A ROW".
Measured on production for September 2026, Delta (1) made **444 pharmacy calls — 15% of everything
they did** — and Phoenix carried none of them. That gap is the reason the second batch had to word a
started team's Pharmacies figure "not recorded in Phoenix" instead of printing `0`
(`src/lib/crm/visit-count-buckets.ts`). It is also what this feature closes, so when it lands that
wording must change for days from its start — the figure stops being absent and becomes a count.

### 1. A third list, and the binary that would swallow it

The customer's own `list_type` carries `Pharmacy`, the vendor's own spelling in `LIST_TYPES`
(`src/lib/crm/contacts-web-client.ts`), which is also where each rep's pharmacies are imported from.

🔴 **Every reader of `list_type` in the module today is a binary** — `row.list_type === "AM" ? "AM" :
"PM"`, in `server/doctors.ts`, `server/customer-timeline.ts`, `plan-review-rules.ts` and
`report-rules.ts`. Each one files a pharmacy under PM, silently, which is exactly what the AM · PM ·
Pharmacies golden rule exists to prevent, and nothing anywhere goes red. `parseListType` is the
single replacement; it still answers `PM` for anything it does not recognise, so a row written by an
older build reads exactly as it always did.

### 2. It is NEVER planned — and this reverses his own answer from the same morning

Owner, 2026-10-02: *"the pharmacy is not added to the weekly plan. He can add any pharmacy, any time.
It's not added to the weekly weekly weekly plan. He don't plan it. We don't want extra."*

Earlier that day he had answered the opposite — *"YES PLANNED LIKE DOCTORS BUT NEVER COUNTED MIXED
WITH DRS"* — and had set a cap to go with it, *"plan up to 10 pharmacies a day"*. **A hand-off note
written between the two holds the superseded half**, so a session reading one is reading a rule that
no longer stands.

The cap goes with the plan, and the reasoning is worth keeping because it is the thing a later reader
will get wrong: **that cap capped PLANNING**. With no plan row there is nothing left for it to limit,
and re-expressing it as a cap on VISITS would be new — it would refuse a rep a call he actually made,
for the sake of a number that does not exist (rule 4), and it is precisely the "extra" he refused.

### 3. It is NEVER approved

Owner, 2026-10-02: *"no approval for an unplanned pharmacy visit."*

An off-plan DOCTOR visit waits on his direct manager and then the SFE, and counts in nothing until
both agree (`unplanned-rules.ts`). That approval exists to stop an unapproved visit inflating a figure
somebody is judged on. **A pharmacy call has no such figure**, so the approval would protect nothing
and cost the rep a step — against Phoenix CRM golden rule #1, that the rep's app is easy and that any
new step in his day needs the owner's word first.

🔴 This is the ruling most likely to be "fixed" back, because the off-plan machinery sits one file
away and a pharmacy call is, literally, a visit that is not on a plan. `visitApprovalKind` answers it
in `pharmacy-call-rules.ts` for that reason: the short-circuit is stated once, where a reader looking
at pharmacies will find it, rather than inferred where a reader looking at approvals will not.

### 4. No KPI reads a pharmacy

Owner, 2026-10-02: *"we are not stuck to coverage of pharmacies … grab the reps' pharmacies from
iReports360 only as a database or as a reference, but no KPIs is counted on it."*

So there is no pharmacy coverage, frequency, monthly target, call rate or capacity anywhere. The
Pharmacies figure of AM · PM · Pharmacies stays a **plain count of calls made** — never a rate, never
a share of a target, never a denominator. `KPIS_A_PHARMACY_IS_NEVER_IN` names the five rather than
counting them, so adding a sixth measure to the system is a decision about that list and not an
oversight.

### 5. The two halves of it that were still missing after the first sweep

Both found on 2026-10-02, after the reference import was already written, and both would have shipped
a feature that did not work.

**A SECOND spelling of the binary.** The sweep converted 26 readers of the shape
`row.list_type === "AM" ? "AM" : "PM"`. There was another: `listType === "AM" ? am : pm`, which chooses
a COUNTER rather than a label and so reads nothing like the first. Two places still filed pharmacy calls
among the doctors through it — `src/lib/phoenix-crm/day-detail.ts` and the team calendar's own buckets —
and the ratchet, which matches the first shape, could not see either. Both now go through
`visitCountBucketForListType`, which is the only function that may decide which of the three figures a
call lands in.

**The database refused the whole thing.** `phoenix_crm_customers` and `phoenix_crm_visits` each carried
`check (list_type in ('AM', 'PM'))`. So `phoenix_crm_ensure_reference_customers` would have raised 23514
on the first pharmacy row it tried to mint, and a visit to a pharmacy could never have been saved at
all — the feature's two writes, both refused, after a migration that reported success. It was found by
reading `pg_constraint` on production rather than the migration files, which is the §1 rule in one
sentence. `20261002205435` widens the two; a staging probe then minted **63 pharmacy customers beside 9
AM and 110 PM** on one seat, and saved a `Pharmacy` visit that the same insert had refused minutes
before.

🔴 **`phoenix_crm_plan_items` IS LEFT NARROW, AND THAT IS THE RULE, NOT AN OVERSIGHT.** A pharmacy on a
plan row is exactly what the owner ruled out, so its own `check (list_type in ('AM', 'PM'))` is now the
database's half of rule 2, under `PLANNABLE_LIST_TYPES` in TypeScript. `phoenix_crm_list_requests` stays
narrow for the same reason: a pharmacy arrives as a reference and leaves as one, with no grade, drop,
add or bring-back request to decide.

## Add visit keeps every point, and its optional steps start folded — owner ruling, 2026-10-02 (night)

**What he asked.** At night he sent Report It's form again: *"I WANT VISIT SUBMISSION TO FOLLOW THIS I
WANT VISIT SUBMISSION SUPER EASY FOR THEM"*. Add visit had worn Report It's four-step frame since that
morning (#5095: Visit type → Customer → Products and comment → Log the visit), but its step 3 was still
one long page of seven boxes. Asked what step 3 should become, he answered: *"I need all the points in
the current form of entering the visit … I don't need too many steps and too many clicks by the reps.
So what do you recommend?"*

**The recommendation he was given, and how it is built.**
- **Every point stays.** All seven boxes keep their header and their number, so the form still shows
  every point, and the read-back on step 4 lists whatever was entered.
- **No step and no press are added.** It is still four steps. A visit that skips the extras (the usual
  visit) costs exactly what it did.
- **The three optional ones start folded:** the pharmacy check, what he left, and what the customer
  said. Each is Report It's dashed "add" row under its own header, and one tap opens it in place
  (`FoldedStep`, `openExtras` in `src/components/phoenix-crm/visit-log-form.tsx`). Once open it stays open
  across Next and "Change something", so nothing typed is lost.
- **A required step is never folded.** The bar under his thumb jumps to the first missing answer, and
  that jump must always land on an open box.

**Never "fix" it back:** do not remove a point to shorten the form, and do not split step 3 into more
steps. Both are what he ruled out in the same answer. Pinned by `tests/phoenix-crm-visit-form-ease.test.ts`, section (e).

## `AGENTS.md` §4 Standing owner rules — as it stood before the 2026-09-12 condensation

On 2026-09-12 `AGENTS.md` was cut to roughly half its size at the owner's request ("Load less of AGENTS.md"): every hook was reduced to its rule plus the one detail needed to obey it. This is that section's hook text **verbatim** from `origin/main` 3eea44aef, kept so that no measurement, date, count or diagnosis a condensed hook dropped is lost. Search it for the hook's wording. The accounts earlier in this file remain the fuller record.

These are the owner's own decisions, stated across many sessions. They are not suggestions. **Each
line is the rule, not the evidence.** The account of every one — incidents, PR numbers, measurements,
his own words at length — is in **[docs/agents-owner-rules.md](agents-owner-rules.md)**, verbatim.

**How to answer**

- Reply in **English always**, regardless of the language he writes in.
- Report every time in **Africa/Cairo** local time, never raw UTC.
- Show **human-readable names**, never raw codes or IDs, in both UI and chat.
- **Never truncate text with an ellipsis.** The old "never let text wrap" companion rule is **superseded** by the no-horizontal-scroll golden rule below — where they collide, wrapping wins.
- When asked for N recommendations, give only the ones grounded in a real confirmed need. **Never pad a list to hit a number.**
- **Open every reply with a single recommended next step — it goes FIRST, not last.** Amended by the owner 2026-09-07 (*"okkay but put ur recommendation first"*); it previously read "end every reply with" it, which is the wording a session drifts back to at the bottom of a long reply. Still exactly ONE, still never padded to a number — only its position moved. Findings are support for the recommendation, so they sit underneath it: he reads on a phone, at night, and he is the only person who can act on it. **Do not also repeat it at the end.** A reply that genuinely asks nothing of him needs none at all. `recommendation-goes-first-not-last`

**How to take work**

- When he says he will list several requests, **log each as a task and wait for the go-ahead** — do not start implementing while the list is still being given.
- **Ask when the answer changes the outcome; decide when it does not.** Scope, business rules and data-correctness questions are always worth asking; permission to do obvious low-risk work is not.
- **Ask business-fact questions as an XLSX with dropdowns, not in prose** (his rule). Whenever the doubt is "which of these does each of these belong to" — bricks to areas, people to seats, products to lines — build one row per item with a locked data-validation list, include the context that makes the call easy and a free-text Note column, send the file, and read the answers back. Applies **everywhere in the repo**. Never guess an item to avoid asking, and never hand back a list for him to answer in chat.
- Take ownership. Automate the work rather than returning a checklist he has to execute.
- 🔴 **"continue verifying" — THE SOURCE OF SALES AUDIT IS FINISHED, END TO END. There is nothing left to resume.** 140 confirmed defects. **The findings are now a FIX backlog, not an audit backlog.** ⚠ Every earlier file in that vault folder still describes work in progress and they are FROZEN INPUTS, correctly never rewritten — a session that reads an older one restarts a finished audit, which has happened **twice**, and this rule is the only thing stopping a third. **Read `RESUME-2026-09-05.md`, the newest, which records the completion.** 🔴 **RE-MEASURE FIRST: THE LIST IS STALE** — a 2026-09-04/05 fix campaign closed many of them, **all three criticals included**, so **start from `sos-remeasure-2026-09-06.md` in the vault, never from the two reports.** Never restart the 20 finder agents, never `resumeFromRunId`, never overwrite the inputs — **write a NEW file.** Run ids, counts and the per-finding triage: [docs/agents-owner-rules.md](agents-owner-rules.md).

**How to build**

- **Before building any new UI, inspect the sibling pages in that module and match their exact design identity.** Never invent a one-off look.
- 🔒 **THE FITS-THE-SCREEN GOLDEN RULE — never a horizontal scroll, always mobile AND desktop friendly.** `overflow-x-auto` over a `min-width` floor IS the bug, not the fix — render `<table className="w-full table-fixed">` with a `<colgroup>`, and **fit by MERGING columns, never by shrinking type; WRAPPING is the permitted answer.** **Measure, never guess** (`scrollWidth > clientWidth` over `main` at desktop AND 375px) — but that check is BLIND to content CLIPPED rather than scrolled, and its INVERSE means content UNREACHABLE, not merely off-screen. **`shrink-0` pins a wrapper to max-content, so a `flex flex-wrap` row inside it is INERT at every viewport.** A native `<select>` may NOT be shrunk. Measured cases, both traps and the `clampPanelToViewport` rule: [docs/agents-owner-rules.md](agents-owner-rules.md). `never-horizontal-scroll-always-mobile-and-desktop-friendly`
- Admin shell: **desktop shows full tables/dashboards, mobile never does** — mobile gets cards.
- 🔒 **THE SQUARE-EDGE GOLDEN RULE — no round or semi-round corners, anywhere.** Owner 2026-09-04. **`tokens.css` CONTRADICTS this** — its `--phx-radius: 4px` default is the bug, and a session copying a sibling inherits it silently. **Measure, never eyeball**: count computed `border-radius` not `0px`; 4px survives review. 🔴 **`globals.css`'s own sweep is NOT coverage** — it matches a Tailwind class on an ELEMENT, so it misses a hand-written radius, can never square a `::-webkit-scrollbar` pseudo-element, and cannot reach an iframed document at all. Pinned by `tests/admin-shell-palette-scope.test.ts` and `tests/hiring-pack-paper-editor.test.ts`. ⚠ **Premium polish RETURNED 2026-09-08; #3114 cut radii AND depth together, so restoring it from history re-rounds corners — take the depth only.** Account: [docs/agents-owner-rules.md](agents-owner-rules.md).
- 🔒 **THE DOCUMENT IDENTITY — every company document wears `SATO-DIS-2026-01 v1.0`, approved 2026-09-05.** It is the **COMPANY's** identity (Sato Pharma), never the Phoenix app's. **"Put it in the system template" is a STANDING instruction** — rebuild the document on it without asking. The palette is **MEASURED FROM THE LOGO** (`#0A527D` deep, `#0A6BA6` blue, `#1482C2` light), replacing a navy `#0B2A4A` that is in no part of the mark. 🔴 **THE INK RULE — no filled areas, anywhere:** colour is carried by lines and type, never by area (9.97% → 3.18% page coverage), the ONE exception being the 6% zebra row he asked for by name. **Government forms are EXEMPT permanently** — Form 1, Form 6 and the labour exit form are Authority facsimiles. On paper the mark is ALWAYS `sato-pharma-logo-on-light.png`; the stock file sets "SATO" in white and the letterhead reads "PHARMA". One module: `src/lib/hiring-pack/house-identity.ts`. `the-house-document-identity-standard`
- **One production deployment per task.** Bundle all phases into one PR; do not deploy per step.
- Use the **`gh` CLI** for all GitHub operations, not the GitHub MCP tools.
- Before wiring any email recipients, **ask who receives it**.

**Product rules that must not be "fixed" back**

- No payslip on any overview/landing page for any role — not the amount, not even the month label.
- 🔒 **THE AUTOMATED PAYROLL EXPORTS ARE EXEMPT from the house identity — Phoenix black-and-orange, owner 2026-09-08.** The run sheet, the finance downloads and the step templates are Calibri on `BLACK` header bands with the orange accents and the coloured held / execution fills; **the published batch download and the payslip renderer STAY on the house identity**, so the split is per-EXPORT, not per-module. `house-identity.ts` reads like an instruction to convert these too — **it is not one**, and the ink rule does not reach them. Pinned by `tests/payroll-phoenix-look.test.ts` in the required `checks` job, which fails on ANY house colour in these workbooks. ⚠ **Two things there are NOT palette and must survive any restyle** — the held row's NOTE (the Phoenix look carries "held" as a red fill alone, which greyscale and a copied range both lose) and the step template's cell LOCKING (its pre-2026-09-05 doc comment claimed "locked" and locked nothing). Account: [docs/agents-owner-rules.md](agents-owner-rules.md).
- 🔒 **THE OFFER LETTER DESIGN IS FROZEN — owner 2026-09-05, asked and answered: *"donot change in offer design"*.** Its own blue (`#0b86be`), the filled navy bands, the tinted salary table and the CIRCULAR initials disc all STAY. **The house document identity does NOT reach `src/lib/offers/`** — not the ink rule, not the square-edge rule, not the vector mark. `house-identity.ts` names these letters as being "on a different blue entirely", which reads as a deviation waiting to be tidied: **it is not one.** The classic template reproduces a letter he SIGNED and the executive bands ARE its premium look, so a house-identity sweep that "finishes the job" here reverses an owner decision. Account: [docs/agents-owner-rules.md](agents-owner-rules.md).
- 🔴 **A REJECTION NOTICE IS NEVER SENT AUTOMATICALLY.** Owner 2026-09-05, asked and answered: *"i dont want to auto send rejection notice"*. No sweep, no on-status-change trigger, no digest, in EITHER channel — and the 97 already-rejected candidates are a SETTLED question, never an unfinished phase to re-raise. The planner built that day was removed the same day; do not rebuild it, and do not read the two recipient sheets he was sent as a queue waiting for a send path. **What the removal KEPT is `isBatchActor`** (`src/lib/recruitment/batch-actor.ts`) — load-bearing for the throughput trend, nothing to do with sending.
- 🔴 **THE SYSTEM NEVER AUTO-APPROVES A PLAN — a DM's weekly plan is submit → NSM (or RSM if applicable) → HR acknowledge, with NO CEO stage.** Owner 2026-09-05, twice; he also rejected a SYSTEM ACTOR — the objection is the approval EXISTING, not its label. `SYSTEM-AUTO-HR-ACK` on the ACKNOWLEDGEMENT stays, a system-signed APPROVAL is forbidden; reading only "drop the CEO" re-adds a cascade and believes it complies. **Never implement "skip a stage" by writing a decision row FOR the skipped stage — let the transition carry it.** **A DM plan now carries NO `ceo_approve` row AT ALL — all 50 deleted from PRODUCTION in TWO passes; do NOT undo, and do NOT read a DM plan's missing CEO row as data loss.** ⚠ The 50 were NEVER one population — classify by GAP and ACTOR before any sweep, and **never delete a human decision on the same predicate that catches a fabricated one.** Pre-image tables, counts and both passes: [docs/agents-owner-rules.md](agents-owner-rules.md). `the-system-never-auto-approves-a-plan`
- 🔒 **A PHARMACY IS NOT A CONTACT — a CRM contact count is `PM` + `AM` only.** Pharmacies are separate: they stay OUT of the denominator the 90–120 rule judges and get their own tile. Never put `rows.length` beside the word "contacts" — route every printed size through one splitting helper — and **never name a row bag `contacts` when it holds pharmacies**, because the next session reads the field name and reprints the bug. Row label **"Pharmacist"**, count **"Pharmacies"**. `a-pharmacy-is-not-a-contact`
- 🔒 **THE CALL RATE IS NEVER AVERAGED — AM against 2, PM against 10, reported APART.** Owner 2026-09-04: *"this two and this ten. Don't never get average."* There is deliberately NO combined figure anywhere — not on a row, not in the team totals, not as a band, not as a URL param — because every way of merging the two lets a good morning pay for an afternoon that never happened: 2 of 2 AM with nothing after lunch reads 50% averaged and 17% over one denominator, when the true answer is 100% and 0%. **Never print the pair with a slash** — he read `1.63 / 6.57` as *1.63 out of 6.57*; the separator is ` AM · ` / ` PM`. Pinned by `runKpiAttainmentAndIdentityTests` in the required CI `test` job.
- Marketing Manager is hidden from the portal Incentive tab; GPM still sees it.
- The Organogram / AU seat model is the source of truth for org-structure and vacancy data.
- **SoS attribution is PERIOD-AWARE — read the function, never the old "today's geography" shorthand.** `au.f_monthly_attribution` and `au.f_monthly_achievement` resolve an area's region through `au.f_line_area_map_asof(period_end)`: the map as it stood at the END of the month being computed, so a forward-dated move leaves earlier months intact. It only LOOKS like today's geography because almost no `au.line_area_map` row has ever been closed. The shorthand this replaces also contradicted the August / Delta golden rule below, which forbids resolving closing geography at the run date.
- 🔒 **A CRM account label is `[Name ]( Area / Line )`, and `E`/`F` are RETIRED line codes.** The area sits between the brackets, the line is the letter after the final `/` or `-`. **`E` became `A`; `F` became `P`** — live codes are `A`, `C`, `P`, so a trailing `/ E` or `/ F` is old naming and **never an open question**. **The CRM admin never deletes an account**: he deactivates, strips the name, keeps the area, then CLONES — so a leaver's identity is unrecoverable from the CRM. **Cloning is safe; RENAMING is what corrupts numbers.**
- **Delta (3) territory move — LIVE, dated 2026-09-01, applied as a migration 2026-08-29.** The five areas (`D11`, `D24`, `D25`, `OT2`, `OT9`) sit on a dated PAIR, so **nothing is owed on 1 September** — do not re-apply, re-date or "finish" it. Resolver gap CLOSED both directions; recruitment CLOSED and `recruitmentAreaRegionOverrides` is PERMANENT. Keep the pre-image `delta3_defer_backup_20260829.line_area_map_pre`. **The SALES geography is DELIBERATELY LEFT ALONE (owner, Option A) — do NOT repoint `code_region_code`**, which can silently hide a district manager's own sales.
- 🔒 **THE AUGUST / DELTA (3) GOLDEN RULE — the August closing NEVER contains Delta (3), whenever it is published.** Owner: "golden rule, no negotiation", twice in one breath. **Already enforced — do not rebuild it**, at four levels including `runClosingPeriodDatingTests`, in the required CI `test` job. **Never resolve closing geography at the run date**, and never offer to publish August "now that the move is live" — the date is the mechanism.
- 🔒 **THE AUGUST / UPPER EGYPT GOLDEN RULE — Pedia's Upper Egypt splits into Upper Egypt 1 and Upper Egypt 2 on 2026-09-01, and the August closing NEVER contains the split.** Owner 2026-09-09, *"golden, golden, golden rule"*, then twice more: *"you will pause August, August as it is."* **UE-1** Fayoum, Beni Suef, Minia 1-2, Assuit 1-2. **UE-2** Sohag 1-2, Qena 1, Qena 2, and **LUXOR, which is NOT a separate area** — it rides in as `other_permanent` with no rep seat, exactly as OT9 did into Delta (3). Aswan stays in Others. **PEDIA ONLY, said three times** — `UE-1`/`UE-2` already exist on Anti Infective with DIFFERENT membership (Assuit is UE-2 there, Fayoum is Giza), and `au.line_area_map` is per line, so **do NOT "align" them**. **The DATE is the mechanism**, as with Delta (3); the pre-image table is belt and braces and never the guard. 🔴 **El Qema's divisor goes 37 → 39** because Qena 2 and Luxor leave Others — the exclusion keys on `operational_region_code` **ALONE**, so an area carrying no target still takes a share. ⚠ `au.seats` is keyed on `seat_id` alone, so a seat cannot be forward-dated: the rep seats re-point when the migration runs, and that is chart metadata only. Pinned by `tests/pedia-upper-egypt-split.test.ts` in the required `checks` job. Account: [docs/agents-owner-rules.md](agents-owner-rules.md).
- 🔒 **Delta (3) is ANTI-INFECTIVE ONLY.** On CNS and Pedia the five areas do not move at all, in BOTH months. A sweep that finds them "half-migrated" across lines is reading the **CORRECT** state.
- 🔒 **THE CLOSING GOLDEN RULE — a closing is never done or sent during the month it covers.** Publishable on the **first day of the following month, Africa/Cairo**. Preparing a running month is fine; **releasing** it is what is forbidden, because publishing notifies every sales and product manager and a sent mail cannot be recalled. Enforced by `src/lib/sales/closing-period-gate.ts` + `tests/closing-period-gate.test.ts` in the required `checks` job. **`unpublishClosing` is deliberately NOT gated** — it is the recovery path. Do not add an override flag.
- 🔴 **A PUBLISHED AND ANNOUNCED MONTH IS NEVER CORRECTED, however wrong it is.** Owner 2026-09-07, refusing a fix that was measured, line-neutral and required by *his own* earlier ruling. So the trigger is PUBLISHED-AND-ANNOUNCED, **not "is the fix justified"** — being able to prove the number wrong is not an exception, and a session that re-derives the justification will reach "we should fix it" every time. **A late ruling is a rule for UPCOMING months.** `monthly_closing_locks` enforces it on `source_of_sales_import_rows` and `source_of_sales_fact_rollup` (every insert/update/delete, **including migrations and direct SQL**) — **treat a lock as his decision, never an obstacle to route around**; unlocking needs him to say so about that specific month. `never-fix-a-published-and-announced-month`
- 🔒 **THE CITY RULE ALWAYS WINS — except EZ, Office, and El Qema’s warehouses.** Owner 2026-09-07. A wholesaler's sales spread evenly across the areas of its OWN city, **even when its goods demonstrably left the city**. **Do NOT reintroduce a per-customer apportionment override**, and do not read the 441164 (ريونيون) history in git as unfinished work — a live sweep of all 323,952 rows found ZERO re-booked rows. TWO exemptions survive and NEITHER is a per-customer override: `evenSplitApplied` (EZ) is arithmetic, not judgement, and **El Qema’s warehouses** key on DISTRIBUTOR plus a per-product QUANTITY — a different axis. **Office needs no entry** — its rows carry no customer. Account: [docs/agents-owner-rules.md](agents-owner-rules.md).
- 🔒 **EL QEMA (`QM`) — 3 BANDS, THE صعيد PASS, THEN THE LEAD GUARANTEE. PEDIA ONLY. Owner 2026-09-09 evening, *"remove any current rule and implement those"*.** Per warehouse per PRODUCT on the MONTH total: **≤200** the governorate only; **201–699** half governorate, half the rest of the country; **≥700** flat over the republic, never Others. **Qalubeya means Qalubeya + Cairo**, EVENLY — the 60/40, 75/25 and PRIORITY LADDER are GONE; finding one missing is a DECISION. Then **تقسيم القمه للصعيد**: Upper Egypt's credited sales pooled, **half back across it evenly, half over الجمهورية** — the REPUBLIC, not the rest of it. 🔴 **IT TAKES MONEY OUT OF UPPER EGYPT** and **RUNS IN EVERY BAND, band 1 included**. 🔒 **THEN THE LEAD LADDER: QALUBEYA FIRST, then Tanta (D14) and Mahalla (D15) LEVEL behind it, all three above the field** (*"لابد"*, then *"Qalubeya number 1"*) — one **2%** step per tier, everyone else paying pro rata. `QEMA_LEAD_TIERS` is ORDERED; within a tier, EQUAL. 🔴 **NOT IN `splitTargetsFor`** — it runs ONCE per line and product over the finished landing, so the Detail sheet and the preview do NOT show it, and **the step is a FIXED POINT** (paying them shrinks the field they must beat). 🔴 **UPPER EGYPT IS NOT READABLE FROM AUGUST'S REGION CODES** — Fayoum (GZ6) and Beni Suef (UE9) are in GIZA until 2026-09-01; `UPPER_EGYPT_AREAS` holds the golden rule's UE-1 + UE-2 membership, less Others. **Others take nothing but keep their own sale.** `store-sales-city-split.ts` (`UPPER_EGYPT_AREAS`, `QEMA_LEAD_TIERS`), pinned by `tests/qema-warehouse-split.test.ts`. [docs/agents-owner-rules.md](agents-owner-rules.md).
- 🔒 **EL QEMA LEAVES NO TRACE IN A CLOSING DETAIL — owner 2026-09-09, *"never anyone know that these sales are from Al Qimma, but they appear in their total and achievements"*.** Distributor, customer code, name and address are **BLANK** on El Qema rows for everyone but **Super Admin** (and `scope: "system"`, which every computation runs as); totals and achievement are untouched. 🔴 **HE OFFERED TO RELABEL THEM AS A REAL DISTRIBUTOR AND IT WAS DECLINED** — false rows in the auditor's file, discrepancy on the wrong company. He then chose **blank** over a neutral code. **Never invent a source.** It is a **MASK, NOT AN ERASE** — the batch and raw rows keep the truth, by his choice. 🔴 **PLACE IT AFTER EVERY COMPUTATION AND BEFORE EVERY RENDER — BOTH mistakes are SILENT**: too early and the split stops recognising El Qema (numbers move, no error); too late and the identity reaches a screen. `loadMonthlyClosingDetails` masks BY DEFAULT and only the closing EXPORT route passes `revealSource: true`, re-masking into each workbook; the Store Split sheets carry no distributor per entry, so they mask by CLIENT CODE. `closing-source-mask.ts`, pinned by `tests/closing-source-mask.test.ts`, which asserts the EXACT list of revealing files. Account: [docs/agents-owner-rules.md](agents-owner-rules.md).
- 🔒 **THE WEEKLY BI AND NSM/DSM EXPORT DESIGNS ARE PASSWORD-LOCKED — owner 2026-09-08, *“never change unless set this password”*.** Sheet set and order, every width/merge/pane/format, the style table and the charts are pinned in `src/lib/sales/weekly/export-design.pins.json`; **values and formulas are NOT locked.** The ONLY sanctioned re-pin is `scripts/weekly-export-design-unlock.ts --unlock`, which checks a scrypt verifier the repository cannot supply the password for. 🔴 **A red design test is NOT fixed by editing the pins — that is the move the lock exists to catch**; revert, or have the owner unlock. **NSM/DSM also stays BEIGE and exempt from the house identity** (#3242/#3303 turned it white-and-blue; the ink rule does not reach it), while **the BI book KEEPS the house identity** — opposite rules, and confusing them reverses one. New capability ships BESIDE, never inside. `tests/weekly-export-design-lock.test.ts` · `tests/weekly-nsm-dsm-beige-look.test.ts`. Account: [docs/agents-owner-rules.md](agents-owner-rules.md).
- 🔒 **THE PREMIUM MONTHLY CLOSING WEARS ITS OWN EXECUTIVE LOOK — owner 2026-09-08, asked and answered: *"yes, keep the design, pin it with a test."*** He approved a redesign as the standing identity of this workbook after being told it departs from THREE of his locked rules: **rounded buttons** (square-edge), **filled navy bands** (the ink rule), and a navy that is **not** one of the four logo blues (house palette). None of the three reaches this export. Third instance of the payroll/weekly shape — a sweep that "finishes the job" here reverses him. Pinned by `tests/closing-executive-look.test.ts`. ⚠ The approved reference file itself CANNOT be opened by Excel, so it is a spec, never a template. Account: [docs/agents-owner-rules.md](agents-owner-rules.md).
- 🔒 **THE OLD MONTHLY CLOSING EXPORT IS FROZEN — every new closing feature ships BESIDE it.** Owner: *"The old monthly closing sheet don't mess it. Anything we will do will be aside it."* Route, workbook, sheet set, layout and the black **Export XLSX** button — no restyle, no refactor. It is the auditor's file. New capability goes in the **premium** export. The one shared thing is `runExport`, pinned by `tests/sos-ui-truth.test.ts`. `the-old-monthly-closing-export-is-never-touched`
- 🔒 **The premium closing workbook FILLS the `.xlsm` engine — it never rebuilds one.** The engine is two Excel Tables plus `PickList`, driving 3 pivots **by table name**, 2 slicers and 120 INDEX/MATCH formulas. **Never round-trip the workbook through ExcelJS** — loading and re-saving silently destroys the pivots, slicers, tables and VBA. Rewrite the data parts inside the zip. Ship the template **EMPTY**: a filler that skips a sheet hands someone another line's real numbers under the right heading. `premium-closing-export-fills-the-xlsm-engine-never-rebuilds-it`
- **Every weekly report and export MUST set `excludeUnmapped`** — an unmapped SKU double-counts against the real product. **An export must MATCH the screen**: never drop a sheet or column silently because it cannot be filtered — label it instead. The Weekly **Summarized Report's LAYOUT AND SCOPE are locked; its INK is not, since 2026-09-05** — the owner lifted the restyle half himself and it now wears the house identity like every sibling. Do not move a column, a row, a sheet or a formula.
- **The system FLAGS an expense; it NEVER auto-rejects one.** **Never auto-publish a deductions month** and never approve a batch on your own initiative — CRM-derived detections run ~80% accurate, so it is always recommend, he confirms, then publish. **A same-day check against the CRM reads zero** because visits are entered through and after the working day — never report that as a measured zero.
- **CRM visit types `-5` (Public Holiday) and `-6` (Casual Leave) are WORKING days, never absence.** `-4` is the only real leave type, and only **FWC** reaches salary.
- **The Ready-sheet >25th full-pay waiver is for genuine RESIGNATIONS only** — terminated and inactive leavers stay prorated with zero allowances. **A regional employee travelling TO Cairo earns no outstation per-diem** (live — do not undo). **DSM and Medical Rep titles auto-provision their real role**, and the title-governance guard was DELIBERATELY relaxed for those two.
- **Social-insurance Form 1 prints exactly as the Authority issues it** — page 2 carries nothing Phoenix wrote, and the whole form is duplex.
- **The organogram XLSX carries a Mobile column**, by his explicit override of the work-fields-only export rule. Fetched at export time: do not remove it.
- **The public Territory Management preview link must NEVER display or offer the line** — pinned to Pedia server-side. **The organogram CHART and the employee detail popup read two different sources**, so a per-person field on the chart means editing the seat report's select. **The one-press WhatsApp button STAYS on the CEO and NSM rows** — he was asked directly and said keep it.
- 🔴 **The CEO is NOT a district, and a picker is never wider than its viewer.** An org walk that climbs to `AA` presents the whole board's scope as the CEO's own doctor panel, and a cached company-wide filter tree offered a Medical Rep the names of all ~73 reps. **The damage is an EMPTY board**, which reads as "you covered nothing" rather than as a bug. Pass the viewer's scope to the PICKER as well as the query. `the-ceo-is-not-a-district-and-a-picker-is-not-wider-than-its-viewer`
- 🔒 **SCOPE RUNS DOWNWARD ONLY — an employee never sees his own manager, nor anyone at or above his own RANK.** Owner 2026-09-04, twice. A `line` basis is line MEMBERSHIP, which carries no direction, so it put a rep's own manager inside his 57-person scope and **nothing rendered her but accident** — so the stop lives in `resolveDoctorCoverageScope`, never in whichever board remembers to filter. **TWO cuts: the management chain (identity-based, title-BLIND) and a SEAT-RANK ladder — strictly BELOW the viewer, so a DSM is out for a PM and in for an NSM.** A flat blocklist of DSM/RSM/peer-PM cannot express that and would hand an NSM the module's EMPTY STATE, which reads as a data fault; for the same reason **the viewer is never excluded from his own scope.** **An UNRANKED title is excluded** — 12 head-office seats carry a `line_id`, the CEO among them. Ladder applies to the `line` basis ONLY. `scope-runs-downward-only-never-your-own-manager` **Recruitment too: a DM never receives a DM CV** — folders and push. `a-dm-never-receives-a-dm-cv`
- 🔴 **An NSM's outstation expense is NEVER held** — *"once submitted, once accepted."* **NSM only** — it does not extend to the three photo-waived roles. `nsm-outstation-expense-is-never-held`
- 🔴 **An NSM's SAME-DAY RETURN outstation allowance is 300.** Owner rule. So a legacy `outstation_expenses` row carrying `allowance = 300` against a SMALLER `total` has the TOTAL wrong, and the fix is to raise the total. **Never reconcile it the other way** — trimming the allowance to make the components add up is the move arithmetic suggests, and it silently UNDERPAYS him.
- 🔴 **The mailbox-monitor app-password entry is `imap`, never "Phoenix" — and never the `___` this replaced on 2026-09-07, which Yahoo/Turbify REFUSES.** Neutral is the point; the monitor UI must never print the word Phoenix in that instruction. `mailbox-monitor-app-password-entry-is-three-underscores-never-phoenix`
- 🔒 **Turbify CANNOT issue app passwords centrally — the owner is STAYING, so do not re-pitch a migration.** There is no API and never was. Employee mailboxes are **unmonitorable at scale**, and it is SETTLED — costed at ~$420/month for 60 seats, answered *"NO LEAVE ME AS I AM NOW."* `turbify-cannot-issue-app-passwords-centrally-owner-stays`
- 🔴 **A password reset does NOT revoke a Turbify mailbox — the app passwords survive it.** It locks the WEB mailbox only; every phone and Outlook client keeps sending and receiving company mail, and the control panel shows nothing wrong. **Both steps are required** — reset AND delete the app passwords, or delete/suspend the mailbox. Never tell the owner (or write in a UI) that a reset closes a leaver's mail access. Tracked in `public.mailbox_offboarding_tasks`, where a row is an **attestation**, never an observation. `a-password-reset-does-not-revoke-a-turbify-mailbox`
- **Four sales-attribution facts that silently change a number.** EZ `1011654` splits EVENLY across Cairo+Giza CNS with the roster FROZEN per month; the closing reads the DISTRIBUTOR-PRODUCT rollup, so `fact_rollup` alone is INVISIBLE; a case-duplicate `line_area_map` row DOUBLED a whole line; and in the owner's sheets "Stores" means `Office` while "UPA" is a channel. `ez-is-credited-evenly-across-cairo-giza-cns-reps` · `closing-reads-distributor-product-rollup-not-fact-rollup` · `a-case-duplicate-line-map-row-doubled-a-whole-line` · `owner-sheet-vocabulary-stores-is-office-upa-is-a-channel`
- 🔒 **THE DIRECT-ORDER MONTH GOLDEN RULE — the month Finance books is the month the order COUNTS, at that pharmacy's own brick and area.** Owner 2026-09-05, *"never forget it"*: the system's direct orders REPLACED the Excel-uploaded ones, so `DirectReq` (2026-08 onward) is the live vintage and blank-area `DIRECT` rows (2026-02..06, `area_code` is an EMPTY STRING, not null) are the retired one — never a defect to repair. **Already honoured end to end; verify before "fixing" anything.** The trap is that the closing is a TWO-PART composition: `phx_closing_distributor_product` (invoice lines, which exclude direct ON PURPOSE) **plus** `phx_monthly_closing_direct` (the direct half, folded onto the row's own area). Quoting the distributor rollup ALONE understates the month and reads as the owner's manual sheet being wrong — that mistake was made and delivered — while flipping its `not is_direct` DOUBLE-COUNTS. **`setDirectOrderSalesMonth` refuses a booking into a LOCKED period rather than saving the month and losing the sales** — the guard, not the database error, is what keeps the two halves together. `direct-orders-are-counted-in-the-month-finance-books-them`
- 🔴 **NOT every distributor uploads every month — "N of 17 missing" is never a finding.** Owner 2026-09-04: only the big feeds are monthly (Ibn Sina, overseas/PS, epda, EGD); the rest send when they send, and files land across the FIRST TWO WEEKS, so a thin count in week one is mid-collection, NEVER lateness. **Measure the EVERY-MONTH set** — the distributors present in every prior month, then ask which of THOSE are absent — and never read a STOPPED feed (`chimipharm`, `EPDA-BULK`) as an outstanding one. Import value and closing value are NOT comparable: Head Office is absent from both trackings. `not-every-distributor-uploads-every-month`
- 🔴 **IS-S 2026-04 and 2026-05 ARE THE SAME FILE, this is KNOWN, and the owner is LEAVING IT — do not "repair" it.** Both batches are one 1,141-row, 349,266.46 EGP file whose own name is timestamped June; March and June are distinct, which is why the pair stands out. So **one month is counted twice and the other was never loaded.** **Owner's decision 2026-09-05: leave BOTH pending, he is checking with Ibn Sina.** Do NOT void either batch, do NOT re-run the import, do NOT pick the likelier month — **the evidence that would settle it is gone**, because the legacy commit route erased the invoice date on 126,321 rows across 2026-04..06. **Quoting IS-S for 2026-04 or 2026-05 quotes a doubled figure** — say so rather than reporting either month clean. A future upload of that same file is refused at the confirm step (`import-duplicate-guard.ts`), which does NOT touch the two rows already there.

## `AGENTS.md` §4.1 Marketing customer, venue and licence validation — as it stood before the 2026-09-12 condensation

On 2026-09-12 `AGENTS.md` was cut to roughly half its size at the owner's request ("Load less of AGENTS.md"): every hook was reduced to its rule plus the one detail needed to obey it. This is that section's hook text **verbatim** from `origin/main` 3eea44aef, kept so that no measurement, date, count or diagnosis a condensed hook dropped is lost. Search it for the hook's wording. The accounts earlier in this file remain the fuller record.

Full account: **[docs/agents-owner-rules.md](agents-owner-rules.md) §4.1**.

- 🔒 **Venue validation is GPS + a live picture ALWAYS — and leg 3 (the registered code, else the licence) is a PHARMACY rule ONLY.** Owner rule, since amended. A venue outside the pharmacy trade is judged by no route at all — `resolveVenueIdentityRoute` answers **`admin`**, never `none`. **Do not over-apply it:** a codeless PHARMACY is still refused, and the code route stays closed to a nursery. The licence is a **fallback identity route**, never evidence in its own right. Direct-order desk only, **not** marketing. **`nursery` is the venue type for ANY venue with no distributor account, and that is the OWNER'S OWN FILING** — a clinic filed as a nursery is **correct, not a data-quality defect**.
- 🔴 **Marketing pharmacies are TERRITORIAL, and a NULL `area_id` makes one invisible.** **Owner rule: the REGISTERED CODE beats live GPS.**
- 🔴 **A licence verdict is PERMANENT and has no correction path.** Write-once at approval — not even a Super Admin can correct a wrong one, and it is then displayed indefinitely. **Ask the owner before the first one is recorded.**
- 🔴 **`system_validated` means NO HUMAN LOOKED.** The screen is **Super Admin only** — not SFE.
- 🔴 **A venue's evidence was WRITE-ONCE, writable only at insert** — now fixed. **AREA governs both sight and reuse; never backfill ownership.**
- 🔴 **The badge read a FROZEN note, never the live evidence.** EITHER half reaching `complete` clears it.
- 🔴 **A duplicate merge STRANDS the desk validation on the retired row.** Repair it with hand SQL, not code.
- 🔴 **The screen that SHOWS a badge is not the screen a rep can OPEN.** Check the gate before wiring any `actionUrl`.

### 🔴 The `Next step:` box holds words CLAUDE can act on — never his own physical act, never a message to a person

Relocated from `AGENTS.md` §4 on 2026-09-29, when the hook crossed the 1,200-byte line the
auto-loaded-footprint check draws. The cue stays there; this is the account.

**The rule.** The quoted words at the end of a `Next step:` line are a **message he sends to
Claude**. The prompt-suggestion box offers them as ghost text, so whatever is quoted is what lands
in Claude's next turn. "Could he send this as-is?" is therefore not the test — *"can Claude act on
it once sent?"* is.

**Failure one: a physical act.** Measured **2026-09-28, four times in one evening**:
`press edit beside app file` (opens a Windows file picker), `open the managed play page`,
`upload the versionCode 4 aab`, and `factory reset PHX-TAB-0002 and scan the config 3 QR` — the last
for a tablet physically in his hands. Each came back verbatim as his next message, and each turn was
spent explaining that Claude has no hands.

**Failure two: a message to a person, which is the easier one to walk into.** Measured **2026-09-29,
three times in one session — in a session that had this rule loaded**:
`tell HR to start scanning the hiring documents`, then `tell HR to work the pedia checklist first`
**twice**. It passes every check the first failure fails: it is a real next action, it genuinely
needs him, and it is unambiguously his call. What it is not is executable — nothing outbound reaches
staff from a business system on Claude's own say-so (§4, and the standing ban on bulk or test sends),
so the ghost text hands Claude an order it must refuse, and the reply is one more copy of a draft he
already has.

**Why the second one repeats.** The first failure announces itself — "press", "scan", "upload" are
visibly physical. The second reads exactly like the decisions the box is *for*. The only thing
separating `tell HR to work the pedia checklist first` from `merge 4729 when green` is who performs
it, and that distinction is invisible in the words.

**How to apply.** Drafting the message is Claude's work and belongs in the prose, in full, ready to
paste. Sending it is his and belongs nowhere in the box. When the bottleneck is his hands or his
phone, say so plainly in the prose with the exact path, and quote something Claude can act on: the
instruction that FOLLOWS the physical act, a merge, a build Claude fires, or the next change in the
thread. Memory: `never-put-his-physical-actions-in-the-next-step-box`.
