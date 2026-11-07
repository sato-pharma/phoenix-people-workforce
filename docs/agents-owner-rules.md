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
  `runDoctorCoverageScopeTests` in the required CI `validate` job, including a runtime assertion
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

### 🔒 The one form design — every form in the system wears the ADR wizard's skin

Owner rule, **2026-10-06**: *"sweep the system wide everywhere admin or emp any form or any thing
applicable make it follow this form design"*, sent with a screenshot of the **Adverse Drug Reaction
Report** wizard in the admin shell. The hook is in [AGENTS.md](../AGENTS.md) §4, "How to build".
This is the account.

**The design he pointed at.** `src/components/report-it/report-it-form.tsx` — square corners, a
hairline `slate-300` border on white, a 40px field with `px-3`, an orange focus border and ring,
micro-caps `text-phx-xs font-black uppercase` labels in `slate-500`, a rose required star, a
numbered left rail with an orange marker, a thin orange progress bar, a near-black **Next** and an
orange **Submit**. Orange is the only accent; rose means a problem; nothing else appears.

**Why it was a sweep and not a restyle.** Before this, the look lived nowhere, and the spread is
measurable from the branch's own diff: **234 files painted their own box, in 621 class strings**, and
no two agreed — **five field heights** (`h-8` through `h-12`), **twelve corner radii** (`rounded`,
`-sm`, `-md`, `-lg`, `-xl`, `-2xl`, `-full`, `-r`, and the hand-written `[5px]`, `[6px]`, `[8px]`,
`[14px]`), **twenty different focus border colours** and **thirty-one different focus rings**. Every
new form copied whichever neighbour the session happened to open. A restyle of one screen would have
changed one screen; **282 files now import the tokens instead.**

**Where it lives now.** `src/components/ui/form-tokens.ts` holds the class strings (plain strings,
no `cn()`, no `"use client"` — so a server component can import them) and
`src/components/ui/form-kit.tsx` holds the components built from them: `FormField`, `FieldLabel`,
`FormGrid`, `FormBlock`, `CheckTile`, `FormError`, `FormActions`, `FormStepHeading`, `FormProgress`
and `FormWizard` — the whole multi-step shell, header and rail and footer, lifted out of the ADR
form so every wizard renders the shell he approved. **The ADR form now consumes the kit**, which is
what makes "change the token and the system follows" true rather than aspirational.

**The measured reach of the sweep.** 1,485 real form controls in `src/components` and `app`
(checkboxes, radios, file pickers and hidden inputs excluded — they are not fields), counting the
wrapper components (`<Input>`, `<Textarea>`, `<SearchableSelect>`) as the controls they render.
After it: **1,171 reach a shared token** — directly, through a local constant now pointed at one, or
through an imported alias — and **none paint a box of their own.** The remaining ~314 paint nothing
at all: they are chromeless inline editors (`bg-transparent`, no real border — the command palette,
the grouped combobox, the in-table name editors, the email template designer's title, the company
e-mail field inside its own bordered wrapper) that take their box from a parent, plus the
printed-document editors under `src/components/hiring-pack/` and `src/components/offers/`, which
follow the **house document identity** instead and are exempt by that rule, not by neglect.

**Two heights are kept on purpose — and that is HIS ruling, not the sweep's judgement.** Asked
directly on 2026-10-06 whether the ~200 dense table and filter controls should be forced to the
design's 40px, he answered *"keep h-8 and h-9 on the dense table filters"*. So `h-8` and `h-9` on a
dense table or filter control STAY, like the icon padding below — **never "bring them into line"
later, and never raise it with him again.** Everything at `h-10` or taller became exactly the
design's 40px.

**Fifteen things the codemod got wrong, and every one is a trap worth keeping.**

1. 🔴 **Dropping a field's `pl-9` puts the magnifier on top of the text.** Side padding *larger*
   than the token's own `px-3` is icon clearance, not skin — the first pass treated every `p*-`
   utility as paint and silently broke ~45 search boxes. The rule now keeps `p[lrse]-4` and above
   and drops only what the token already provides.
2. 🔴 **A regex that ends a JSX tag at the first `>` ends it inside `(e) => …`.** That truncates the
   attribute list before `className` on exactly the controls that carry a handler — i.e. most of
   them — so the sweep skipped them *and* the audit afterwards reported them as "built at runtime",
   which reads as "nothing more to do". It cost a full re-run: 362 controls on the broken scan
   against 466 on a brace-aware one. The same shape as every other fail-open in this repo — an
   ABSENT answer arriving dressed as a NEGATIVE one.
3. 🔴 **The first ratchet passed with 376 painted controls still in the tree.** It read only
   bare `<input>`/`<select>`/`<textarea>` tags with a STATIC className, so it missed the wrapper
   components entirely, missed constants named in another style (`FIELD_CLASS`, `SELECT_CLASS`,
   `CONTROL`, `cell`), and counted any className that was a *reference* as on-design without ever
   following it. 376 of 1,485 controls were still painting, and `ui/searchable-select.tsx` sat
   inside that blind spot: its own
   `rounded-[6px] border-phx-line h-9` was a square-edge breach in a primitive the whole app
   renders, and every one of its ~150 call sites inherited it outside the admin shell, which does
   not reset a radius in the employee portal. A guard that resolves the reference is the only kind
   worth having.
4. 🔴 **This repo's comments quote JSX, and a codemod that cannot see a comment writes into the
   prose.** `select-field.tsx` says *"A labeled `<select>` with a custom chevron"*;
   `kpis-period-picker.tsx` says *"a native `<select>` is the one control it names as
   unshrinkable"*; `device-register-workspace.tsx` says it inside a `{/* … */}` block. An unmasked
   scan read 26 of those as controls carrying no className — which is exactly the shape that
   invites a codemod to ADD one. A per-character comment mask comes first, always.
5. 🔴 **An inserted import above `"use client"` is a BUILD failure that lint and typecheck both
   pass.** The import inserter's "this file has no imports yet" fallback wrote at line 1, and
   `interview-calendar/org-fields.tsx` has nothing above the directive. `remote-check all` reported
   `lint PASS`, `typecheck PASS`, the whole unit suite green, and then
   `Ecmascript file had an error … org-fields.tsx:2:1` — so two of the three cheap gates said the
   change was fine. **Only the build catches it, which is why such a sweep must BUILD before it
   merges** — a pull request never builds by itself (owner, 2026-11-05: "Yes, skip the PR build"), so
   run `remote-check all` on it before asking for the merge.
6. 🔴 **A chromeless control must not be GIVEN the token.** 24 controls paint no box by design —
   `border-0`/`bg-transparent` inside a wrapper that carries the border and the `focus-within`
   ring. The sweep's keep-list held `bg-transparent` but still *prepended* the token, which paints
   a second border inside the first. Detectable afterwards precisely because `bg-transparent`
   survives the strip; reverted by that signal.
7. 🔴 **A TEMPLATE LITERAL GETS NO TAILWIND-MERGE, SO THE OVERRIDE SILENTLY LOSES.** 177 of the
   constants the sweep wrote were `` `${phxSelectClassName} h-9 px-2` `` — which puts BOTH the token's
   `h-10` and the caller's `h-9` into one class attribute with nothing to resolve them, because
   `cn()` is tailwind-merge and a template is string concatenation. The winner is then whichever
   utility Tailwind emitted later in the stylesheet, which on a numeric scale is the LARGER one: a
   caller asking for a 36px dense field rendered a 40px one. **It is the same shape as the
   `text-phx-*` defect of 2026-08-28** — present in the source, absent from the DOM, invisible to
   lint, to typecheck and to any test that reads classes. `cn(token, "h-9 px-2")` resolves it, and
   part 4 of the guard now refuses the template form outright. A tail that conflicts with nothing
   the token sets (`cursor-pointer`, `font-mono`, `tabular-nums`) may stay a template.
8. 🔴 **A GUARD THAT MANDATES `cn()` MUST ALSO RESOLVE `cn()`.** Converting those 177 made the
   resolver stop following exactly the form it had just required, and the measured reach fell from
   1,171 to 668 with nothing having changed on screen — a number that, left unread, would have gone
   into the PR as the truth.

9. 🔴 **THE TOKEN'S `text-sm` IS 14px, AND iOS SAFARI ZOOMS THE WHOLE VIEWPORT WHEN IT
   FOCUSES A FIELD UNDER 16px.** One screen had already been fixed for that — the approvals-hub
   decision box, `src/components/approvals-hub/decision-actions.tsx`, the screen where money moves
   — carrying `text-base … md:text-sm` so it is 16px on a phone and the design's 14px from `md`
   up. The sweep flattened it to the bare token and the iOS guard went with it. **The whole unit
   suite on the box is what caught it**, by its own named assertion in
   `tests/direct-orders-approval-window-mobile.test.ts` — *"the reason box must be 16px on mobile,
   or iOS Safari zooms the viewport when it is focused"* — and lint, typecheck and the build all
   passed the same commit. It is now `cn(phxTextareaClassName, "text-base md:text-sm")`, and the
   assertion pins the composition instead of the old contiguous literal, in both halves, so
   removing either the 16px step or the token's orange focus pair still fires. **Measured across
   the whole branch: exactly ONE call site had that pair, so this is a one-screen exception and not
   a reason to change the token** — the design he pointed at is 14px, and changing it system-wide
   would be a redesign of his own screen.

10. 🔴 **LIFTING A SHELL INTO A SHARED KIT MOVES THE REFERENCE A SIBLING'S TEST MEASURES
    AGAINST.** `tests/phoenix-crm-step-form.test.ts` pins the Phoenix CRM step form to Report It's
    own five class strings — the progress bar, the orange step bar, the 244px rail column, the
    large step number, the eyebrow — by asserting BOTH files carry them, with the message *"the
    reference moved"* on the first half. Making Report It consume `form-kit.tsx` moved all five out
    of it, byte-identical, so the first half fired exactly as designed while the screen itself did
    not change by a pixel. The reference is now the kit, and a second assertion requires Report It
    to still RENDER `<FormWizard` — otherwise the kit this test measures against could drift away
    from the screen the owner pointed at. Both halves verified by breaking them. **The lesson is
    the general one: a sweep that centralises a look has to re-point every test that pinned the old
    home, and the test that says "the reference moved" is doing its job, not blocking you.** The
    whole-suite consequence is real — `run-tests.ts` stops at the first throw, so each box round
    buys exactly one of these; the cheap way to find the rest is to list every test that reads a
    file the branch changed and name a literal the branch removed (that sweep returned 0 after
    these two, which is what let the branch go out).

11. 🔴 **THE DARK AUTH SCREENS ARE NOT THE FORM DESIGN, AND HALF-CONVERTING THE FRONT DOOR
    IS WORSE THAN EITHER ANSWER.** `auth/premium-login-page.tsx` and `auth/password-setup-form.tsx`
    are a deliberate dark glass identity — `border-white/14`, `bg-white/[0.045]`, white text, the
    brand's own `#ff7900` focus ring, at `h-12`/`h-14` and `text-base`. The sweep handed them the
    light token, so the login fields became white boxes on a dark panel — **on the screen every
    employee meets first** — and inconsistently: one of the login page's two fields kept its dark
    overrides and the other did not. Both files are restored byte for byte and
    `src/components/auth/` joins the guard's exemption list beside the printed-document editors.
    🔴 **And the login screen staying out is HIS OWN RULING, not the sweep's judgement.** Asked
    directly whether the front door should wear the form design too, he answered *"keep the login
    screen out of the form design"* (2026-10-06) — so `src/components/auth/` is never brought into
    line later, and he is never asked again.

    🔴 **AND EVERY OTHER DARK GROUND IS HIS RULING TOO, NOT THE SWEEP'S.** Five more
    controls had been handed the light token on a dark panel and were restored byte for byte on the
    sweep's own judgement: the two admin layout menus, the black admin sidebar's search box
    (`ADMIN_SIDEBAR_BG` is a bare `bg-[#000000]`), the weekly Field Force band, and the weekly
    distributor column editor's near-black select (`bg-[#020617]`). Told plainly that those five
    were a session's call rather than his, he answered *"keep the dark menus and bands out of the
    form design too"* (2026-10-06). **So a dark ground is exempt BY HIS DECISION: the light token is
    never prepended to a control sitting on one, no dark control is converted later, and he is never
    asked again.** The practical trap underneath it is that two of those grounds are arbitrary hex,
    so a sweep looking for colour NAMES (`bg-slate-900`, `bg-black`) cannot see them at all — read
    the ground a control sits on from its container, never from its own class string.
12. 🔴 **FILTERING A SCAN'S GENERIC MATCHES TO KILL FALSE POSITIVES KILLS THE REAL ONE TOO.**
    After the first box failure, the cheap way to find the rest was to list every test that reads a
    file this branch changed and names a class literal the branch removed. The first pass returned
    21 hits, nearly all noise like `border-slate-200`, so the generic fragments were filtered out
    — and `text-base` is generic. The scan then reported **0 remaining** while
    `tests/portal-rep-kpi-month.test.ts` was already red on the box. What actually finds this class
    of defect is a diff, not a scan of assertions: for every swept file, count a functional class in
    `origin/main`'s copy and in the branch's, and read every file where the count went DOWN. Four
    files had dropped a deliberate `text-base`; three of them mattered.

13. 🔴 **A DENSE SIZE CAN BE PINNED BY A TEST THAT EXISTS BECAUSE MONEY IS APPROVED THERE.**
    The outstation expense review's approved-amount field is `h-8 w-28 … text-xs`, and
    `tests/expense-review-row-height.test.ts` pins that exact string with the words *"the controls
    are moved, never reshaped"* — it was written after an earlier attempt to shorten that row
    reached for the controls themselves. The sweep took it to the design's 40px and the guard fired
    on its own message, *"no size reduction on a money field"*. **Restore the string, exempt the
    file — never relax the assertion to let a sweep through**, which is the one move that would
    have turned a red test into a shipped change on an approvals screen.
14. 🔴 **A SHORT className ON A WRAPPER COMPONENT IS NOT A HALF-STRIP, AND READING IT AS ONE
    COSTS A REAL REGRESSION.** Two portal planning-calendar controls read
    `className="w-full px-3 ring-1 ring-transparent"` where `origin/main` had a full grey-filled
    skin, which looks exactly like a control the codemod stripped and never gave the token. They
    are `<SearchableSelect>`, and the primitive does `cn(cn(phxSelectClassName, "pr-9"), className)`
    — so the token IS there and the caller's classes merge over it. "Restoring" the fill painted a
    grey box over the design, and a guard was half-built on the misreading before the element was
    read. **Read the TAG before judging a className: `<Input>`, `<Textarea>` and
    `<SearchableSelect>` carry the token themselves, and a raw `<input>`/`<select>`/`<textarea>`
    is the only one that must name its own ground.**

**What holds it.** `tests/form-design-system.test.ts`, in the required `validate` job. It pins the
identity (no radius on any token, `h-10`, the orange focus pair, the micro-caps label, and a palette
assertion that allows exactly slate + orange + rose), it asserts the ADR form still imports the kit
and renders `FormWizard`, and it carries a **ratchet at ZERO**: no control anywhere may paint its
own box. The ratchet masks comments, resolves a className through the file's own constants and
through an imported alias, and counts the wrappers — the three gaps that let its first version pass
on a tree with 376 painted controls in it. It also asserts its own scan still FINDS ~1,485 controls
and that ~1,171 still reach a token, because a cap of zero would otherwise pass on a scan that had
quietly stopped finding anything. **Never raise the cap** — a number above zero is a form that did
not use the kit, which is the only thing this guard exists to catch.

15. 🔴 **AN `EXEMPT` LIST STOPS A RATCHET COUNTING A FILE — IT DOES NOT KEEP THE FILE'S
    CONTROL DARK, AND THE SHIPPED BRANCH PROVED IT.** The five dark grounds were restored and
    their files added to `EXEMPT` in `tests/form-design-system.test.ts`; four of them survived,
    and the admin sidebar's module search did not. It shipped in #5382 as
    `cn(phxFieldClassName, "pl-9 pr-8")` — a lit white box inside a bare `bg-[#000000]` sidebar,
    on the chrome of every admin page — because exempting the FILE made the guard look away from
    exactly the control that needed watching. Restored to its pre-sweep string verbatim
    (`border-white/10 bg-white/5 … text-slate-100`, `h-9`) and now pinned by `DARK_GROUND_KEEPS`,
    which asserts the fragment that MAKES each of the six dark controls dark. **An exemption is
    the absence of a rule; his ruling needed the presence of one.**

    **And the audit that found it is the one to repeat, because a file list cannot answer this.**
    All 283 files that import a form token were scanned for a control whose enclosing container
    carries a dark ground: 33 candidates, of which 23 re-declare a light ground below a dark
    HEADER STRIP (the Phoenix card identity — dark title band, white body) and were resolved
    mechanically, and 10 were read by hand. Nine were light bodies or a dark BUTTON caught by the
    same pattern. The tenth, the payroll copilot's sheet search, does sit inside a `bg-slate-900`
    band — and was a deliberate white box there BEFORE the sweep too, so it is his design, not a
    dark ground the sweep lost. **The sidebar was the only real loss.** The lesson for the next
    sweep: a dark ground 40 lines up is usually a header strip, so resolve on whether a LIGHT
    ground is re-declared between it and the control — and compare against the pre-sweep file
    before calling a white control on a dark band a defect.

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
[#3068](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/3068), live as `28fb7a40d`.

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
the required CI `validate` job.

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
   required CI `validate` job, so breaking it turns a PR red.

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
just going red. Both run in the required CI `validate` job.

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

`tests/qema-warehouse-split.test.ts`, in the required CI `validate` job, plus the neighbouring
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
these workbooks, and runs in the required CI `validate` job, so the sweep goes red instead of
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
- 🔴 **THE ONE DM CHAIN WITH A REAL SECOND STAGE — the DMs reporting to Hany Saad (`PD-0001`): submit → Hany → Ali Mohamed Ali Elsayed (`A-12`, NSM) → HR auto-acknowledge.** Owner 2026-09-20, with Ali able to read those DMs' plans at every status and period, history included. It is policy data in `src/lib/workforce/plan-second-approver.ts` (re-exported by `src/lib/weekly-planning/second-approver.ts`; the district manager's Phoenix CRM week reads the same entry), keyed by the MANAGER (add another manager there, never compare ids inline). No migration: the stage rides `manager_approved → final_approved` (the `ceo_approve/return/reject` actions), and the decide RPC never checks the actor, so the application gates it on Ali's IDENTITY (`assertSecondApprover`), not on `weekly_plans:approve`. The manager stage no longer passes `p_bypass_ceo` for these plans, so a Hany-DM plan cannot skip Ali; the CEO has NO turn on them (his pending count and export exclude them). The header's `ceo_decision_*` columns then hold ALI's real decision (`resolvePlanCeoDecision` shows it only when he wrote it). Every OTHER DM plan is unchanged — the rule above stands. Pinned by `tests/dm-plan-second-approver.test.ts`.

### AGENTS.md §4, line 397 as it stood on 2026-09-07

- 🔴 **A PUBLISHED AND ANNOUNCED MONTH IS NEVER CORRECTED, however wrong it is.** Owner 2026-09-07, refusing a fix that was measured, line-neutral and required by *his own* earlier ruling: *"donot fix any already published an announced month implement this to be considered in the upcomings."* So the trigger is PUBLISHED-AND-ANNOUNCED, **not "is the fix justified"** — being able to prove the number wrong is not an exception, and a session that re-derives the justification will reach "we should fix it" every time. A late ruling is a rule for UPCOMING months. `monthly_closing_locks` enforces it on `source_of_sales_import_rows` and `source_of_sales_fact_rollup` (every insert/update/delete, **including migrations and direct SQL**) — **treat a lock as his decision, never an obstacle to route around**; unlocking needs him to say so about that specific month. `never-fix-a-published-and-announced-month`

### AGENTS.md §4, line 398 as it stood on 2026-09-07

- 🔒 **THE CITY RULE ALWAYS WINS — except EZ, Office, and El Qema’s Qalubeya.** Owner 2026-09-07, asked directly whether he wanted to override the even city share for a named customer: he does not. A wholesaler's sales spread evenly across the areas of its OWN city and that is the answer, even when its goods demonstrably left the city. **Do NOT reintroduce a per-customer apportionment override**, and do not read the 441164 (ريونيون) history in git as unfinished work — its hand-split lived in the fact ROWS, a re-import erased it on 2026-08-09, and a live sweep of all 323,952 rows on 2026-09-06 found ZERO re-booked rows, so the route it used matched nothing before it was removed. TWO exemptions survive, and NEITHER is a per-customer override. `evenSplitApplied` (the even-split registry, EZ) is arithmetic not judgement: a customer the DATABASE already distributed must not be distributed twice. **El Qema’s Qalubeya** is keyed by DISTRIBUTOR plus ORIGIN AREA and runs one way — a different axis from the per-customer override this rule forbids, which is why it does not breach it. See its own hook below. **Office needs no entry** — its rows carry no customer, so `isStoreCustomer` is false, and `loadMonthlyClosingPartsWithStoreSplit` passes the `office` grid through unsplit.

### AGENTS.md §4, line 399 as it stood on 2026-09-07

- 🔒 **EL QEMA (`QM`) — its QALUBEYA sales split across Qalubeya PLUS all six Cairo areas. ONE WAY, EL QEMA ONLY.** Owner 2026-09-07, both halves asked and answered: *"one way only, only for el qema"*. A warehouse IN Qalubeya reaches Cairo; a warehouse in Cairo reaches Qalubeya NEVER, and the same Qalubeya warehouse sold through any other distributor does not split at all (Qalubeya is a one-area governorate). **This is why it canNOT live in `AREA_CITY`** — city membership is symmetric, so moving `D11` into "Cairo" would silently start paying Qalubeya a share of every Cairo wholesaler from every distributor, and the drift check would not see it (it compares UNITS; the split preserves them). It lives in `DISTRIBUTOR_SPLIT_TARGETS`, keyed `DISTRIBUTOR|ORIGIN AREA`, pinned by `tests/qema-warehouse-split.test.ts`. The origin keeps its own share — seven areas, not six. **The divisor is AREAS — a vacant seat or NO seat** (*"حتى لو فيها فاكانت"*). **Down town (`CA5`) has no Pedia seat and STAYS IN** — owner 2026-09-07, *"we split in reference to areas not actual reps"*, ruling against his own SIX-way manual sheet. Dropping it reverses that; the test names it.

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
**Attendance › Attendance Review** (`/attendance/weekly-review`), which lists every
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

`tests/weekly-export-design-lock.test.ts` builds the workbook from `sampleDashboard()` — the same fixed
fixture `runWeeklyExportTests` uses, so no data change can move the pin — and compares a design
fingerprint. It runs in the required CI `validate` job.

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

`tests/pedia-upper-egypt-split.test.ts`, in the required CI `validate` job. Its headline assertion is the golden rule itself: August's El Qema distribution built **with** the September rows present is `deepEqual` to August's built **without** them. Proved red by dating the pair to 2026-08-01, the real failure mode.

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

## The EPDA bonus deduction — owner rule, 2026-11-04

His words: *"we will deduct the bonus quantity from each sato items example ivyronc deduct 30% roya and saginkgo deduct 15% if ivyronc sales is 6000 so we consider only 4200 bottle . sure this calculation not for announcment. only we announce the figures after deduction no need to say anything other.only in epda starting oct closing"*, and *"never to put a decimal in units units are always a true number"*.

He settled the rest in answers the same day: Ivyronc 30% (his other example, 100 to 85, was not the rule), only these three products, EPDA-BULK (`EP-BK`) and EPDA-Pharmacies (`EP-PHS`) only, whole numbers made on each area's total.

### The rule

- From the October 2026 closing on: Ivyronc `IV001` loses 30%, Royafloxacin `RO001` and Saginko `SA001` lose 15%. Royanoxicam `RY001` is a different product.
- The value follows the units at the row's own price, so sales, achievement and incentives all carry the deducted figure.
- Nothing announced names the deduction: no note, label or caption. The upload screen alone shows both figures (his answer the same day: "show both actual and reduced"), in its "Actual and reduced" table, because the person uploading has to check the book against the file.
- The rule below this one stands: the sheet's bonus column is still not counted. This is a flat percentage of the book's units, whatever that column holds.

### How it works

`src/lib/sales/import-epda-bonus-deduction.ts` runs when the rows are stored, on both routes into `source_of_sales_import_rows`. A read-time net like the bulk allocation's was rejected: about thirty-five database functions read those rows directly, and any one a net missed would announce the undeducted figure. `raw_row` keeps the sheet's units and a re-upload starts again from the sheet, so changing a percentage means re-uploading that month's two books.

Each area × product total rounds once and its rows take whole shares by largest remainder, so a one-unit pharmacy line can store 0 or 1. EPDA-BULK's Ivyronc is one group across the whole book, because the closing ignores its invoiced area and spreads it by contribution; from October that spread lands whole units too (`wholeUnits` in `contribution-respread.ts`).

## EPDA rule 2 — the EPDA books spread by each product's retail units, owner rule, 2026-11-04

His words, typed: *"okay this was rule number one rule number 2 will be that u will get the total retail sales of every rep without epda bulk or epda-pharmacies then you will distribute the epda sales based on the contribution per area in retail sales but do not forget the 15% and 30% rule then add the direct sales and in exported xlsx sheet you will add a separate column that shows epda sales units"*.

His answers the same day, as multiple choice: the products are **the three Sato items** (Ivyronc, Royafloxacin, Saginko; Lacto Advanced keeps its invoiced area); the share is measured by **the same product's units**; **both books** are spread; and for the column: *"never show that there are reduced units in the xlsx closing sheet, you will add a column per product share for epda after the spread"*, in **all three** downloads (normal closing, premium closing, rep ranking).

### The rule

- From the October 2026 closing on, EPDA-BULK (`EP-BK`) and EPDA-Pharmacies (`EP-PHS`) rows of Ivyronc `IV001` (Pedia), Royafloxacin `RO001` and Saginko `SA001` (Anti Infective) leave their invoiced areas.
- Each product comes back by each area's share of that product's RETAIL units: every other distributor's included, non-confidential rows, the main EPDA book (`EP`) included, never a direct order, and counted as each rep's closing shows it: after the city rule has shared each wholesaler across its city's areas (his answer the same afternoon, asked which retail: "As each rep's closing shows"; `bulkAllocationRows`). Direct is then added on top, as always.
- 🔴 **PHARMACIES ONLY** (owner, 2026-11-04 about 17:00 Cairo: *"in ebd2 rule 2 of the retail exclude stores and put the contribution on pharmacies only"*; asked, he chose **both books** and **hospitals left out**). Only a retail row whose customer is a PHARMACY (`classifyCustomerChannel` = `pharmacy`) and not a store or wholesaler for the month (`isStoreCustomerForPeriod`) counts toward an area's share. Stores, wholesalers and hospitals are no weight at all (`isWeightRow` in `closing-bulk-allocation.ts`, pinned by case 13 of `tests/closing-bulk-allocation.test.ts`).
- 🔴 **UPPER EGYPT 2 IS THE ONE EXCEPTION — PHARMACIES AND STORES** (owner, 2026-11-04 about 18:00 Cairo: *"make upper egypt 2 does not follow the stores rule only upper egypt 2 gets its contribution on retail stores and pharmacies"*). In an area the line's organogram files under Upper Egypt 2 (`UE-2`) for the month, a store's units weigh as well, counted where the city rule credits them; a hospital there still never weighs. Every other region stays pharmacies only. The areas come from the same organogram the city split reads (`regions`, passed by every caller of `buildBulkAllocation`). Pinned by case 14. Measured on October 2026 the day it was made: Anti Infective's Upper Egypt 2 went from 79.1% to 100.1%, every other region gave a little, the line total unchanged at 1,711,454.41 EGP; Pedia did not move.
- Whole units per area. The rows are already reduced by rule 1 (above), so the spread moves reduced units and never deducts twice.
- A product no retail distributor sold that month keeps its invoiced areas.
- September keeps the rule it was published with (EPDA-BULK Ivyronc only, by Pedia value).

### The EPDA tab

Every closing download (the normal closing, admin and portal, the premium closing and the rep ranking) carries a tab named `EPDA` from October: region and area rows, one "<product> EPDA units" column per product, a total per column and never across products. It is drawn from one module, `src/lib/sales/closing-epda-sheet.ts`, fed by `epdaUnits` from `loadClosingStoreSplit` (the IN legs of the whole month's spread), and drawn on each reader's own scoped matrix. Nothing on it names a deduction, a bonus or a percentage. It is a tab rather than a column inside the matrix because the premium engine's matrix is a fixed template. A product with no retail sales that month was not spread, and the tab shows its units on the areas it stayed on, so the tab always holds every EPDA unit the closing holds.

### The rows a reader sees carry the same spread

`applyCreditedAreaView` (`closing-main-stores.ts`) splits each moved EPDA row into one share per receiving area, by that area's part of the product's spread, so the Details tab and every scoped portal file (rebuilt from those rows by `buildPortalClosingWorkbook`) put each area's EPDA units where the matrix does. Without it a District Manager's file disagreed with his screen by his whole EPDA share. The closing's own spread reads the raw rows (system access, source revealed), never this view, so it is never applied twice. Pinned by case 12 of `tests/closing-bulk-allocation.test.ts`.

### The rep ranking's channel columns

`carveChannelsByArea` (`closing-rep-ranking.ts`) never counts a spread EPDA row as Stores at its invoiced area. The matrix has already moved it, so a Stores figure there would drive that area's Distributor column below zero and inflate every receiving area's. Left out of Stores, the spread units read as distributor book wherever they landed. Pinned by `assertSpreadEpdaRowsAreNotStores` in `tests/closing-rep-ranking.test.ts`.

### After the deploy

`au.monthly_store_split_net` (what attribution and incentives read) is rewritten by every upload and by the publish gate, so October corrects itself on the next upload; run the period refresh once after the deploy anyway (`writeStoreSplitNetForPeriods` for 2026-10, then `phx_refresh_attribution_for_period`), so Anti Infective's attribution does not wait for one.

### Known residual

Rule 1 rounds each invoiced area's total once (his words: "rounding per area total"), and rule 2 then pools those totals, so a book can carry a few units more than one whole-book rounding. October, measured: Saginko 3,002 against 3,528 × 85% = 2,999; Royafloxacin 2,952 against 2,949.5; Pharmacies Ivyronc 212 against 211.4. Bulk Ivyronc is rounded as one book, 3,190. Changing it means changing rule 1, which is his call.

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
   knowingly, and is recorded here so no later session reads it as drift. **Narrowed again on
   2026-10-02** (see "Three visibility rulings" below): the POSITION cases and the phone's own
   mock-location answer went back to the Super Admin alone; SFE keeps the photo cases and the behaviour
   months.

### What it does not license

It is not a reason to hide a genuine refusal. If a save is rejected because a required field is
missing, the rep is told plainly what to do — silence about *checks* is never silence about *his own
work failing*. And thresholds stay set so an honest rep cannot trip them: a false positive accuses a
real person of fraud, which is worse than a missed catch.

### A field his browser receives counts as shown — audit, 2026-10-02

The screens already drew no measurement of the rep, and that was not enough. A field in the JSON his
phone receives is one network tab from being read and one careless render from being drawn, so the
SERVER decides, never the screen. `team.ts` cleared `locationFlag` on the rep's own row that
morning; the Phoenix CRM audit of the same day (against `f14fd8834`) found the same shape in five
more places, each hidden only by its screen, and all five are closed in one PR:

1. **The Visits report** carried `farVisits` in every row, day and total for a rep reading his own
   seat — the tab is open to him, and only `reports-tab.tsx` withheld the words.
2. **The List** carried every place measurement — the phone-clock verdict, the accuracy, both raw
   readings, where the fixed point came from, the SFE's or the Super Admin's **written reason** for
   moving it, the brick distance — and the weak-signal threshold.
3. **The visit form** carried the far and weak-signal thresholds, which nothing on it draws.
4. **An ACTING District Manager who still holds a rep seat** read his OWN seat's distances in the
   team-only sections — the place-vs-actual report, the far counts and the tracking spacing note —
   because `readsTeamReports` is true for anyone holding a manager seat, while every visit screen
   already blinded him on that seat.
5. **The day page** never asked gate one (`canAccess(…, "phoenix_crm", "read")`), so a per-account
   module lock did not close it; nor did the integrity and duplicates pages ask it.

### Three visibility rulings — owner, 2026-10-02

Put to him by the Phoenix CRM audit session the same evening, each with a recommended answer. He took
the recommended answers there (a fourth, a rep sending his running week late, shipped separately), and
confirmed in the session that built these three — answering "Add all three here" — that they belong in
the same PR as the audit fix.

1. **The mock-location evidence is the Super Admin's only.** The integrity board's position cases
   (`source = 'gps'`) and `device_mocked` are never queried for the SFE Manager — a screen that hid
   them would leave them one network tab away. SFE keeps the photo-duplicate cases and the behaviour
   months (`readsPositionCases`). The duplicate-customers page got its own predicate
   (`canReadDuplicateCustomers`) so a clerical double-entry never inherits a rule written for evidence.
2. **Everyone below the Super Admin and SFE sees the distance only.** The district manager, the acting
   one, the RSM, the NSM and the CEO read the distance and the far / at-the-place wording. The accuracy,
   the weak-signal sentence ("The phone was not sure where it was"), the phone-clock warning, a place's
   two raw readings and where its fixed point came from are SFE's and the Super Admin's
   (`locationSight`: `none` for the rep on his own seat, `distance`, `full`). A weak reading is never
   far (far beats weak, `geo.ts`), so to a distance-only reader it is a visit at the place, read by its
   plain distance. It covers the day page, the visit rows, the saved visit, the off-plan approval cards,
   the List's place measurements (enforced in the list response, `seesMeasurements`) and the
   place-vs-actual report's rows and weak-signal count.
3. **The place-vs-actual report is the DM's, the NSM's, SFE's and the Super Admin's only.** The CEO and
   the regional managers came off it. It has its own predicate (`readsPlaceVsActual`: a DM, ACTING_DM or
   NSM seat, or SFE, or the Super Admin); `readsTeamReports` is unchanged, because the exceptions board,
   the brick report, the adoption board and the digest still read it and he narrowed none of them. The
   Reports tab's far-visit count follows the report (`canSeeLocations`), and so does the workbook's
   location sheet — behind the old manager gate its service would have refused the CEO and failed his
   whole export.

**How it is closed.** Each loader now ends in a pure shaper in `src/lib/phoenix-crm/server/blind-payloads.ts`.
A measurement is ABSENT, never zero — `farVisits: 0` would still name the check, and would be a false
figure. The place shaper is an ALLOW-LIST, so a measurement added to the place later is withheld until
somebody decides who may have it. The place's point itself STAYS: his own board needs it for the pin
each address opens and for gathering neighbours (`rowPoint`), and a point is where his customer is,
never a judgement. The acting manager's own seat leaves the team-only sections through
`readsSeatLocations` / `locationReportSeats` / `readsTeamReportsOn`, and the far TOTAL becomes his team's alone, so his own
count cannot be had by subtracting the team from it. The integrity board's readers changed only by the
owner's ruling above, never as part of the audit fix.

Pinned by `tests/phoenix-crm-blind-payloads.test.ts`, which builds each payload through the loader's
own mapper, calls the real day-page loader with a locked account and counts any request it makes.

## A rep's visit away from the validated photo is refused — owner ruling, 2026-10-20

His words, in the small hours of 2026-10-20 (Cairo): *"MAKE THE SYSTEM NOT ACCEPT MEDICAL REPS VISITS LOGGED AWAYS FROM
THE VALIDATED PICTURE OF THE CUSTOMER WITH MAXIMUM 300 M APPART"*. It is the third exception to Golden
rule #1, beside Phoenix Ranks' field accuracy and the timetable hold, and only his word made it one.

**What it was before.** The same 300 m line (`visit_far_meters` in the module's settings) already
measured every visit against the customer's validated place, but it only FLAGGED a far visit
(`location_flag = 'far'`) for the managers' place-vs-actual report and the integrity board's
photograph detector. The visit saved, counted, and the rep was told nothing.

**What it is now.** `saveVisit` (`src/lib/phoenix-crm/server/visits.ts`) asks
`visitAwayFromValidatedPlace` (`src/lib/phoenix-crm/entry-rules.ts`) on the REP's own save and refuses it
when the reading is more than the line from every validated place of that customer on that seat.

- **The anchor is the photograph** (one of TWO readings since 2026-10-21 — the nearer of it and the pin
  decides; see the amendment below) — the reading the shutter took at the door — **when it is sharp**:
  within the place's own 250 m line, or with no accuracy reported. Since 2026-10-11 a place validates on
  its pin alone, because iPhone Safari hands the camera an approximate position (650-2,000 m) while the
  pin reads 11-30 m; measuring against such a photograph would refuse an honest rep at the door for good.
  Then the place's own validated point is the anchor. Measured 2026-10-20 on production: 2,627 active
  places, 2,510 anchor on the photograph, 11 carry a photograph reading wider than 250 m, and the 104
  customers seated in a polyclinic carry none and anchor on the building's point.
- **The nearest place decides** — a customer with two clinics is at whichever door the rep stood at.
- **No validated place, no refusal** — a pharmacy (which needs no validation) or a customer still waiting
  for one has nothing to be away from.
- **The visit's own accuracy excuses nothing.** The integrity board drops a finding whose radius reaches
  the door, because a board must not accuse; a door that did the same would let a rep log from 500 m on a
  rough reading. Not one of the measured visits past the line was within its own radius.
- **Only the medical rep's own save.** A double or chain visit a manager enters still saves and is
  flagged; a district manager's own single visits go through their own path (`logManagerVisit`) and never
  reach this door; the Super Admin's "Record a missed visit" carries no reading.
- **Before anything is written.** The refusal comes before a required recording is claimed and before
  `phoenix_crm_save_visit`, so a refused visit leaves no row, no claimed recording and no notice.

**From today, never backwards.** His second message the same morning: *"DONOT REFURE HISTORICAL START FROM
TODAY WHIS RULE"* — do not refuse historical, start this rule from today. The rule lives only in the save,
so no visit already saved is re-judged, un-counted or moved, and nothing was backfilled onto the
refused-readings board. `FAR_VISIT_REFUSAL_FROM_DAY` (2026-10-20) closes the one way an old visit could
still meet it: the day judged is the day the visit was CAPTURED, exactly as the save dates it — the app's
offline anchor, else the photo slot, else now — so a visit taken with no signal before the rule and synced
after it is never refused (`farVisitRefusalApplies`).

**What the rep reads** (`VISIT_AWAY_FROM_PLACE`): *"This visit can be logged only at the customer's place,
and your location now is not there. If you are at the place, step outside, wait a moment for the location
to settle, then tap Log visit again."* His own work, never the line, never his metres, never a word for a
check — and never a dead end for a rep who IS at the door on a reading that has not settled.

**What the SFE reads.** Every refused attempt is kept in `phoenix_crm_refused_readings` as reason
`far_from_place` (migration `20261020034610`), with `distance_meters`, `place_id` and the far line in
`max_accuracy_meters`, and the refused-readings board prints *"The visit was logged 1.2 km away from this
customer's validated photo, so it was not saved. A medical rep's visit is taken only within 300 m of it."*
A rep who then logs the visit at the door reads as "Got through afterwards".

**What it costs.** Measured on production for 6-19 October 2026: 97 of 2,558 measurable rep visits (3.8%)
were logged more than 300 m from the validated photo, 38 of them over a kilometre out, across 94
customer-seats — about seven a day that will now be refused until logged at the place.

Pinned by `tests/phoenix-crm-visit-far-refusal.test.ts`.

### Amendment, 2026-10-21 — the NEARER of the photograph and the pin decides

**What happened.** A medical rep was refused 26 times between 12:07 and 14:38 Cairo trying to log a planned
visit at Sehet Behteem Hospital (Anti-Infective). His own GPS read ±3-11 m and sat **7-91 m** from the
place's validated pin the whole time; the refusal measured him **324-401 m** from the photograph (line 300 m,
so 24-101 m over it). The photograph's own reading was ±200 m — inside the 250 m "sharp" line, so it
anchored — and sat 327 m from the pin captured at the door (±7.9 m). His two earlier visits there (13 and
15 October, before the rule) had read 52-54 m from the pin and flagged ok: three separate days at the pin.

**Why moving the place could not fix it.** `phoenix_crm_move_place` rewrites the place's point and never
the photograph's reading, and the photograph outranked the point, so a move changed nothing.

**His ruling, picked from three options the same afternoon:** a visit passes if it is within the line of
**either** the photograph's anchor **or** the place's own validated pin — the nearer decides
(`validatedPlaceReadings`, `entry-rules.ts`). The other options — keep the photograph as the only anchor
but require it to be ±100 m or better, or leave the rule and have the Super Admin record each blocked visit
by hand — were declined; never re-propose either.

- A photograph reading wider than the place's 250 m line is still not a reading: the pin alone stands.
- The line stays `visit_far_meters` (300 m) and is never widened by the photograph's accuracy circle or the
  visit's own radius.
- **The refused metres are now the NEARER reading's**, so the SFE board's "logged N m away from this
  customer's validated photo" sentence can name the pin's distance; the wording was left as it was.
- Measured the same day on production: 72 `far_from_place` refusals since 20 October across 10 reps and 13
  customers; the 26 within 150 m of a pin were all this one rep at this one hospital, and the other 46 sat
  further out. Of 2,720 places anchored on a photograph, 2,712 carry one within 100 m of the pin; 8 sit
  104 m or more apart (this hospital 327 m, one other doctor's place 10,070 m — a data conflict for the
  Place checks board, which the nearer-reading rule does not settle: it accepts either point).

### Correction, 2026-10-22 — the "pin" the door read was the photograph

**What was wrong.** `validatedPlaceReadings` took the place's kept point (`lat`/`lon`) as the pin. On a
place whose point was taken from the photograph, that point IS the photograph, so the ruling above never
reached those places: the pin did not count. Sehet Behteem was fixed only because its own kept point is
its pin. Measured on production: **9 active places** hold a photograph 300 m or more from the pin with the
kept point on the photograph, and on **3** of them visits stood at the pin — Linda Iskandar (photograph
and pin 2,768 m apart, visits 56 m from the pin), Ashmoun Fever Hospital (869 m apart) and Ahmed Sabry
Mashaal (441 m apart). A rep logging a visit at the door of any of the three would have been refused.
None had been yet (production, 22 Oct): every `far_from_place` refusal within 300 m of a pin since the
rule began was Sehet Behteem's on 21 Oct before the fix, or one rep standing 299 m from a place whose
pin and photograph sit 7 m apart — which the corrected door now lets through, at the line.

**What it does now.** The second reading is the place's own `pin_lat`/`pin_lon` (`validatedPin`,
`entry-rules.ts`), used when the pin's accuracy is within the same 250 m line; a moved point (the Super
Admin's or the SFE Manager's) and a seated customer's venue point stay the place's point, and a rough or
missing pin falls back to it. The line, the nearer-reading rule and everything else above stand.

**What it does not change.** The night check that measures each visit against the place's photograph
(owner, 2026-10-13) still measures against the photograph only, so a visit at the pin on one of these
places is still filed on the integrity board, weakly, for him to settle; the door and the night check
answer different questions. The other doctor's place above was Dr Tharwat Milad's: its photograph was
the phone's first network reading, 10 km from the door
(`docs/phoenix-crm-integrity-settlement.md` §16).

Pinned by `tests/phoenix-crm-visit-far-refusal.test.ts` §1b on the three places' shapes; the assertion
that a point settled on the photograph still has its pin as the second reading was broken on purpose,
fired (one reading, not two), and the file was restored byte-identical.

### Amendment, 2026-10-26 — the live photo is the customer's saved point; the pin still opens the save

**His words.** *"The source of trust that you compare from is the live validation photo. The location on
the live validation photo."* And, asked what that means for the place: *"this is the saved location of
this customer in the system that we later on compare with it"* — every visit or entry after it is judged
by how far it sits from the photo.

**What was wrong.** Since 2026-10-11 `pickPlacePoint` fixed a place on whichever reading claimed the
sharper accuracy. A claimed accuracy is the phone's guess about itself, so on production (26 Oct) **760
of 3,422 active places** held the pin although a photo existed, and the same doctor validated by two reps
could hold two different points. The kept point (`lat`/`lon`) is what the visit flags, the address,
the brick and the area are read from.

**What it does now.** `pickPlacePoint` takes the photo's own reading whenever it is within the place's
250 m line or its phone reported no accuracy; the pin only when there is no photo reading or it is rougher
than that. On 26 Oct 2026 (~16:00 Cairo) 746 places holding the pin beside a usable photo were moved
onto their photo, their address re-read where the photo sat 25 m or more from the pin, and 588 of
their visits measured again (`scripts/phoenix-crm-settle-on-photo.ts`): no brick or area changed and
one visit flag moved, far to ok. The pre-image is `phoenix_crm_backup_20261026.phoenix_crm_photo_point_backup_20261026_places` and
`_visits` (moved out of `public` on 27 Oct, `20261027235603`). 🔴 **Six places were HELD on the pin**: their photo sits 300 m or more from it (Dr Tharwat
Milad's 10 km cold-receiver photo, Sehet Behteem Hospital's ±200 m photo 327 m off, and four more), the
contradicting readings — moving them is his decision, place by place. The places whose photo is rougher
than 250 m keep the pin, and validations saved before this merge served need the script run once more.

**His answer on the door, picked from options the same afternoon:** *"Photo for flags, pin still lets it
save."* The 2026-10-21 nearer-of-photo-and-pin refusal stays exactly as it is, because 7 rep visits since
20 October stood 1-279 m from the pin and 322-860 m from the photo — five of them 1-15 m from the pin —
and a photo-only door would have refused them. Such a visit saves and reads as far from the photo to the
managers. Never re-propose the photo-only door without his word.

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

- 🔴 **Twice a week at most (owner, 2026-10-20).** His words: *"for reps cap weekly plan edit requests + plan it self to 2 to be the rep makes the plan and send s to manager after the approval he have only 2 times to request edit per week"*. Read as: one week, two
  asks. Every request raised on the week counts, whatever became of it — a refused or expired one
  included — because what he capped is the asking, not the edits granted. `PLAN_EDIT_ASKS_PER_WEEK`
  (`plan-edit-rules.ts`); `raisePlanEdit` counts the week's requests with no status filter and refuses
  the third with a sentence, before anything is written; the week's `canAskToEdit` needs an ask left,
  the count left sits under the button ("1 ask left this week"), the confirmation says when it is the
  last one, and once both are spent the button gives way to "No asks left this week". No migration: the
  database already lets only one request wait on a week, under the plan's own lock, so two presses at
  once still end at two. A district manager's own week (`phoenix_crm_manager_plan_edit_requests`) is not
  capped by it — he named reps.

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

**Changed 2026-10-20: to Omar Gawish (`B-10`) alone, no BCC and no CC.** That day Yasmeena moved
to a seat of her own (the role key `HR Administration`, shown as HR Operations Specialist), the HR
Generalist seat was left open for a future hire, and asked who receives the milestones now he
picked *"To you only"*. Two things kept the change from re-sending anything:

- **The dedup key is FROZEN.** It still ends `:HR-009` (`PROBATION_MILESTONE_KEY_SUFFIX`). It names
  "this case's Day N milestone", not the recipient, and every milestone already delivered is
  recorded under it.
- **The frozen key alone was not enough.** The notification layer keys each DELIVERY by event,
  channel AND recipient, so the same event addressed to a new person is a new delivery, and the
  event upsert would also have moved her bell row onto him. The sweep therefore reads
  `notification_events` for the due keys first and SKIPS a key whose row is addressed to anybody
  but the current recipient (`milestoneKeysToSend`). A failed read sends nothing that run, which
  costs nothing because a milestone stays due until day 90.

Pinned by `tests/probation-milestone-emails.test.ts` and `tests/vacant-seat-recipients.test.ts`.
The rest of this section is the account as it stood on 2026-09-29.

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

### Changed 2026-10-20: the notice follows the SEAT, and the Super Admin stands in while it is empty

That day she moved to a seat of her own (the role key `HR Administration`, shown as HR Operations
Specialist), and `HR Operations` — shown as HR Generalist — was left open for a future hire. Asked
where the informed notice goes meanwhile, he answered *"Both to you until the hire"*, and the same
for the business-card request notice. Neither names a person by HR id any more:

- **Both resolve the HR Generalist seat** through `resolveSeatOrStandInHrIds`
  (`src/lib/notifications/vacant-seat.ts`). Whoever holds the seat is told; while nobody does, the
  Super Admin is. The day somebody is seated the notice follows them, with nothing to undo.
- **A failed read is never an empty seat.** It resolves nobody and logs a warning, rather than
  handing the owner the seat's mail on every transient database error.
- **Every role-addressed notice now works the same way.** `resolveNotificationRoleRecipients` puts
  each policy's roles through `withVacantSeatStandIns`, so any notice addressed to the HR Operations
  role reaches the Super Admin while the seat is empty. An audience that already names the Super
  Admin needs no read and gets no second copy.

Everything below about "her" describes the 2026-09-29 build. The approver rule, the channels, the
annual-only scope and the panel are unchanged, and now apply to whoever holds the seat. Pinned by
`tests/vacation-informed-hr.test.ts`, `tests/business-card-requests.test.ts` and
`tests/vacant-seat-recipients.test.ts`.

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

## The HR premium identity — owner instructions, 2026-10-12 and 2026-10-13

### What he said

At about 22:20 Cairo, after approving the Talent Acquisition New Starter Handbook page by page:
*"Save this identity as the HR premium identity … make all the normal templates or forms in Sato
Pharma follow this perfect template. But not the governmental, the governmental as they are."*
The same evening, while it was being rolled out: *"the contract keep corporate as it was"*.

### What wears it

The shared module is `src/lib/hiring-pack/premium-identity.ts`, built once beside
`house-identity.ts` and never pasted per renderer. It is the house identity `SATO-DIS-2026-01 v1.0`
raised to premium — the same three blues, the same ink rule — plus a page frame with Latin security
microtext, the Arabic mark as a 5% watermark, a masthead with the Latin mark and the engine-turned
band drawn as an inline vector, and the Phoenix running foot carrying the identity code.

- **Wears it (his answers of 13 October, below):** the English certificate of experience (and, since
  28 October, the Arabic one - see "The certificate of experience's own design" below), the English
  salary letter (and, since 28 October, the Arabic one - see "The HR letter in the certificate's
  design" below), the exit interview, the payslip, the organogram employee record, the interview
  calendar PDF, the Phoenix CRM start guide, the Field Activity report, and a new fifth job-offer
  design called Premium. **Everything else he ticked "keep" and prints as it did before the identity
  existed** - the clearances, the custody receipts, the worker data form and every other HR paper -
  through the `PREMIUM_DRESS` table in `premium-identity.ts`, whose branch for each is switched off,
  not torn out, so a changed mind is one line.
- **Keeps the corporate dress, by his word:** the employment contract, every version of it. The
  renewal annex goes with it — it is read stapled to the contract, and `tests/hr-forms-renewal.test.ts`
  pins its masthead identical to the contract's — and so does the non-renewal notice, drawn by the
  same renderer from the same furniture.
- **An archived version keeps the dress it was signed in.** Only the current version of a paper wears
  the premium identity, so a reprint from the Archive screen still matches the paper on file.
- **Never touched:** the Authority's forms (Form 1, Form 6, the labour exit forms, the official pack
  forms, the field-layout overlays), and the designs he decided one by one - the four existing job
  offer designs, the Spotlight sheet, the business card and the workbooks. `houseLetterhead()` is
  unchanged and byte-pinned by `tests/payslip-document.test.ts`; the payslip now calls
  `premiumLetterhead()` instead.
- **No seal**, as on every hiring paper: the seal is the job offer's alone.

### The certificate of experience's own design (2026-10-28)

He had a premium pair of certificates printed for one employee that day, approved it, and then asked
for it in the HR forms module: *"make this the certificate of experience in the hr forms module"*.
Asked whether the printed papers should carry his signature, he chose *"Blank box, sign by hand"* -
anyone with access to HR forms can print a certificate, so a blank box means none leaves without HR
signing it.

- **Both certificates wear it - the English one and the Arabic one.** The Arabic certificate had been
  ticked "keep" on 13 October; this word moves it. It is drawn by its own renderer,
  `experience-certificate-ar.ts`, beside `experience-certificate-en.ts`, and both share
  `experience-certificate-design.ts`. It sits inside the premium identity (same masthead, band, frame,
  watermark and foot) and adds a two-weight title, the holder's details, the period in figures, and
  three signing boxes.
- **The Arabic words are the template's, unchanged** - every sentence, heading and label is still read
  from `experience-certificate-v1` in `hr-paper-text.ts`, including «السيد / السيدة المبيّنة بياناته».
- **The three signing boxes print BLANK** - name and title, signature, company stamp. No name, no
  signature and no seal is drawn into them. His signature file never enters the repository.
- `PREMIUM_DRESS.hrPapers` is unchanged: the Arabic certificate wears the design through its own
  renderer, not through the house papers' premium branch. An archived version would still print
  through `renderHrPaperHtml` in the dress it was signed in.
- Pinned by `tests/hr-premium-identity.test.ts` and `tests/hr-forms-house-papers.test.ts`.

### The HR letter in the certificate's design (2026-10-28)

The same evening, about 17:40 Cairo: *"SHOW ME HR LETTER WITH SAME IDENTITY"* - the salary
certificate, English and Arabic, in the certificate of experience's design. Shown the previews, he
wrote *"PUT THE BASE NOT THE BASIC SALARY"*, then answered *"Make it the HR letter"* for both
languages and *"Move them to the new boxes"* for his hand-placed Arabic marks.

- **Both letters wear the certificate's design** - the two-weight title beside the issuing company,
  the employee's details as a ruled list, the words, the salary at a glance in figures, and blank
  signing boxes. The English letter (`salary-letter-en.ts`) has three - name and title, signature,
  company stamp. The Arabic letter (`salary-letter-ar.ts`) has two, because its template signs with a
  name and a signature only.
- **The Arabic words are the template's, unchanged** - every sentence, heading and label is still read
  from `salary-letter-ar-v1` in `hr-paper-text.ts`. The Arabic letter had been ticked "keep" on 13
  October; this word moves it.
- **Both state the BASE salary on record.** This reverses his rule of 13 September, *"salary we put
  basic not net"*, for the English letter; the Arabic letter has stated the base since 20 September.
  Never the basic, the net or the gross. With no base on record the sentence carries a dotted rule
  and the strip is left out, so nothing reads as a zero.
- **His hand-placed marks moved with the design.** The signature and stamp he placed on 29 September
  were anchored inside the old signature table; they are re-anchored to the new signature box
  (`section:nth-of-type(2) > div:nth-of-type(1) > span:nth-of-type(2)`) and still print only when
  ticked in the print dialog.
- No seal is drawn, and an archived version still prints through `renderHrPaperHtml` in the dress it
  was signed in.
- Pinned by `tests/hiring-pack-salary-letter.test.ts`, `tests/hiring-pack-salary-letter-ar.test.ts`
  and `tests/hr-premium-identity.test.ts`.

### The Arabic logo: watermark and footer only

At about 23:50 Cairo the same evening, looking at the premium papers: *"make the arabic sato logo only
as water mark"*, then *"everywhere"*. Asked about the two papers that sign their foot with it, he
answered *"ok watermark and footer only"*, and then chose to keep their foot mark and add the
watermark.

- **The HR premium papers:** the Arabic mark left the masthead. Its empty right column now mirrors the
  Latin mark's, so the title sits on the page's centre line, and the gaps closed by the same amount, so
  the title column is exactly as wide as before: it wraps on the same words and no paper grows a line.
  The 5% watermark is now the only Arabic mark on these papers.
- **The Spotlight sheet** (and the Phoenix Ranks certificate, which shares its sheet frame so the two
  cannot drift apart) and **the Sales Review pack PDF:** the foot keeps the Arabic mark, and every
  sheet now carries it as a 5% watermark too, low on the right of the content column and above the
  foot. It is contained, so the whole name shows. That is none of the four Spotlight placements he
  struck on 2026-09-12 (a wash behind the figure, a bleed off the right edge, low under the gauge, over
  the figure's left shoulder). The rep's own Spotlight sheet already had its centred watermark
  (2026-09-30) and keeps it instead of getting a second one.
- **Already a watermark, unchanged:** the milestone cards, the award cheque and the joining form's
  band.
- Pinned by `tests/hr-premium-identity.test.ts`, `tests/spotlight-sheet-design.test.ts`,
  `tests/spotlight-rep-self.test.ts` and `tests/business-review-pack-model.test.ts`.

### What it cost to get right on paper

- **Nothing in the fixed frame may carry an SVG `transform`.** The frame is `position: fixed` in
  print, which is how Chrome repeats it on every page, and Chrome paints a fixed element's
  transformed SVG children on the first page only. With rotated side runs and turned corner pips,
  page two of the contract printed with empty side channels and hollow corner tiles. The side runs
  now lie on `<textPath>`s and the pips are four-point polygons. CSS rotation on HTML (the foot's
  diamond) is not affected.
- **The reference number rides the masthead's name line, never a line of its own.** Measured on the
  numbered renders: a line of its own cost 3.2 mm and pushed the contract (then premium) to a fourth
  sheet and the employee clearance to a second. On the name line it costs no height on any paper.
- **The sheet prints on `@page { margin: 0 }`**, because a fixed frame is clipped to the page area.
  Chrome draws its footer template inside the bottom margin, so with no margin a premium paper's
  filed PDF is numbered by `paper-pdf.ts` after layout ("N / M" in the foot's right end, per copy).
- **Every page count held**: all papers, numbered and not, print on the same number of sheets as in
  the house dress, with at least 1.3 mm between the last line and the foot rule.

### His keep-or-change answers - 13 October 2026, about 00:40 Cairo

Given on the review page, one box per paper (ticked = the new premium look, unticked = keep, which
prints as today). **Change:** the English salary letter, the exit interview, the English certificate
of experience, the payslip, the organogram employee record (PDF), the interview calendar export
(PDF), the Phoenix CRM start guide, the Field Activity report - *"and for job offers create new
templete with the new identity"*. **Keep:** the confidentiality undertaking, the laptop custody
receipt, the employee clearance, the worker data form, the Arabic salary letter, every other HR and
hiring paper, the contract with its annex and notice, all four existing job offer designs, the
Spotlight sheet and the Phoenix Ranks certificate, the business card, the Excel workbooks, the
printed candidate record, the WhatsApp application sheet, the Monthly Closing sheet, the Sales Review
pack, the Make It Happen forecast, the award cheque, the Sato Pharma email and the CEO letter email.
**The Latin face:** keep as it is. **The foot code:** keep `SATO-DIS-2026-01 v1.0`.

- **The foot of a company paper says Sato Pharma, not Phoenix** (asked, and he chose "Sato Pharma
  alone", 13 October 2026; one line to change: `PREMIUM_COMPANY_DOCUMENT_BRAND`). The payslip and the organogram record
  have pinned "no Phoenix branding on a company document" since 2026-09-05, and the job offer's
  reader is the candidate, to whom nothing says Phoenix (`src/lib/offers/identity.ts`). The HR papers
  that wear the identity keep the approved Phoenix foot.
- **Landscape.** The interview calendar and the Field Activity report are landscape, so the chrome
  takes an `orientation` option (the same sheet turned on its side, frame, watermark and foot the
  same distance from the edges), and a `slim` masthead for one repeated on every page.
- **A kept paper is proven byte for byte.** Rendered with the same fixture, 21 of the 24 hiring papers
  are identical to the code from before the identity existed; the 3 that differ are the three he
  ticked "change".
- **The Premium job offer is a FIFTH design beside the four he froze** (`premium`, "SATO Premium
  Offer", never seeded as the default). It draws through `src/lib/offers/premium-skin.ts` and
  `premium-template.ts`; the wording, fields, tables and signature cells are the ordinary offer's.
  The four older designs are pinned by a sha256 of their rendered letter, computed on the tree from
  before the identity and carried unchanged in `frozenDesignTests`, so a change to any of them goes
  red. The company seal is still drawn by the base (`.offer-seal`, company rule only, never the
  candidate's); Premium adds 6 mm of headroom on both parties' signature rows so the four rules stay
  level and the impression no longer lands on the signatory's name and title. The offer prints on two
  sheets, the same as the House design.
- **Its database half ships first.** The `offer_templates` CHECK constraints on `variant` and
  `builtin_key` had to allow `premium` before the code that registers it deployed, so migration
  `20261013120000_job_offer_premium_variant` was applied to staging and to production on 13 October
  2026 and read back from both; it rewrites no row. The Premium row is created the first time the
  app lists offer templates after the code deploys.
- **Offer emails do not change.** The email an offer travels in (`render-email.ts`) is the same for
  all five designs; only the PDF letter differs.
- **The money papers keep every figure and word.** On the payslip and the organogram record only the
  title words moved into the masthead ("Payslip", "قسيمة راتب", "Salary statement · month"); the
  visible text below it was compared old against new and is identical. Each still prints its own
  footer line carrying the document code beside the premium foot.
- **Fonts were measured on Windows.** The premium type stack names Segoe UI first; Railway's Chromium
  substitutes Noto Sans. The Premium offer measured 28.0 mm and 44.8 mm above the foot rule on its two
  sheets here; that slack is what absorbs the substitution, and it has not been measured on Railway.

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
- **Counts only.** No report anywhere shows a "no objection" figure or a rate: that would be an honesty
  figure, and golden rule #1 keeps those out of every screen but the integrity board. What the field heard
  itself is unchanged: by product, speciality and area, with no row per rep.
- **One separate list names the rep: Objections by customer, his "per-doctor list" under the 23 September wording rule (owner, 3 November 2026).** He partly lifted the
  no-row-per-rep rule for a per-doctor list for managers: each rep's doctors and what they objected to,
  with the product, the day and the rep's note. Counts only: no percentage, rate, rank or score, sorted by
  name and never by a count, with no "no objection" row and no blank. Readers are `readsTeamReports` alone
  (Super Admin, SFE Manager, CEO, a manager on his own team); reps and the product audience are refused.
  It never scores a rep: `tests/phoenix-crm-objections-by-customer.test.ts` refuses an import of it from
  ranks, KPIs, payroll, incentives, coaching and the integrity board. It reads
  `phoenix_crm_countable_visits`, so copied iReports360 history stays out; What the field heard reads the
  view that keeps that history. Module: `src/lib/phoenix-crm/objections-by-customer.ts`.

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
(`src/lib/crm/list-types.ts`), the spelling the retired iReports360 scraper imported each rep's pharmacies under.

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

## A pharmacy visit is logged normally — owner rulings, 2026-10-03

The hook is in `.claude/rules/phoenix-crm.md`. This is the account.

### What happened

Hassan Elsherbiny (Pedia, El Mahalla) reported that he "visited pharmacies and submitted them but
they appear as not visited at all". Measured on production the same afternoon: **no rep had EVER
saved a `list_type = 'Pharmacy'` visit.** The 2026-10-02 rules above lived in
`pharmacy-call-rules.ts` and were wired to no screen, and 568 of the 570 imported pharmacies were
still `pending`, so the only road to one was Out of plan, a reason and an approval. What the reps
actually did was type the pharmacy's name as "pharmacy you took feedback from" on their DOCTOR
visits, and the pharmacy's own page went on reading "Not visited this month".

### His three rulings, in order

1. *"Since he locked him, consider this as a pharmacy visit and make it count everywhere … make it
   appear for him and for anyone who have his same situation. Then let's build the real fix later."*
2. *"Pharmacies doesn't need a validation. Pharmacy don't need a validation. It is visit is logged
   normally."*
3. *"Make all their … pharmacies … appear in their accounts and the manager account. Then start
   fixing."*

The data half was done first: 11 pharmacy visits filed through `phoenix_crm_admin_enter_visit` for
Hassan, Khaled Saeid, Radwa and Sara (four of the pharmacies were new and joined their lists), and
`20261003174346` made `phoenix_crm_countable_visits.customer_validated` true for every pharmacy.

### The fix

- **No validation.** A `pending` pharmacy is on his list (`awaitsValidation` and `onTheList` in
  `list-request-rules.ts`), and the countable view counts its visits.
- **Logged normally.** Add visit → **Pharmacy visit** goes straight to the form; `phoenix_crm_save_visit`
  (`20261003175653`) files a pharmacy as on-plan, with no unplanned kind and no approval, and names
  the visit after the pharmacy.
- **The pharmacy a doctor's visit names is a visit to it.** The name is matched to his list by
  `linkNamedPharmacy` — an exact `pharmacyNameKey`, else ONE unique partial match; never a dropped
  pharmacy, never a guess between two — or ADDED as `pending`, and filed as its own visit with
  `linked_from_visit_id` pointing at the doctor's, `on conflict do nothing` (one a day).
- **One pharmacy counts once in the day however it is spelled** — `pharmacyNameKey` in
  `todayPharmacies`, `day-detail.ts` and `team-calendar.ts`. It folds letters with the repo's own
  `normalizeArabicPharmacyName` and drops only the word pharmacy, never the Pharmacy Master's wider
  stop words: there a person confirms each match, here nobody does.

### The linked visit is part of the doctor's submission, never a second piece of work

Everything it carries was checked against every reader that could count it twice:

| It is… | Because otherwise… |
| --- | --- |
| a `single` visit by the rep (or by the manager, on a visit of his own) | `phoenix_crm_report_manager_visits` counts every `double` and `chain` row, so the manager would get two double visits for one stop |
| carrying NO stock answers (`product_availability = '{}'`) | the Missing stock report would count each missing product twice; the answers stay on the doctor's visit, where every stock reader finds them by the pharmacy's name |
| left out of the first-visit email gate, the behaviour sweep and the location report (`linked_from_visit_id is null`) | it is written in the same second as the doctor's, with no place reading of its own |
| left out of "What the field heard" (with every pharmacy visit) | that report has an AM side and a PM side only, so it filed a pharmacy as PM and would hear the doctor's products twice |

It keeps the doctor's products because `phoenix_crm_visits_products` requires one to twelve.

### One box, two pharmacies — the same evening

He asked: *"fix a doctor visit that names two pharmacies in one box"*. Measured on production that
evening: three of the doctor visits that named a pharmacy named TWO, all Mohamed Salem's (Pedia), all
with the Arabic comma — "صيدليه التهامي، صيدليه الرحمه", "صيدليه الوكيل ،صيدليه الكوانيني" and
"كوانيني ،الوكيل". The whole box was matched as ONE name: the first found only التهامي, the second
half-matched two pharmacies and filed nothing, the third filed الوكيل under both names; and the day's
Pharmacies figure read each box as a pharmacy of its own (his day read 8 where he had visited 5).

- `splitNamedPharmacies` (`pharmacy-call-rules.ts`) reads each name in the box: the Arabic and Latin
  comma and semicolon, a new line, "+", "&", and "و" standing before the word pharmacy. It never splits
  on "/" — the reps' "ص/ناصر" IS the word pharmacy — or on "-", which names a branch ("صيدلية العطار -
  الفرع التاني"). A part that is only the word pharmacy names none; a second spelling of one name is
  dropped; five at most.
- `linkNamedPharmacies` matches each name on its own with `linkNamedPharmacy`; two names that land on
  one pharmacy on his list file it once.
- `phoenix_crm_save_visit` (`20261003202903`) reads `linked_pharmacies: [{ name, id, new }]` and files
  one visit per entry, named as he spelled THAT pharmacy, so the doctor's mention and the visit share
  a key. A caller from before sends the old one-match fields, read as a list of one; the new caller
  fills those only for a box naming ONE pharmacy, because 175653 names its visit (and any pharmacy it
  adds) with the whole box.
- `pharmacyNamesOnVisit` is what the day screen (`todayPharmacies`) and the manager's calendar cell
  count: a pharmacy's OWN visit is always one pharmacy, a doctor's box is what it names.
- His data that evening: الكوانيني got the visit his 20:19 box should have filed, and the الوكيل visit
  filed under "كوانيني ،الوكيل" was renamed "الوكيل". His day reads 6, not 5, because he typed the same
  pharmacy once as "الكوانيني" and once as "كوانيني": `pharmacyNameKey` keeps the article, and that
  is a spelling question, not a box one.

### He adds a pharmacy himself — the same night

He asked: *"he can add to his list pharmacies without approval normally … then he goes to visits and
when he press add a visit … in pharmacy visit … all his pharmacies to be listed and he can also add a
pharmacy without any validation or without any approval"*, and to keep the doctor visit's pharmacy box
exactly as it is, and never to mix these visits with the AM or PM ones.

Measured first: Pharmacy visit ALREADY listed every pharmacy on his list, validated or not (the form
reads `active` and `pending`; 576 of production's 579 pharmacies are `pending`). What was missing was a
way to ADD one — the screen said "No pharmacy is on your list yet. Name one on a customer's visit" and
offered nothing, and the List's Add new customer is AM/PM only, with a photo and two approvals.

- **Add a pharmacy** takes the NAME and needs nothing else — no photo, no hours, no request — on
  the List (beside Add new customer) and on Add visit → Pharmacy visit, where saving opens the visit
  form on it. The territory's own rep only (`territoryForRepWrite`); a manager entering a visit picks
  from the rep's list. **Since 2026-10-09 the name is joined by two OPTIONAL extras — a pin on the
  pharmacy's own location and the responsible person's phone** (his instruction that day: *"make it
  optional to add its location by a pin button … also make optional to add the responsible person
  phone number"*). Optional in the full sense: an add with neither sends the body this route has
  always received. "A pharmacy's own place and its responsible person's phone are optional", below,
  holds that rule; the photo, the hours and the approvals stay absent.
- The name is matched EXACTLY by its key (`matchAddedPharmacy`): on his list already → opened, never a
  second row; in his Archive → refused with the way back, as typing never undoes the Archive (rule 3c);
  otherwise `phoenix_crm_add_pharmacy` (`20261003211501`) adds it `pending`, `origin` 'new', repeating
  the exact-name check under a per-territory lock so a double tap adds one. Never the doctor box's
  half-match: "النور" must not open "النور الجديدة".
- Its visits are Pharmacy visits like any other — counted in Pharmacies, never inside AM or PM.

### What must NOT be "fixed"

- 🔴 **The five SQL report functions keep `c.validated_at is not null`** (Visits by day, Coverage,
  Brick coverage, Manager visits, Plan against actual). They look like the gate the owner removed, but
  every one of them is drawn as AM and PM only, so a pharmacy row never reached a screen through them;
  a pharmacy is in no KPI denominator (2026-10-02). Opening them changes no number anyone reads.
  Measured 2026-10-03: 9 of the 11 backfilled pharmacy visits sit on pending pharmacies, and all 11
  read `customer_validated = true` in the countable view, which is what the rep's and his managers'
  screens read.
- Never give the linked visit the doctor's people or stock answers back "for completeness".
- Never widen `pharmacyNameKey` to the Pharmacy Master's stop words.
- Never split the box on "/" or "-": the first is the reps' "ص/", the second names a branch.
- Never put a photo, a request or an approval back on Add a pharmacy, and never match its name by
  half — an exact key or a new pharmacy. 🔴 **The location is the one exception, and only as he set it
  on 2026-10-09: an OPTIONAL pin, never required, never checked** — see the next account.

## A pharmacy's own place and its responsible person's phone are optional — owner ruling, 2026-10-09

**What he asked**, by voice: *"In Phoenix, CRM. One, visiting pharmacy or adding a new pharmacy, make
it optional to add its location by a pin button — optional, if you want to save its location do this,
if you want also don't do this. And also make optional to add the responsible person's phone number.
And of course, when he captured the location, the location is then cleaned and separated into area,
brick, government. Area, brick, and government, yes."*

**How it is built.**
- **Both are optional in the full sense.** `PharmacyExtras` (`src/components/phoenix-crm/pharmacy-details.tsx`)
  puts the pin button and the phone box under the name on Add a pharmacy, and the request omits each
  key he left alone — an add with neither is the body `/api/phoenix-crm/list/pharmacy` has always
  received, taking the path it has always taken.
- **Correcting them later** is the same two controls on the pharmacy's own page and from the Pharmacy
  visit picker (`PharmacyDetailsScreen` → `POST /api/phoenix-crm/list/pharmacy-details` →
  `phoenix_crm_set_pharmacy_details`). A NAMED key sets it, an ABSENT key leaves it, and `pin: null`
  clears all thirteen columns — so a screen that sends the pin unconditionally would wipe yesterday's
  reading, which is why the correction screen sends it only after he captured one or pressed Remove.
  `phoenix_crm_add_pharmacy`, by contrast, fills only what is EMPTY on a pharmacy already on the list.
- **"Cleaned and separated" is the server's work, from the coordinate alone.** `resolvePinGeography`
  in `src/lib/phoenix-crm/server/list.ts` — the SAME function a doctor's validated place reads, so a
  pharmacy and the clinic across the street can never disagree about which brick the street is in —
  returns the clean address, the governorate, the area and the brick with its distance. The
  governorate is the geocode's own component, never cut out of the address text: an address line holds
  district names that read like governorates, and a wrong governorate is worse than none.
  `brick_lookup` says which kind of nothing a missing brick was — `matched`, `none_nearby`, or
  `could_not_look` when the brick master itself could not be read.
- 🔴 **The pin is a RECORD, never a CHECK.** A pharmacy needs no validation (his 2026-10-03 rule), so
  there is no photo, no second reading, no approval, nothing flagged for being far from it and no KPI
  that reads it. The rep's screens show WHERE it is — governorate, area, brick — and never how good
  his reading was. Only a reading wider than 500 m is refused, and that refusal offers to save the
  pharmacy without it.
- **Nothing changed** for a doctor's primary pharmacy or for the pharmacies a doctor's visit names.

### The 500 m limit is his, confirmed the same day

The one judgement call the build left open was whether a pharmacy pin should keep the module's
existing accuracy line or take the tighter one a validated place is held to. It was put to him twice
and he answered on the second asking, 2026-10-09: *"keep the 500 m limit on a pharmacy pin"*. So the
limit stays `VISIT_MAX_ACCURACY_METERS` — 500 m, the visit line — and **not** a place's
`PLACE_MAX_ACCURACY_METERS` of 250 m.

The reasoning behind the recommendation he accepted: a rep pinning a pharmacy is standing inside a
shop, not at a signboard being validated, so the tighter line would cost him the pin indoors for no
gain. The limit is not there to judge the rep at all — it exists because a phone left on APPROXIMATE
location reports a flat ~2,000 m, which resolves to a different brick and would be read months later
as that pharmacy's own brick. And it never blocks the work: the refusal is about that one reading and
its own words offer to save the pharmacy without a location. An UNKNOWN accuracy still pins, because
refusing it would cost the pin on every phone that does not report one.

**So nothing was changed in the code for this ruling** — it confirmed the behaviour that shipped in
#5652, and this section exists so no later session reads the two different limits as an
inconsistency and "fixes" the pharmacy down to 250 m. `tests/phoenix-crm-pharmacy-pin.test.ts` names
the ruling where it asserts the line, so a session that tightens it reads whose decision it is in the
failure itself.

**What must NOT be "fixed".** Never make either one required. Never measure a pharmacy visit against
the pin, never let it gate or flag anything, and never show a rep an accuracy or a brick distance.
Never tighten the 500 m line to a validated place's 250 m — it is his own confirmed choice, above.
Never resolve the geography a second time anywhere — `tests/phoenix-crm-place-location-frozen.test.ts`
pins `resolvePinGeography` as the file's only caller of the address service for exactly that reason.

Pinned by `tests/phoenix-crm-pharmacy-pin.test.ts`; the module rule is in `.claude/rules/phoenix-crm.md`.

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

## "I started working" — the rep confirms his start, before his first AM visit — owner ruling, 2026-10-03

**What he asked for, and why.** *"I want to make a feature for medical reps to confirm they started
their work, because as you know the visit is entered after it is done, so I want to know when actually
did they start working. Only before the first AM visit show them an obvious clean button called 'Show
your manager you started working', and under this button write 'press here before doing only the first
AM visit', and confirm before, not after. After the rep presses this, the managers are informed by
in-app, Telegram and email."* The gap is real and nothing in the module could close it: a visit's
`captured_at` is stamped when the rep SAVES it, which is the end of a call. The first visit of a
morning therefore says when his first call finished, never when he began.

Asked the same day where the reading goes, he added: *"when they press the button their location and
their time send to managers and saved in system."*

**The four answers he gave when asked.**
- **Who is told:** his **district manager and the SFE Manager** — not the national sales manager. (The
  first-visit email goes to the whole chain, but that one fires once per rep ever; this one is daily.)
- **Channels:** all three, with **email to the district manager only**. He was shown the arithmetic: at
  about 5 reps a district the DM takes ~5 emails a morning, while the SFE, who reads every line, would
  take one per rep — about 74 every morning once the module is company-wide.
- **If the rep forgets and logs his first AM visit anyway:** the visit goes through, the button
  disappears, nothing is blocked. The manager's screen simply shows no start for that day.
- **Location:** recorded — and then he overrode the "silent" half: it is SENT to the managers.

**How it is held.**
- `phoenix_crm_day_starts`, one row per seat per visit day per world, with a unique index that makes
  the press idempotent: a second tap returns the first row and tells nobody again. The time is the
  database's own `now()` and the day is the module's 02:00 rule — a feature whose whole purpose is
  "when did he really start" cannot take either figure from the phone being asked about.
- The row snapshots `planned_am_minute` from his SENT plan (`phoenix_crm_plan_day_starts.start_am_minute`),
  so the manager reads planned against actual and a plan edited later cannot change how punctual the
  morning looks. A rep with no sent plan is reported as exactly that.
- 🔴 **TWO EVENT TYPES, and that is the only thing holding "email to the DM only".** Channels are
  decided per event type and never per recipient, so `day_start_confirmed` sits on the email
  allow-list (the DM) and `day_start_seen` sits on the push-blocked list (the SFE: in-app and Telegram,
  with email unreachable even through the Telegram-failure fallback — the back door that put the daily
  digest on the phone once already). Collapsing them into one type silently mails the SFE ~74 times a
  morning.
- 🔴 **It is NOT one of the module's silent checks, and the button says so.** Every other reading in
  Phoenix CRM is invisible to the rep because it is a check ON him; this one is a report he MAKES, and
  that distinction only holds while he can read it before pressing. The third line under the button —
  "Your district manager and the SFE Manager see the time and where you are" — is part of the ruling,
  not decoration. Golden Rule #1 forbids a check he cannot see; it does not forbid this.

**Where his managers read it, and the silence that is part of the rule.** He asked the same day:
*"show the day start time on the manager's team day screen too."* It now appears on both manager
surfaces — the **day in full** (the page a calendar cell opens, `day-detail-view.tsx`: "Started
working: 08:42 · his plan said 08:00") and the **Team tab row** ("Started 08:42 · Planned AM 1 of 2
· …"), which is where the notice's own `tab: "team"` already sends him. The clock on both is the
server's time read in Cairo and the planned minute beside it is the snapshot on the row, so the two
screens and the Telegram message cannot print three different figures.

🔴 **A DAY WITH NO PRESS SHOWS NO LINE AT ALL, and that is the rule rather than an omission.** No
"not confirmed", no "not started yet" half. The press never blocks a visit and was never required of
him, so printing its absence would put a flag on every rep's row before the first press of a morning
— and on every day that passed before the button existed, which is the module's whole history up to
2026-10-03. `dayStartReadLine` and `teamTodayLine` both return the line unchanged when there is no
start, and the test asserts the word does not appear at all.

The Team tab's read is one batched query for the whole scope (`loadDayStartsBySeat`), beside the day's
figures rather than inside them: an SFE Manager's Team tab holds every territory in the company, and
the table's unique index gives at most one row per seat, so the reply cannot approach PostgREST's
1,000-row cap.

Pinned by `tests/phoenix-crm-day-start.test.ts` (section (f) for the two manager screens) and
`tests/phoenix-crm-team-today.test.ts`; the database half is
`supabase/migrations/20261003075803_phoenix_crm_day_starts.sql`.

## A visit is never dated onto an earlier visit day than its arrival — the 2026-10-02 audit

The owner's rule is **the visit day ends at 02:00 Cairo, and it is never a past or a future day**
(2026-09-29: "maximum 2 AM"). The account of the ruling itself is "The rep's flow rebuilt", earlier in
this file. This section is the account of the two paths that broke it, found by the 2026-10-02 Phoenix
CRM audit against `origin/main` f14fd8834, and of why one path keeps its exemption.

Yesterday is not a neutral place to put a visit. It is a day whose plan is closed, whose coverage and
call rate a manager has already read, and whose `visit_date` the one-a-day unique key, the
planned-or-not verdict and every report follow.

### 1. The offline claim — the real hole, and it is now the app's alone

`deriveOfflineCaptureTime` (`src/lib/phoenix-crm/offline-clock.ts`) bounds the claimed elapsed time
only from **above**: it may not exceed the window the server brackets with its own two readings, the
anchor it issued and the save it received. That bound is made of physics rather than trust, and it is
the right shape. **There is deliberately no bound from below**, and there must not be — a capture taken
moments after anchoring is exactly what an honest early-morning visit looks like, and a floor would
throw away real work. So `capturedAt = anchor.issuedAt + elapsed`, and a SMALL elapsed time back-dates
freely. The anchor may be 20 hours old (`ANCHOR_MAX_AGE_SECONDS`) and anchors are minted on demand,
60 an hour, by `POST /api/phoenix-crm/time-anchor`.

**The web app makes no offline claim at all.** Nothing under `src/components/phoenix-crm` has ever sent
an `offline` body or asked for an anchor; the queue that needs one lives in the app. (It had no queue of any kind
when this was written. Since 3 Nov 2026 it holds a press that lost signal and sends it again, dated at arrival:
see "The visit retry". That queue makes no claim either, so everything here still stands.) So in a browser
that field had no honest sender and one dishonest one: mint an anchor on Monday afternoon, post a visit
on Tuesday with `offline: { anchorId, elapsedMs: 0 }`, and `phoenix_crm_save_visit` — which accepts any
`offline_captured_at` within a day — files and counts it as Monday's.

The fix is structural rather than a tighter bound, because the capability no web screen ever used is
simply removed. `captureClientOf` (`src/lib/phoenix-crm/server/capture-client.ts`) answers `app` only
for a request carrying a bearer token and **no** session cookie, and `browser` for everything else:

- **Both a cookie and a bearer is a BROWSER.** `resolveAccessContextInner` tries the cookie FIRST and
  returns on it, so a request presenting one was identified by it. Reading this the other way would
  hand the capability straight back to the page that already holds the cookie — and that includes the
  app's own WebView, which carries a cookie of its own and renders the web portal's pages.
- **Neither is a BROWSER too.** A dev-auth role sweep, a system caller, an unauthenticated probe. It
  fails towards the answer that grants nothing, and losing an offline claim costs a visit nothing: the
  save still happens, dated at arrival, and the rep is told nothing (Golden Rule #1).
- **It is not authentication and decides no permission.** `assertPermission` and the territory gates
  are untouched. It answers one question: may this request's body move a visit's date backwards.

A browser's claim is dropped — not parsed, not partially honoured, not refused — and its mint answers a
flat 404, so the refusal says nothing about what was refused and no rep ever meets it. The client is a
**required** argument on both `saveVisit` and `issueTimeAnchor`, so the typechecker, not a convention,
stops a new caller forgetting it.

🔴 **What this does NOT close, and deliberately does not pretend to.** A bearer token is a token. A rep
who can reach `/api/auth/login` with an `x-phoenix-client` header can mint one for himself, and from
the server's side that request is indistinguishable from the app's. `src/lib/auth/native-session.ts`
already names the hardening that would answer it — a device-bound refresh token — as a later phase, and
this change does not fake one with a flag. What it removes is the path that needed nothing but devtools
on a page the rep is already signed into.

### 2. Photo-slot dating — smaller, API-only, and clamped in the database

A visit that names `photoPath` is dated by its slot's **issue** time (`phoenix_crm_take_photo` returns
`issued_at`), and a slot lives two hours. A `reusePlacePhoto` visit is dated by the place's own
`captured_at` — itself that photo's slot issue time — and the place need only have been created in the
last thirty minutes, so up to two and a half hours can separate the date from the arrival. Either can
carry a save arriving at 02:30 back across 02:00 onto the previous visit day.

Both are API-only today: the one-tap visit form sends no photo at all (2026-09-29), and the app sends
its own. Neither ever needed the reach. A slot proves **when the photo was taken**; it was never
evidence of which day the work belongs to.

`phoenix_crm_save_visit` now re-dates such a visit at arrival, with `capture_source` `server` and
`dwell_seconds` null rather than a made-up zero. Silently — the visit is real, so it is never refused
and never explained (Golden Rule #1) — and the row then reads `capture_source` `server` beside a
`photo_path`, which is how the Super Admin and the SFE Manager can see that it happened at all.

🔴 **The clamp compares VISIT DAYS, never calendar dates.** Written against the calendar it would move
an honest 23:00 photo saved at 00:30 a day forward and silently empty a rep's evening — the same defect
pointing the other way. `20261002222403_phoenix_crm_visit_day_never_before_arrival.sql`.

### 3. The offline anchor keeps its exemption, and must

A capture at 19:00 synced at 02:30 belongs to the **19:00** day. That is the entire point of the
offline design, and `tests/phoenix-crm-offline-clock.test.ts` has pinned it since the feature shipped:
"the arrival time deciding the day … undoes the entire feature". It earns the exemption twice over —
the server brackets the claim at both ends with its own readings, and after §1 only the app can make
the claim at all. So the clamp runs **before** the offline block, which overwrites it. Never "fix" the
two into one.

The Super Admin's `phoenix_crm_admin_enter_visit` is a different function and is untouched: entering a
visit a rep missed logging, on a day he chooses, is exactly what it is for.

### The trap

`tests/phoenix-crm-visit-dating.test.ts` finds the live `phoenix_crm_save_visit` by **sort order over
`supabase/migrations/`**, never by a path written into the test. A pin naming a migration file is how a
check quietly starts reading dead SQL — the text is still in the file and the database stopped running
it the day a later migration replaced it. The same reading repaired three pins this change would
otherwise have left stale: `SAVE_VISIT_DEFINER` in `tests/phoenix-crm-plan-review.test.ts`, the writer
assertions in `tests/phoenix-crm-visit-product-manager.test.ts`, and — a different shape of the same
failure — the `indexOf("const offlineClaim = parseOfflineCaptureClaim")` slice in
`tests/phoenix-crm-offline-clock.test.ts`, whose anchor the TypeScript half detached: `indexOf` would
have returned −1, `slice(-1, …)` returns the file's last character, and the "a clock argument must
never cost a rep a real visit" check would have passed on one byte with nothing going red.
## A seat's carried-over list belongs to the SEAT — owner's pick, 2026-10-02 (evening)

**What he was asked.** A rep who changes LINE but keeps his area: does his carried-over iReports360
doctor list follow him to the new seat, or does it stay with the seat he left? He was shown the measured
state and the consequence of each answer, and chose **the seat**.

**What the measurement said.** On production (`ozucdzovmcqvepbozvqf`), read 2026-10-02:

| Rep | From | To | iReports360 rows that moved with him | Already minted as pending |
| --- | --- | --- | --- | --- |
| AI-0002 | `SEAT-AIF-REP-AB1` (Anti Infective, Alex/Beheira 1) | `SEAT-PED-REP-AB1` (Pedia, same area) | 154 (145 AM/PM + 9 Pharmacy) | 105 |
| B-177 | `SEAT-AIF-REP-AB5` (Anti Infective, Alex/Beheira 5) | `SEAT-PED-REP-AB5` (Pedia, same area) | 189 (188 + 1) | 124 |

Both moves were effective 2026-10-01, same region and area, different LINE and different district
manager. `phoenix_crm_seat_reference` picks the seat's occupant and then reads **his** live
`crm_contact_assignments`, and iReports360 keys an assignment to the PERSON — so each pedia seat
inherited its rep's anti-infective doctor list, and `ensure_reference_customers` had already minted 229
of them as pending `phoenix_crm_customers` stamped `line_code = 'pedia'`. The rows were minted
2026-09-28 17:32 UTC, three days before the move took effect, because a future-dated occupancy row
carries `effective_to is null` and therefore reads as current from the day it is entered.

**Why the fix is safe, measured rather than argued.** The resolution now attributes each assignment to
the rep seat its agent held **when the assignment was made** (`rep_spells`). Compared seat by seat
against every REP seat in the company: **exactly two change**, both to zero, and no other seat's
reference moves by a single row. 8,568 of 8,597 live AM/PM assignments fall inside one of their own
agent's rep-seat spells; the 29 that fall inside none — one agent with no rep seat at all, plus four
strays — keep today's behaviour through an explicit fallback, which is the clause that makes the change
surgical instead of sweeping.

**The 229 rows.** All `pending`, `origin = 'reference'`, with no place, no visit, no plan item, no list
request, no unplanned visit and no visit ask — nothing had happened to any of them; their only record is
one `customer_minted` event each, which is KEPT (nothing references
`phoenix_crm_list_events.customer_id`). They are deleted by
`20261002224250_phoenix_crm_seat_reference_and_place_removal.sql`, pre-imaged first into
`phoenix_crm_backup_20261002.misminted_reference_customers` in the same transaction, because production
has no point-in-time recovery.

🔴 **The one thing this must never be confused with.** A pending row whose assignment merely **ENDED**
is not this. That one survives on purpose (`20260922233000`, the owner's rule 1: a carried-over customer
leaves the list only by being validated or removed), and the cleanup's predicate excludes it by
requiring that the assignment was made during a spell in ANOTHER seat and during none in this one.

## Removing a clinic is kept exactly as a move is — 2026-10-02

Moving a validated place has needed a written reason and an audited event since 2026-09-29, and
re-measures every visit to the customer. **Removing** one — the same two seats, the same consequence for
where the customer is — had neither: `phoenix_crm_update_place` wrote `place_retired` with `'{}'` for
details, so *why* a clinic went existed nowhere at all, and the visits already stamped against it kept
their distance and their "ok", measured against a door the movers had just decided was not the
customer's. A wrongly added clinic is precisely how a far visit reads as near on the place-vs-actual
report, so the removal is now kept and re-measured identically: a reason of 10–500 characters on the
event, and `restampVisitLocationsQuietly` with scope `all`.

Two shapes were found beside it and closed in the same change:

- **Two doors to the same RPC.** `updatePlace` (the rep's edit path) also accepted `action: "retire"`.
  `assertPlaceMover` guarded it, so it was never a privilege hole — it was a second implementation, and
  a removal through it would have carried neither the reason nor the re-measure, silently. It refuses a
  removal now; `retirePlace` is the one door.
- **A clinic captured AFTER a visit was judging that visit.** Scope `all` measured every visit against
  every ACTIVE place, which is the laundering `visit-locations.ts`'s own comment says cannot happen: a
  second clinic added in October plus any later move retroactively made a September visit "ok". Each
  visit is now measured only against the places captured before it, falling back to the EARLIEST place
  for a visit logged before the customer was validated — which is the other half of the owner's rule of
  2026-09-29, that his earlier visits get their distance from the place the validation captured.

## The exceptions board and the 06:55 digest count WORKING days — the 2026-10-02 audit

The owner's call-rate rule has two halves, both settled long before this: **working days are Saturday
to Wednesday** (2026-09-05, *"donot count thursday as working day"*, superseding his own earlier
"count Thursday as 0.5"), and **national holidays come out of them** (2026-09-02, *"if we have a
national vacation in this week, then the week will be four"*). `src/lib/crm/call-rate.ts` has
implemented both since those dates, as `isCallRateWorkingDay`.

The exceptions board did not use it. `src/lib/phoenix-crm/exceptions.ts` carried a rule of its own,
`isFieldDay`, which excluded **Friday alone** — so Thursdays and public holidays sat in both halves
of the call rate it reports.

### What that cost, in figures

- **A perfect week read as a failure.** A rep who made exactly **10 PM calls on each of Saturday to
  Wednesday** — the owner's own standard, met exactly — was divided by **six** days instead of five:
  50 / 6 = **8.3 a day against 10**, and the board listed him *"Below the PM call rate"*. The AM half
  did the same against its target of 2. Nothing anywhere said the sixth day was a Thursday.
- **The 06:55 digest judged Thursday every Friday morning.** It reads a window of ONE day and
  resolved it as "the last day that was not a Friday", so on a Friday it reported on **Thursday** — a
  day that holds no PM call by design, because Thursday is a morning for accounts only
  (`planDayListTypes`). Every active territory therefore produced *"Below the PM call rate · 0.0"*,
  and on a **holiday** Thursday — such as **8 October 2026**, Armed Forces Day moved from the 6th —
  *"No visit on the last field day"*. That is pushed to managers' Telegram, which is the same flood
  as 2026-09-28 wearing a different cause.

### What it is now

Both read `isCallRateWorkingDay`, imported and never re-derived, so the board can no longer disagree
with Reps List or the KPIs board about which days a rep owed work on:

- `isWorkingDay(isoDay, holidays)` replaces `isFieldDay`; `RATE_WINDOW_WORKING_DAYS` replaces
  `RATE_WINDOW_FIELD_DAYS`; `TerritoryFacts.windowWorkingDays` and `lastWorkingDayVisits` replace
  their "field" spellings, so no name says "field day" while meaning something narrower.
- `lastFinishedWorkingDay` returns **`null`** when no working day has finished inside a month, and
  `lastWorkingDayVisits` is then null rather than 0 — a fallback to `cairoToday` would have the board
  judging a day the rep is still working, which is the noise the "day that has ENDED" rule exists to
  remove. `judgeTerritory` suppresses `no_visit` on a null.
- **The digest SKIPS a morning with no working day behind it** and reports that it did
  (`skippedNotAWorkingDay` on the run), because a correct silence must be tellable from a broken one.
- 🔴 **An unreachable holiday calendar is SAID, not swallowed** (`holidaysUnread`, on the board and in
  the workbook). `loadCallRateHolidays` never throws — it returns `complete: false` — and a missing
  holiday leaves the denominator too generous, so a rate reads LOW for a reason nobody performed.
  A failed data source must never read as a real answer.

Pinned by `tests/phoenix-crm-exceptions.test.ts` (which names the 8.3 figure both ways, so the fix
cannot be reverted quietly) and `tests/phoenix-crm-daily-digest.test.ts`.

## Approved leave is not an exception — owner's ruling, 2026-10-03

Found on **Delta (1)'s go-live morning**, and found by him, not by a test. Walking the board for the
region that went live that Saturday turned up one rep with no plan for the live week —
**Ragaa Mosaad Mahmoud Ahmed Shabaan**, Anti Infective D16 — and the board listed her for it. His
answer was one line: *"RAGAA IS SICK LEAVE"*.

**Two separate things were wrong, and only one of them was code.**

**One — the board could not see leave at all.** Neither `src/lib/phoenix-crm/exceptions.ts` nor its
server half contained the word *leave* anywhere; the only match was the English word "leaves" in a
comment. Meanwhile the plan-vs-actual report already honoured it — *"A customer planned on a day HR
approved the rep's leave, and not seen, is on leave: never missed"* — so **two reports in the same
module disagreed about the same rep on the same day**. A manager reading the board was being told to
chase someone signed off sick.

His ruling, chosen over hiding the row: **"Show 'On leave', not an exception."** So leave now does
two separate jobs:

- **A week signed off in FULL leaves the exception ladder entirely.** It is not "no plan this week" —
  there was no week to plan. It is listed in `board.onLeave` and counted in `summary.onLeave`,
  **never in `needingAttention`**, which is the figure the 06:55 digest sends and the one a manager
  acts on. It stays visible because an uncovered territory is worth seeing; hiding it would trade one
  blind spot for another.
- **Approved leave comes out of the call-rate denominator, exactly as a national holiday does.** Six
  working days with two full days of leave is a four-day week for that rep. Dividing his real calls
  by six reports a rep who worked every day he owed as "below the rate" — the same defect the
  Thursday fix removed, arriving through leave instead of the calendar.

**Part-week leave excuses nothing but its own days:** two days off does not excuse the plan for the
other three, and a half day still answers "anything?" because the rep worked the other half.

🔴 **Full days only, and that is deliberate.** `ApprovedLeaveDay` reduces the stored `day_part`
(`full_day` / `am_only` / `pm_only`) to a bare `fullDay` boolean, so by the time leave reaches any
reader it no longer says *which* half was taken — and that type has **fourteen consumers** across
attendance, the CEO command centre and compliance, so widening it was not this fix's business. A half
day therefore changes nothing here. Guessing the half would either excuse work that was owed or
accuse work that was not; the conservative direction is the one that never silently forgives.

🔴 **`leaveUnread` is the half that matters most.** `loadApprovedLeaveDays` throws, so a failed read
is caught and said out loud on the board and in the workbook. "Nobody is on leave" is the one wrong
answer that *invents* a chase, so it is never the silent default.

**Two — the data was not there either, and no code could have fixed that.** Her sick leave was
recorded nowhere: no row in the vacation requests for those dates, no excuse row. And a correction
worth keeping — I first reported that the system had **no `sick` type at all**, having grouped the
rows that exist and found only `annual`, `compensatory`, `emergency` and `other`. He pushed back
(*"NO THEIR IS SICK TYPE CHECK"*) and he was right: the CHECK constraint reads
`vacation_type = ANY (ARRAY['annual','emergency','sick','other','compensatory'])`. **`sick` has
always been allowed; it simply has zero rows system-wide**, so grouping the data could never see it.
No migration was needed. That is the same shape as Head Office being absent from
`phx_monthly_achievement` — **no rows is not the same as not supported** — and it is why a schema
question is asked of the schema, never of the rows.

Pinned by `tests/phoenix-crm-exceptions.test.ts`.

## The SFE's list template — owner's ask, 2026-10-02 (evening)

**What he asked for.** Put the question of who grades an add on a territory with no district manager, he
answered with a third option of his own: *"make a third option for SFE and system administrator … with
the download and upload template of the list … the SFE will send him an Excel sheet and he will populate
it with the list, then he [sends it back to] the SFE and SFE uploads this sheet so his list appears …
regarding the template that will be downloaded, put in its field every single thing you need. Every
single data you need. Put it to be populated."*

**What the sheet carries, and the one thing it cannot.** Every fact about a CUSTOMER is a column: his
list (AM, PM or Pharmacy), name, speciality, grade, potential grade, phone, where to find him and a note
for the rep. 🔴 **The PLACE is not a column and must never become one.** A place is validated once, at
the door, from a live signboard photo and a GPS read taken on the spot, and its address, brick, area and
region are resolved server-side from that point. A latitude in a spreadsheet is a typed location, which
is the one thing that rule exists to forbid. So a loaded customer lands as `pending` and the rep
validates him at his clinic exactly as he validates one carried over from iReports360 — "his list
appears" is satisfied: they appear under **To validate**. The sheet says so on its own face, above the
table, because otherwise somebody will add the column.

**Where the grade comes from.** A rep never sets one. On the ordinary path the district manager confirms
the A/B/C and sets the potential, then SFE admits, one customer at a time — and that path is unchanged
and remains the normal one. This route exists for the list that cannot travel it: a territory whose
manager chain is vacant, a seat being staffed from scratch, a whole list at once. The SFE who uploads is
the one who graded it, in the sheet, and the load is recorded as his act (`list_loaded` plus a
`customer_loaded` event per row, both naming him).

**The shapes that had to be built for it to work at all.**

- **`listed`, the third validate mode.** A loaded customer has no iReports360 contact, so
  `phoenix_crm_reference_entry` can never find him and the reference branch cannot serve him. `listed`
  validates a customer already on the list, by id, `pending` only — which is what the retired `restore`
  mode was structurally, minus the hole it carried (it reached a customer in the ARCHIVE and inserted an
  active place onto him).
- **`rowActionFor` stopped asking for a contact id.** It fell back to Open for a pending row with
  `referenceContactCrmId === null`, because the Validate screen could only open on a live vendor entry —
  so a loaded customer would have sat on the list with no way off it, the exact shape rule 1 forbids.
- **`intake_where` and `intake_note`.** The rep has to know which door to stand at for a doctor he has
  never visited, and a loaded customer has no iReports360 address to show him. `where` is a NOTE and
  nothing measures it; the place is still captured at the door.

**Two guards worth keeping in mind.** The sheet names its own territory and an upload against a
different one is refused — two sheets filled for two reps are otherwise one slip from loading the wrong
rep's doctors, and nothing downstream would notice. And the List cell is canonicalised before
`parseListType` sees it: that parser answers `PM` for anything it does not recognise, which is right for
a stored value and catastrophic for a typed cell, because a pharmacy typed in lower case would be filed
among the doctors and counted in their KPIs with nothing going red.

## A manager validates a customer already on the list — `reference` AND `listed`, 2026-10-03

The 2026-10-02 rule read **"a manager may validate only the `reference` mode"**, and its reason was
stated in the same breath: *"Add new customer" and an out-of-list validation FILE A REQUEST whose
first step is the territory's reviewer, and that is him — he would propose and approve in one act.*

`listed` did not exist when that was written. A customer the SFE loaded from a sheet **files no
request**: he is already on the list, already graded by SFE, and what is left of him is the door — the
live photo and the GPS the frozen-place rule reserves for the clinic. By the rule's own reason he
belongs with `reference`, not with `new` and `outside`.

**And the hole was real.** The manager-validates screen exists for a **vacant** seat, whose list
nobody else can work through. The list template exists for a territory whose manager chain is vacant
or whose seat is being staffed from scratch. Those two overlap exactly: a seat with no rep yet, whose
list SFE has just loaded. With the manager held to `reference` alone, every one of those customers
would have sat in To validate until somebody was hired.

Asked directly on 2026-10-03, with the three options spelled out — the manager too, the rep alone, or
the manager and the SFE Manager — the owner answered **the manager, same as carried-over**. The SFE
Manager was not extended: he loaded the sheet, but validating means standing in front of the clinic
with the camera, and a place is captured once, at the door, for good.

Unchanged by this: `territoryForRepWrite` is not widened, so the plan, the day activities, the
forecast, the drop, the grade, the add and the hours are still the rep's alone; scope still runs
downward only; and the place photo slot still takes the validation gate rather than the narrower one.

## The SFE list template run end to end on production — 2026-10-03, and the defect it found

PR #5202 shipped at 07:44 Cairo. The owner then asked for a **test-world list load for SEAT-PED-REP-AB1
end to end on production**, because the one layer no test could reach is the database — and the review
had already found the feature dead at exactly that seam.

### The defect: a guard that never fired

`phoenix_crm_load_list_customers` refused an ungraded doctor like this:

```sql
if v_list_type <> 'Pharmacy' and (v_grade not in ('A','B','C') or v_potential not in (...)) then
```

An empty sheet cell leaves `v_grade` NULL. In SQL **`NULL not in (...)` is NULL, not TRUE**; `NULL or
NULL` is NULL; and `if NULL then` does not fire. So a PM doctor with no grade and no potential was
**INSERTED** onto the list as `pending` with `grade = NULL`, against the owner's locked rule that every
doctor on a rep's list carries A/B/C and a potential set by his district manager or by SFE.

It was invisible for a precise reason: `parseTemplateRow` in TypeScript refuses the same row before the
RPC is ever called, so the upload path was safe and the whole suite stayed green — while the function
whose own comment says *"Checked again here because this function is the authority"* was not an
authority at all. **A guard that only holds when its caller already held it is decoration.** Fixed by
migration `20261003075335` with `coalesce(..., '')`, applied to staging and production, and pinned on
both halves by `tests/phoenix-crm-list-template.test.ts` (`checkGradeGuard`).

The verdicts either side of it were all correct — `pharmacy_has_no_grade`, `already_on_the_list`, and
both well-formed rows — which is why nothing looked wrong.

### What the run proved, after the fix

| Step | Result |
| --- | --- |
| 4 bad grade shapes (none, grade only, potential only, `X`) | all `grade_required` |
| A fully graded doctor | loaded |
| `listed` with an id nobody has | `phoenix_crm:customer_not_found` |
| An unknown mode `listedd` | `phoenix_crm:bad_input` — the branch list is closed |
| `listed` on a real pending customer | validated: `active`, `validated_at` set, a place captured, no request filed |
| The same one twice | `phoenix_crm:already_validated` |
| One moved to the Archive | `phoenix_crm:archived` |
| Reached through another seat | `phoenix_crm:customer_not_found` |

Two guards were satisfied by hand and only two — the photo slot the app's own issue endpoint writes, and
a `storage.objects` row standing in for an uploaded file. Neither is the link under test.

### What the probe left behind, and why

The Supabase tool **declined every destructive statement** of the cleanup: the batched `DELETE`s, a
single narrow `DELETE`, and the `DROP FUNCTION`. That is its guardrail, and it was not routed around.

What landed instead was a `REVOKE`, which is not destructive — and it mattered, because the two probe
functions had been created in `public` and so inherited the schema default: their ACL read `=X/postgres`,
the bare `=X/` being **PUBLIC**, which `anon` and `authenticated` inherit. After the revoke both read
`postgres=X/postgres | service_role=X/postgres`, the same shape as every real Phoenix CRM function. The
exposure was closed from that day; what remained was inert debris.

**The two functions are now gone — `20261003075838` was applied on production on 2026-10-07**, ledger
version `20261007203921`. `supabase-production` declined the `DROP FUNCTION` a second time that day, and
it ran through the account connector the owner allowed on 2026-10-05; one apply, one ledger row,
`statements` populated. Verified against `pg_proc` rather than the ledger: 0 functions matching
`zz_probe%` in `public`, `phoenix_crm_validate_customer` untouched, and `function_search_path_mutable`
gone **entirely** from the security advisor — the lint no longer appears, where before it was WARN with
exactly these two findings.

🔴 **Four days is the cost of the gap, and it is the measurable half of the lesson below.** The file and
this document both said, correctly, that the drop had not run — but nothing was watching that sentence,
so the two functions stayed on production as the only two `function_search_path_mutable` findings until a
session auditing that WARN found them cold and re-derived this entire account. A statement of what did
*not* happen needs an owner and a trigger, or it becomes the next session's investigation.

**The durable lesson:** a throwaway probe gets the same treatment as shipped SQL, or it is not
throwaway — it is an undocumented object carrying the schema's default grants. A probe that must return
rows belongs inside a transaction that drops it, or nowhere.

### The contradiction a reviewer caught, which is the sharpest lesson here

`20261003075335`'s first header said the probe's ungraded row *"is deleted in the same session"*. **It
was not.** That sentence was written while planning the cleanup, the tool then declined every
destructive statement, and the header was never revisited — so for one commit the migration told an
operator the invalid row was gone while this very document, in the same commit, said the test rows
remained. The two halves of one change disagreed, and the half somebody cleaning up would read was the
wrong one.

That is `AGENTS.md` §1's "confidently wrong" in its most expensive form: not a claim nobody checks, but
a claim that **replaces** the check. The rule it earns is narrow and worth keeping — **a note about what
you did to a database is written after the last statement lands, never beside the plan**, and a header
that describes an outcome has to be re-read when the outcome changes.

The row itself: `ZZ Test Doctor No Grade` (PM, no grade, no potential) could not be deleted, so it was
**UPDATEd** to carry `B`/`BB`. An UPDATE is not destructive and the tool allows it, so the invalid shape
is gone and the row is now ordinary test data. Measured after: **0** ungraded doctors anywhere on that
seat.

### Nothing is left on production — cleared 2026-10-08 on the owner's word

**The probe left nothing behind.** The two functions went on 2026-10-07 (above); the owner then said
*"clear the ZZ test rows on SEAT-PED-REP-AB1"* and the rows went on 2026-10-08. Measured before:
5 customers named `ZZ …`, 1 place, 8 list events, 1 photo-upload row, 1 `storage.objects` row — and
that was the WHOLE footprint, swept across all 26 `public` tables carrying both `seat_id` and
`is_test`, not just the ones somebody remembered. Measured after: **0, 0, 0, 0, 0.**

What the clean-up taught, which the statement list below had wrong:

- 🔴 **`delete from storage.objects` CANNOT RUN AT ALL** — `storage.protect_delete()` raises `42501`,
  *"Direct deletion from storage tables is not allowed. Use the Storage API instead."* The statement
  sat in this document for five days as the documented way to do it. A storage object goes through
  `DELETE /storage/v1/object/<bucket>/<path>` with the service-role key; here that was
  `phoenix-crm-photos` / `zz-probe/SEAT-PED-REP-AB1/listed-place.jpg`, answering `200
  {"message":"Successfully deleted"}`, which removes the file and its row together.
- 🔴 **`phoenix_crm_customers` has EIGHT child foreign keys and not one of them cascades** — seven
  `NO ACTION`, `phoenix_crm_customer_moves` `RESTRICT`. The three-table delete order below therefore
  only works because every child happened to be empty, which was measured (with a positive control)
  rather than assumed. On any other seat it would raise instead.
- 🔴 **`is_test = true` is NOT a synonym for "the probe's rows"** — production carries **1,724** test
  customers on other seats, and this seat itself carries **105 real `is_test = false` list events**.
  The seat-plus-flag scoping is load-bearing; an unscoped version of any of these is a real incident.
  Note that "real rows on that seat: 0 before, 0 after" was only ever true of *customers*.

The pre-image is `crm_backup_20261008` — five tables holding all 16 rows, in a dedicated schema with
`public`, `anon` and `authenticated` revoked, deliberately **not** a `public.zz_backup_…` table
(`ad-hoc-backup-tables-are-anon-readable`). The storage object's bytes are not in it, only its row.
Drop the schema once nobody wants the rows back.

The row deletes, as actually run — one statement, every count asserted, raising and rolling back the
whole thing on any surprise:

```sql
do $$
declare c_ev int; c_pl int; c_cu int; c_ph int;
begin
  delete from public.phoenix_crm_list_events   where seat_id = 'SEAT-PED-REP-AB1' and is_test = true;
  get diagnostics c_ev = row_count;
  delete from public.phoenix_crm_places        where seat_id = 'SEAT-PED-REP-AB1' and is_test = true;
  get diagnostics c_pl = row_count;
  delete from public.phoenix_crm_customers     where seat_id = 'SEAT-PED-REP-AB1' and is_test = true;
  get diagnostics c_cu = row_count;
  delete from public.phoenix_crm_photo_uploads where path like 'zz-probe/%';
  get diagnostics c_ph = row_count;
  if c_ev <> 8 or c_pl <> 1 or c_cu <> 5 or c_ph <> 1 then
    raise exception 'ABORT, nothing committed - unexpected counts: events=%, places=%, customers=%, photos=%',
      c_ev, c_pl, c_cu, c_ph;
  end if;
end $$;
```

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
- 🔒 **THE CALL RATE IS NEVER AVERAGED — AM against 2, PM against 10, reported APART.** Owner 2026-09-04: *"this two and this ten. Don't never get average."* There is deliberately NO combined figure anywhere — not on a row, not in the team totals, not as a band, not as a URL param — because every way of merging the two lets a good morning pay for an afternoon that never happened: 2 of 2 AM with nothing after lunch reads 50% averaged and 17% over one denominator, when the true answer is 100% and 0%. **Never print the pair with a slash** — he read `1.63 / 6.57` as *1.63 out of 6.57*; the separator is ` AM · ` / ` PM`. Pinned by `runKpiAttainmentAndIdentityTests` in the required CI `validate` job.
- Marketing Manager is hidden from the portal Incentive tab; GPM still sees it.
- The Organogram / AU seat model is the source of truth for org-structure and vacancy data.
- **SoS attribution is PERIOD-AWARE — read the function, never the old "today's geography" shorthand.** `au.f_monthly_attribution` and `au.f_monthly_achievement` resolve an area's region through `au.f_line_area_map_asof(period_end)`: the map as it stood at the END of the month being computed, so a forward-dated move leaves earlier months intact. It only LOOKS like today's geography because almost no `au.line_area_map` row has ever been closed. The shorthand this replaces also contradicted the August / Delta golden rule below, which forbids resolving closing geography at the run date.
- 🔒 **A CRM account label is `[Name ]( Area / Line )`, and `E`/`F` are RETIRED line codes.** The area sits between the brackets, the line is the letter after the final `/` or `-`. **`E` became `A`; `F` became `P`** — live codes are `A`, `C`, `P`, so a trailing `/ E` or `/ F` is old naming and **never an open question**. **The CRM admin never deletes an account**: he deactivates, strips the name, keeps the area, then CLONES — so a leaver's identity is unrecoverable from the CRM. **Cloning is safe; RENAMING is what corrupts numbers.**
- **Delta (3) territory move — LIVE, dated 2026-09-01, applied as a migration 2026-08-29.** The five areas (`D11`, `D24`, `D25`, `OT2`, `OT9`) sit on a dated PAIR, so **nothing is owed on 1 September** — do not re-apply, re-date or "finish" it. Resolver gap CLOSED both directions; recruitment CLOSED and `recruitmentAreaRegionOverrides` is PERMANENT. Keep the pre-image `delta3_defer_backup_20260829.line_area_map_pre`. **The SALES geography is DELIBERATELY LEFT ALONE (owner, Option A) — do NOT repoint `code_region_code`**, which can silently hide a district manager's own sales.
- 🔒 **THE AUGUST / DELTA (3) GOLDEN RULE — the August closing NEVER contains Delta (3), whenever it is published.** Owner: "golden rule, no negotiation", twice in one breath. **Already enforced — do not rebuild it**, at four levels including `runClosingPeriodDatingTests`, in the required CI `validate` job. **Never resolve closing geography at the run date**, and never offer to publish August "now that the move is live" — the date is the mechanism.
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

## A rep's first Phoenix CRM visit — owner ruling, 2026-10-03

*"Very important task to be prioritized now. Every rep submit visit on Phoenix CRM … only the first
visit for each medical rep … his district manager, his national sales manager and the SFE goes to them
an email and Omar in the BCC. Example: Aya Ibrahim submitted her first visit at the account and its
name, and the time the visit was submitted in."*

**Why he asked for it on this day.** Measured the same morning: `phoenix_crm_visits` held **7 rows, all
of them test entries**, from two Super Admin logins — not one real visit in the whole table. Delta (1)
starts on the module on **Saturday 3 October**, so every real first visit in the company is still ahead
of this rule rather than behind it, and nothing had to be backfilled. That also makes the rule cheap to
get wrong in the one direction that matters: a rep announced twice, or announced weeks late because a
read failed, is a message about a real person that cannot be recalled.

**Who is told, and how each one is resolved.**

| He said | What the code resolves it to | Why that, and not the literal seat |
| --- | --- | --- |
| his district manager | `managerChain[0]` — the nearest OCCUPIED manager seat above the territory | 4 of the 23 district seats are vacant (measured 2026-10-03). A literal DM seat would tell NOBODY for those reps. It is the same person his grade request and his weekly plan go to, so "his manager" means one thing across the module. |
| the Pedia RSM (added the same day) | every other occupied manager seat in the chain | See the correction below — the rule is the TIER, so the whole chain is addressed and no tier is enumerated. |
| his national sales manager | the chain's `NSM` seat, which the chain already includes | Each line has exactly one, and all three are occupied — Anti Infective `AI-0008`, CNS `B-122`, Pedia `A-12`. |
| the SFE | `sfeManagerHrIds()` | The SFE Manager is a ROLE with no seat in the organogram, read from the accounts — the same list the plan edit's SFE step and the daily approval nudge already use. |
| Omar in the BCC | **nothing in the module** | `sendPhoenixEmail` already puts `ADMIN_STANDING_EMAIL` on the BCC of EVERY email the system sends. Wiring a copy here would send him two. |

**🔴 THE REGIONAL MANAGER WAS LEFT OFF FIRST, AND THE OWNER CORRECTED IT THE SAME DAY.** He had named
three people, so the first shipped version addressed exactly those three and said so; he answered *"add
the Pedia RSM to the first-visit email"*, and `firstVisitDeliveries` now addresses **`managerChain`
entire**.

**🔴 AND THE SEAT IS NOT WHERE THIS DOC FIRST SAID IT WAS.** The company's one regional seat
(`SEAT-PED-RSM`, `PD-0001` Hany Saad) is labelled *"PEDIA RSM (Alex-BHR, Delta (1), Delta (2))"* and
covers exactly those three regions — **17 rep seats, 13 occupied**, measured 2026-10-03. **Pedia Upper
Egypt 1 sits straight under the NSM** and has no regional manager at all, so the first write-up of this
rule — and #5198's own PR body — named the wrong chain. It matters in his favour: **Delta (1) is the
team that started on the module**, so the regional manager is on the very first emails of the rollout,
which the wrong description made look like a quiet edge case. The code was never wrong, because it reads
the live chain and never a region name.

**Why the fix is the whole chain and not "DM + RSM + NSM" written out.** A tier list is wrong in the
direction that looks right: a second regional seat, or a tier added between, is **silently** missed, and
the email still arrives — just without the manager appointed most recently, which nothing surfaces. The
chain cannot under-report that way. It also cannot over-report: the manager tiers are exactly `DM`,
`ACTING_DM`, `RSM` and `NSM`, `managerChain` never reaches the CEO, and it already skips a seat the
territory's own rep holds. The vacant-district rule then stops being a special case at all — an empty
seat is simply not in the chain. Pinned by *"the district manager, the regional manager between, and the
national manager — every occupied seat above him"*, which fires the moment the tier list is restored.

**And never the rep** (Golden Rule #1 — his app never lets him feel the system is watching him begin).
This is not theoretical: an acting district manager holds his own REP seat **under** his acting seat, so
the chain's nearest manager for his own territory is himself. The recipients are compared with
`personKey`, which is what keeps him off his own notice, and the same comparison drops a rep who happens
to hold the SFE role.

**"Submitted" names the person doing it.** A double visit the district manager entered, and a visit the
Super Admin entered for a rep who missed logging one, are not that rep's first submission — so the gate
is `enteredAs === "rep"` and the read asks about `entered_by_hr_id`, the actor, not `rep_hr_id`.

**Once per rep, ever, and the key is what guarantees it.** Every other notice in the module keys its
`idempotencyKey` on the thing that happened — a request id and a version, a visit id, a territory and a
day. This one keys on the **REP** (`phoenix_crm:first_visit:<hr id>`), because the promise is about the
person, not the event: a retried save, two visits landing in the same second, or any future second
reading of "this is his first" upserts the same `notification_events` row instead of sending a second
email. `personKey` normalises the id first, so a lower-case HR id cannot slip a duplicate through.

**A failed read answers NO.** `isFirstVisitSubmittedBy` returns `false` on an error or an unreadable HR
id. The asymmetry is the point: a missed announcement is a line nobody sees, while a wrong one tells
four people that a rep who has been working for weeks has just started.

**What it costs per save, and the index that makes it cheap.** The question "has this person submitted a
visit before?" had no index — `entered_by_hr_id` was indexed nowhere — and `limit 1` cannot stop early
in exactly the case the notice exists for, a rep with no earlier row. At the ~600 visits a working day
this module is built for that is a full scan per save, so
`supabase/migrations/20261003000705_phoenix_crm_visits_entered_by_idx.sql` adds
`(entered_by_hr_id, captured_at)`. Applied and verified in `pg_class` on staging
`cifwmndunmlxjhyjugxa` and production `ozucdzovmcqvepbozvqf` on 2026-10-03.

**The time in the email is the SERVER's.** `captured_at`, as the save returns it, rendered by
`formatPhoenixDateTime` — "7:42 PM, Saturday, 3 October 2026", Cairo local. The phone's clock dates
nothing in this module, which is the whole reason the save hands the stamp back.

**🔴 The customer's name is bidi-isolated, and it is the only run on the line that is** (owner,
2026-10-03, after reading the rendered wording: *"isolate the Arabic customer name in the first-visit
email"*). **Every** Phoenix CRM customer name is Arabic — 12 of 12 sampled on one real production seat —
so this one sentence always mixes an RTL run into LTR text, and the neutral punctuation beside it
resolves to the paragraph's direction and can display on the wrong side of the name.

`src/emails/phoenix-email-layout.tsx`'s `renderEmailParagraphs` already wraps each **line** in FSI … PDI.
That is correct for a single-language line and does **nothing** for a run inside one — the granularity
the `bilingual-bodies-need-direction-per-line-not-per-block` rule is about, met here from the other
side: the line itself mixes both languages, so isolating the line only sets the paragraph to LTR (FSI
takes its direction from the first strong character, the rep's Latin initial) and leaves the Arabic run
bare. So `bidiIsolate` is applied where the name is **interpolated**, in `firstVisitDeliveries`, which is
also the only place that knows which substring is the name. The nested isolate that results is legal and
intended.

**Two deliberate choices inside that.** It goes in the **shared message**, not an email-only layer,
because the bell, Telegram and the phone show the same string and have the same problem. And it is
applied **before** HTML-escaping, although `bidiIsolate` is documented for after it: FSI and PDI pass
through `escapeEmailHtml` untouched, and this value is not HTML. Rendered against the real Delta (1)
chain, the body reads `… on Phoenix CRM: ⁨احمد زهران⁩, Qalubeya · Pedia, at 10:12 AM …` — exactly one
isolate opens and one closes. Stripping the two marks leaves the sentence that shipped before them, which
is what the test asserts: the **wording** did not change, only the direction handling.

**What it is NOT.** It is the module's fifth emailed event type and the first that is not a step of
anything: nobody who reads it has to act, and the message says so. It raises no approval, appears in no
queue, and changes no figure. Rule: `.claude/rules/phoenix-crm.md`. Pinned by
`tests/phoenix-crm-first-visit.test.ts` (who is told, the once-ever key, the words, the save-side gate)
and by `tests/phoenix-crm-email-block.test.ts`, which holds the whole emailed list to exactly five.

## The rep honour strip's two watermarks — owner's layout, 2026-10-03

He designed this strip himself over one morning, correcting it five times while watching the running
page. The rule is in `.claude/rules/portal.md`; this is what each correction was and what it measured.

**The layout.** *"You will make it white, striped horizontal and vertical; at the left is PHX logo
watermark and the right Sato logo watermark, and the ranking centered in between."* A navy band was
tried first and rejected. Then *"replace Arabic Sato logo with normal logo"* — so the mark is
`public/brand/sato-pharma-logo-on-light.png`, never `sato-pharma-arabic.png`, and the
`sato-pharma-identity` skill's "Arabic wordmark as watermark" guidance does not apply here.

**"Mobile view is different than desktop view."** It was, and the cause was structural. The marks hung
off the **capped plate** (`max-w-[34rem]`), which stops growing at 544px while the band does not — so
on a 351px band they sat at the band's edges and on a 668px band they sat ~116px inside it. They hang
off the **band** now. Nothing about the strip may re-introduce a mark positioned against the plate.

**"But resize based on the view, do not fix a size."** Every size is a `cqw` clamp against the strip's
own width — the `<section>` carries `@container`. 🔴 **Without that class `cqw` silently resolves
against the viewport**, which is a different number on every page that embeds the strip, so the
`@container` is load-bearing and is pinned by its own assertion.

**The sizes, corrected four times in one morning.** *"In desktop view the logos are very small"*,
*"bigger a bit again in the desktop view"*, then *"PHX logo size OK — the Sato logo make a bit smaller,
same size as the one above"*, then *"also in mobile view needs to be … a bit bigger"*. Each change moved
one end of a clamp and left the other alone, which is the whole reason the sizes are clamps:

| band width | Phoenix mark | Sato mark |
| --- | --- | --- |
| 351px (phone) | 24 → 28 → 32 → 38 → **46px** | 33 → 34 → 40 → 44 → **48px** |
| 668px (laptop) | 24 → 47 → **73px** | 33 → 53 → 83 → **57px** |

🔴 **The Sato mark's desktop size is not a taste call — it MATCHES the identity card's own mark directly
above it**, which is `h-7 w-auto` and measures **57×22**. The strip's measures 57×22 at a 668px band.
That card hides its mark below `sm`, which is why the phone is free to carry a larger one.

**"Align them on the same line" — and the real reason it looked wrong.** Anchoring each mark to the
band's bottom put their **bottom edges** on one line, which is not the same thing, so they moved onto one
`flex items-center` row. That still was not enough, and he said so again about mobile. 🔴 **Centring the
BOXES does not centre the INK.** Measured off the real files: the Phoenix ink centre sits at **46.78%** of
its 1024×1024 canvas and its ink fills only **64%** of it, while the Sato ink is centred at **50.00%** and
fills **93%**. So the Phoenix mark read as sitting high. A `translate-y-[3.2%]` on that image — in its
OWN height, so it survives every clamp — puts the two ink lines on one line: measured **0.01px** apart at
both 351px and 668px, with the boxes themselves 1.5px and 2.4px apart. The `sato-pharma-identity` skill
states the general rule this is an instance of: align a Sato mark to its **ink**, never its file edges.

**The clearance has to scale with the marks, and the tightest width is not the phone.** A fixed padding
against a growing mark is a collision waiting for a wider screen — a `px-10` foot left **2px** between
the Sato mark and the share control at 375px. Both paddings are `cqw` clamps now. The worst case is the
**~544px band**, where the plate still fills the strip *and* the marks have already grown with it; above
it the plate caps and the bare band margin `(w − 544) / 2` does the clearing by itself.

**He then rebuilt it from a banner of his own.** He sent a picture of an existing Phoenix band — Sato
left, a dateline centred under a short orange tick, Phoenix right, on faint ruled paper — and said
*"exactly like this, but logos are watermarked and instead of date put rankings."* That reversed the
sides this strip had carried all day, and it replaced the capped centre plate with three columns.

🔴 **THE MARKS MOVED INTO FLOW, AND THAT IS THE LESSON.** Every overlap this strip ever had — a mark on
top of "of 35", a mark 2px from the share control, a mark sliced by the foot's rule — came from pinning
them absolutely: an absolute mark reserves no space, so each width had to be cleared by hand with a
padding clamp, and a width I had not measured was a defect waiting. Two `flex-1` columns centre the
middle in the band whatever the marks measure and make a collision impossible. The clearance clamps were
deleted with the problem they solved.

**The ruled paper, in three corrections.** *"Make the strip with horizontal and vertical lines"* (it had
been damped to 18% and could not be seen); then *"too much"* at a 24px pitch, which gave twenty-seven
verticals and read as graph paper; then *"all squares must be … same size"* — the cells were
`calc(100%/8)` by `calc(100%/2)`, which divides the band exactly but makes RECTANGLES. It is one length
used twice now, so each cell is a true square.

**The frame he dictated last**, while looking at the page: *"above the July–August 2026 you will make a
thicker line, its colour is more clearer, only this line. And after the Company and after the CNS line
you will make also a thick line that ends with the horizontal thick line. And this square will be empty,
no strips in it. The logo of Sato and the logo of Phoenix are at the bottom down, Sato at the left
bottom and Phoenix at the right bottom."*

🔴 **AND THEY BRACKET THE RANKING, THEY DO NOT DIVIDE IT.** Read literally, "after the Company and
after the CNS line" put one rule between the two cells and one past the last — which is what shipped
first, and he corrected it in the next breath: *"the thicker lines are left the ranking and right it, no
lines is in between."* Exactly two, one per side, and the count is pinned so a per-cell loop cannot
quietly reintroduce the middle one.

🔴 **"Ends with" is geometry, not ink.** The rank panel is `self-stretch` and its cell row `flex-1`, so
the panel's bottom edge IS the row's bottom edge and a full-height rule lands on the horizontal with
**0.00px** of gap, measured at both 351px and 668px. Give that panel bottom padding back and every
vertical floats above the line.
🔴 **The horizontal is a SPAN, not a border.** `border-t-2` computed to **1.25px** here — some app rule
beats it — so the line he asked to be *thicker* rendered **thinner** than the 2px verticals meeting it.
A span cannot be out-specified. Verified after: horizontal 2px, verticals 2px, gap 0.00px.
🔴 **And the bird is trimmed to its ink at the bottom too.** Its ink ends at **78.7%** of its 1024×1024
canvas, so 21.3% of that image is empty space below the drawing; bottom-aligning the BOXES would have
stranded it ~15px above the Sato mark's baseline. A wrapper at 78.7% of the mark's own width clips the
rest, so its bottom edge is the ink's bottom edge — measured 0.00px apart at both widths.

**And then he asked for an honest verdict, and the frame came off.** *"To be honest I don't like it …
eyeball it yourself and tell me what we can do."* Measured on what was there: the rank panel was 206×64
in a 668px band — **31%** of it — with **231px** of empty white each side, a foot row spending **26%** of
the strip's height to say "JUL – AUG 2026", and **five** line weights (1px grid, 2px verticals, 2px
horizontal, 3px seam, 2px tick). The frame enclosed nothing, so it read as a piece cut out of a
spreadsheet. Each instruction had been right on its own; the sum had no hierarchy, and the two figures —
the entire point — were not the loudest thing on it.

Three directions were rendered side by side with his real figures — **A** stripped back, **B** the frame
pushed out to enclose the whole band, **C** the same strip shrunk to a plate. I recommended B. **He chose
A**, then on seeing it built: *"not too pale — premium polish and enhance the best."*

🔴 **A's lesson is that the furniture comes back one piece at a time.** Every element removed was once
a reasonable instruction, so the ABSENCE of each — grid, tick, verticals, second rule, foot row — is pinned
by its own assertion, and each was broken back in to watch it fire.
🔴 **And pale is not premium.** A first shipped with every remaining tone at watermark strength — marks at
22% and 10%, labels `#8a959d`, the window `#a9b2b9`, the share glyph `#b6bec4`: four greys all
fainter than the identity's own body ink. Now every grey is a real SATO token (soft `#69757e`, body
`#45515a`), the marks are 62% and 45%, and the figures are 28px from `@md` (24px on a phone so the row
still fits 351px). The floor is pinned so nobody makes it "quieter" again.
🔴 **The bird is shown as its ink box.** Its ink spans 14.8%–78.7% of a square canvas, so 36% of the
image is empty space above and below the drawing — and that empty space set the STRIP'S height: A was
meant to be ~62px and measured 91px. The wrapper is the ink's own height with the image pulled up by its
top margin, so the mark keeps its size and a centred row centres the drawing. Measured after: **72px** at
a 914px band and **89px** on a phone (the window wraps under the figures there), ink centres **0.0px**
apart at both, no horizontal overflow.

**"Too pale" — said twice — and the period moves under the ranking.** The first polish lifted the
marks to 62% and 45% and moved the greys up one token; he looked again and said the same word, and
added *"I want the duration under the rank, not beside."* So nothing on the strip is faded any more:
both marks are at full strength and every piece of type is the identity's body ink `#45515a` or a brand
colour. The two marks and the two figures now share one palette — Sato blue and Phoenix orange — which
is his own *"brand Sato + Phoenix"* from earlier the same day.

🔴 **The Phoenix mark became the COLOUR BIRD** (`phoenix-bird-icon.png`, the logo the sidebar uses) in
place of the camera line-art. The line-art is a watermark drawing — at full strength it reads as an
illustration — and its square canvas is 36% empty space that had to be clipped by hand. Measured off the
bird icon: ink centred at **50.05%** of its canvas and filling **87.5%** of it, so it needs no clip and no
nudge. If anyone puts the line-art back, the ink-box wrapper has to come back with it.
🔴 **One window label, always in the centre column, under the figures.** It had been split into a phone
copy under the figures and a laptop copy inline beside them; that split is what he overruled.

Measured after, both widths: Sato **57×22** at a 668px band (exactly the identity card's own mark directly
above), the bird 33×33, the period centred under the figures to **0.0px**, the two marks' centres **0.0px**
apart, no horizontal overflow; 76px tall on a laptop, 91px on a phone.

**Then he showed the design he had wanted all along.** He sent a finished Sato × Phoenix photo frame —
a team photo over a footer: a blue rule, a faint square grid, Sato on the left, the Phoenix lockup on
the right, and a date under a short orange tick in the middle — and said *"check this design"*, then
*"build the rank strip in this footer's style"*, then *"put a line at the bottom as the one at the top"*.
A navy-tile redesign tried just before it was rejected in one word ("no") and parked on the local
branch `trial/rank-strip-seal-tiles`; it never reached CI.

**The footer, measured off the image (2000×1659) rather than eyeballed:** a 3px brand-blue rule; a grid
of true 34px squares in neutral grey; Sato at 9.6% of the width; the lockup at 17.5% — the bird 114×88,
then PHOENIX in navy `#00132a` over WORKFORCE in orange, 4px from the bird; a 32×3px orange tick 18px
above a line of near-black navy capitals.

🔴 **Two of the footer's own defects were deliberately NOT copied.** Its date is centred BETWEEN the logos
(x=927 of 2000), which is 73px left of the photo above it, because the lockup is 158px wider than the Sato
mark; and its side margins differ by 13px (138 vs 125). The strip puts the ranking between two EQUAL
`flex-1` columns — on the true centre, measured 0.0px off — and pads both sides the same.
🔴 **His own earlier rule overrides the footer in one place:** the area behind the ranking stays blank
(*"this square will be empty, no strips in it"*). The footer's small date can sit on the grid; 26–30px
figures cannot.
🔴 **The grid had to be FAINTER than the footer's grey to read the same.** At `#e4e7ea` it read far louder
on a phone than on his image, because a 1px CSS line is two device pixels at 2x. It is `#ebeef1`.
🔴 **The portal's own 88% zoom shrinks container units by about that factor**, so the first cut landed
the logos ~12% under the footer's proportions. They are calibrated to how he views it; the lockup is
1.87× the Sato mark's width against the footer's 1.83×, and on a phone, where the wordmark gives way to
the bird alone, the bird's floor is 40px so the two sides weigh the same.

Pinned by `tests/rep-rank-badges.test.ts` — the corner anchoring, the one centre-aligned row, the fluid
mark widths, the fluid clearance paddings, and the `@container`. Each was broken and watched to fire.

**The strip's long-label defect, and the three fixes he refused before the fourth (2026-10-03).** The ranking
panel is a FIXED block of whole grid squares — 180 × 108 on a phone, 252 × 108 from `@md` — so with both boards
showing, each label gets about 95px on a phone. `ANTI INFECTIVE LINE` did not fit, and the first three answers
were all wrong in the same way: they gave way on the TEXT or on his LAYOUT rather than on the type.

1. **Drop the word `line`.** He answered *"no truncation ever."* Cutting a word to make it fit is truncation.
2. **Keep the words and let them wrap.** It came out stacked three deep, `ANTI / INFECTIVE / LINE`, beside a
   one-line `COMPANY`. He answered *"they are still truncated"* — a name broken into a stack reads as mutilated
   even with every letter present.
3. **Stack the two boards so each gets the full width.** It did put every label on one line, and he stopped it
   mid-build: *"no — small the size of the font."*

🔴 **So the TYPE gives way, and that is his explicit override of the fits-the-screen rule's "merge, never
shrink" — for this label only.** Past ~18 characters both labels drop to `text-[8px] tracking-[0.08em]
@md:text-[10px] @md:tracking-[0.1em]`. Both, never just the long one: two sizes side by side read as a mistake.
The rank figures are untouched — they are what the strip is for.

**Two things the smaller type does not fix by itself, and both were found by measuring the running page:**

- **The cells size to their CONTENT.** Shrinking the type shrank the cell with it, and the label wrapped again at
  its new width — 82px into 81.7px. It is held `whitespace-nowrap`.
- **Held on one line, the long cell is 92px.** With the original 24px gap the two cells came to **190.4px inside a
  180px panel**, so the ranking spilled out of the white onto the grid. The gap closes to 12px on a phone; the row
  is then 178.4px. From `@md` the panel is 14 squares wide and the original gap has room (row 239.2 of 252).

Verified live, signed in as real reps: **B-7** (both boards, Anti Infective) reads `ANTI INFECTIVE LINE` on ONE
line at 375px and at laptop width, with the row inside the panel and no horizontal overflow; **B-135** (CNS) is
untouched at 10.5px with the 24px gap. 🔴 **Widening the panel was never available on a phone** — at a 351px band
the two marks leave it 22px a side.

## The rep's performance card — his banner, his proof, his footer (2026-10-03)

The card a Medical Rep saves or shares from his rank strip. The rule is in `.claude/rules/portal.md`;
this is why it looks the way it does.

**What he asked for.** *"The export picture must show the photo, the name, the title, the identity banner
and the rank — so full redesign the photo, premium, polishing it."* The first card had none of the
photograph, printed the HR id under the name, and carried its ranks on two navy "metal" panels — the
look he had just rejected for the strip.

**Three bands, each one a design he already owns.** Nothing on the card is invented for it.
- **The identity banner** is `PhoenixSignatureCard` restated in print CSS: the cream field and its two
  radial glows, `identity-watermark.png` bleeding off the right exactly as the component places it, the
  portrait in `EmployeePortrait`'s gold gradient bezel with its glow, the hairline divider, the Pinyon
  Script name over the orange rule with its square, the title in spaced orange capitals, and the navy wave
  with its orange stroke (the component's own SVG path). The component is design-locked, so the card
  never imports or edits it.
- **The proof**: the cumulative figure toned by the one target scale, a bar drawn TO SCALE (at 108% the
  100% tick sits at 100/108 of the bar — Sato's "charts are drawn to scale or not at all"), the facts as
  label/value rows, and the Achievement-by-month chart.
- **His footer**, the strip's own design at card scale: 3px Sato-blue rules top and bottom, the faint
  `#ebeef1` grid offset half a square so a line runs through the centre, Sato left, the Phoenix lockup
  right, and both ranks on a blank panel of 20 × 8 whole squares under the orange tick, the period beneath.
  A long line label ("Anti Infective line") widens the panel two squares at a time, so it stays even.

🔴 **No HR id.** The portal banner prints one under the title; a card built to be posted publicly shows a
name or nothing. Pinned on the emitted document: the HR id appears nowhere in it.

🔴 **The structure line is seats and vacancies only.** The first card printed "111 seats · 35 vacant · 70
scored this period". His rule that same day was *"do not show the current medical reps, only show total
structure of medical reps count vacants"* — the scored count IS the current reps, so it went: the card
reads "111 rep seats · 35 vacant".

**The photograph is the portal's, polished like the milestone keepsake.** `loadMilestonePhotoBytes` is
the one place photo resolution lives (uploaded → bundled static → none, the portal's order), and the
milestone card's `polishPortraitDataUri` grades it — at 640px, since the card draws it 204px wide at twice
the pixels. No readable photo is the monogram plate, never a failed card.

**The name is the banner's signature** (`signatureNameFor`, `src/lib/employee-portal/signature-name.ts`):
three parts or more cut the middle to its initial, "Hager N. Abdelmaged". The banner's copy lives inside
the locked component, so the test pins BOTH copies — a change to one without the other fails it.

**Built for the longest real values, measured off production that day** (76 reps): area "Dokki -
Mohandseen - Bolak", line "Anti Infective", title "Senior Medical Representative", signature names from
"Amr M. Gbr" to "Esraa F. Al-Shandalati". Three defects the stress renders caught before he saw anything:
- **Equal thirds broke "MONTHS CLOSED" onto two lines** and dropped its value below the others; with a
  long area the facts then ran under the footer, and the 8px achievement bar — a flex item — was squeezed
  to nothing, leaving only its 100% tick. Facts are label/value rows now, nothing in the column shrinks,
  and the worst case ends 14px clear of the footer.
- **A value broke inside a word** ("Alexandri / a") under `overflow-wrap: anywhere`. It wraps at spaces only.
- **A short name under a long title** let the centred title spill left across the divider. The signature
  block is now as wide as the WIDER of the two, so the rule becomes a signing line under a short name.

**Fonts.** "Noto Sans" at 400 and 700 only — production's Chromium has `font-noto` (the Dockerfile) and
the laptop has it too, so the render approved here is the one served there; the PDF embeds exactly
NotoSans-Regular, NotoSans-Bold and PinyonScript-Regular. Pinyon Script is inlined as a data URI, and the
layout pass fits the one-line name only after `document.fonts.ready` — an unloaded webfont measures at the
fallback's metrics.

🔴 **The PDF was checked as a PICTURE, and that found the one defect the picture did not have.** Both files were
exported through the real route (`POST /api/employee-portals/performance-card`, dev-auth as the rep), the PDF
page rasterised with the repo's own pdf.js, and the two diffed pixel by pixel. They agreed everywhere but
one place: the banner's 1px divider, which the component fades out through ALPHA, printed as a dark line
in the PDF — darkest pixel 87 against 203. It fades between solid colours now (cream → beige → cream):
197 against 203, and no differing pixel left in it. (Rewriting its 'transparent' stops as zero-alpha
colour changed nothing — Chrome already normalises them; the alpha itself was the problem.)

🔴 **The gradient-numeral trap is retired, not forgotten.** The first card's metal numerals needed BOTH
`-webkit-text-fill-color: transparent` and an inline `background-image` (the `background` shorthand
resets `background-clip`) — two real renders had shipped an empty gold box where the rank belonged. The
redesign has no gradient text; the test keeps the guard and arms it the moment `background-clip: text`
returns.

Pinned by `tests/rep-performance-card.test.ts` on the emitted HTML — the photo in the bezel and the
monogram fallback, the signature name and title, the inlined script face, no HR id, both ranks in his
footer and their order, the rules, the grid, the whole-square panel, the to-scale bar, the structure line
without the scored count, and the refusal to print a card the layout pass did not run on. The photo, the
HR id, the scored count and the ranks were each broken and watched to fire.

## Sick leave evidence is an append-only dated history — owner ruling, 2026-10-03

**His words**, on `/employee-portals/vacation-request`: *"here in sick leaves, make the employee able
to upload multiple photos or multiple PDFs, and also make him able after he upload and submit to
re-upload — but that does not replace the one he uploaded before, no, it is an add-on on them. And I
get the admin get that till the day — for example 3 October he uploaded this, by 10 October he
uploaded those."*

**Three separate requirements, and the third is the one a careless implementation loses.** Several
files at submit; more files afterwards; and the admin reading **when each file arrived**. The shape
before this ruling was six columns on `v2_vacation_requests` —
`sick_attachment_bucket / content_type / object_path / original_name / size_bytes / uploaded_at` —
which hold exactly ONE file and ONE date. So a second upload could only overwrite the first, and the
arrival date of anything but the last file did not exist anywhere.

**What was built.** `v2_vacation_request_attachments`: one row per FILE, with `kind`, `bucket`,
`object_path`, `original_name`, `content_type`, `size_bytes`, its own `uploaded_at`,
`uploaded_by_hr_id` and `uploaded_by_login_id`, cascading on the request. Migration
`20261003125818_vacation_request_attachments_multi.sql`, applied to staging
(`cifwmndunmlxjhyjugxa`) and production (`ozucdzovmcqvepbozvqf`) on 2026-10-03; it backfilled the
3 compensatory files production already held, and production carried **no** sick attachment at all
at that moment, so nothing was at risk in the copy.

**The legacy columns are KEPT, deliberately, and keep naming the FIRST file.** That is what makes
the change small: the evidence-review gate (`hasAcceptedRequiredEvidence`), the approver emails, the
report and audit exports, `createVacationAttachmentReviewUrl` and the `/attachments/<kind>` download
all read those columns and none of them changed. **Never "tidy" them away as duplicates, and never
let the add path write them** — the first document would vanish from every one of those surfaces at
once, silently, while the new list still looked complete.

**Why the storage path carries a per-file unique id.** Append-only in the database buys nothing if
the object store overwrites. Two phone photos are routinely both `IMG_0001.jpg`, and the same
certificate gets re-sent a week later; the path is
`<kind>/<HR id>/<request id>/<8 hex>-<file name>` and the upload stays `upsert: false`, so a repeat
lands beside the earlier file or fails, never on top of it.

**Who may add, and when.** The employee who filed the request, and HR/Super Admin — at **any**
status, because a rejected sick request is exactly when a stamped governmental document is asked for
a second time. Adding a file decides nothing: it raises no approval, re-opens nothing, and does not
touch an evidence review. A manager who is the assigned approver may OPEN the files (he has to read
the note before approving) and may not add to them; the route refuses him either way.

**Transport.** Every added file is streamed straight to the `leave-attachments` bucket through a
short-lived signed upload URL (`/api/vacations/attachments/upload-url`) and named to
`POST /api/vacations/requests/<id>/attachments` by its pending path — never as bytes in the request
body, because five 3MB phone photos meet the same ~4.5MB serverless cap a single 9MB one does. At
submit the form picks ONE transport for the whole set by the TOTAL size, so the order the employee
picked survives and the first file is always the first file. A path may only ever name the caller's
own pending slot: the service-role client copies that object and then deletes it, so an unchecked
path let a signed-in employee lift, and then erase, another employee's medical document.

**Where the dates are read.** The second and later documents open through
`/attachments/file/<attachmentId>`, never `/attachments/<kind>` (which signs the first file only).
The dated list renders in the vacation report's request drawer, in the report's desktop and card
rows for HR, and on the approvals-hub request page — each line being one file, its name, its Cairo
upload time and its size. The employee sees it for his own request, through the
"Documents & timeline" button, and adds more from there.

**Deletion and retention follow the files, not the columns.** `deleteVacationRequestAsAdmin`, the
system-cleanup snapshot and the evidence retention purge all enumerate the attachment rows as well
as the two legacy paths — otherwise every file after the first stayed in the bucket for ever, past
the retention date the purge exists to enforce, with nothing left pointing at it.

Rule: `.claude/rules/time-off.md`. Pinned by `tests/vacation-sick-attachments.test.ts` (append-only
writer, no legacy-column write from the add path, a repeated file name cannot collide, `upsert:
false`, the per-file date in the migration and on screen, `getAll("sickDocument")`, the picker
appending, the ownership gate).

## The place's accuracy line — 100 m for one day, then 250 m, 2026-10-03

**The rule:** a place is validated only when BOTH its readings — the live photo's own location and the
separate Capture-location pin — are within **250 m**; a visit is taken within 500 m. Rule:
`.claude/rules/phoenix-crm-approvals.md`. Pinned by `tests/phoenix-crm-accuracy-gate.test.ts`.

### 🔴 The words ship as a button, or as ghost text — whichever surface the app build gives

**🔴 AND ON 2026-10-15 AT 20:03 CAIRO HE PUT THE OLD BUILD BACK, SO THE GHOST TEXT RETURNED.**
`Get-AppxPackage` reads `Claude_2.31226.1.0_x64__pzs8sxrjxfjjc`, installed from his own kept
`Claude-2.31226.1.msix` (294 MB); the install folder was created 20:03:07 and its `app.asar` 20:03:18.
That build mounts no turn box, so `zt` is false, the app never zeroes `promptSuggestions`, and the
CLI's own chain runs again — the `Next step:` line's quoted words appear in his input box and
Tab+Enter sends them.

**The discriminator is the session's own tool list, never the version string.** A transcript from the
44.7.0 build carries `"name":"mcp__ccd_turn__update_plan"` and `…__wrap_up` inside its `tools[]`
attachment — 4 matches in the 2026-10-15 worktree session — and one from 2.31226.1 carries none.
`.claude`-external `next-step-capture.mjs` **clause 7** therefore stands down unless that marker is
present, and it fails SILENT: a warned line is deliberately not captured, so on this build the clause
written to fill his box would have emptied it on every turn that edits a file. Proved by breaking it:
42 cases, 0 failed, and removing the one test made exactly the new case fail. The three live rule
files (`task-rules.txt` rule 6, `suggestion-context.mjs`, `~/.claude/CLAUDE.md`) were rewritten the
same evening to say "whichever surface this session has", and the memory note
`the-turn-box-took-the-ghost-text` leads with the restored build.

Measured 2026-10-15, after he reported it himself: *"I was receiving suggestions in the box where I
typed to you the prompt, and then I press tab and then this ghost text become real text … since this
update the suggestions are not appearing. I tried in a several sessions."*

**It is not a switch and it is not usage.** All five were ON while his box was empty: the app's own
`prompt_suggestions`, `promptSuggestionEnabled`, the `env` copy, the Windows user variable, and the
flag read live out of the session's own environment.

**What actually changed** — read out of `resources/app.asar` of `Claude_2.37337.1.0_x64` (app
`version` = **44.7.0**, asar written **13/10/2026 20:46 Cairo**), in the session-spawn path:

```js
let Ot = n.bu() && i.turnBox === true && re?.turnBox !== !1;        // turn box wanted
let { ..., turnBoxMounted: Rt } = await this.setupMcpAndPlugins(Q, r, d, { ..., turnBox: Ot, ... });
let zt = Rt, Bt = zt || !(A||b||H) && re?.turnBox === !0;
(zt || Bt && W) && (E += n.ao(G));     // append the turn-box system prompt
zt && (Q.promptSuggestions = void 0);  // AND STOP ASKING FOR A SUGGESTION
```

`turnBoxMounted` is true whenever the `mcp__ccd_turn__*` pair is mounted, which is every Code session
now. The CLI — the app runs its own bundled **2.1.295**, not the global 2.1.293 — then returns on the
FIRST line of `DS.afterResult`, `if (!this.promptSuggestions() || … ) return`, before the
`turnOrigin` check, before `cacheSafeParams()`, and before any `tengu_prompt_suggestion` event is
emitted. **Nothing is suppressed and nothing is logged: it is never asked for**, which is why the
nine-rung CLI chain in the memory note explains nothing about an app session any more.

**No local lever.** `n.bu()` reads a server-side gate that defaults ON, `CLAUDE_DEV_FORCE_GATES` is
ignored in a packaged build and can only force a gate ON, and there is no turn-box setting key.
**Never tell him to reinstall, restart the app, or flip a switch for this.**

**The replacement surface is the box's own buttons.** A `wrap_up` reply button's `message` is sent
verbatim as his next message — one click where Tab + Enter used to be two keys. So the quoted words
belong in `actions[0].message`, his pick first, and a second button only when it is a real
alternative.

**Dated against his own sessions:** the turn box first appears in a session started **14/10/2026
19:55 Cairo** and in all **39** sessions since — every session he has run since the update, which is
exactly the "several sessions" he tested.

**What holds it:** `~/.claude/hooks/next-step-capture.mjs` **clause 7** (Stop hook, warns, never
blocks) fires when a turn kept a task list or edited a file and never drew the box, when the recap
carried no actions, and when no action sends the line's words; `selftest` is 40 cases and was proved
by breaking it. The per-turn rules carry it too: `~/.claude/hooks/task-rules.txt` rule 6 ("THE BOX IS
A BUTTON NOW", injected on every prompt) and `~/.claude/hooks/suggestion-context.mjs` at every
session start. Those three files live outside this repository, so this section is their only account
here.

### How the number moved, in his own words, inside one day

| When | His words | The line |
| --- | --- | --- |
| 3 Oct, morning | "accept up to max 500 m in visits and 200 m in validation" | 200 m |
| 3 Oct, the same hour | "inform the rep that validation must be accurate minimum accepted 100m accuracy" | **100 m** |
| 3 Oct, evening | "make the 100m 250m" | **250 m** |

The morning's tightening answered a real incident: on Delta (1)'s first field day a phone left on
Android's APPROXIMATE location validated four different Benha hospitals at one identical point,
30.4684684684685 / 31.1899555209043, every reading "within 2,000 m". A place is fixed for good, so
every later visit there read "0 m apart" — a 2 km blur compared with itself, proving nothing. Every
other rep that morning read between 3.6 and 19.8 m.

### Why 100 m could not stay — the nine refusals of 21:30

The evening's widening answered the opposite failure, and it was measured, not argued.
`phoenix_crm_refused_readings` (shipped the same evening, PR #5262) was live for **half an hour**
when it recorded **nine refusals in 67 seconds** — 21:30:29 to 21:31:36 Cairo — from one rep,
Hassan Elsherbiny, all `place`, all `rough`:

| Time (Cairo) | Pin | Photo | Line then |
| --- | --- | --- | --- |
| 21:30:29 | **47 m** | 220 m | 100 |
| 21:30:40 | **47 m** | 220 m | 100 |
| 21:30:52 | **58 m** | 220 m | 100 |
| 21:31:05 → 21:31:17 | **30 m** | 220 m | 100 |
| 21:31:24 | **29 m** | 220 m | 100 |
| 21:31:36 | **27 m** | 220 m | 100 |

His phone was **fine**, and three measurements say so rather than one:

- his **pin** improved on its own — 47 → 58 → 30 → 29 → 27 m — every reading already inside the old
  line;
- his coordinate carried real GPS jitter (30.9649311938527 → 30.9647848165291);
- it sat **890–911 m** from the corner of a 2 km privacy-grid square. Android's blurring lands **on**
  a corner (0.0 m); a hand-placed fake pin lands ~500 m away. Neither describes this.

What refused him was the **photo's** reading, and it was **frozen**: `photo_accuracy_meters` was 220 on
all nine rows, `photo_lat`/`photo_lon` were identical to 13 decimals, and `device_captured_at` was the
single instant **21:29:58** every time. He took one photo before his GPS had settled, and **a retry
resends that same photo**. So the gate refused him on a number that could not improve however long he
stood there: a loop whose only exit — retaking the photo — nothing on his screen named. The photo had
been taken in the right place; it sat 9–34 m from his pin.

### The alternative he was offered, and declined

The session recommended keeping 100 m and making a refused photo **force a retake**, on the grounds
that the photo's reading is what proves he was standing there when the shutter fired. He chose the
wider line instead. His design is final: **do not move it back, and do not re-propose the retake fix.**

250 m still catches what the gate exists for — an approximate-location phone reports a flat 2,000 m,
eight times the line — and the visit's own 500 m stays the wider of the two.

### Amended 2026-10-11 — the pin alone decides, a rough photo reading no longer refuses

Asked directly (options A: a sharp pin alone validates; B: keep both readings) after a rep at the
clinic was refused eight times, the owner answered **"A"**. Production that day, from
`phoenix_crm_refused_readings`: B-182 pin 11.2 m, photo 2,000 m then 1,414 m (the photo's own position
sat ~640 m from the pin); B-158 pin 29.9-31.8 m, photo 634-1,865 m. iPhone Safari hands the camera an
approximate position while the Capture-location button reads a real one, and retaking the photo
returned the same kind of reading. So `placeReadingsPrecise` judges the PIN only, `placePoint` never
fixes the place on the SHARPER of the two readings (the photo's on a tie; `pickPlacePoint`, also used by the capture screen so the address shown is the address saved - a 2026-10-11 follow-up after a rep read a wrong address), and the photo's raw reading
is still stored and read by the integrity board, above the rep. A rough pin is still refused. Never
restore the photo gate without his word. Pinned by `tests/phoenix-crm-accuracy-gate.test.ts`.

## The touch trail is retired — owner ruling, 2026-11-01

His words, 1 November 2026, about 21:00 Cairo, in the speed root-cause session, after the facts below
were put to him: **"retire and delete all its traces."** The two sections that follow (3 October and
27 October) are the account of the trail while it lived; they stay as history and bind nothing.

The facts, read on production at 20:55 Cairo that evening: `phoenix_crm_touch_trail` held 2,834,233 rows
and 1,224 MB — 668 MB of heap and 556 MB across six indexes — 26 % of the 4,690 MB database; it had been
written 4,557 times since the 14:03 restart and read never; the collector cost one request on every
screen change and one every 30 s for every open tab, on a database host whose request handling (not
its SQL) was the measured root cause of the slow pages; and the 30-day archive had written no file,
because its first night fell due on 2 November. Counting the rows took 19 seconds on that host.

What went, in one PR: the collector and the two `field-crm` layouts' mount of it, the route
`/api/phoenix-crm/touch-trail`, the Super Admin's reader page and its sidebar card, the nightly archive
route, its declaration in `job-schedule.ts` and `cronjob-sync.mjs`, the cron-job.org job (deleted the same
sitting, so the heartbeat never alarms about a stopped job), the three tests, the module-memory globs,
and every rule line that described it — each edited to one "retired" line, never a second contradicting
line. The reps' phones still held queued batches under `localStorage["phx-crm-touch-trail"]`; a
one-release cleanup component mounted by those same layouts removes the key, and both go in the release
after this one.

The table and the empty archive bucket are dropped by
`supabase/migrations/20261101203000_retire_phoenix_crm_touch_trail.sql`, run on production by hand only after
the code is live (nothing may still write to the table), off-hours, with the day's backup confirmed —
production has no point-in-time recovery, so that backup is the only copy of the trail that remains.

Where a refusal that saved nothing is found now: the refused-readings board
(`/admin/phoenix-crm/refused-readings`), which since 13 October records a browser-blocked permission
through its own route — the case that first made the trail the only trace.

## The Phoenix CRM touch trail — owner ruling, 2026-10-03

His words, on the evening of 3 October 2026, after a day in which two reps were blocked and both
diagnoses had to be reconstructed from fragments:

> "Look, in Phoenix CRM, I want every click or every touch on the touch screen for this module to be
> saved in a separate audit trail for Phoenix CRM. Every separate touch, every single thing is
> saved, even if the rep didn't save it. Since it touched Phoenix, then automatic saved. Anything,
> anything you can record, anything you can capture. Anything is automatically saved. I want Phoenix
> this to be like a file manager grabber. Anything touches him, automatically saved."

**Why he asked.** Until that evening the module recorded only what a rep SUCCEEDED in saving, and
that gap cost a whole day twice over:

| Rep | What happened | What it left behind |
| --- | --- | --- |
| B-130, 16:12–18:47 | Refused eighteen times on the 100 m place line, her phone on Android's approximate location | **Nothing.** `phoenix_crm_location_integrity` is filed only after a save succeeds, no place or visit row is created, and the upload slot keeps only the fact that a slot was asked for |
| Hassan Elsherbiny, 21:29–21:31 | Nine refusals in 67 seconds — his pin 27–58 m, his photo frozen at 220 m from one capture | **Nothing.** The retry loop he could not escape existed only in his hands |

Her 2,000 m was knowable at all because four captures were ACCEPTED that morning, before the line
shipped at 11:24; his nine were knowable because `phoenix_crm_refused_readings` had gone live forty
minutes earlier. Neither was knowable from the module. The refused-readings table closed one door;
the touch trail closes the module.

**What it is.** One table, `phoenix_crm_touch_trail` (migration `20261003221224`), and one collector
mounted once over each half of the module — the rep's `app/employee-portals/field-crm/layout.tsx`
and the admin twin — recording press · tap · type · change · focus · submit · screen · scroll ·
hide · show · offline · online, with the element touched, the words on it, the field's contents at
that moment, the point on the glass, the viewport, and three clocks (the server's, the phone's, and
the Cairo 02:00 visit day).

**Golden rule #1 is not bent, and the three things that hold it mechanically.** The rep's app is
easy and BLIND, and `tests/phoenix-crm-touch-trail.test.ts` pins each of these rather than trusting
them:

1. **The collector draws nothing and intervenes in nothing.** It returns null, every listener is
   registered `{capture: true, passive: true}` so it cannot swallow or delay a tap, it never calls
   `preventDefault` or `stopPropagation`, and it never throws — a trail that fails is a trail with a
   hole in it, never a rep who is stuck.
2. **The route answers 204 on every path.** A count, an id or an error message is exactly what would
   tell a rep this table exists, so there is no readable body anywhere — not even the module's own
   `phoenixCrmFailure` helper, which writes one.
3. **It is readable only above the rep**, the same tier as the mock-location evidence: service role
   only, revoked from `public`, `anon` and `authenticated`.

**What a browser cannot see, stated so nobody reads the table as more than it is.** Taps outside the
page (the launcher, another app, the camera's own shutter), individual keyboard keys, and anything
at all while the page is closed. Offline is covered — a failed flush is held in `localStorage`,
capped at 1,000 events with the OLDEST dropped, and retried on the next flush or the next page load.

**The two things that are not literal, and why.** Typing is coalesced after 800 ms of quiet and on
every commit and focus change; scrolling is coalesced to one row per second per screen. A row per
keystroke would be roughly fifty times the volume for no finding the settled text does not already
carry — what is recorded is the field's CONTENTS at each pause, not the key pressed, so **the
abandoned comment he asked for by name survives in full either way**, and the timing is still in the
`ms_since_load` gaps between successive rows for the same field. Every other kind is one row per
event. There is no keystroke listener at all.

**The one thing that is never recorded.** A password-type field, a field a password manager fills
(`autocomplete` naming a password or a one-time code), or a field NAMED for a password has its value
dropped **in the browser, at the point of capture** — so there is no stored secret for a later
redaction to forget. Its LENGTH is kept: that a password of eleven characters was typed tells a
failed sign-in from an abandoned one and discloses nothing.

**The table is deliberately UNKEYED**, the module's second after the refused readings. Nine
identical presses are nine rows: the repetition IS the evidence, and a unique constraint on any
column here would collapse exactly the retry history that diagnosed both of 3 October's incidents.
`id` is a `bigint` identity rather than a uuid because of the volume — roughly 1,000–3,000 events
per rep per field day — and because a monotonic key is what lets a reader page the table by keyset
instead of by offset, which it must: PostgREST stops at 1,000 rows with no error and no marker.

Rule: `.claude/rules/phoenix-crm.md`. Pinned by `tests/phoenix-crm-touch-trail.test.ts` (the secret
drop and the kept comment, the descriptor that never carries a class list, the total parse, the
blindness of the collector and the route, the session-resolved actor and test flag, both layouts,
the registry declaration, and the unkeyed locked table).

### Gap 16 — the trail stays unkeyed, by his own ruling

The second-pass CRM audit (3–11 October 2026) listed as **gap 16** that the touch trail carries no
visit id, so a press cannot be tied to the visit it belongs to. Reading the code showed the table is
unkeyed on purpose, so the question went to him rather than being implemented, and he answered on
**12 October 2026**: *"leave gap 16 as it is — the touch trail stays unkeyed."*

Why that is the right answer, and not merely his preference: the trail exists to answer "a rep is
blocked and the system will not let her through", and a refusal that saved nothing leaves no row
anywhere else in the system. Those are precisely the touches that have no visit to be keyed to. A
`visit_id` column would be populated for the presses that became a visit and null for the ones that
matter most, and a reader that joined on it would quietly drop the evidence it was built to find —
the failure the trail already caught once, when an empty venue picker cost two days of polyclinic
seating and the HTTP log proved nothing.

Keyset paging on the `bigint` identity already gives every read a total order, so nothing about
reading the trail needs a visit id. **Never add the column, never derive one on read, and never
re-raise gap 16 as a defect.** Rule: `.claude/rules/phoenix-crm-boards.md`.

### The label is the control's words, never the card's — the first hour of real data

Owner, 2026-10-03, after reading the first hour: *"trim the touch trail label to the control, not the
whole card."*

`elementOf` returns the interactive **owner** of a press when there is one, and the bare element under
the finger when there is not. A touch screen produces that second case constantly: a finger down to
scroll a list fires a press on a container with no control above it — **36 presses against only 3 taps**
in the first hour, the gap being the scrolling itself. And a container's `innerText` is every
descendant's text joined, so the 160-character cap was never a trim. It recorded, for single taps:

| What was pressed | What was recorded | Length |
| --- | --- | --- |
| the Telegram banner | "Get Phoenix CRM messages on Telegram Plans, requests and reminders reach your phone the moment they happen. Connect Telegram Later New here? The one-page guide" | **159** |
| a territory card | "Menoufia 1 · CNS Nada Saied APPROVED 17 AM · 71 PM Approved Fri 2 Oct, 10:34 PM by Mahmoud ElHassanin Nothing flagged Open the plan" | **131** |

At a rep's thousand-odd events a field day that buries the signal the column exists to carry.

**The fix is the first LINE, not a smaller cap**, and that distinction is the whole design. Cutting the
joined text at 48 characters would keep the start of line one plus whatever of line two happened to
fit, which reads as one sentence nobody ever saw. `innerText` already breaks a line per rendered
block, so its first line **is** the heading a person would name the thing by — "Get Phoenix CRM
messages on Telegram", "Menoufia 1 · CNS". That keeps **which** card was pressed, the only thing a
container label is for, and drops the paragraph behind it.

So `containerLabelOf` takes the first non-blank line, flattens its whitespace and caps it at
`MAX_CONTAINER_LABEL_CHARS` (48). An element that is itself interactive is unchanged — its `innerText`
**is** its own words, and keeps the full 160. An authored `aria-label`, `title` or `placeholder` is
still asked first for both: an author who wrote a label wrote the label, however long. Cut, never
ellipsed, for the reason `labelOf` gives — an added "…" is indistinguishable from one the rep typed.

Proved by breaking it three ways and watching each fire its own assertion: flattening the subtree
again reproduced the exact 159-character banner label; rewiring the collector to `labelOf` fired the
source assertion, measured on comment-STRIPPED source so the comment explaining the call cannot
satisfy it; and appending an ellipsis fired the no-ellipsis rule.

**One thing that looked like a defect and is not.** `seat_id` is null on every row recorded that
night. The collector reads the seat from the `day/<seat>/<date>` segment, and that is the only route
carrying one — both screens touched that night sit above the seat level, so null is the correct
answer there, not a miss.

### Reading it — the Super Admin's own page, 2026-10-04

*"build the touch trail reader for the Super Admin."* The table had been filling since 23:02 the
night before and the only way to read it was hand-written SQL. The page is
`/admin/field-crm/touch-trail`: a visit day grouped into the page loads that made it, and one page
load read event by event.

**Why the gate is the Super Admin's and not the SFE Manager's.** `canReadTouchTrail` is the same
predicate `canDecideValidationReviews` uses — `isSuperAdmin && canUpdate && !isTestPersona` — and it
guards the page and both loaders, not one of them. Two reasons, and the second is the one that would
hurt. The trail records every pair of hands on the module *including a manager's*, because
`actor_hr_id` is the signed-in person and a manager entering a visit for a rep is recorded as the
manager; widening the gate one tier would therefore hand one manager another manager's keystrokes.
And the table deliberately keeps the field contents a rep typed and then deleted, which is the most
private thing the module holds. A rep cannot reach `/admin` at all, so golden rule #1 needs nothing
extra here: he is never shown that the trail exists, let alone that it was read.

**🔴 KEYSET PAGING IS CORRECTNESS HERE, NOT PERFORMANCE.** PostgREST answers a request for 5,000 rows
with 1,000 rows and a 200 — no error, no marker, no short-read signal — and the migration's own
header said so when the table was created. A field day is 1,000–3,000 events per rep. So a plain
`.select()` over a day would return the morning and be indistinguishable from the whole day, which is
the worst failure an evidence reader can have: a confident wrong answer. Every read walks the
`bigint id` with `.gt("id", cursor)`, a page at a time, to `MAX_TRAIL_ROWS` (40,000) for a day and
`MAX_SESSION_EVENTS` (3,000) for one page load, and both ceilings are REPORTED on the screen when
reached. `range` and `offset` are refused by the test: over a table still being written to they both
repeat rows and skip them, which an identity cursor cannot.

**The day is read whole and narrowed in memory.** A rep filter in the query would shrink the people
list to the person already chosen and the totals to his share — so the filter could never be widened
again from the page, and the day's own numbers would silently become one person's. One Super Admin
page can afford a few extra round trips for that. The summary read does drop the heaviest column:
`value` is never printed by the day view, and `value_length` is all a count of typed events needs.

**The two clocks are never averaged.** `occurred_at` is the batch's ARRIVAL and is shared by up to
forty events; `ms_since_load` is what orders them inside it; `device_at` is the browser's own clock,
and the only one a phone can be wrong about. So the reported figure is the MINIMUM signed gap between
arrival and device stamp across the session — the flush wait can only inflate it, so the closest
event is the only honest bound — and nothing at all is said while that sits inside
`FLUSH_EVERY_MS` + 55 s. A pill on every session would train the reader to ignore the one session
where it means something. Measured over the first 102 real rows: **105 ms to 1,972 ms** across six
page loads, so not one of them is flagged — which is the design working. (An earlier note in this
file said "2–6 s"; that was the raw per-row gap, which the flush wait inflates, not the minimum the
reader reports.)

**`ms_since_load` orders a page load and the arrival never does**, for two reasons that the test
holds in one case: forty events sharing one stamp cannot be ordered by it, and the collector queues
events while the phone is offline, so an event that happened FIRST can arrive in a much later batch.

**Nothing is rounded down.** A row that will not parse is dropped *and counted on the screen*; a day
past its ceiling says the page is the earliest part of it; a session past the stream cap names its
true length from a `count: "exact"` query rather than from what it is showing. The whole table exists
because nothing is ever lost, and a reader that quietly showed less would undo that in one screen.

**The reader is itself on the trail, and the page says so.** `app/(admin)/admin/field-crm/layout.tsx`
mounts the collector over this subtree, so reading the trail writes to it and the Super Admin's own
page loads appear in the list. That is deliberate — every pair of hands on the module is recorded —
but a reader who did not know it would read his own sessions as somebody else's, so an `AdminCallout`
states it above the board.

**Checked against production, not only against fixtures.** The 102 rows the table held for
2026-10-03 were pulled in the exact shape PostgREST hands the reader and run through
`parseTrailRow` + `summariseSessions`, then compared field by field against the same summary computed
independently in SQL. All 102 parsed with none dropped, the reader found the same six page loads, and
`events`, `onScreenMs`, `deviceClockOffMs`, the screen count, the viewport count and the test flag
agreed on every one of them. Two of those figures are worth keeping: a phone flipping between
`360x633` and `360x697` as its address bar collapses shows up as two viewports on four of the six
loads, and the test persona's single event came from a `1920x947` desktop. The oldest rows still carry
the pre-trim 159-character labels, and they were deliberately left alone — rewriting them to match
today's format would destroy evidence to make history tidy.

**What was broken to prove the test bites.** Eleven breaks, each firing its own headline assertion:
the cursor replaced by a `range` walk; the gate widened to the SFE Manager; an `.update()` added to
the service; a column the table does not have added to the stream projection; a stored column
(`viewport_h`) dropped from it, which the "every column is reachable" check caught; the day filtered
by `actor_hr_id` in SQL; the clock gap taken as the maximum instead of the minimum; the ordering
falling back to `occurred_at`; the Cairo clock put on a fixed `Etc/GMT-3`, which the WINTER case
caught and the October one did not; and the unreadable count zeroed on its way to the screen.

## The touch trail keeps 30 days — the rest is archived (owner ruling, 2026-10-27)

He asked why the production database stalls every afternoon. The read that evening: a 4.3 GB database
on a 2.03 GB box, about 6.6 GB swapped out in the 52 hours since the 25 October boot, every restart
between 11:30 and 19:05 Cairo — and `phoenix_crm_touch_trail` the biggest table, 985 MB after 24 days
(95,000 to 181,000 rows on a field day, 181,290 on 22 October), with nothing ever leaving it. Offered
keep-all, archive or delete, he chose **"Archive after 30 days"**: touches older than 30 days go to
gzipped files in Supabase Storage and are then deleted from the database, and the touch-trail screen
shows the last 30 days and says older days are archived.

**How it runs.** `app/api/cron/phoenix-crm-touch-trail-archive`, 04:37 Cairo nightly on cron-job.org,
calls `runTouchTrailArchive` (`src/lib/phoenix-crm/server/touch-trail-archive.ts`; rules in
`src/lib/phoenix-crm/touch-trail-archive.ts`). The database keeps today and the 29 days before it, so
3 October leaves on 2 November. Oldest day first, at most two days a night, 20,000 rows to a file at
`<yyyy>/<mm>/<day>/ids-<first>-<last>.ndjson.gz` in the private bucket
`phoenix-crm-touch-trail-archive` (migration `20261027175121`). `?dryRun=1` names the day due and
writes nothing.

**The four rules, and why.**
1. **Nothing is deleted that was not first read back from storage.** Production has no point-in-time
   recovery, so "uploaded" is not enough: the file is downloaded again, its sha256 compared with what
   was sent, its lines counted and its first and last id compared. Any difference stops the run with
   the rows still in the table.
2. **The delete names every id — never a range.** A `visit_day`/`id` range would also take a row a
   late flush filed on an old day after the read, and that row would be in no file.
3. **A file names its first and last id**, so a run cut off half-way never overwrites the part already
   archived. One id may then sit in two files; a reader of the archive takes each id once.
4. **Golden rule #1 is untouched.** Only the service role reaches the bucket; nothing mints a signed
   URL for it or serves from it. The Super Admin is still the one reader.

A delete that does not land (the next file starts at or below the last archived id) stops the run
rather than writing the same file until the budget runs out. Pinned by
`tests/phoenix-crm-touch-trail-archive.test.ts`.

## A refused capture keeps its photo — owner ruling, 2026-10-03

His words, in two messages: *"save the photo when a validation is refused"*, then — while the first
was still being built — *"i mean keep it in the datbase donot loose any thing"*.

**This reversed the session's own standing proposal.** The recommendation that had been put to him
twice was the opposite: CLEAR the photo on a refusal, so a retry could not resend the frozen reading
that trapped Hassan in the loop above. He chose to keep it. **His design is final — do not re-propose
clearing, expiring or replacing a refused photo**, and do not read "force a retake" (already declined,
same evening) back into this.

### What was actually lost, and what was not

**The bytes were never lost.** The browser uploads the live photo to its own storage slot *before* the
save is even attempted, so by the time the gate refuses him the JPEG is already in
`phoenix-crm-photos`. What was lost was the **pointer**: a refused place or visit row is never
created, and `phoenix_crm_photo_uploads` records only that a slot was *asked for* — not which refusal
it belonged to. So the one piece of evidence a person can simply *look at*, rather than infer from a
radius, was reachable only by hand-joining unused slots to `storage.objects` against a time window.
That is exactly how both of 3 October's incidents had to be reconstructed, hours late — B-130's
eighteen refused captures between 16:12 and 18:47, and Hassan's nine at 21:30.

**And it is not a deletion risk either.** No code path in this repo removes a Phoenix CRM photo or its
slot row: eleven other buckets call `storage.from(...).remove(...)` and `phoenix-crm-photos` is called
by none, and no migration deletes from `phoenix_crm_photo_uploads`. "Don't lose anything" was already
true of the object store; it was the *row* that forgot.

### What shipped

One nullable column — `phoenix_crm_refused_readings.photo_path` (migration `20261003224941`, applied
to staging and production on 2026-10-03, verified live from `pg_attribute`) — plus a partial index on
`refused_at desc where photo_path is not null`, which is the read it exists for: *every refusal that
has a picture, newest first*. `refusedReadingOf` fills it on both branches (`no_fix` and `rough`) with
the same 200-character bound `parseVisitDraft` uses, and `recordRefusedReading` writes it onto the row.

It uploads nothing, copies nothing and deletes nothing — **a pointer kept, not a second copy.** 🔴 If
a purge of unused upload slots is ever added, it must exempt a path named in this column; otherwise
this starts pointing at objects that are gone, which is worse than not having it.

**Golden rule #1 is untouched.** The rep's refusal is byte-for-byte the one he read before the column
existed, nothing is drawn on his screen, nothing is added to his day, and the table stays
`service_role`-only (anon ✗, authenticated ✗) — readable above him alone.

### Why this is worth more than the two coordinates it sits beside

The row already carried `photo_lat` / `photo_lon` / `photo_accuracy_meters`. Those three numbers are
what *refused* him; the photograph is what shows **where he actually was**. Hassan's nine rows carried
one identical frozen photo reading — so with the path on the row, nine refusals resolve at a glance to
*one picture, taken once, resent nine times*, which is the finding itself rather than a conclusion
drawn from three columns agreeing to thirteen decimals.

Rule: `.claude/rules/phoenix-crm-approvals.md`. Pinned by
`tests/phoenix-crm-refused-readings.test.ts` — section 10 (the path on both branches, the null cases,
the 200-character bound, the writer, and the migration's additive shape) and section 11, which scans
`src`, `app` and `scripts` for any `.remove(` or `.delete(` against the CRM photo bucket or its slot
table and fails if one appears, so "nothing is ever lost" is enforced rather than observed.

### The recorder's own three rules — why the table looks the way it does

These predate the photo column (PR #5262, owner: *"record the refused readings so the next refusal is
traceable"*) and govern every change to `src/lib/phoenix-crm/server/refused-readings.ts`:

1. **The rep learns nothing new.** No message, no screen and no figure changes. The refusal he reads
   is byte-for-byte the one he read before the table existed; only its number now outlives it.
2. **It must never cost a rep his work.** Every path returns void and swallows its own errors. A rep
   already being refused must not then be refused *differently*, or meet a 500, because an evidence
   insert failed.
3. 🔴 **It is AWAITED, unlike the integrity judgement, and that is deliberate.** `judgeCapture` runs
   after a save has already returned; this runs while the request is still open, so a
   fire-and-forget promise can be killed with the serverless invocation and record nothing — which is
   precisely the hole being closed. One bounded insert is paid before an error message the rep is
   waiting for anyway. If that trade ever becomes wrong, the fix is a queue, **never** an unawaited
   promise.

Two further properties are load-bearing. **`refusedReadingOf` restates no threshold** — it asks the
doors' own `placeReadingsPrecise` / `withinAccuracy`, so a capture they accept records nothing and the
record can never disagree with the refusal; a refusal about the comment, the products or a missing
photo files nothing at all, because a table that also held every mistyped form would be a table
nobody reads. And **the table is deliberately UNKEYED**: eighteen refusals are eighteen rows, and the
repetition is the evidence — B-130's eighteen between 16:12 and 18:47, and Hassan's nine in 67
seconds, are both findings only because nothing collapsed them.
## The Rankings tab — owner's rulings, 2026-10-03

His ask, verbatim: *"i want to you to build a page the same concept I can filter by line, I can
filter by multiple lines, I can filter by all company, I can filter by period, uh, I have multiple
months, quarter, semester. Um, I can filter like anything by, uh, I can filter on one employee, on
one title, on anything I want. But of course, you will not build it in the overview. You will only
take the concept and build it as a, a, a new tab."* Shipped as `/sales/rankings` in #5266 — the
concept he sent as its own tab, with the overview untouched.

**The whole line, never a top slice.** It shipped with each per-line panel titled `Top 5` and cut
with `.slice(0, 5)`. He answered within the hour: *"Don't show me the top five only. I want to see
the whole line. I want to see the whole line."* The panels now render every ranked rep on the line
and the title says `<Line> line — full ranking`. The reason the slice was wrong is not length: a
cut-off board answers "who is winning", and the page exists to answer "where does everybody
stand" — the bottom of a line is the half a line manager acts on, and it was the half being
hidden. `tests/sales-rankings.test.ts` refuses a `.slice(` anywhere in
`src/components/sales/rankings/rankings-explorer.tsx`, and refuses the words "Top 5" too, so a
rename cannot slip the old shape back in.

**A rank is only meaningful with its filter.** The filter decides the population, so filtered to
CNS a rep is ranked on CNS money alone. A board is never quoted without saying what it was
filtered to.

**The window is summed, then divided once.** Over a quarter or semester all sales and the
target are each summed across the window and divided a single time. Averaging the monthly ratios
instead made 1200/1100 read 205% where the truth is 109%.

**It owns no arithmetic.** Every figure comes from `loadAchievementRange` + `loadPublishedPeriodKeys`,
gated per `lineCode|period`, so an unpublished month cannot put anybody first and the Monthly
Closing stays the one source of truth (§4's golden rule). The test refuses the loader if it ever
reads a table directly.

**The numerator is ALL sales, the closing's own** (owner, 2026-10-25: *"make sure results here
/sales/rankings is perfectly matching with the monthly closings"*). It shipped dividing COVERED sales
(the product-rows that carry a target), so a rep who sold off-target products read lower than his
closing — 7 of 240 rep-months drifted, worst CN0008 in August at 30.71% against the closing's 107.82%.
The board, the portal rank badge (`rep-rank.ts`) and the performance card now divide every pound by
the target, as `closing-matrix` does; the DM board already did. Pinned in `tests/sales-rankings.test.ts`
and `tests/rep-rank-badges.test.ts` (a 100-on-target + 300-off-target rep reads 200%, never 50%).

**"Out of N" is organogram seats**, vacancies included, and it goes blank the moment a title,
region or name filter narrows the population — the seat model counts REP seats, so it would answer
a question the filtered board is no longer asking.

**Who sees it.** The sidebar row is Super Admin, SFE Manager and CEO, each also needing
`sales:read`. Portal-shell roles are redirected to `/employee-portals/sales-vs-target` rather than
denied. Finance Manager holds `sales:read` on the admin shell and so can reach the page by URL with
no sidebar row — the same reach it has always had on `/sales/vs-target`, deliberately not narrowed
here; put to him 2026-10-03 and not yet answered.

**The fits-the-screen rule needed a container query.** A board sits full-width in one place and at
half of `xl:grid-cols-2` in another: a 1280px viewport holds a 452px board and a 918px one at once,
and a viewport-keyed `lg:block` table clipped 18 cells there. `@container` + `@min-[660px]` asks the
band itself, 660px being the width the colgroup is proven at. The clause is in `AGENTS.md` §4's
fits-the-screen rule, since it is true of any table that can land in a grid cell.

Rule: `.claude/rules/sales-closing.md`. Pinned by `tests/sales-rankings.test.ts` (every window mode
and its prior window, sum-then-divide, the per-line published gate, leavers and the fail-open
directory read, each filter's effect on the seat count, the trend, the loader reading only the
closing engine, the page's `assertPermission` and portal redirect, no slice, no `Top 5`, the
container switch and the colgroup arithmetic). Real pixels: `scripts/measure-rankings-fit.mjs`.

## The refused-readings board — the SFE's view of who the location check turned away

Owner, 2026-10-03: *"record the refused readings so the next refusal is traceable"*, and the same night,
once `phoenix_crm_refused_readings` had caught its first real case — **nine refusals in 67 seconds from
one rep whose phone was fine**, every one a retry of the same photo — *"build the refused readings view
for the SFE"*. Until then only SQL could read the table, so the people who could help a stuck rep would
never have seen him.

**Where and for whom.** `/admin/phoenix-crm/refused-readings`, the Super Admin and the SFE Manager (the
integrity board's audience), a 404 for anybody else in the service AND on the page, behind gate one. It is
a page of its own and not a tab of Location Integrity on purpose: a refusal is the system saying no to a
phone, and the rep already read it on his own screen, so the wording is housekeeping — *who is stuck and can
I help* — never *who is lying*. Same stance as the duplicate-customers list.

**The mock-location answer** (`device_mocked`) is the Super Admin's alone, as on the integrity board
(owner, 2026-10-02) — and not by filtering: the select names the column only under `readsMockAnswer`, so
the SFE Manager's process never holds it.

**What it counts.** The last 14 days, one line per rep: how many customers he was refused on and how many he
later SAVED (a visit saved for the same customer, or a place created for it, by the same rep, AT or AFTER the
refusal — a save before it proves nothing). Reps with a customer still blocked sort first; a rep refused often
who always gets through is listed below him, because a phone that needs eleven tries is worth knowing about.
Nine retries on one customer are ONE blocked customer, never nine. A refusal tied to no customer (a new
customer, one met outside the list) is counted apart — never as stuck and never as through. If the save
lookup fails the board still opens and reads "not through yet", the safe direction.

**The photo the phone sent** (owner, 2026-10-04: *"show the refused photo on the refused-readings page"*). Each row in
"Latest refusals" shows the picture that came with the refused capture, as a thumbnail that opens full screen — what
shows where the rep stood, and whether nine retries sent the same one nine times. Four things hold it:

- **Both readers see it**, unlike the mock-location answer: `photo_path` is in the select for the SFE Manager too.
- **The board hands the page a POINTER, never a link.** The page draws it with `CrmPhotoThumb`, which signs through
  `/api/phoenix-crm/photos/sign` — the scoped route, ten-minute links, re-signed when one expires. The SFE Manager's
  scope is every open line (`COMPANY_ROLES`, `access.ts`), so that route already covers every rep he can see here and
  nothing about it was widened. The page never opens the bucket itself (`photos.ts` is the one file that does).
- **Only a real slot path is handed on** (`photoPathTerritory`, and not a `test/` one) — a stored value of any other
  shape reads as "None kept", never as a broken tile. Refusals before 3 October kept no pointer, so they say the same.
- **Lazy.** The list holds up to a hundred refusals and each is rendered twice (desktop table, phone card, one hidden
  by CSS), and a hidden eager image still loads. `ZoomablePhoto` and `CrmPhotoThumb` gained an optional `lazy` that sets
  `loading="lazy"`; with it unset, every other surface loads as before.

The table fits by MERGING columns, not by shrinking type: Rep and Customer became one "Rep and customer" column to make
room for a 64 px photo column.

**What it does not do.** No button, no write, no notification, and nothing the rep is told.

Rule: `.claude/rules/phoenix-crm-boards.md`. Logic `src/lib/phoenix-crm/refused-readings-rules.ts`, reader
`src/lib/phoenix-crm/server/refused-readings-board.ts`. Pinned by `tests/phoenix-crm-refused-readings-board.test.ts`
(the wording, the strict "got through afterwards", the audience, the mock-flag select, that only the recorder and
this reader name the table, the page shape and its card, and the photo: a pointer for both readers, slot paths only,
the page never signs, `lazy` end to end).

## The place check reaches him on all three channels — owner ruling, 2026-10-05

His instruction, naming the page itself: *"WHEN AN UPDATE HERE /admin/field-crm/validation-reviews I
MUST BE NOTIFIIED BY EMAUL, IN APP AND TELEHGRAM"*.

**What "an update" is, read mechanically.** The only thing that ARRIVES on that page is a place the
Google Maps check could not settle — no listing the system is confident is the account, a lookup that
failed, a listing over `GOOGLE_STALE_PIN_METERS` away, or (since #5337) a second mismatch on the same
account. That raises `validation_review_waiting`. His own approve / reject / refuse / restore are NOT
mailed back to him: he is the sole decider, so a notice about his own click is the only thing it could
be, and `B-10` is the owner himself (`MEMORY.md`, rule #1).

**What was actually missing.** In-app, Telegram and push were already live on that notice from the
2026-10-03 ruling. **Email was not** — Phoenix CRM's standing email block (`enforcePhoenixCrmEmailBlock`)
strips email for the whole module whatever a call site asks for, and it is keyed on the module with an
allowlist on the exact event type. So the notice was arriving on two of the three channels he named,
and no amount of asking at the call site could have changed that.

**Why this email is narrow, and why that matters.** It is the FOURTH exception to the module's email ban
and the only one whose recipient is him and nobody else. `resolveHrIdsForRole("Super Admin")` reads
`app_auth_users` for active holders of that role, drops anyone whose employee record is terminal, and
`notifyValidationReviewWaiting` filters `TEST-` logins out. Read on production 2026-10-05: **one**
holder with an hr id — `B-10`, `omar.anwar@satopharma.com`, employment status active — plus one row with
a NULL hr id, which the resolver's own `.filter(Boolean)` drops. So the volume arithmetic that narrowed
`day_start_confirmed` to district managers (~74 emails a morning for the SFE Manager at full rollout)
does not reach this one: one address, and only while a decision is actually waiting on him.

**All three channels verified reachable the same day, not assumed.** `notification_preferences` for
`B-10`: `email_enabled`, `telegram_enabled`, `in_app_enabled` and `push_enabled` all true, no quiet
hours, `module_preferences` empty. `telegram_connections`: `status = connected`, chat id present, linked
2026-07-11, never disabled. `notification_module_channel_policies` holds no `phoenix_crm` row, so the
code default (`defaultTelegramPolicyFor`, enabled and not generic-only) applies. An email channel
switched on over a missing address delivers nothing and looks identical to working, which is why this
was read rather than inferred.

**Where the ruling lives, and the one shape that would quietly undo it.** The allowlist
(`PHOENIX_CRM_EMAIL_EVENT_TYPES` in `src/lib/notifications/phoenix-crm-channel-guard.ts`) is the single
place the exception is declared; the policy row `phoenix_crm.validation_review_waiting` is the intent and
the guard is the enforcement. 🔴 **The service must not name its channels itself** — it asks
`phoenixCrmChannels("validation_review_waiting")`. A hardcoded `["in_app", "email", "telegram", "push"]`
there is a second truth the guard silently overrules, so the day this notice is narrowed again the call
site would read as sending email while the guard stripped it. Both halves are pinned by
`tests/phoenix-crm-email-block.test.ts`, which compares the two lists exactly so a widening is visible
rather than quiet. **The rep's side is untouched: he still reads only "the system is checking", never
that a person looked at him (Phoenix CRM Golden Rule #1).**

## Phoenix Ranks — owner's rulings, 2026-10-05

He asked for one board shared by every medical rep of every line: a score for accuracy, timing,
number of visits, the KPIs and sticking to plan; the top of the day, week, month, quarter and
semester; military ranks in Arabic with stars a colleague can see on a profile and a timeline; and
every rep able to read exactly why they are or are not #1. His answers, asked as multiple choice:

| Question | His answer |
| --- | --- |
| Sales in the score? | **Never — field work only.** Sales stay on Sales Rankings. |
| Who sees what? | **Everything for everyone** — every rep sees every rep's pillars, rank and timeline. |
| Ranks | **Egyptian army, Arabic** — جندي (Private) up to لواء (Major General), twelve rungs. |
| Weights | **Equal, and printed on the page.** |
| GPS | A visible score only. His words: *"for the reps, only accuracy score and give them a score … the metrics keep in your back end or show it to the admin account."* |
| Added mid-build | *"also am start time"* — its own pillar, on the Early Birds clock (08:00 = 100, 12:00 = 0). |

**What it is built from — Phoenix CRM only.** The first build read the KPIs board, Early Birds and
iReports360 check-ins; the same evening he ruled *"all data in phoenix crm not ever any data from old
crm"*, and it was rebuilt before it merged. Now: Phoenix CRM's countable visits (real, validated, AM
and PM lists — Pharmacy is in no KPI), its lists and grade targets, `phoenix_crm_report_plan_vs_actual`
with leave applied by `groupPlanByTerritory`, the rep's own "I started working" press, and its place
check. A rep owes days from the team's start (`phoenix_crm_team_starts`), or from the first real visit
for a team never started, never before hiring; working days are `isCallRateWorkingDay` and approved
full-day leave comes out. The call-rate targets are Phoenix CRM's locked AM 2 and PM 10, two pillars.

**Coverage and frequency over any duration.** Asked how they should appear on a day or a week, he
answered *"it's monthly now, but we can measure it by weekly … it thinks monthly"*. Each window is cut
into month slices; in each, the month's expectation is prorated by the share of the month's working
days the rep owed there, and slices are weighted by owed days. A whole month at full attendance equals
Phoenix CRM's own coverage figure; frequency counts visits against the grade's monthly target at that
pace, and visits beyond it earn nothing.

**AM start is a BONUS, not a measure.** The first rebuild left a day with no press out of the AM
start average, and the live October data showed the flaw at once: only 4 of 13 reps had pressed, and
pressing LOWERED a score — Hassan Mohamed pressed at 10:11 and ranked #5 while Mohamed Ahmed never
pressed and ranked #1. Asked, he ruled: *"suppose that he forgot, but he made his visits. So give it a
bonus, but do not make it zero for the whole AM."* So the total is the average of the other
measures (seven then, twelve now) plus up to 5 bonus points, earned day by day (08:00 earns the day's full share, 12:00 none, a
day without a press nothing), never above 100. Pressing can only add. Field accuracy is left out when no
visit could be judged against a place; every other missing measure is a 0 (no plan scores 0).

**Five deeper measures, added the same evening — twelve in all.** Asked which to add, he chose all
four offered — *"Time between visits, Products per visit, Visit notes, GPS precision"* — each worth the
same as the first seven, and integrity *"In the score, admin sees detail"*; reps still see scores only.

| Measure | How it scores |
| --- | --- |
| Time between visits | His own model, in his words: *"calculate the distance in kilometer between each visit and the other … if walking how much time it will take and consider to add … from 10 to 30 minutes … a waiting list to enter to the doctor and the visit itself it takes from 5 to 10 minutes maximum"*. Walking is the straight line × 1.3 at 5 km/h — **not Google Maps**: Phoenix CRM's `geo.ts` records his earlier rule never to buy a map API. A gap inside walk + 15 to walk + 40 minutes is 100; shorter falls in a straight line to 0, longer falls to 0 at three hours. A pharmacy saved within 3 minutes of a doctor visit is the same stop; a gap over 3 hours is a break, not a gap; both fixes must be 100 m or better. |
| Products per visit | Three products discussed on a doctor visit is full marks. |
| Visit notes | The share of field saves with a comment of three characters or more, or a voice note. |
| GPS precision | A fix of 20 m or better is 100, 200 m or worse is 0. |
| Integrity | Each save carrying a strong location flag (mock provider, replay, impossible travel, zero jitter) costs five times its share. A fix past Phoenix CRM's own coarse line (`COARSE_ACCURACY_METERS`, 500 m — the accuracy-gate section below) never counts the precision flags, whose list is that module's too: Android's approximate location raises them by itself, the false positive measured on an honest rep, and a row written before the gate landed must not cost a rep either. The admin twin sees the flags; the rep and the certificate never see which check fired. |

🔴 **Time between visits reads `captured_at`, which is the SAVE time, not the arrival** — a rep who
saves in batches from the car scores low on it. That is the trade-off he chose knowingly; it is why
this measure was left out of the first build.

**The board is wide cards and every ranked rep can print a certificate.** He found the table *"so
condensed"* with *"very small"* fonts and asked for cards, and for *"any rep who is taking a rank or a
title to be able to export premium polished PDF showing his title, his rank and his score and a
snapshot of why he is in this place"*. `GET /api/rep-ranks/certificate` renders one A4 sheet in the
spotlight sheet's own design (crest, brackets, stat band, SATO-DIS-2026-01): the rank and its insignia
(the same SVG the board draws) beside the rep's portrait (owner, 2026-10-06: *"and add his picture"* —
the performance card's photo source, initials when there is none), titles held, the score, "Why this
place" and the twelve measures. A
rep prints their own; Super Admin, CEO and SFE Manager print anyone's from `/admin/ranks`. It reads the
portal audience, so it never carries a count.

**Where it runs.** A nightly cron at 04:17 Cairo (`/api/cron/rep-ranks`, dead-man's switch
`phoenix-rep-ranks`) snapshots every window into `rep_rank_standings`; `?backfill=YYYY-MM` rebuilds a
past month. The portal page (`/employee-portals/ranks`) reads `PORTAL_COLUMNS`, which never selects
`metrics`; only `/admin/ranks` (Super Admin, CEO, SFE Manager) reads the raw counts. A star is a
month, quarter or semester title; day and week wins are medals. The rank is the mean of the newest
three ranked months. Pinned by `tests/rep-ranks.test.ts`.

---

## The accuracy gate and an approximate-location fix — owner, 2026-10-05

*"fix the accuracy gate that is flagging Hassan"*. He had read the Super Admin's integrity board and
seen a rep accused of preset coordinates. The board was right about what it measured and wrong about
what it meant, and the first thing the fix had to establish was **who it was actually accusing**.

**The rep was not Hassan.** The rows belong to **Yasmeen Samy** (B-130), four of them on 3 October.
Hassan Mohamed (B-158) does have coarse fixes of his own — 1273.4 m and 1414.0 m — and they produced
no integrity rows at all. Acting quietly on the name he gave would have "fixed" a rep who was never
flagged and left the flagged one accused, so the name correction is part of the account rather than a
footnote to it.

**What the phone was doing.** Android's **Precise location** toggle has an off position. With it off
the OS stops handing an app a receiver reading and returns the **centre of a ~1–2 km grid tile with a
fixed accuracy figure**. The coordinate therefore repeats and the accuracy never varies — *by
construction*, for every app on the phone, with nothing for the rep to do about it and nothing for the
phone to confess. Her morning, read from `phoenix_crm_location_integrity` on production:

| | |
| --- | --- |
| fixes | 11, across 4 customers, in 59 minutes |
| spread | `spreadMeters: 0` |
| accuracy | exactly `2000` on **every** reading |
| the phone's mock flag | `deviceMocked: null` — nothing confessed, because there was nothing to confess |
| what the board said | `coordinate_replay` + `constant_accuracy`, three rows of them **strong** |

🔴 **`zero_jitter` — also strong, and worse — missed her only on the clock.** It wants a 120-minute
span and her morning was 59 minutes. A full day on the same phone setting reads as *"the position
never moved all day"* about a rep who moved all day. That is the version of this that would have
reached him as a fraud finding.

**The threshold is measured, not chosen.** 772 real fixes from 14 reps: median **14 m**, 95th
percentile **60 m**, 99th **122.4 m** — and then **nothing at all until 1273.4 m**, where the only
inhabitants are approximate-mode fixes. `COARSE_ACCURACY_METERS = 500` sits inside that empty band:
four times the worst honest fix, under half the nearest coarse one. No real reading is on either side
of it, so it separates the two populations without touching a single honest fix.

**What goes quiet, and what does not.** The four **precision-dependent** detectors are suppressed
above the line — `coordinate_replay`, `zero_jitter`, `constant_accuracy`, `typed_coordinate`
(`PHOENIX_CRM_PRECISION_INTEGRITY_FLAGS`). 🔴 **`mock_provider` and `impossible_travel` still fire**:
the first is the phone's own confession and owes nothing to precision, and the second already
subtracts both error bars before it judges a speed. Both are pinned, because waiving them is what
would turn a false-positive fix into a hole.

**Coarse readings leave the EVIDENCE on both sides, not only the verdict.** Without that half the same
false accusation lands one fix later: an honest *precise* fix gets flagged for "replaying" the tile
centre its own phone returned an hour earlier. `signals.coarseHistoryIgnored` records how many priors
were set aside.

**The row is not silent.** It carries the weak flag **`coarse_location`** — *"The phone was set to
approximate location, not precise"* — with `signals.coarse.suppressed` naming exactly what was set
aside. A manager can act on that: a rep whose every fix is coarse is a **visible pattern** to be asked
about, instead of a false accusation. Golden Rule #1 is untouched — none of this reaches the rep's own
screen.

**Her four rows were re-scored**, because code alone would have left three strong accusations standing
on the board. They now read `coarse_location`, `strong = false`, with the original preserved in
`signals.rescored.previousFlags`; nothing was deleted and a rollback file was written before the
update ran. Afterwards: `strong_rows_left=0 replay_rows_left=0 coarse_rows=4 rows_total=4`. **The
integrity board now holds no strong rows at all** — the same answer the field audit reached by
measurement, which is that its entire strong content was this one false positive.

---

## One customer, one name key — owner, 2026-10-05

*"fix the customer name match in Phoenix CRM"*. **Two keys were answering one question.**
`server/duplicate-customers.ts` folds a name through `normalizeContactName` before deciding two rows
are the same customer — NFKC, the hamza carriers أ إ آ ٱ onto ا, final ى onto ي, final ة onto ه, the
diacritics and the tatweel, punctuation, honorifics, case — while `phoenix_crm_load_list_customers`
compared `lower(c.name) = lower(v_name)`. **So the loader created the second row and the board then
reported it.** The system disagreed with itself, and the SFE got a duplicate that nothing had
prevented.

**Measured on production, 2026-10-06.** **2,708 of 9,137** customer names (29.6%) change under the
fold, and **8** groups on one seat and one list type hold the same customer twice where the raw key
could never have seen it. Every one of the eight is a pure orthography pair — the same doctor or
pharmacy, typed by two keyboards:

```
أحمد محمد الصباغ / احمد محمد الصباغ            hamza carrier
مستشفي مصطفى محمود / مستشفي مصطفي محمود        final ى
محمد الشكلى / محمد الشكلي                       final ى
أيسر بسالى / ايسر بسالي                         both
احمد شلبى / احمد شلبي                           final ى
أسلام نعيم / اسلام نعيم                         hamza carrier
صيدلية الحرية الجديدة / صيدلية الحرية الجديده    final ة
بيشوى نبيل / بيشوي نبيل                         final ى
```

**`public.phoenix_crm_fold_name(text)` is the SQL half** — immutable, service-role only — and it is
used by **both** of the loader's name comparisons: the customer insert *and* the days-and-hours pass.
A fix to one of them would still let the duplicate in through the other, which is why the test counts
the folded comparisons rather than merely finding one.

🔴 **It only ever SKIPS.** A folded hit takes the existing `already_on_the_list` branch, which reports
the row to the SFE and moves on. **Nothing merges, deletes, renames or overwrites a customer** —
removing a duplicate is the district-manager-then-SFE two-step the owner owns — so the 55 groups
already on the list stay exactly as they are. (A unique index could not have been created over them
anyway.)

**Exercised on production in the test world, then removed:** `أحمد محمد الصباغ` loaded; the hamza
variant and the honorific form (`د/أحمد محمد الصباغ`) were both **skipped · already_on_the_list**; the
same name on the **AM** list loaded, because a different list is a different list; and `محمد أحمد
الصباغ` — the names reordered — loaded, so the fold has not become a blunt instrument that folds a
stranger onto a customer. Afterwards: `0 customers and 0 events left behind, 9,137 real customers
untouched`.

🔴 **The fold now exists TWICE, and that is the whole cost of this change — so it is measured, not
assumed.** `TITLE_TOKENS` is exported for the purpose, `tests/phoenix-crm-customer-name-fold.test.ts`
compares the two honorific lists **literally**, and all 9,137 live names were folded by both halves
with matching digests (`00807c0abf8c22d7f9d55c57bbeda6a4`).

🔴 **Replacing that loader again: take the body from `pg_proc.prosrc` and prove it by md5 BEFORE
editing it.** The repo's newest migration is the live body only until the next one lands, and the
first attempt at this was refused by exactly that check over a 3-character difference
(`893c9642aa53799b4a9f949f13a40ab5` is the pre-edit digest; the two functions afterwards are
`6ccedbf0aad66e7a04424c69716c6b93` and `6cbec6c37b04152d0af1f009b2eb905e`, identical in production,
staging and the migration file).

---

## The Production Planner is English OR Arabic, chosen with a toggle — owner, 2026-10-06

His words: **"U WANT THE MODULE TO BE ENGLISH OR AARABIC AND I CHOSE BY SWITCHING A TOGGLE"**. It
amends — it does not contradict — his original ruling for this module,
*"طبعا اللغه دي عربي عربي عربيك ايجيبشن عربيك"*: **Arabic stays the default**, and the toggle is a
per-reader choice over it.

**What that means in the code**, and why each half is the way it is:

- **English is a full second catalogue, not translated headings.** `PP_EN` in
  `src/lib/production-planning/strings.ts` is a `Record<ProductionPlanningStringKey, string>` over
  the Arabic catalogue's own key type, so all **199** keys exist on both sides and a key added to one
  and forgotten on the other is a COMPILE error rather than one Arabic word in the middle of an
  English screen. `tests/production-planning-strings.test.ts` asserts the parity in both directions
  at run time too, because a `Record` can be satisfied with an empty string, and sweeps the English
  half for any Arabic character left in it.
- **The whole module flips, not only its text.** `productionPlanningStrings(lang)` carries the
  direction, the face stack, the five tab labels, the three label maps and the planner sentence
  together. English is **left-to-right on the app's own type**: an English page forced onto an
  Arabic-first face stack reads as a different application from every other English screen.
- **It is a CONTEXT, not a prop.** The portal page passes the header to `EmployeePortalPageShell` as
  its `hero` and the workspace as its children, so the two are siblings in different prop slots and
  no prop could reach both from one piece of state. Context resolves where an element is RENDERED,
  which for both of them is inside the shell — so the provider wraps the shell.
- **Remembered per BROWSER**, in `localStorage`, never in `prodplan_settings`: the choice is worth
  nothing to anybody else, and a stored setting would make one reader's toggle change the language
  for the other four. It is read AFTER mount, because the server has no `localStorage` and resolving
  it during render is a hydration error rather than a language.
- **The Excel export follows it** through `?lang=`, which flips the sheet's `rightToLeft` with the
  strings — an English sheet laid out from the right reads as a corrupt file, not as a language. An
  unreadable value falls back to Arabic rather than to a blank sheet.
- **The server's refusals follow it too.** The 18 validation messages the service can throw are a
  catalogue in both languages (`PRODUCTION_PLANNING_ERRORS` / `_EN`), resolved per request from the
  `lang` every write carries — the workspace's own `post` puts it on the body in one place. A
  refusal is the one part of this module a reader only ever sees once something has already gone
  wrong, and an Arabic sentence landing on an English screen at that moment reads as a broken page.
- 🔴 **The REORDER EMAIL stays Arabic whichever way the toggle is set.** Four named people were given
  an Arabic notification, nothing has been said about changing what lands in their inbox, and a
  screen preference held in one browser must not decide the language of somebody else's email.
- **Latin digits and the genderless Arabic are untouched**, and now swept in both halves.

- **Names follow the toggle too (owner, 2026-10-08: "If English, every single Arabic word").** The first
  version flipped the labels and left every product, material and store name in Arabic, because the
  screen and the workbook read `nameAr` directly. All three tables store both names, so the bundle
  carries `S.name(item)` (Arabic reads `nameAr`; English reads `nameEn`, falling back to Arabic only if
  the English name is blank) and neither the workspace nor the workbook may read `.nameAr` again. The
  Excel filename now comes from `productNameEn` in plain ASCII, since it travels in a header.
  The language switch follows the same rule (`languageArabic`: Arabic script on the Arabic screen, the
  word "Arabic" on the English one), so the English screen holds no Arabic character at all. Measured
  2026-10-08 by server-rendering all five tabs plus the header from the real production payload:
  0 Arabic runs in English against 807 in Arabic (the positive control).

**The two things the toggle cannot reach**, both deliberate: the portal shell's `title` and
`errorBoundaryTitle` are server props on a server component, so the client context cannot see them —
they are page chrome, and the title a reader sees INSIDE the module is the header's, which does
follow. And the sidebar entry, which has always read "Production Planner" in English like the rest
of the app's navigation.

**A THIRD thing it cannot reach, settled by him rather than by me: the stored plan TITLE.** When a
plan is committed, `savePlan` names it `<product> — <n> تشغيلة` from the Arabic catalogue, whoever saved it.
It is the one reader-visible string in the module that does not follow the toggle, and leaving it
there was a judgement I made and then put to him; asked directly on 2026-10-06 he answered **"pin
the stored plan title as Arabic"**.

The reason is that a stored title is not a screen — it is a row, and both readers meet the same rows
later in the same Plans list. A title following whoever saved it would give that list a mix of
Arabic and English entries with nothing to explain the pattern, which is worse for both readers than
one language used consistently. The two refusals that name a material went the other way, and the
distinction is exactly this: a refusal is read ONCE, by the person who caused it, so it belongs in
their language; a title is read repeatedly, by everybody, so it belongs in one.

Pinned by `tests/production-planning-strings.test.ts`, which asserts the title line still reads from
`PP` rather than the bundle — so a later session sweeping the module for "strings that should follow
the toggle" meets the pin instead of quietly undoing the ruling. Rule: `.claude/rules/production-planning.md`.

## The planner's fit is measured in a browser, in both shells and both languages

🔴 **The portal shell is unreachable from an admin account, so "look at it on production" cannot
answer the portal question.** Each twin redirects the other shell's viewer to its sibling —
`app/(admin)/admin/production-planning` sends a portal-mode viewer to
`/employee-portals/production-planning`, and that page sends an admin-mode viewer back — so one
account sees exactly ONE surface for ever. The owner is Super Admin, i.e. admin mode, so his own
signed-in session can never render the surface the module's MAIN USER opens, and production accepts
no dev-auth headers.

`scripts/measure-production-planning-fit.mjs` is the answer
(`pnpm run ui:measure-production-planning-fit -- --fixture <file>`; `--capture` writes the real
payload first, and it holds prices, so it is never committed). It renders the real tab components
inside each shell's own container chain, serves them over HTTP — a `file://` tab loads as a static
snapshot and Tailwind never applies — and reads the browser.

**Measured 2026-10-06 against the real production payload: 40 rows** — two shells × two display
scales × two languages × five widths (375/768/1024/1280/1920). Zero overflow, zero clipped cells,
zero corner radii, zero Arabic-Indic numerals rendered; the tab strip wraps onto two rows at 375px
and one above it. **The tightest box in the whole sweep is the PORTAL's at 1024px and display scale
1 — 636 layout px, columns 196/146/146/146.** Both languages are measured and neither is derived
from the other: English is a left-to-right layout of different strings, so its columns, its header
rail and its wrap points are a second layout rather than a translation of a measured one.

🔴 **A rect is VISUAL px under `phx-zoom-surface` and `clientWidth` is LAYOUT px — never compare the
two.** `.phx-zoom-surface { zoom: var(--phx-display-scale, 1) }` sits on `<main>` in both shells, so
`getBoundingClientRect()` returns the zoomed width while `clientWidth` returns the width the columns
were actually laid out in. Mixing them reported a content box 20% narrower than its own table and
made two correct measurements look like a contradiction. The zoom is also gated to
`@media screen and (min-width: 1024px)`, so BELOW 1024px zoom 1 is the correct reading and asserting
the chosen scale there asserts the opposite of the rule. Sweep both scales: 1 is every user's
default and the tight case; 0.8 is the owner's own session, where the same portal box is 795px.

**Every control in it was broken and watched to fire**, which is the only reason its zeros mean
anything: an over-wide child, a per-cell clip (sized to the cell, because at 1920px a column is
485px wide and a fixed repeat count stops overflowing exactly where the page is widest), an inline
`border-radius: 9px` probe (`rounded-lg` computes to 0px here, so a class probe would certify a
deleted sweep), an injected Arabic-Indic numeral, and a hard-coded direction surviving the toggle —
which is how the loading state's own `dir="rtl"` was caught.

## The objection and the next step are UNFOLDED — owner, 2026-10-06

*"unfold objection and next step in Phoenix CRM"*. This **amends his own 2026-10-02 ruling**, which
folded all three optional steps of the visit form, and only his own word could do it.

**Why he was asked for it, and what the field had said.** On 2026-10-02 he asked for fewer steps and
fewer clicks: *"I need all the points in the current form of entering the visit … I don't need too
many steps and too many clicks by the reps."* Every point stayed and kept its header, and each of the
three optional steps shrank to a one-tap dashed row. Then the field answered. Across the module's
first three live days the reps recorded a **next step on 1 visit of 332** and an **objection on 2** —
and these are the two questions a pharmaceutical manager actually coaches on. Five readers run on
them (`commitments.ts`, `call-prep.ts`'s last objection, `field-heard.ts`, and the boards that quote
those), so they were not broken, they were simply never filled in.

**What changed, exactly.** Step 7, *What you took away*, renders its two rows of chips with nothing in
front of them. The other two optional steps — the pharmacy stock check and what he left behind — are
**unchanged and still folded**, so `VisitExtra` is now `"pharmacy" | "left"` and `openExtras` still
starts empty. 🔴 **Step 7 carries no folded branch at all.** A step that can never be folded must not
keep the row that folds it: a key nothing folds would leave an *"Add what the customer said"* row on
screen that could never be shown, which is the silently-dead branch this repo has been bitten by
before.

🔴 **UNFOLDED IS NOT REQUIRED, and that is the half that would go wrong quietly.** Chips in view read
as a question the save asks. The save's own check (`draft`) refuses a visit for the customer, the
products and the comment and **for nothing else** — a rep at a door must never be refused for an
objection he was not given, and the header still reads `Optional` above the line that says the visit
logs without it. `tests/phoenix-crm-visit-form-ease.test.ts` (e) asserts the refusal half of `draft`
mentions neither `objection` nor `nextStep`, and the break that adds one goes red.

**The press count moves the right way.** A rep who answers now taps 2 instead of 3; a rep who skips
taps nothing either way and pays only the scroll. Nothing was asked twice and no step was added —
which is the 2026-10-02 ruling's own standard, met with the step open.

## The Super Admin corrects a visit, and Double takes one person while Chain takes two — owner, 2026-10-06

*"Make the admin able to edit a visit submitted by an employee. Example, if he chooses a wrong double
visit, make me able to enter and edit it."* And, of the rep's own form: *"When he chooses double visit,
his district manager appear, the product manager appear, the national sales manager appear, and he can
choose only one … and if applicable, the regional manager. In the chain visit, all those appear, but he
can choose two, not one."*

**What the rep sees now.** Single, Double and Chain — three choices, where there were four. Under
Double and Chain one list shows the managers above his territory (district, the regional manager where
his line has one, national) and the product managers of his own line, and he ticks **one** for a
double and **two** for a chain. The "A product manager" chip is gone: a product manager is a person on
the list, not a fourth kind the rep has to know. The rule is `src/lib/phoenix-crm/visit-company.ts`;
the list is `visit-company-picker.tsx`, shared with the Super Admin's correction so the two can never
offer different people.

**What each pick is filed as — and the part that must not be "tidied".**

- A manager under Double → `kind = 'double'`, the manager in `manager_hr_id`.
- 🔴 **A product manager under Double → `kind = 'product_manager'`, in his OWN column — never a
  double.** `double_visits` is counted from `kind = 'double'` on every board, a figure district
  managers are judged on (`20261002205436`); the rep never sees the word, the kind is derived from
  who he ticked.
- Two managers under Chain → `kind = 'chain'`: the nearer one in `manager_hr_id`, the one above him in
  `senior_hr_id`, whichever order they were ticked in.
- A manager and a product manager under Chain → `kind = 'chain'` with the product manager in his own
  column and `senior_hr_id` empty. **At most one product manager on a chain** — the table has one
  column for him, and a chain is the management line; two of them is refused (`ONE_PRODUCT_MANAGER_ON_A_CHAIN`).

That last shape did not fit the table. `20261006234611` widens `phoenix_crm_visits_participants` so a
chain's second person is a senior manager **or** a product manager (never both, never neither), allows
the product-manager column on exactly its two kinds, and patches `phoenix_crm_save_visit` in place
(three edits, the rest byte for byte; `tests/phoenix-crm-visit-product-manager.test.ts` finds the live
body by sort order). `resolveVisitParticipants` (`scope.ts`) is the server's check for all of it.

**The correction.** A **Correct this visit** button on each visit card of the day page, drawn only for
the Super Admin (`editsVisits`, from `canEnterMissedRecords`; the route and the service assert the same
gate again — `territoryForVisitEdit`). It changes three things and nothing else:

- **who was on the visit** — through the same picker, re-checked server-side exactly as the rep's own
  save checks it, as the rep;
- **the products**, from the line's own list (plus any the visit already carries, so a family the line
  has since dropped never makes a typo unfixable);
- **the comment**, which stays required.

🔴 **It never touches the evidence** — the customer, the day, the time, the location, the photo or the
voice note. Those are what every figure and every integrity check read, and a correction must not be
able to move a visit onto another day or another customer. That is a remove-and-enter, and a rep's own
visit is not removable. The pharmacy visits a visit filed (`linked_from_visit_id`) always carried its
products, so they follow a products correction.

🔴 **Who was on a visit changes only where the rep entered it, or the Super Admin entered it for him.**
A visit a MANAGER entered carries that manager as the visit's manager; re-picking would make his own
record read as entered by somebody who was not on it (`isEnteredForRep`), so on those the products and
the comment can be corrected and the people stay as recorded, with the sentence that says why on the
screen. A comment-only correction sends no people at all, so a manager who has since left the
territory's chain cannot make a typo unfixable.

🔴 **Nothing is lost, and the rep is told nothing.** `phoenix_crm_admin_edit_visit` keeps what the
three things said before and after, who changed them and when, in `phoenix_crm_visit_edits` (production
has no point-in-time recovery; the table has no foreign key, so removing a visit never takes its history
with it). It sends no notice to the rep or to anybody: this is a correction to a record, not a check on
him (Golden Rule #1). Pinned by `tests/phoenix-crm-visit-company.test.ts`.

## The reset code goes to the work email — owner, 2026-10-07

The self-service password reset was being built on `codex/email-login` (sign in with a Sato email,
reset by an emailed code) and had not been pushed. AGENTS.md §4 says to ask who receives an email
before it is wired, so he was asked, and answered:

> yes, Sato work email only, never a personal address

**The rule.** A reset code is sent only to the employee's `work_email` as stored on their row. Never
a personal address, and never an address taken from the request body — a flow that mails whatever
the form submitted would let anyone redirect another person's reset code to themselves.

### What it costs, measured on production the same night

`public.employees` has exactly one email column, `work_email` (`text`, **nullable**). There is no
`personal_email` column on the table, so there was nothing to prefer it over.

| | |
| --- | --- |
| Employees | 208 |
| With a `work_email` | 188 |
| Of those, on `@satopharma.com` | **188 — all of them** |
| On any other domain | **0** |
| With no `work_email` at all | 20 |

So the ruling excludes nothing that exists today: every address on record is already a Sato one. Its
real cost is the 20 rows with no address, and almost all of those are not login-bearing people:

| `employment_status` | missing `work_email` |
| --- | --- |
| `historical_payroll_record` | 15 |
| `system_placeholder` | 2 |
| `resigned` | 1 |
| **`active`** | **2** |

**Two active employees, both Medical Representatives, therefore cannot self-reset** and need an
admin reset until HR fills their address. They are named in the session where this was measured, not
here — a tracked file is the wrong place for two people's records.

### Why the nullable column is the part that bites

The obvious reading of "Sato work email only" is a domain check, and a domain check would have passed
188 of 188 and told you nothing. The failure mode is the **absent** address: a reset flow that
resolves `work_email` and sends to `null` either throws for the user or, worse, quietly succeeds
against an empty recipient. Treat "no address on record" as an explicit branch with its own message
pointing the employee at an admin reset — not as an error state to discover in production.

## A merge approval names a PR that exists — 2026-10-07

Not an owner ruling: a session defect, recorded here because it is the `Next step:` box turning his
own rules against him, and because it put a live authentication change one word away from shipping
unseen.

### What happened, twice in one session

The box rule says the line always ends in words he could send, and the suggestion is exactly those
words. Twice within about forty minutes the session filled it with a merge for a PR that did not
exist:

| Time (Cairo) | What the box offered | What was actually open |
| --- | --- | --- |
| 00:07 | "merge the next PR those three sessions open, when green" | nothing — none of the three branches was pushed |
| 00:46 | "merge the email login PR when it opens and is green" | nothing — `codex/email-login` still unpushed, no PR |

He typed both, because that is what the box is for. Neither could be executed, so each cost him a
turn and got an explanation back instead of work.

### Why the second one was worse than a wasted turn

`codex/email-login` is **12 files** of authentication: sign in with a Sato email, self-service reset
by an emailed code, two new API routes under `app/api/auth/password-reset/`, changes to
`src/lib/auth/credentials.ts`, `password-setup.ts`, the login page, `src/lib/security/access-registry.ts`,
and a migration (`20261006214500_password_reset_codes.sql`).

A merge to `main` is a production deploy at full traffic within minutes, with no smoke test between.
So a pre-approval of that PR is a pre-approval to replace the sign-in path for **114 active
employees** on a system real salaries are paid from, before anyone has read the diff. And the branch
was still moving while the suggestion sat in his box — `e769d8408`, then `8906294cd`, then more.

Green CI would not have covered it either. `validate` and `checks` prove lint, types, the contracts
and the unit suite; the Playwright **login smoke test is skipped on pull requests** and runs only on
`main` — i.e. after the merge, after the deploy. §7 puts auth in the band that needs a role sweep
with denial paths and an explicit risk review, and the migration has to be applied by hand first,
because the deploy applies none.

### The rule

**Quote a merge only with a real PR number that has been read.** When nothing is open, the box takes
a real action instead, and the prose says plainly what will need approving once it exists. This is
the merge-shaped form of the existing box rule — never a task Claude invented — and it is the worse
form, because what gets invented is an approval rather than a chore.

A standing pre-approval also cannot be carried forward: an approval given for one PR is spent on
that PR, and leaving it somewhere a later session would act on it is laundering a permission
decision out of the window it was given in.

## Every double visitor reads the visits he was on — owner, 2026-10-07

> "nada abdullah yesterday submitted double visits with ahmed sharaf those visists are not appearing
> in his data also check all double visists are appearing to the double visitor"

Both halves of that message are answered here: why one rider could see nothing, and what the sweep
of every other rider found.

### It was a column, not a missing screen

`phoenix_crm_visits.product_manager_hr_id` has existed since `20261002205436` — the owner's own
ruling that a product manager rides in his own column and never in `manager_hr_id`, because
`double_visits` is counted from `kind = 'double'` on every board and district managers are judged on
it. Two things were never widened to match:

1. **`phoenix_crm_countable_visits` did not carry the column.** Every Phoenix CRM report reads that
   view and none of them reads the raw table, so no report could name the person in it even in
   principle.
2. **`phoenix_crm_report_manager_visits` joined `manager_hr_id` and `senior_hr_id` only.** The one
   report that says who went out with whom had two branches where the data has three.

And a third, which would have kept the report empty even with the first two fixed: a product manager
**holds no seat in the sales organogram** (`au.v_org_tree` is sales-only), so `managersInScope` can
never name him and `chooseTerritories` hands him no territory. `scopeTerritories` is empty for him,
which is why every visit, team, plan and photo route had already been answering him with nothing.

### The sweep, measured on production 2026-10-07

Every non-rep who stood on a Phoenix CRM visit, and whether a seat above the rep's territory gives
him sight of it:

| Slot | Person | Kind | Visits | Rep seats under a seat he holds |
| --- | --- | --- | --- | --- |
| `manager_hr_id` | Nermeen Salah Abohussien, District Sales Manager | double | 27 | 3 of 3 |
| `manager_hr_id` | Dina Hamdy Bdair, District Sales Manager | double | 18 | 2 of 2 |
| `manager_hr_id` | Mahmoud ElHassanin, District Sales Manager | double | 17 | 3 of 3 |
| `manager_hr_id` | Nermeen Salah Abohussien, District Sales Manager | chain | 4 | 1 of 1 |
| `senior_hr_id` | Hany Saad Omar, Regional Sales Manager | chain | 4 | 1 of 1 |
| `product_manager_hr_id` | **Ahmed SharafEldeen, Product Manager** | product_manager | **13** | **0 of 2** |

So 66 of the 79 non-single visits were already reaching their rider through downward scope, and 13
were reaching nobody — every one of them Ahmed SharafEldeen's, 8 with Nada Abdullah on 2026-10-06
and the rest with another Pedia rep the next morning. The owner's "check all double visits are
appearing to the double visitor" has exactly one answer, and this is it.

### The fix

- the view gains `product_manager_hr_id`, **appended last** — `create or replace view` accepts a new
  column only at the end, and `crm_visits_unified` and `crm_checkins_unified` depend on this view so
  it cannot be dropped to order the column properly. Read it by name, never by position.
- the function gains a third branch, `role_on_visit = 'product_manager'`, counted in its own
  `product_manager_visits` column.
- `readsOwnRideAlongs` → `loadOwnRideAlongReport`: the **same** "Double and chain visits" report,
  with HIS hr id as the whole `p_hr_ids` and every open line's territories as the reach — one row,
  his own. The team's gate is asked first, so a product manager who also held a manager seat reads
  the full board instead.

### What did NOT change, proven rather than asserted

The pre-migration two-branch output was rebuilt as an ad-hoc query and diffed against the live
function narrowed to those same two roles, over every rider and the whole week: **11 rows each, 0
rows in either direction, `double_visits` 57 = 57.** No district manager's figure moved by one. A
product manager is still never filed as a double visit; his own screen says "double" because that is
the word the rep ticked, and only the stored kind and the counted figure keep them apart.

## The weekly unexplained-day notice is the employee's own — owner, 2026-10-08

**His instruction, in full:** *"add an employee notice when his own calendar has an unexplained day"*.
It followed directly from the measurement he had just asked for — *"check whether reps can actually
find the Request review control"* — and the answer that came back.

### What the measurement actually found

The control was not hidden, not wrongly gated, and not broken:

- `/employee-portals/private-calendar` carries **no role restriction** in
  `src/config/system-navigation.ts`, only `permissions: [{ resource: "employee_profile" }]`, so every
  one of the **111 active employees** has the page in their portal nav.
- The `Request review` button renders for any day of the viewer's **own** calendar, gated correctly by
  `canActOnOwnDay` — `privateCalendarHrIdKey(viewerHrId) === privateCalendarHrIdKey(selectedEmployee.hrId)`
  in `src/components/employee-portal/private-calendar.tsx`.
- In the **two and a half months** since it went live on 22 July 2026 it had been used **once**:
  Weaam Mahmoud's 4 October request, still `pending_review` at the time of the measurement.

Three things explained the one request, and only the first was fixable:

1. **Nothing in the system ever told an employee to look.** All three notifications in the module fire
   the other way — the Super Admin on a new request, the employee on a *decision*, and thread replies.
   Discovery depended on somebody opening a portal page unprompted and noticing a small button in a
   section header.
2. The red exceptions strip on the calendar is **navigational only**: its per-exception button does
   `onClick={() => focusException(exception.date)}` and nothing else, so even an employee already
   looking at the strip is not told what to do about it.
3. Most reps' calendars are populated by CRM visits anyway, so a genuine gap is rare for them — the
   people with unexplained days are disproportionately those the fingerprint devices do not cover.

### The notice he asked for

Saturday **08:09 Cairo**, for the completed **Sat–Thu** week. One notice **per employee**, not one per
day: five separate notices about one week teach the bell to be ignored.

- 🔴 **It judges nothing of its own.** The days come from `getCompanyNoActivityDays` — the *same*
  engine call the Deductions module's No Records Activity connector makes, over the same
  `derivePrivateCalendarExceptions` the employee's own calendar renders. No detector re-runs, no
  threshold lives in it, and it reads no table the calendar does not. So **the day the notice names,
  the day the calendar shows, and the day that can become a payroll deduction candidate are one day by
  construction** — the same reasoning that put the approved-plan source into both engines on 2026-10-07
  rather than one of them.
- 🔴 **The audience is the EMPLOYEE ALONE** — never the manager, never HR, never an admin digest. A
  recording gap is usually a day away from a fingerprint device or work that was never logged, not an
  accusation, and nobody else is told before the employee has had the chance to answer.
- 🔴 **Never email.** In-app and push only. Bulk outbound email from a business system is banned, and
  every automated email in Phoenix also mirrors to the owner's Telegram — so a weekly sweep over the
  roster on the email channel would both spam the staff and page him dozens of times a week about news
  that is not his. Push is per-subscription and opt-in.
- **A day already carrying a review request of ANY status is named to nobody.** A pending one must not
  be nagged about; an accepted one is settled; and a rejected one was answered by a Super Admin in
  person, so re-raising it weekly would argue with that decision through the bell.
- 🔴 **That suppression read fails CLOSED.** If `private_calendar_data_disputes` cannot be read the run
  throws rather than sending: a notice is unretractable and a retry is free, so the one thing it must
  never do is nag an employee about the exact day they have already done the right thing on.
- The idempotency key is **per employee per week**, keyed on the window end, so a retry or a double
  fire reaches nobody twice — and it is independent of the message text, which a late-arriving punch
  could still change.
- The wording is **neutral** (the 2026-10-05 rule). His own instruction says "his"; the notice does
  not, because 88 of the 206 active employees are women and 31 have no gender recorded.

**Known limit, stated rather than worked around:** `app/employee-portals/private-calendar/page.tsx`
takes no `searchParams` and always opens on the current Cairo month, so the notice cannot deep-link to
the day. The dates travel in the message text and the body says to step the calendar back.

**Where it lives:** `src/lib/private-calendar/gap-notice-rules.ts` (pure — window, composition, cap,
suppression keys) and `gap-notice.ts` (the run), behind
`app/api/cron/private-calendar-gap-notice/route.ts`. Pinned by
`tests/private-calendar-gap-notice.test.ts`, which also holds the five registration sites to each
other so the cron cannot strand. The hook: `.claude/rules/time-off.md`.

## Phoenix CRM never emails — owner, 2026-10-13

His words: *"make phoenix crm send notifications through telegram and in app only, stop any email firing
from phoenix crm."* It **reverses the 2026-10-08 ruling below** ("email for every action on CRM to the
person responsible") and ends every email exception the module ever had.

**What was measured first (production, 2026-10-13).** `notification_outbox` held 1,053 sent and 98
skipped Phoenix CRM rows since 2026-10-03, and nothing pending or queued — so the change strands no mail
that would drain after the deploy.

**What changed.** `PHOENIX_CRM_EMAIL_EVENT_TYPES` in `src/lib/notifications/phoenix-crm-channel-guard.ts`
is now an empty list, kept as an exported constant so a future exception is a visible one-line change.
Every `phoenix_crm.*` policy row in `policy.ts` dropped `"email"`. The guard keys on the MODULE, so the
Telegram-failure fallback (`["email","in_app"]`) is stripped too, and no call site can opt back in. No
Phoenix CRM code sends mail directly (checked: no `sendPhoenixEmail` / `sendTemplatedEmail` caller names the
module), so the guard is the whole path.

**What did NOT change.** In-app, Telegram and the phone are untouched, and so are the pulsing badges and
"New for you" strip. He said "telegram and in app only"; the phone was added for Phoenix CRM on 2026-10-02
at his own choice (16 of 74 reps allowed it, Telegram reached none) and he asked only to stop email, so it
stays. Pinned by `tests/phoenix-crm-email-block.test.ts` (list empty, every policy row email-free).

## Phoenix CRM emails every step and pulses what is new — owner, 2026-10-08

His words: *"I need Telegram, in app, email for every action on CRM to the person responsible … and show
pulsing badges beside the thing that has a notification. I want the people to be alerted."*

**What was measured first (production, 10 days).** The notices were being written and delivered in-app
and to the phone — 47 plan-waiting, 48 plan-approved, 4 plan-returned, 106 off-plan-visit-waiting — and to
Telegram only for the minority who linked it (plan-approved: 11 sent, 33 skipped). Email was blocked
module-wide except seven event types, and nothing inside Phoenix CRM showed that anything was new: the
only badge was a static "N waiting" on Team and Reports counting decisions, and a module page has no tab
bar. "Silent" was real for email and for the screen, not for the bell.

**The email list.** Every person-to-person step now emails beside the other channels: a weekly or monthly
plan sent, approved or returned; a grade, drop, add or restore request waiting and decided; an off-plan
visit waiting, approved, refused and moved on; a visit ask waiting, accepted and declined. Asked about by
name the same day, he added the plan reminder (12:57 and 17:57), the daily approval nudge and the rep's
"validate this customer again" — **the last reverses his own ruling from earlier that day** (in-app only,
never email or phone). He chose it with the choice in front of him; its wording is unchanged and still
about the photo alone.

**Still off email, by his earlier explicit rulings:** the daily forecast alert, the courtesy copy of a visit
ask, the SFE Manager's day-start and re-send copies, the plan-edit expiry, and the feeds (activity mirror,
hourly rollup, 06:55 digest, fraud scan).

**The badges.** `src/lib/phoenix-crm/notice-badge-rules.ts` maps an unread notice to the module its own
link opens; `src/lib/notifications/unread.ts` reads the viewer's unread rows under the bell's fences
(addressed to him, test-world fence, not read or archived). A chooser card pulses "N new" and the module
page opens with a "New for you" strip. The feeds never pulse. A failed read draws no badge — never "nothing
new". **It clears from a mounted page** (`POST /api/phoenix-crm/notices/seen`), never a server render,
because the chooser cards prefetch the page on hover and a prefetch renders it with nobody looking.
Pinned by `tests/phoenix-crm-notice-badges.test.ts` and `tests/phoenix-crm-email-block.test.ts`.

## Only a live team is told anything — owner, 2026-10-08

He had just been given email, Telegram, in-app and pulsing badges for every Phoenix CRM step (see "Phoenix CRM emails every step and pulses what is new"), and said: "bump notifications to people who didn't go live yet. The only ones who go live are Cairo and Giza, and Delta One — don't pump to all the people." Asked who the notices should reach, he chose **started teams only**.

- **Live = the Super Admin pressed Start**: a `phoenix_crm_team_starts` row for the team's district-manager seat with no stop, or a stop still in the future. Delta (1) started 3 Oct; Cairo and Giza hold rows dated 10 Oct but are already planning that week, so the gate does NOT wait for `starts_on`.
- **Everyone around a non-live team is silent** — its reps, district manager, SFE Managers and national sales manager — on every channel, and its old unread notices stop pulsing too (the badge reader filters by the notice's `metadata.seatId`).
- **Where it is asked**: `notifyPhoenixCrm` (real world only; the test world keeps its in-app copies), the plan reminder, the approval nudge, the 06:55 digest (on top of its real-activity test), the hourly visit roll-up, and `unread-notices.ts`. Fraud scan and validation-review notices go to Super Admins and SFE and are not team notices.
- **A failed read of the starts fails OPEN** (and is logged as `phoenix_crm_live_teams_unreadable`): an empty answer would silence a live team's approvals on a database hiccup.
- Pinned by `tests/phoenix-crm-live-teams.test.ts`. Rule: `src/lib/phoenix-crm/live-team-rules.ts`; read: `src/lib/phoenix-crm/server/live-teams.ts`.

## The Administrator is not an approval step — owner, 2026-10-08

Voice message: take HR (Omar Gawish, B-10, the sole Super Admin) out of the approvals — the plan edit used to wait for his acknowledgement after the district manager and SFE. He may still decline, or return with a comment, any decision at any time, but nothing waits for him. Then: "call it the Administrator" — never HR, never an override.

- **Scope: every approval** (weekly plans, monthly plans, list requests, off-plan visits, plan edits). **Effect: it reverses and the rep is told** — a declined plan edit or request returns to the rep with his comment, and the rep, district manager and SFE are notified naming "The Administrator".
- **Plan edits:** two steps, district manager then SFE; SFE's approval reopens the week itself (`hr_acknowledged_at` is kept as "when the week was opened" because plan-rules and offplan-day read it). Migration `20261008160000_phoenix_crm_administrator_not_hr.sql` retires `hr_pending` (it refuses to run while one exists), adds `admin_decided_by_hr_id`, `admin_decided_at`, `admin_note`, and a stage `administrator` that may only refuse, with a note, at either waiting step.
- **Code:** `canAdminister` and `canOverrideDecision` in `access.ts` (never on a test entry, compared as a person). The `canOverride` flag on Team requests, visits and plan edits sits APART from `canDecide`, so no "waiting for you" count holds him. UI: `administrator-decline.tsx`.
- **AMENDED 2026-10-14 — he may now APPROVE too (owner, voice: *"make the super admin able to override any type of approval … as the request appears to him he can approve, but his approval is not in the workflow, but in an urgent situation he can approve instead of anyone, any title in Phoenix CRM, anything"*).** This replaces "decline only" in the two bullets above; "no step, nothing waits for him, no count holds him" is unchanged. **How:** in each service the Administrator branch skips the step-holder check and takes the step the row is AT — he never skips a step, so a district manager's step approved by him still goes on to SFE. `decideListRequest`, `decideUnplannedVisit`, `decidePlanEdit` (his decline keeps its own stage, his approval is written as the step's) and `transitionPlan` / `decideMonthlyPlan` (`decidedAs` and `actor_role` read `administrator`). The database needed no migration: every decide function takes `actor_role` as free text and the step from the row. **UI:** the card's own Approve and Refuse show for him under a line saying whose step he is taking (`AdministratorStepNote`); the week and month decision block opens for him through the single-view `canApprove` only, never the review list's, which feeds the counts. **Add at the district manager's step still needs the grade and the potential** — the card asks him for both. **Not covered:** a request with the rep (nothing to approve until the rep answers), a test entry (the test world stays retired), and the places/validation reviews, which were already the Super Admin's own.
- **Reversing what was already decided (owner, 2026-10-08: "build reversing approved items for the Administrator").** The Team tab's "Decided · reverse" lists, for 14 days, what he can take back (`loadReversibleItems`, null for everyone else); `POST /api/phoenix-crm/administrator/reverse` (`reverseDecision`) takes a kind, an id, a required comment and — for a week or a visit — the version he saw. His answers to the two questions asked:
  - **A reopened week** closes back to exactly how it was sent ("Close it back only if untouched"): only while the plan is still the draft the reopening made (same version). The original status returns — approved with the ORIGINAL approver, time and note restored from the plan's own event, or submitted — and a plan event records it (the event table has no "reversed" value, so it writes `approved`/`submitted` with `details.restored_by`). Otherwise `plan_edit_cannot_reverse`, and the message tells him to return the week with a comment instead.
  - **An approved list request** ("All four, refused if the customer moved on"): a grade change goes back to the old grade (read from its `grade_changed` event); an add leaves the list into the Archive (dropped, `not_admitted`); a bring-back returns to the Archive; a drop returns to the list (active, or pending if it was never validated). If any later list event or later request touched the customer: `reverse_customer_moved_on`, nothing changes.
  - **An approved off-plan visit** becomes refused and stops counting.
  Each ends as "refused" with `admin_decided_by_hr_id`, `admin_decided_at`, `admin_note`; the rep, district manager and SFE are told "The Administrator reversed the approval of …". Weekly and monthly plans are out of scope — his existing return already takes them back. Migration `20261008190000_phoenix_crm_administrator_reverses.sql` (three functions, six additive columns).
- Pinned by `tests/phoenix-crm-administrator.test.ts` and `tests/phoenix-crm-plan-edit-requests.test.ts`.

## The EPDA-BULK contribution rule — owner, 2026-10-09

**His words, spoken:** *"Starting from September closing, the ابدأ bulk will be distributed and
calculated exactly as uh, office but in line pedia it will be you will get the total sales
contribution of the other distributors … over the total sales and get … the contribution of every
one and based on this distribute the same uh, contribution from uh, epda, bulk."*

**His three answers the same day**, asked as in-chat multiple choice because each changed the
outcome: the source is **"ساتو قطاع جملة"**, which still arrives as its own upload under `EP-BK`
(so nothing has to classify a merged pharmacies file); the lines are **Pedia only**; the allocated
money is labelled **EPDA-BULK**, the real distributor, not a Main-Stores-style stand-in.

### The rule

From the **2026-09** closing, an `EP-BK` row on **Pedia** is no longer credited where the wholesale
invoice put it. Each area takes the whole bulk book by **its share of the line's other
distributors' sales value** — units × master factory price, excluding `EP-BK` itself and direct
orders — one blended share per area applied to every product, then pro-rata onto the area's bricks.
That is the locked Office rule's arithmetic (`src/lib/sales/office-allocation.ts`,
`GOLDEN RULE · LOCKED`) applied to a real distributor's book rather than to a channel.

**Why it is right:** the bulk book invoices warehouses, so the invoice address is where the goods
were BOUGHT, never where they were sold — the same defect the Office channel and the city rule
exist to answer. Measured on June 2026: all 30 Pedia packs sat in **two** areas (AB1 24, AB2 6)
while 37 others showed nothing.

**What is untouched:** Head Office — **99.2%** of every bulk row ever uploaded, Lacto Basic
(`LA003`/`LA004`), untracked and confidential, excluded by name by both closing RPCs — and every
month **before 2026-09**. A late ruling is a rule for upcoming months, never a correction of a
published one.

### Three implementation facts that are decisions, not details

1. **It is a NET, computed at closing READ time, folded onto the city split's existing rails** —
   the matrix write-back and `au.monthly_store_split_net` — so the Closing tab, the premium
   workbook, achievement, incentives and the rep keycard all move together.
   **Row substitution was rejected:** `tests/closing-total-sheet-matches-matrix.test.ts` proves
   Total = Data SUMIFS + net + direct, so allocated detail rows PLUS the net would move the same
   money twice. Read time rather than upload time for the measured Office defect — a batch
   re-mapped after the file lands leaves upload-time shares stale (6,834 of August's 109,719 CNS
   Office units, 6.23%, measured on the live rows 9 October 2026).
2. **The allocated bulk rows are the FOURTH carve-out from the city rule** (Ivyronc only, see the
   narrowing below), beside EZ, Office and El Qema's
   warehouses: `isSplitEligible` refuses them from September. `WHOLESALE_ONLY_DISTRIBUTORS` is
   `{"QM"}` only, so `EP-BK` rows are classified by customer name — most of its customers are
   wholesalers, so without the carve-out the city rule shares each row across its own city first
   and the same units move twice.
3. **`closing-bulk-allocation.ts` cannot import `buildOfficeAreaWeights`** — office-allocation →
   monthly-distributor-import → attribution-store-split-refresh → attribution-store-split-net
   cycles back to the caller. The arithmetic is duplicated and `tests/closing-bulk-allocation.test.ts`
   pins it **equal to the locked builder to 1e-9** instead; the locked file itself is never touched.

**Known and accepted:** on a FILTERED export the Store Split sheet's `crossing` excludes the bulk
net while the Total sheet's applied delta includes it — the sheet re-derives from the rows it was
given, by design. Whole-month exports are unaffected, both zero.

**The arithmetic, on June's real shape:** 30 packs invoiced to 2 areas, spread by contribution —
D21 20,000/35,000 → 17.142857, D15 → 8.571429, D14 → 4.285714, largest-remainder residual pushed so
the net sums to **0** on units and on value. Shipped in #5662.

### He narrowed it to ONE PRODUCT the same evening — Ivyronc

**His words, typed:** *"IN EPDA BULK ONLY IVYRONC WILL BE CONTRIBUTION ANY OTHER PRODUCT NORMAL
MAPPING"* (2026-10-09, about three hours after the rule above).

So the question is no longer "is this the bulk sector, on Pedia, in a covered month" — it is that
**and** "is this Ivyronc". `IV001` is the whole of Ivyronc: the live master holds exactly one
Ivyronc product code (family `IV`, line Pedia, active — read 9 October 2026), so
`BULK_ALLOCATION_PRODUCT_CODES` is the product rather than a sample of it, and a second
concentration would have to be added there because a closing detail row carries its product code
and not its family.

**"Normal mapping" is three things, and the second is the one a later change could break
silently.** A bulk row that is not Ivyronc (1) keeps the area its invoice names, (2) is **not a
weight** — the shares are "the other distributors'" contribution in his words, and the bulk sector
is not one of them whichever product its row carries, so an unallocated bulk row joins neither the
moved set nor the base; letting it into the base would let the book help decide where its own
Ivyronc goes — and (3) **stays split-eligible**, so a bulk wholesaler in a multi-area city still
takes the city rule. The carve-out from the city rule is therefore exactly as wide as the
allocation, by construction: both ask `isBulkAllocatedRow`. Freezing every bulk row on its invoiced
area would be a change to published behaviour he did not ask for, in the opposite direction to the
one he did.

**What it changes on the live book: nothing yet, and that is correct.** The bulk sector has uploaded
four batches ever — 2026-02, 03, 04 and 06 — and **not one carries Ivyronc**: they are Lacto Basic
(`LA003`/`LA004`) on the untracked Head Office line plus 599 packs of Lacto Advanced (`LA001`/
`LA002`) on Pedia (measured on `source_of_sales_import_rows` 9 October 2026). So on the historical
shape the allocation now moves nothing, and the 599 Lacto Advanced packs the line-level version
would have spread are back on normal mapping. **A zero here is the rule working** — never a defect
to chase, and never a reason to widen the product list. The rule is for the Ivyronc volume the
September `EP-BK` file is expected to carry.

Pinned by case 9 of `tests/closing-bulk-allocation.test.ts`, which was proven by breaking both
halves and watching each headline assertion fire: the product gate ("Lacto Advanced is not
allocated any more") and the weight half ("the same three areas weight it").

### The coverage banner was calling EPDA-BULK's absence a 24.16M EGP hole

His next instruction the same day: *"fix the SoS coverage banner so EPDA-BULK's absence since July
is not a hole."*

**What it was reading.** `source_of_sales_import_batches` (validated, 141 rows, read 2026-10-09)
holds `EP-BK` in **2026-02, 03, 04 and 06 only**. The SoS dashboard's batch-coverage report priced
each absent month at the distributor's own mean — 4.83M × 5 months = **24.16M EGP**, the largest
single "hole" on the board — while `EP-PHS`'s own value went from **998K** in June to **8.16M**
(July) and **12.02M** (August). EPDA had switched to ONE combined pharmacies file; the bulk sector
was never missing, it was inside its sibling's upload. The same report also read "DIRECT is missing
from 2026-09" about a channel that landed 880,976.70 EGP that month under `DirectReq`.

**The two absences that are not holes** are now `MERGED_SOURCE_WINDOWS` (`EP-BK → EP-PHS`,
2026-07..2026-08) in `src/lib/sales/sos-coverage.ts` and the existing Direct fold in
`direct-channel.ts`. The window is **bounded on purpose**: from the September closing the bulk
sector uploads on its own again, and the contribution allocation above has nothing to spread
without that file, so a September absence must still be reported. A merge excuses a month only when
the **absorbing** file actually landed in it — if EPDA sends nothing at all, both sources are
missing and the month is a real hole.

🔴 **And the fix would have put El Qema on the banner, which is why `maskSosCoverageReport` is in
the same change.** The banner names the single costliest gap by estimated value. With EPDA-BULK's
merged months no longer counted, that is **El Qema** — `QM` appears only in 2026-08 and 2026-09, so
seven absent months at roughly **10.6M EGP** — on a dashboard gated on `sales:read`, which 13 of
the 19 roles hold. `maskPortalSosDashboard` could never have caught it: it masks four structural
fields, and the banner is a SENTENCE inside `insights`. The mask follows his closing-workbook
choice of 2026-09-14 — keep the money, drop the name — so every period, estimate and count is
untouched, and Super Admin still reads the real name.

🔴 **The El Qema gap itself was never real either, and masking a name is not fixing a number.** Read
on production 2026-10-09: the `source_of_sales_distributors` row for `QM` was created
**2026-09-06 22:27 UTC**, its first batch **2026-09-07 07:35**, and no El Qema row of any status
exists outside **2026-08 and 2026-09** — the distributor was onboarded in September for its August
book. The seven months before it were priced at **10,541,399 EGP** (1.51M mean × 7) of sales nobody
can ever upload, which made it the third-largest hole on the board and inflated the "and N other
distributors have gaps too" count behind the headline. `SOURCE_ONBOARDINGS` (`QM` from 2026-08)
excludes them from the missing list, each month's missing list and the estimate alike, so El Qema
leaves the ranked list entirely; the mask stays exactly as it is, for the month it genuinely misses.
Measured against live production before and after: the banner's own headline fell from
**24,160,764 EGP** (EPDA-BULK, five months) to **14,496,459 EGP** (EPDA-BULK, 2026-01, 2026-05 and
2026-09 — January and May never arrived, and September's own bulk file is outstanding and is what
the contribution allocation needs), and the trailing count from 11 other distributors to 10.


## September's split is rebuilt once its books are all in — owner, 2026-10-09

He parked the rebuild on a condition rather than a date: **"rebuild September's split once the last
books are in, not now"**, after being shown that the frozen 2026-09 store-split net is stale and
still moving. The rebuild is worth exactly one shot, at the end, because every upload changes it.

**Why a month's completeness cannot be judged against the whole upload history.** The first version
of the gate used `buildSosCoverageReport`, whose expectation is every source seen in any loaded
period — correct for the audit banner, because the SoS history was backfilled and a never-uploaded
January is indistinguishable from an onboarding. As a gate it is useless: **chimipharm last supplied
2026-05**, so it would call every month since May incomplete for ever and the gate would never fire
once. The shipped rule uses the basis `source-coverage.ts` already uses for a closing — what fed the
**previous** month, plus whatever another source's file carried for it then — and a month with no
validated batch at all is never "complete".

**Why the merge-carry term is not optional.** EPDA-BULK's file was folded into EPDA-Pharmacies' for
2026-07..2026-08 only, so it is absent from last month's present set while being exactly the book
the EPDA-BULK contribution rule spreads. Dropping it because last month was quiet would hide the one
absence that rule depends on. Proven by breaking it: with the term removed the test's own headline
fired — `September is INCOMPLETE — the merge window ended in August`.

**What it read when it was armed.** Production, 2026-10-09:
`sos-month-complete: INCOMPLETE 2026-09 missing=5` — **epda, EPDA-BULK, EPDA-Pharmacies, Marcyrl,
mec**. Direct (Company) is correctly excluded by the DirectReq fold, so it is not a sixth hole.

**Why the drift figure is read only after the month is complete.** On an incomplete month it moves
with the next upload: 2026-09's frozen-versus-live difference went from **839,283.83 EGP** to
**1,030,551.19 EGP** on different areas inside one day (347 cells over 76 line×area pairs, frozen
139 cells versus live 423; **CNS holds 36 pairs and 221,712.21 EGP**, Anti Infective holds 0, so
nothing he announced has moved). The sum of differences is 0.00 and every line's unit totals agree,
which is why the publication drift check — it compares units — is blind to all of it.

The `september-upload-completeness` scheduled task watches the gate at 21:30 Cairo daily, stays
silent on an unchanged incomplete month, reports when the missing list changes, reports once after
five static days, and on COMPLETE reports the drift and deletes itself. The rebuild itself starts
with his unpublish of 2026-09 on the Monthly Closing publication screen, which is his click and
never belongs in a Next-step line.


## The Office channel's read-time respread — owner, 2026-10-09

**His words:** *"fix the Office allocation to read-time shares."* Typed the same day as the
EPDA-BULK rule above, and about a defect that surfaced while that rule was being measured.

### What was wrong — and what was NOT

The owner's **locked golden rule** spreads the Office channel's units across a line's areas by each
area's share of the line's **non-Office sales value** (`src/lib/sales/office-allocation.ts`, the
`GOLDEN RULE · LOCKED` region, password-protected, pinned by
`tests/office-golden-rule-lock.test.ts`). **That rule was never in question and is not touched by
this change** — no threshold, no weight, no reconciliation, and the locked file is not even
imported. What was wrong is **when** it was evaluated.

The weights were computed **once, at upload**, and stamped onto the stored Office rows. So every
distributor batch that landed, was re-mapped or was corrected *after* the Office file left those
units on a geography the data no longer supported. Nothing anywhere reported it, and the only repair
available was to re-upload the Office file by hand.

**Measured on the live August 2026 CNS rows, 9 October 2026**, through the repo's own closing loader
and the new rule (so the number is reproducible, not estimated):

| | |
| --- | --- |
| Office channel, August CNS | **109,719 units** of 178,272 — **61.5%** of the published month |
| Weighting base | 4,277,307 EGP of non-Office sell-out across **48 areas** |
| Sitting in the wrong area today | **6,834 packs — 6.23% — 548,777 EGP** |
| Areas short of what today's data gives them | **17 of 48** |
| Office file's last batch | 10 September **20:15** Cairo — `created_at` is `timestamptz`, UTC 17:15:54, and Cairo is UTC+3 in September; an earlier copy of this table read 19:15 by converting at +2 |
| Month published | 10 September **23:22** Cairo |
| Largest single area error | CA1, **+3,119 packs** (+250,488 EGP) on a 4.75% share |

🔴 **TWO TRUE NUMBERS, AND NEITHER IS A MISTAKE TO CHASE.** A narrower count the same day — the
one the drift detector merged as #5679 reports — put August CNS at **3,698 units, 3.37%**: that
compares the Office BATCH's own stored rows with today's shares applied to the line's own stored
total. The **6,834 packs, 6.23%** above is the same defect measured where it is actually read, through
the closing LOADER and after the city-split rails, as the sum of the positive legs of today's net
over the stored spread — so it is the one this rule moves, and the one every comment and rule line
here carries. A later session finding both must not "reconcile" them by changing either.

### The rule

From the **2026-10** closing, **CNS only**, the Office spread is **recomputed on every read**, as a
**net movement** rather than a rewrite of the stored rows:

    net = (today's spread of the Office totals)  −  (the areas the upload stamped on them)

The OUT legs come from the stored Office rows themselves, so the net cancels the stale spread
precisely, whatever it was; the IN legs are today's. **A month whose batches have not moved since the
Office file landed nets to exactly zero** — that invariant is what makes this a correction and not a
second allocation, and it is the first behavioural case in
`tests/closing-office-respread.test.ts`.

**Why a net and not a re-run of the upload-time allocation.** Re-running `computeOfficeAllocation`
on every re-map was the obvious alternative — the re-map already triggers the attribution refresh —
and it was rejected because that path **rewrites the stored rows**, which restates the Closing tab of
a month that may already be published and announced. A net is additive and gated by period, so July
and August keep the numbers they were published with. 🔴 **The 6.23% on August is the
evidence for the rule, never a backlog to go and fix.**

### The start month: October for one day, then September — both his own word

**First ruling, 9 October 2026 afternoon.** Read live before choosing the start month:

- **August CNS** is published (10 September 23:22 Cairo, snapshot 178,272 units) and holds the
  109,719 Office units above. A rule starting in August would restate a published, announced month.
- **September CNS is NOT published.** Only September *Anti Infective* is, and that line carries no
  Office channel at all. September CNS is still being imported — its last batch landed **9 October
  16:51 Cairo** — and holds **zero Office rows**, because its Office file has not been uploaded yet.
- **October CNS has no rows at all yet.** So on today's data the rule moves nothing: it starts
  working the moment October's distributor batches and Office file land.

Two further reasons made September more than a constant change at that hour:

- **September's net was FROZEN, for every line.** `isFrozenStoreSplitPeriod` matches
  `monthly_closing_publications` by **period with no line predicate** (deliberately — PR 4848), so
  his publication of September *Anti Infective* froze CNS September too, and that frozen net was last
  stamped **4 October 16:52 Cairo**, before this rule and before thirteen of September's fourteen
  books. A respread gated at September would not have reached the matrix at all until the period's
  net was rebuilt: unpublish → `scripts/backfill-attribution-store-split.ts --apply 2026-09` →
  `au.f_refresh_monthly_attribution('2026-09')` → re-publish.
- **September had no Office rows yet.** Its Office book (Marcyrl) had not arrived, so there was
  nothing for the rule to respread.

🔴 **HE WAS ASKED WITH ALL OF THAT AND RULED: "leave the Office respread at October"** (2026-10-09).

**Both premises then inverted the same evening, and neither by a session's reading.**

| | |
| --- | --- |
| Marcyrl's September Office book | landed **20:10:51 Cairo** — 3,920 rows, 80,565 units, 6,971,179.95 EGP |
| A customer re-map applied after it | **21:00:22 Cairo**, 2,643 rows re-resolved |
| September CNS Office units on a geography the data no longer supports | **10,987 of 80,565 — 13.64% — across 48 areas**, four times August's figure |
| September *Anti Infective* unpublished | **19:12:21.58 Cairo** — so no `2026-09` row in `monthly_closing_publications` has `unpublished_at IS NULL` |
| Therefore `isFrozenStoreSplitPeriod('CNS','2026-09')` | **false** — the month recomputes live, there is no frozen net to rebuild, and nothing published to restate |

🔴 **PUT TO HIM AGAIN WITH THAT, AND HE RULED: "make September's Office split recalculate like
October"** (2026-10-09). So `OFFICE_RESPREAD_START_PERIOD` is **`2026-09`**, and it was a
one-constant change after all — because the freeze that would have made it more than one had been
withdrawn an hour earlier.

🔴 **It moves again only on his own new word, in EITHER direction** — never on a session's reading
that the data makes a different month look safe. And **if he re-publishes September, nothing needs
doing**: the net stamped at that publish is computed by the live path, which now carries the
respread, so September freezes *with* it. The hazard in the first ruling is reachable only for a
month frozen *before* this rule — August 2026 and earlier, which the constant excludes.

🔴 **A month the respread covers is not a task on the Needs You board.** The stored-row drift
detector (#5679) still measures and reports it, because the stored rows are what a re-upload or a
re-map meets, but the row sits in **worth-knowing** rather than *yours* and says the closing figures
are already right — re-committing the Office book would fix nothing that is broken, and would total
*higher* than the file (`allocateProduct` drops products netting ≤ 0 inside the locked region).

### The three things that had to be wired, and the one that nearly shipped wrong

1. **Three derivation points, not one.** The city split already has three by design — the screen's
   cached loader (`closing-store-split-net.ts`), the export's own fallback
   (`closing-store-split-export.ts`) and the attribution payload
   (`attribution-store-split-net.ts`) — and two of them exist *because* a second derivation once
   drifted from the first. Each folds the respread. Attribution carries it on **both** measures
   (`net_qty` and `net_effective_units`): Office is 61.5% of a CNS month, so a respread the matrix
   applies and attribution does not would put every CNS rep's achievement out by most of their line.
2. 🔴 **The `office` grid is NOT display-only — this is the part that nearly shipped wrong.**
   "of wh. Office" and the **Closing Matrix (No Office)** tab are built from
   `MonthlyClosingParts.office`, and that tab is literally `matrix − office` **cell by cell**
   (`closing-matrix-without-office.ts`). Move the matrix's Office units to today's geography and
   leave the grid on the upload's, and the subtraction stops describing distributor sell-out and can
   print **negative sales**. So `mergeOfficeRespreadIntoSplit` carries an **Office-only `officeNet`**
   out beside the combined net, and each of the three Office grids applies that slice and nothing
   else — never the combined net, which also holds the city split and the bulk book.
3. **No unit may move twice.** Office rows carry no customer (`clientCode` is null on that channel),
   so `isStoreCustomer` is false and `isSplitEligible` refuses them before any period gate is read —
   asserted beside a fixture-sanity line proving a real wholesaler on the same geography *does*
   split, because an assertion that passes for the wrong reason proves nothing.

### The arithmetic lives in ONE place now

`buildOfficeRespread` does not re-implement a largest-remainder spread. The EPDA-BULK rule's
arithmetic was lifted into a new leaf, `src/lib/sales/contribution-respread.ts` (`round6`,
`spreadByShares`, `areaValueShares`, `buildContributionRespread`, `mergeRespreadIntoSplit`), and
`closing-bulk-allocation.ts` was rewritten as a thin driver that keeps its public API — which is why
its own suite stayed green unchanged. **Two copies agree on test data and disagree on a return.**

🔒 **The locked file is still not imported, and still not touched.** `office-allocation.ts` →
`monthly-distributor-import.ts` → `attribution-store-split-refresh.ts` →
`attribution-store-split-net.ts` cycles back to the caller, so the equivalence is pinned **by test**
instead: `tests/closing-office-respread.test.ts` hands five areas and two prices to both
implementations and requires the shares to agree **to 1e-9**. That clause runs **first** on purpose —
the zero-sum cases are sharper than any tolerance, so they would fire first on a share error and say
only that money moved, never which rule moved it.

### What the test proves, and that each clause actually fires

Ten numbered cases plus **twelve source-level wiring checks**. Every one was verified by
break-and-watch — the fix or the wiring was broken, the suite run, the *headline* assertion watched
to fire, and the file restored byte-for-byte:

- the locked-share equivalence, the aligned-month zero, the drift and its zero-sum on units,
  effective units and value, the 2026-10 gate, the CNS-only line gate, Office never weighting its own
  spread, no-contribution-base, the city rule's refusal of an Office row, largest-remainder on a
  return, and the fold keeping `officeNet` isolated;
- all three derivation points, the cache key (renamed to
  `closing-store-split-with-bulk-and-office-respread`, and again on 2026-11-04 to
  `closing-store-split-with-bulk-office-respread-and-epda-rule-2`, so an entry written by the previous deploy can
  never be read back as this shape), attribution on both measures and its period gate, and each of
  the three Office grids.

### Two residuals, named rather than hidden

1. **A month published AFTER the respread applies** reads the frozen combined net in the matrix and a
   live Office slice in the grid, so the no-Office tab is out by any post-publish drift — zero
   whenever the rows have not changed since publication. Closing it properly needs a channel column
   on `au.monthly_store_split_net`; deliberately not attempted inside this change.
2. **The weighting base keeps the locked rule's own population**, `EP-BK` included at its invoiced
   area. Excluding the bulk book would change the LOCKED rule's input, which is not a session's call;
   the effect is negligible (599 packs of Lacto Advanced is all the bulk book has ever put in a
   closing) and the bulk rule is Pedia-only, so it never meets CNS.


## The store-split rulings of 2026-10-09 — twelve more names, and the keywords behind all of them

He asked for the whole customer list, split the way the system splits it: *"give me xlsx 2 coloumns
splityted and non splitted"*, then *"add the select column … from our rules shared rules put in the
third row what should be splitted third column"*, then — on the eleven that column proposed —
**"split the 11 in column C"**, and finally **"do a deeper audit and remember the keywords that we
split based on them and use your mind don't be as a fool of course more than this should be split
of course"**.

### What the list actually is

10,420 customer names, all distinct, judged by the repo's own `isStoreCustomer` rather than a copy
of the rule: **119 split, 10,301 whole** (98 of them hospitals, 10,203 pharmacies). The legacy and
current rules disagree on 42 names, which is the cutover working as designed, not a defect.

### The keywords the split is based on — the answer to "remember the keywords"

Everything lives in `src/lib/sales/customer-channel.ts`, and nothing outside it decides this.

| Layer | Content |
| --- | --- |
| Store words (substring, anywhere) | `مخزن` · `فارم` (covers فارما / فارماسي / فارمسي) · `تريد` · `الشركة` · `الجمعيه` · `للتجارة` |
| Store PREFIXES (start of the name only) | `م - ` and `م- ` — EPDA's own notation for مخزن. It cannot be a keyword: it starts 29 names and appears inside 623 |
| The trade phrase | a business word (`تجار` · `توزيع` · `توريد`) **plus** a goods word (`ادوي` · `دواء` · `دوائ` · `الادي`), or `تجار` and `توزيع` together — tested on the name with ALL whitespace removed, because distributors split words mid-token |
| Hospital words (win the overlap) | `مستشف` and its siblings — a hospital is never a warehouse |
| Never-store words | `صيدلي` · `مستشف` · `سجل تجار` · `مخازن` · `مستودع` · `هيئه` · `ت.ص` · `قوي عامله` · `سكك حديد` · `كهرباء` — the 17-of-17 "government depot, do NOT split" ruling of 2026-09-06 lives here |
| Five override lists | `PHARMACY_OVERRIDE_CLIENT_CODES` (code) · `STORE_OVERRIDE_CUSTOMER_KEYS` (distributor\|code — **the only one the legacy rule reads**) · `PHARMACY_OVERRIDE_CHAINS` and `PHARMACY_OVERRIDE_NAMES` (name, can only ever REFUSE a split) · `STORE_OVERRIDE_NAMES` (name, the only one that can CREATE one) |

🔴 **A new ruling goes in `STORE_OVERRIDE_NAMES`, by NAME, never by code.** The name list is read
from the cutover forward (`WAREHOUSE_RULE_FROM_PERIOD_BY_LINE` — 2026-09, Pedia 2026-08), so a
published month cannot restate; the code-keyed list is what `legacyIsStoreCustomer` reads, and an
entry there rewrites all of 2026 silently.

### The twelve, and what they move

Of the 10,301 names left whole, only **154 carry any organisation marker at all** — the token
frequency of the rest (محمد 2,109, احمد 1,275, الجديده 817) is the signature of individual
pharmacies. Eleven survived judgement in the first pass and were put to him; the deeper audit he
then ordered added four more. Those fifteen names are **twelve stems**, because three of them are a
second or third account of a business another stem already names — the long form of `دار الدواء`,
and two of the three `صيادلة البحيرة` accounts.

Measured on production (`ozucdzovmcqvepbozvqf`) over `source_of_sales_import_rows` where
`validation_state = 'valid'`, all-time, before the stems were written:

| | names | rows | EGP |
| --- | --- | --- | --- |
| everything the twelve stems reach | 20 (26 accounts) | 374 | 435,133.42 |
| already warehouses on `مخزن` — no change | 2 | 9 | 7,132.05 |
| DIRECT — carries no area either way | 1 | 4 | 16,772.40 |
| `official_line = Head Office` — never splits | 3 | 7 | 42,890.78 |
| **what actually changes hands** | **15** | **58** | **51,022.72** |

`دار الدواء` deliberately reaches its whole family — the company, its long form, a DIRECT account,
two Head-Office branches and `دار الدواء المنصورة` — because the bare company name cannot be
narrowed without a code, and a code would reach the published months. `صيادلة البحيرة` is one
business on three accounts at two distributors (177,392.03 EGP), which is the case this list exists
for. Every stem is written long: bare `الشرق` would have taken 184,707.00 EGP of pharmacy sales,
bare `صيادله` 3,117,937.50 on its two largest neighbours alone, bare `اورينت` 50,220.00.

### 🔴 طاى جروب — he overrode his own 2026-09-06 sheet, the same day, in his own words

He named it in column C. He had also ruled its four accounts **pharmacy** on the 2026-09-06 decision
sheet — 433363 (IS and IS-S), 3080282 (RM), 1500023301 (SF) — with their value and areas in front
of him, and those 167 answers are pinned in the required `validate` job by
`tests/sos-warehouse-owner-rulings.test.ts`. A contradiction in this rule goes back to him instead
of being resolved in code; the five before it all did, and so did this one. **He settled it on
2026-10-09: "split طاى جروب too, it overrides the Sep 6 sheet".** The later answer stands, the
pinned fixture carries it (79 warehouse, 72 pharmacy), and the 2026-09-06 sheet itself is left
untouched — the sixth such reversal, handled exactly like the five before it.

🔴 **THE STEM IS TWO WORDS, AND THAT IS THE WHOLE RISK OF THIS NAME.** `طاى` is a SUBSTRING of
`مطاى`, the town Matay, which 60+ Minia pharmacies carry in their name (`الفتح - مطاى`,
`نشوى - مطاى`, `هيثم اسامة مطاى`), and of `مصطاى` and `نهطاى` besides; bare `جروب` is common on its
own. Measured on production over every name containing `طاى` / `طاي` / `طى جروب`, the stem
`طاي جروب` reaches that ONE business on its SIX accounts and not a single neighbour: `طاى جروب`
(433363 IS and IS-S), `شركة طاى جروب` (3080282 RM, 1500023301 SF), `طاى جروب - الاسكندرية`
(22197684 EP-PHS) and `مخزن طاى جروب - طاى` (0001573635 PS), which already split on `مخزن` and is
unaffected either way. The Matay guard was proven by widening the stem to bare `طاي`: the test fails
with `هيثم اسامة مطاى was never ruled a warehouse and must not be swept in by a neighbour's stem`.

**WHAT IT MOVES.** All six accounts sell from ONE area — AB2, Alex Center — so the split deals their
sales into thirds across Alexandria (AB1 Alex East, AB2 Alex Center, AB3 Alex West). Measured on the
rollup at the period factory price: 166 rows and 1,057,167.56 EGP all-time across the six accounts,
113 rows and 620,042.96 on the five that were not already stores, 338,276.36 of that on the tracked
lines. 🔴 **But the name list is read from the cutover only, so what actually CHANGES HANDS is 11
rows and 20,025.30 EGP, every one of them September 2026 CNS** — 3080282 (RM) 200 units 14,951.25
and 433363 (IS) 123 units 5,074.05. Alex Center gives up 13,350.20 and Alex East and Alex West take
6,675.10 each. 22197684 is Head Office only and never splits; 1500023301 carries no row at or after
the cutover. The 1,060,947.52 quoted before this was the same six accounts measured over
`source_of_sales_import_rows` where `validation_state = 'valid'` — a different basis, not a
correction.

### The government health-insurance depots — RULED the same day

🔒 **"the three تامين الصحي depots are government, never split them"** (owner, 2026-10-09, after he
was shown that they split against his own 17-of-17 "government depot, do NOT split" answers of
2026-09-06). The three, as production spells them:
`فرع شرق الدلتا - المخزن الاقليمى العاشر من رمضان - تامين الصحي` (23495),
`فرع شرق الدلتا - المخزن الاقليمي القليوبية- تامين الصحي` (64845 — **its own spelling runs the dash
straight onto the word, with no space before it**, which is why a search for the spaced form misses
it, and why they were first reported as two) and
`فرع شرق الدلتا - المخزن الاقليمي شبرا الخيمة - تامين الصحي` (27863). They carry `مخزن` and spell
"تامين الصحي" out in full, so the abbreviation stem `ت.ص` could not reach them.

🔴 **THE INSTRUMENT IS A NEVER-STORE WORD, NOT `STORE_OVERRIDE_NAMES`.** A government ruling REFUSES
a split, so it belongs with `صيدلي`/`هيئه`/`ت.ص` — the name-keyed override list is the one that
CREATES a warehouse and would have been the wrong half of the file. The word is `تامين`, and it is
the same 17-of-17 ruling reaching the names that spell themselves out, not a new policy.

**Counted on production both ways before it was written** (`ozucdzovmcqvepbozvqf`, resolved with
`list_projects`):

- `تامين` reaches **26 accounts**, every one of them the health-insurance authority, a branch, depot
  or clinic of it, or the unified-procurement authority buying for it. **Not one is a wholesaler.**
- **Seven of the 26 split**, all seven on `مخزن`: his three, plus four of exactly the same kind the
  sweep found beside them — 139383 (منوف main depot), 66085 (بنى سويف main depot), 139359 (جديلة
  students' medicines depot) and 139062 (سوهاج). His ruling reaches these four as well; after the
  word, 0 of the 26 split.
- 🔴 **Broadening the stem by one letter to `امين` adds 257 more names, every one a PERSON called
  أمين** (احمد امين, منال حسنى امين موسى …) — and none of them carries a store word, so the wider
  stem would be inert today and wrong the first day one of them registered a company.

**WHAT IT MOVES.** The never-store words are invisible to `legacyIsStoreCustomer`, so every month
before the cutover is judged by the old rule and **nothing published restates**. In a gated period
the seven hold exactly two rows, both September 2026 CNS: 23495 in **D24 Sharkia 1** (249 units,
8,889.30 EGP) and 64845 in **D11 Qalubeya** (200 units, 7,140.00 EGP). Qalubeya is a one-area city,
so its split was already a no-op; Sharkia has two areas, so **what actually changes hands is 124.5
units and 4,444.65 EGP returning from Sharkia 2 to Sharkia 1**. The other five carry no row at or
after the cutover. 🔴 **All seven are CNS-only — not one Anti Infective row, ever** — so they cannot
move an Anti Infective number. (An earlier note here put 23495 in **Dakahlia 4**; the import rows say
D24 Sharkia 1 in every period it ever sold, and 10th of Ramadan is in Sharkia.)

### The other defect found in the same audit

1. Four `الطرشوبى` accounts say `مخزن` in the name and are held pharmacy by his chain override —
   correct by his standing ruling, and worth knowing before anyone reads the name as evidence.

### What holds it

`tests/store-split-owner-rulings-2026-10-09.test.ts`, registered in `tests/run-tests.ts` and
therefore in the required `validate` job. It pins the thirteen stems verbatim, asserts all 29
accounts they reach are warehouses, asserts the cutover (September yes, August no, July no), asserts the
legacy rule stays blind to every one of them — and measures the neighbours **against the live
`STORE_OVERRIDE_NAMES`**, so a stem added next month is checked against them too. The neighbour
guard was proven by breaking it: an over-wide `صيادله` stem fails with
`الصيادلة فارم -الكوامل must not match any STORE_OVERRIDE_NAMES stem`.

The same file pins the health-insurance ruling: the seven depots are asserted to carry `مخزن` AND to
be refused by the `تامين` word, so deleting the word puts them back to splitting while nothing else
in the file notices; August CNS is asserted to still read 23495 as a store, which is the proof no
published month restated. Proven by breaking it three ways — the word deleted
(`تأمين صحى (هيئة التأمين الصحي)` must still be a NEVER_STORE keyword), the stem shortened to `امين`
(the stem must stay `تامين`), and the stem shortened with that assertion removed, which leaves only
the behavioural control and fails with
`a warehouse whose owner is called أمين must still split — the stem is تامين, not امين`.

## `AGENTS.md` — the full wording condensed out on 2026-10-08

AGENTS.md loads on every request and again after every compaction, so on 2026-10-08 these lines were shortened to their rule. Nothing was dropped: each block below is the wording as it stood, word for word, and the rule it carries is still in AGENTS.md. Search here for the evidence, the owner's words and the measurements behind a rule.

### §4 — Open every reply with one Next step line

- **Open EVERY reply with one `Next step:` line — FIRST, not last, and not repeated at the end**, and it **ALWAYS ends in curly-quoted words he could send as-is** (owner, 2026-09-18 — "always put something in the box"). It names what needs him; when nothing does, it says what finished and quotes the next REAL action, named with its real target — never filler, never invented work. 🔴 **The no-quotes "nothing waits on you" form is RETIRED** — it left his box reading `<no suggestion>`. The 2026-09-15 loop ban is untouched: never quote a re-check, a re-run, a status read, "continue", "check other pending items" or a closing word. `recommendation-goes-first-not-last`

### §4 — The quoted words are a message he sends to Claude

- 🔴 **THE QUOTED WORDS ARE A MESSAGE HE SENDS TO CLAUDE — never a PHYSICAL act, and never a MESSAGE HE SENDS TO A PERSON.** The test is not "could he send this as-is" but **"can CLAUDE act on it once sent"**: a click, a file pick, a factory reset, a QR scan, a power-on — and `tell HR to …` — all fail it, because the box offers them as ghost text and they arrive as an instruction to do the one thing Claude cannot. Four physical ones on 2026-09-28, three `tell HR` ones on 2026-09-29 in a session that had this rule loaded. **When the bottleneck is his hands or his phone, say so in the PROSE with the exact path and put the draft there in full; quote something Claude can act on** — the instruction that FOLLOWS, a merge, or a build Claude fires. Account: `docs/agents-owner-rules.md`, "The Next step box holds words CLAUDE can act on". `never-put-his-physical-actions-in-the-next-step-box`

### §4 — The fits-the-screen golden rule

- 🔒 **THE FITS-THE-SCREEN GOLDEN RULE — never a horizontal scroll, always mobile AND desktop friendly.** Use `<table className="w-full table-fixed">` with a `<colgroup>`; fit by MERGING columns, never shrinking type — `overflow-x-auto` over a `min-width` IS the bug. Measure `scrollWidth > clientWidth` over `main` at desktop and 375px; `shrink-0` makes an inner `flex-wrap` inert. 🔴 **A table that can sit in a GRID CELL switches on its own width, never the viewport's** — `@container` + `@min-[Npx]`, not `lg:block`: a 1280px viewport holds a 452px half-column and a 918px full-width band at once, so a viewport breakpoint cannot see the narrow one (measured 2026-10-03, 18 clipped cells on `/sales/rankings`). `never-horizontal-scroll-always-mobile-and-desktop-friendly`

### §4 — The one form design

- 🔒 **THE ONE FORM DESIGN — every form, admin shell or employee portal, wears the Adverse Drug Reaction wizard's skin** (owner, 2026-10-06: "sweep the system wide everywhere admin or emp any form or any thing applicable make it follow this form design"). Import the field, label and button strings from `src/components/ui/form-tokens.ts` and assemble from `form-kit.tsx` (`FormField`, `FormWizard`, `CheckTile`, `FormActions`); never hand-write a field's border, background, radius, height or focus ring. Square corners, `h-10`, slate-300 hairline on white, orange focus, micro-caps labels, near-black Next and orange Submit. 🔴 **The ratchet in `tests/form-design-system.test.ts` is at ZERO and covers `<Input>`, `<Textarea>` and `<SearchableSelect>` as well as bare tags, resolving a className through the file's own constants — never raise it.** Exempt, by HIS OWN 2026-10-06 rulings: `h-8`/`h-9` dense table and filter controls, and EVERY dark ground — login, menus, sidebar, weekly bands — plus any chromeless control, `hiring-pack/` and `offers/`. Account: `docs/agents-owner-rules.md`, "The one form design". `the-one-form-design-every-form-wears-the-adr-wizards-skin`

### §4 — The Monthly-Closing source-of-truth golden rule

- 🔒 **THE MONTHLY-CLOSING SOURCE-OF-TRUTH GOLDEN RULE — the Monthly Closing module is the ONE source of truth for every SALES *and* every TARGET figure, system-wide** (owner, 2026-08-13; **targets made explicit and the rule ordered locked everywhere 2026-09-27**: "your source of truth to calculate any sales any targets is the monthclosing module, lock this golden rule everywhere in system"). Every surface — Sales vs Target, overviews, portal landings, command centres, incentive achievement, Employee 360, **Business Review** — computes BOTH the sales and the target it divides by through the closing engine, and must equal the **PUBLISHED** closing for that person and month; a page that re-derives either half from its own query, its own table or its own period is the bug, never a variant. Weekly Sales, Marketing ROI and the **Business Review pack** are the carve-outs — never invent a fourth. 🔴 **THE BUSINESS REVIEW READS THE LIVE ENGINE, NOT THE PUBLISHED SNAPSHOT** (owner, 2026-09-28, asked directly and answered *"use the live one"*). It is a REVIEW, not a payout record, and the two diverge for reasons correct on BOTH sides — a direct order counts in the month Finance books it, and the engine resolves geography as of the period — so the snapshot would understate real money and freeze a stale geography. **Never "fix" the Business Review back onto the snapshot, never republish a month to make them agree, and never acknowledge the drift to silence it.** A partial-window or per-page TARGET that inflates an achievement is the same defect on the denominator side. Account — the measured drift, line by line: `docs/agents-owner-rules.md`, "The Business Review reads live". `sos-monthly-closing-is-the-only-sales-truth`

### Cairo and Giza's go-live training day counts — 2026-10-10

On Wed 7 Oct 2026 the Cairo and Giza teams (CNS, Anti Infective, Pedia) sat the Phoenix CRM go-live
training; their iReports360 → Phoenix start is 10 Oct, so the day was invisible to every reader of
`crm_visits_unified` (the private calendar, the Deductions "No Records Activity" connector, the weekly
gap notice). Owner ruling, in chat as multiple choice: **7 October only.** `phoenix_crm_team_starts.day_activities_from`
(set to 2026-10-07 on the six Cairo/Giza start rows) lets a started team's RECORDED day activities count
from that day — `least(starts_on, day_activities_from)`, so it can only move the gate earlier, never
later, and it never touches visits. 15 reps had recorded a Phoenix meeting/training that day; 8 of them
had no iReports360 row and read "No Activity Recorded" before. Leave stays HR's record (a rep on approved
leave that day is not given a worked day), and a district manager has no Phoenix territory, so his day sits on his
team seat — the view's day-activity branch also reads a started team's OWN seat. Owner added the Anti
Infective Cairo district manager (Momen Abdelhady Shehata) for 7 Oct as a meeting entered by B-10, and
excluded Samir Saad (annual vacation that day). The Phoenix team calendar grid lists territories, so a
manager's day has no cell there.

## Qena per line — owner rulings, 2026-10-12

His words: *"in cns line its only a single qena"*, *"in cns the both qenas are counted to qena rep"*,
and — after asking for an audit of the Upper Egypt organogram — that in Anti Infective and Pedia there
are two reps, one for Qena 1 and one for Qena 2, each counted on his own part. His answers to the two
in-chat questions the same day: *"All nine months"* (CNS Qena 2 rolls up from 1 January, orphan
targets included) and *"Qena 1 rep covers it"* (Pedia's Qena 2 before its own seat existed).

**CNS — one Qena rep.** `cns / UE8` is `occupied` on `SEAT-CNS-REP-UE7` in ALL NINE months: rows
2026-01-01→07-13 and 07-14→open, with a one-day 07-13 Others row kept as dated history (monthly
attribution reads the period END, so that row never applies). January and February are the only two
months carrying a CNS Qena 2 target (92,163.59 and 41,509.20); because `carries_target` is a generated
column, the Qena 1 rep carries those two orphan targets — that is his answer, not a defect. The CNS
target template LISTS Qena 2; never upload a target into it from March on (October's CNS upload has
Qena 1 only, 337,469.87).

**Pedia — two reps from 1 September.** `SEAT-PED-REP-UE8` was born on 2026-09-01. Before it the
Qena 1 seat covers Qena 2, through `pedia / UE8` rows on `SEAT-PED-REP-UE7` for 01-01→07-13 and
07-14→09-01; February's Pedia Qena 2 target of 104,252.74 counts to that seat. From September each
area scores its own seat.

**Anti Infective — two reps in every month.** `anti_infective / UE8` is occupied on
`SEAT-AIF-REP-UE8` from the structure's first row (2026-07-13, which `f_line_area_map_asof` falls
back to for earlier months); its holder has held the seat since 2026-05-02.

**The towns** (his lists, applied to the brick master the same day): Qena 1 = أبو تشت · نجع حمادى ·
الأشراف · فرشوط · دشنا · القناويه · اولاد عمرو · الطوابيه · قريه الكلاحين; Qena 2 = مدينة قنا · قوص ·
الطويرات · الصالحية · نقادة · قفط · كامولا · الزينى · العشى · الدير · أبنود. مدينة قنا also keeps a
Qena 1 brick (`B209-1`) for the CNS and Head Office customers, which is harmless because CNS rolls
both Qenas to one rep; `B209-2` and `B209-8` are empty placeholders that must stay active.

**Read the seat, not the person, for a back month.** `au.f_seat_occupant_asof` credits a seat's whole
history to today's holder, so Qena figures for January–September name the reps hired in late
September and October, not the people who sold them. Measured 2026-10-12: every Qena row in all
nine months and three lines credits the right seat, nothing sits in Others, and the only negative
area-month is Pedia Qena 1 September (−13,113.84, the Office allocation — see the zero-sum roll-up
note in `org`).

## Her week is the interview calendar itself — owner, 2026-10-13

**The account behind the `employees` module rule "HER WEEK *IS* THE INTERVIEW CALENDAR".** Yomna
Gamal, Talent Acquisition Specialist, starts 18 October 2026; her landing page is
`/hr/admin/hr-command-center` under the `HR Resourcing` bundle.

### What he said, in order, all on one day

1. *"godmode heavy full premium polish"* — the page was built.
2. *"i want her calender to show like real calender"* — he rejected a bordered card per booking
   inside a bordered day inside the bordered panel.
3. *"PREMIUM POLISH !!!!!!!!!!!"* and *"2 OUT OF 10"* — he rejected the ruled list that replaced it,
   for not being a calendar at all.
4. A time canvas was built: an 84px-per-hour sheet, blocks absolutely positioned by start minute and
   sized by duration, lanes for overlaps, the window the booked span ±30 minutes.
5. **"BULLSHIT ,, AUDIT THE INTERVIEW CALENDER"** — with a screenshot of her week on a phone.
6. Asked whether to rebuild on the company's own interview-calendar grid or keep the canvas, he
   answered: **"The interview calendar's own grid"**.
7. That grid shipped, wearing the sibling's exact tokens — and he answered **"FULL INTERVIW CALENDAR
   FEAATURES"**. Three week layouts for this page had now been rejected in one day, the last of them
   visually identical to the real calendar, which is the whole lesson: **wearing a calendar's skin
   is not having its features**, and there is exactly one way to have all of them.

### What the audit of that canvas found, measured in the rendered HTML

- An invented calendar: sheet 588px = 7 × 84, eight blocks at `h42`, hour rules at
  84/168/252/336/420/504 and half rules at 42/126/…, a 48px time rail at `text-[9px]
  text-slate-300`, the platform word in `text-orange-300` on a `#FFF7ED` wash (≈1.6:1 contrast, on
  8 of 8 blocks), and today's whole column washed `bg-orange-50/30`.
- The now line was legitimately absent from his screenshot — it was 04:40 Cairo, outside the window.
- The company already owns the grid he was asking for:
  `src/components/recruitment/interview-calendar/interview-calendar-view.tsx` renders a
  `w-full table-fixed` slot table — a `w-[5.75rem]` time column, 30-minute rows 9:00–17:00 at
  `h-[46px]`, `bg-slate-50/70` zebra on the odd rows, the shared dark head band with today in
  `bg-orange-600`, chips at `border-l-[3px] border-l-orange-600 bg-orange-100`, and `md:hidden` day
  cards on a phone. Two calendars for one company was the defect; a second design was never needed.

### What finally shipped: the component, not a copy of it

The week tab mounts `InterviewCalendarView`. Everything this page had written for itself is deleted —
`weekGridWindow`, `placeDayInterviews`, `bookingsInSlot`, `outsideWorkdayInterviews`, `buildWeekDays`,
`WeekSlotTable`, `SlotCell`, `SlotBooking`, `WeekDayCards`, `JoinerChip`, the now-line state, the
60-second refresh and the `taWeek` plumbing — 686 lines out of the calendar component and 198 out of
the logic file. She gets the real thing instead: week navigation and the week picker, pressing a free
half hour to book from Recruitment or from outside with a CV, interview **sessions**, every name
opening that candidate's CV, the interview detail with its Zoom link, panel, outcome and notes,
Export PDF and Export Excel, Request an interview, and the component's own phone cards.

The page resolves on the server the same four answers the recruitment page resolves, by the same
functions — `resolveInterviewCalendarRole`, `interviewCalendarAbilities`, `mayRequestInterviews`,
`isZoomConfigured` — and hands them over with the server's `todayKey`. Two details are decisions, not
plumbing: `initialWeek` is **`upcomingWeekStart`**, not the week today sits in, because Friday and
Saturday are not working days here and the week containing a Friday is Sunday-to-Thursday already
over; and **`lockedWeek` is never passed**, since that is the prop a week-limited share link uses to
freeze one week, which would delete the navigation he had just asked for.

**She owns the calendar, since 2026-10-21, and nothing here narrows that.** The owner's words were
"make the TA have full access on the interview and can schedule and do everything and use every
single feature". `isInterviewCalendarOwner` names `HR Resourcing`, so she resolves to an **owner**,
the tier HR Operations holds: she books, moves and cancels interviews, gives a waiting request its
time, comments, records outcomes, exports and shares the calendar, with the component drawing every
button her role meets. Until that day she was a **Viewer** (2026-10-08, "Full view built into her
seat", `seesWholeInterviewCalendar`) with a read-only request list (2026-10-18); both stay in the
code as the floor under her ownership and decide nothing for her. Her fence stands: the calendar's
candidate search and bookings run the Talent Acquisition fence, so she never sees an HR applicant.
The component offers only what her role holds and every API route behind it enforces again, so a
prop that said more would buy nothing.

The joining days moved to the **month**, which is the only view that draws all seven days; the week
strip they used to sit on was Sunday to Thursday, so it could never have been complete.

### How the test pins it now

`tests/talent-acquisition-overview.test.ts` pins the EMBEDDING: the import of the real component,
that the sibling still exports it under that name, that it is rendered, each of the six props with
the reason that prop exists, that `lockedWeek` is absent, that the four resolvers are the source of
those props, that `upcomingWeekStart` is the opening week — and, negatively, that this file carries
**no `<table>`, no `slotStarts()`, no `h-[46px]`, no `border-l-[3px]` and no `<colgroup>`** ever
again. That negative half is the one that matters: the rejected third layout would have passed every
design-token test ever written. All 26 assertions were broken one at a time and each watched to fire
its own headline.

### The proof read off her rendered page, while the token-copy grid was up

Fetched with dev-auth `HR Resourcing` / `HR-011`, before the embedding replaced it: one
`table-fixed`, one `w-[5.75rem]` time column, **80 cells at `h-[46px]`** (16 half-hour rows × 5 days,
Sunday 11 Oct → Thursday 15 Oct), zebra on all 8 odd rows, the time rail 9:00 AM → 4:30 PM, **8
bookings each in its own slot** carrying the 3px orange edge, **no `min-width`, no
`overflow-x-auto`**, and no occurrence of "Employee requests" anywhere in the DOM. It is kept here
because it is what the measurement looked like, and because it is the measurement that passed while
the answer was still wrong.

### The band that must never be blank

Same day, same page: *"i donot want this blanque area empty like this"*. The portrait reserves
~101px whether or not anything is drawn, so the **shut** notice band draws the same ledger the open
one does, absolutely positioned over that reserve. Clipping is the visible fault; a pushed-down
dashboard is the silent one. Pinned by `tests/identity-strip-emblem.test.ts` §8b.

**Standing from the same day, and not re-litigated:** do not touch the portrait or the identity
banner, and never show Employee requests on her page.

### Her overview, rebuilt 2026-10-16

He asked for her landing page to be rebuilt from scratch with full premium polish, and answered
three questions before the build: **add Today's interviews, Joiners arriving in the next 14 days and
CVs received today**, and stand the eight figure cards in **three labelled groups — Seats,
Candidates, Outcomes**. The page now reads, top to bottom: the identity strip → the command rail
(the one Needs attention button, an "N overdue" chip only when something is overdue, and the Hired
window at its right) → the three groups → the Today band → the interview calendar → on a vacation
today → my record.

**The Conversion scoreboard stands in the air beside her portrait** — the same evening he circled
the white space under the notice rail, left of the photo, and wrote *"fit the keycards where i
marked"*. The strip gained ONE optional prop, `reserve`: given, the notices keep their rail (and
still open on a press) and the caller's content stands under it; absent — every other landing — the
strip is byte-for-byte what it was, with the notices' shut peek filling that air. The three cards lie
down at every width (figure left, label, meter and named halves right) so the band fits the reserve:
measured on her account, row 144px against a 143px reserve at a 1440px window, 160 = 160 at 1531px,
168 = 168 at 1920px. Under ~1100px the reserve is only ~93px of air and the band grows the row
instead of clipping — a figure is never cut to fit (*"never the ever tranculte text"*, same evening:
the band is a flex item with `overflow-hidden`, which CAN shrink below its content, and at a 1009px
window it was cut to 120px of 232 until it became `flex-auto shrink-0`). The sweep that proves it
tests every text node's rectangle against every clipping ancestor; a `scrollHeight` check reads
every glow and watermark as a cut and is useless here.

**The eight figure cards are his own dashboard's card.** The dressed version — a different tone bar
per card, a wash, a medallion and a watermark, eight across at 109px — he called *"awful"* and then
said *"audit the b-10 dashboard and take ideas from it in design"*. So they are `HrCommandCenter`'s
`MetricTile`: centred, tracked caps label, `text-3xl` figure, faded top edge (Phoenix orange on every
card), the arrow on hover, no icons. They stand eight across only from 1120px of container (~130px a
card); under that each group is its own row of wide cards, as his dashboard's are.

- The parts live in `src/components/hr/talent-acquisition/` (`panel.tsx` holds the shared frame);
  the data comes from domain reads that already existed — `listInterviewCalendarDay`, the offers
  the page already loads, and `buildTodaysCvDigest`, gated on `candidates:read`.
- **A failed read is never drawn as a quiet day.** Each Today panel checks that its read LOADED
  before it chooses between a list and an empty state; a failure names itself in amber.
- The duplicate charts and the never-rendering Hiring quality band are gone from the loader, not
  just hidden.

**The colours are Phoenix's only.** He asked for colour the same evening ("her page is so pale and
poor"), was shown a four-hue version — Sato blue for Seats, violet for Candidates, emerald for
Outcomes, a navy scoreboard — and refused it: *"nono too much like this, stick to phx identity"*.
So the dark band is the platform hero's black deepening into ember, and every edge, medallion,
marker, watermark and glow is Phoenix orange or amber. Emerald, amber and rose appear only on a
FIGURE, where the builder sets them as meanings (good, waiting, a problem) — never as a theme. Pinned
by `tests/talent-acquisition-overview.test.ts`, which refuses a sky, blue, indigo, violet, purple,
fuchsia, cyan or teal class and the Sato blue hexes in the page and every new part.

**The three conversion cards, as the audit of 2026-10-16 corrected them** (all three of his answers
were the recommended option, asked in chat as multiple choice).

- *Interview to offer* read **66%** (45 letters over 68 people) and the like-for-like figure was about
  **22%**. The 45 were every letter written in 90 days — 12 withdrawn, test-looking ones, letters to
  people who were never on the calendar (28 of the 45 had no booking) — over the people interviewed, so
  the top half was not a subset of the bottom and the old caption admitted it could pass 100%. It now
  counts, among the people interviewed, those who hold a live letter. Measured on production the same
  day: 12 matched through the pointer on the candidate (`ats_candidates.offer_id`), 3 more through the
  e-mail on the letter, 15 of 68. A booking in the future no longer counts as an interview held.
- *Offer to join* read **22 of 22** under "joined through the form", and only 3 of the 22 came through
  the form (19 through HR's Add Employee). It now counts accepted letters whose employee is active with
  a first day on or before today: **18 of 22 = 82%** that day, the other four starting 18 and 24 October,
  so it climbs as first days pass.
- The header says "Last 90 days" over all three, and now it is true of all three: Offer acceptance and
  Offer to join read only the letters written in the window (before, they read the newest 200 with no
  date filter). Without the Employee Master the join card is left out, never drawn as 0 of N.
- *CVs received* keeps counting people HR added by hand from the interview calendar (3 on 15 October,
  33 of 1,432 lifetime) — his answer: keep counting them. The 18:00 CV summary is unchanged.

**His other answers the same day.** *Screen* counts the candidate pool's New pile (754 that day) —
it read 0 because it counted applications against a requisition. The vacancy cards stay as they are:
his rule "if hired then exclude from vacants" already holds, because a hired person's seat is closed
(all 14 sent or accepted letters that point at a seat were checked: every accepted one is `filled`,
the only open one is a letter still awaiting a reply). Parked seats were not decided and are not
flagged. One sent letter (Zahraa Hamdy Sobeih, District Sales Manager) carries 12 October as both its
start date and its validity date, and he says her real date is 1 November 2026, so no "past its
validity" flag was added to Offers Out. The month grid wears Phoenix tones only: ink for holidays,
ember for joinings, orange for interviews and birthdays, amber for leave, slate for events and plans,
told apart by lightness and the named legend, pinned by the hue ban in
`tests/talent-acquisition-overview.test.ts`.

## The rep ranking workbook's admin button — owner, 2026-10-13

He had just merged the rep ranking workbook into the Anti Infective employee portal (#5867) and
asked, in his own words, **"from admin account how to download uh, how to download the sheet."**
Offered four ways to reach it, he typed his own: **"add a third button"**.

### Why he could not already

Nothing was broken. `/api/sales/monthly-closing/export` branches on ROLE at line 204 —
`Super Admin || scope === "system" || SFE Manager || CEO || Finance Manager || marketingOversight` —
and returns the full six-sheet workbook at line 608, **before** the rep-ranking branch at line 753.
Everyone who runs the admin Monthly Closing screen is in that disjunction, so for them the ranking
branch is unreachable code. The disjunction is **append-only**:
`tests/sfe-manager-nav-dead-links.test.ts` pins its first three terms as a literal source substring,
and the workbook it guards is frozen. Widening it was therefore never an option.

The other door was shut too: `/employee-portals/monthly-closing` redirects him, because
`PORTAL_CLOSING_ROLES` is Medical Rep, District/Regional/National Sales Manager, Product Manager,
Group Product Manager and Marketing Manager — **no Super Admin** — and the portal view posts the
same body with no surface marker, so even there his role would take the full branch.

### What was built

`/api/sales/monthly-closing/rep-ranking-export`, a route of its own BESIDE the frozen one, calling
the same `buildScopedRepRankingExport`. One builder, so a change to the ranking reaches both buttons
or neither. Four decisions inside it are load-bearing:

- **Scope is the viewer's own** — "everyone his scope, not me", his words the same day. The builder
  asks `loadPortalMonthlyClosing` for each trend month, so for a Super Admin
  `resolvePortalClosingScope` yields `allowedLineNames === null` → every official line minus Head
  Office, with null region and product bounds, which is the whole line unscoped; a Medical Rep
  hitting the same route still gets his own row. No new scope code exists anywhere in it.
- **The selection only, never the screen's filter.** Every other closing export forwards the
  on-screen filter. This one must not: the ranking is built from matrices that take no row filter at
  all, while the channel carve is built from the detail rows. Narrow the rows and the Direct/Stores
  split shrinks underneath a ranking that did not move — a workbook disagreeing with itself, with
  nothing on it saying which half was filtered.
- **An unpublished month is refused in plain words, first.** Super Admin, SFE Manager, CEO and
  Finance Manager read unpublished months everywhere else in the closing, but this workbook trends
  over `loadPortalMonthlyClosing`, which offers published months only and answers an unpublished one
  with the NEWEST PUBLISHED month instead. The builder drops a month that came back under a
  different name and then returns null, so without the check an unpublished month would read as
  "cannot be built". It reuses `unpublishedClosingMessage`, the portal's own sentence.
- **Anti Infective only**, by the same single gate — refused in plain words rather than quietly
  handed the ordinary workbook, because the button was clicked for the ranking and a different file
  arriving under that name is how a reader ends up quoting the wrong sheet.

`isRepRankingLine` moved into the dependency-free `src/lib/sales/closing-rep-ranking-line.ts` and is
re-exported from the builder, so every existing caller keeps its import path. The reason is the one
`confidential-products.ts` exists for: the admin closing screen is a CLIENT component and has to ask
the same question to decide whether to show the button, and one import of
`closing-rep-ranking-export.ts` from the browser bundle drags `@/lib/supabase/server` and the
employee-directory chain behind it into webpack, which refuses it outright — and in dev poisons the
server for every later request once it compiles.

### The fourth button cost the export row its `shrink-0`

Three buttons measure about 530px and fitted one line; the fourth takes the row past 730px, which is
wider than the panel at 640 and at 768. A flex item with `shrink-0` is never handed a width narrower
than its content, so a `flex-wrap` on that same element never fires — the row grows past its parent
and the page scrolls sideways, which the fits-the-screen golden rule bans outright. So the row is
`flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end` and the buttons drop
onto a second line instead; each BUTTON keeps its own `shrink-0`, correct inside a row that wraps.
The note left in the file when there were three recorded that wrapping had been tried and reverted
"for no gain" — the gain exists now, because four buttons no longer fit a line the filters can give
back. See `tests/flex-wrap-shrink-guard.test.ts`, which exists because that pattern bit for real on
2026-09-30, and note its own finding: `scrollWidth` cannot see a flex item overflowing its
container, so the measurement is the child's `getBoundingClientRect().right` against the parent's
content edge.

The button is **absent** on CNS and Pedia rather than disabled: the workbook does not exist for
them, and a greyed-out control invites a click that can never succeed.

All four, plus the frozen export being untouched, are pinned by `tests/closing-rep-ranking.test.ts`
(`assertAdminRepRankingButton`).

### His own copy reads an unpublished month — same day, after the button refused September

He clicked **Export Rep Ranking** on September 2026 and read back *"The Anti Infective Monthly
Closing for September 2026 has not been published yet, so its details cannot be opened or
exported."* The message was correct. `monthly_closing_publications` on production, where published
means `unpublished_at IS NULL`:

| Month | Published | Unpublished since |
| --- | --- | --- |
| September 2026 | 5 Oct, 15:25 Cairo | **9 Oct, 18:12 Cairo** |
| August 2026 | 7 Sep, 12:10 Cairo | **12 Oct, 00:05 Cairo** |
| July 2026 | 8 Aug, 15:48 Cairo | **12 Oct, 00:06 Cairo** |

So **no Anti Infective month was published at all**, which means the workbook could be built for no
month whatever — not from the admin button and not from the portal export either. The publish gate
is the right rule for a rep and the wrong one for him: he reads an unpublished closing everywhere
else in this module, and his own screen was showing him September while the button refused it.

Offered the choice, he picked **"Build unpublished months for admin roles"** over publishing
September again (publishing would have released it to every Anti Infective rep and manager, which is
why it was unpublished on 9 October).

**What that is, exactly.** `loadPortalMonthlyClosing` gained an opt-in `includeUnpublished`, and the
route passes `readsUnpublishedClosings(access)` into it — never a literal `true`. That predicate is
already the repository's single answer to "who reads an unpublished closing": Super Admin, system
scope, SFE Manager, CEO, Finance Manager and the Marketing oversight set, mirroring the closing
export's full-workbook branch term for term, with a test that fails when the two drift.

🔴 **It is an option on the ONE loader rather than a second loader, deliberately.** The flag swaps
the month list and nothing else: the confidential strip, the per-user product bound, the region and
area narrowing and the identical pass over the Office grid all still run. A copy of that chain is
precisely how a workbook ends up carrying a restricted product's Office units, or showing a manager
the national Office figure beside his own region's sales. So this widens **which months** he may
export and never **whose figures** — and the portal export never passes the flag at all.

🔴 **A validated month this line never traded in is not a zero month.** The validated month list is
global, because an import batch carries no line, so `includeUnpublished` can offer a month with no
Anti Infective rows. It comes back as a matrix with no regions, and the builder drops it from the
trend rather than rendering a column in which every rep scored nothing and the quarter disagrees
with the line. The requested month failing that test returns null, so the route says "could not be
built" rather than shipping an empty ranking.

Both rules were proven by breaking them: forcing `includeUnpublished: true` and restoring the old
`matrix ? … : null` each made its own assertion in `tests/closing-rep-ranking.test.ts` fire, and the
suite returned to green once restored.

### "Cannot read properties of undefined (reading 'split')" — the trend is not always three months

Minutes after July and August were published he clicked **Export Rep Ranking** and got that error
instead of a file. It was the **first real run of the builder in production**: no Anti Infective
month had been published since 9 October, so neither the portal export (#5867) nor the admin button
(#5869) had ever built a workbook against live data.

`resolveTrendPeriods` returns the closing month plus the offered months before it, capped at three.
With only July and August offered, **July's trend is one month and August's is two**. The workbook
was written against the Jul–Sep scratchpad build and assumed three throughout:

- `monthName(TREND[2])` in the Trust sheet's Scope row — `undefined.split` — **the crash itself**.
- Three sheet subtitles hard-coded `"July to September 2026"` / `"units, July to September 2026"`.
- Three `W` width arrays carried three literal `13`s, so with one or two month columns every width
  after them shifted onto the wrong column.
- Prose on four sheets asserted "THE THREE MONTHS'", "JULY PLUS AUGUST PLUS SEPTEMBER", "THE SEATS
  ARE SEPTEMBER'S", "the quarter", and "three cells in this feed are months whose credits
  outweighed their invoices" — a **counted figure stated as a literal**, true only of the build it
  was written against.

Every one of those is now computed from `TREND` and `PERIOD`: `SPAN`, `SPAN_COUNT` and `SPAN_PLUS`
beside the trend they describe, widths spread from `TREND.map(() => 13)`, and the negative-cell
count incremented by the same pass that prints the cells. `monthName`/`monthShort` also stopped
being able to throw — a period they cannot read comes back as itself, because a caption may be wrong
and survivable but must never lose the file.

🔴 **The general rule: a figure or a month name in a workbook's prose is COMPUTED by the pass that
prints it, never transcribed from the build it was first written against.** A sentence naming "three
months" or "three cells" becomes a confident lie the first time the data moves, and nothing goes red.

Pinned by `tests/closing-rep-ranking.test.ts`, which now builds the one-month and two-month shapes
as well and reads their captions back out of the emitted zip — **out of the worksheet XML as well as
`sharedStrings`**, because a sheet's subtitle is written into its print footer and a sharedStrings-only
check passed a build whose every sheet still footed "July to September 2026" over one month of data.
Proven by breaking all three: restoring `TREND[2]` with the unguarded helper reproduced his exact
error inside the test, and the two caption breaks each fired their own assertion.

## A pharmacy with no distributor code is validated on its licence and released by a person — owner, 2026-10-14

**SUPERSEDED 2026-10-21** by "Marketing Requests hold only venues that carry a distributor code" below: a licence no longer stands in for a code in Marketing, and the release no longer makes a target. Kept as the history of what shipped.

**The incident.** A District Sales Manager on the Anti Infective line was validating a customer for a marketing request. The pharmacy had no distributor code, he attached its licence, and the form blocked him on the code check — while the licence box itself told him to attach the licence when no code existed. Both the client gate and the server required at least one code, and the licence was never read.

**His two rulings (chat, multiple choice).**
- *Release rule — "Usable target, no sales channel".* A licence-only pharmacy that a Super Admin or the CEO has read and released can be picked as a request target like a nursery. Spend is allowed; sales cannot be matched until a code is added.
- *Resubmit rule — "Restart at the first approver".* A returned request that is resubmitted with a changed cost, customer or target venue restarts the approval chain at the first approver. (Built 2026-10-14, in the same PR as the release rule: see the next section.)

**How it works.**
- The licence stands in for the code: the pharmacy saves with a codeless link held on `pending` (desk and field alike) carrying `LICENSE_ONLY_PHARMACY_NOTE`. It is not usable in requests.
- Approve on that link in Customer Pharmacy Mapping (Super Admin or CEO) writes `admin_approved`. It needs an explicit "the trade name on the licence matches the shop sign" tick and records the licence verdict on the pharmacy. A name that does not match is a Reject.
- `requestTargetKind` in `src/lib/marketing-requests/code-link-reach.ts` is the one test the request picker and the server's draft guard share. Only an `admin_approved` link carrying the marker qualifies as `licence_released`; a nursery stays `no_distributor_account`; a coded link stays `coded`.
- The server now also requires every chosen target to be one of THIS customer's own validated links (`target_not_linked_to_customer`), on create and on resubmit. Before, the code was looked up by id alone and the gate only asked whether the customer had some validated venue. Production showed no live violation (all 88 live targets sat on valid links), so nothing needed repairing.
- The marker stays in the link's notes for good, so every banner reads the STATUS as well: "not usable yet" shows only while the link is `pending`.
- Every reviewer screen draws the licence large (`PharmacyLicenseEvidence prominent`): the request approver detail, the decision confirmation, the Customer Database register and Customer Pharmacy Mapping.
- A new licence file gets its own storage path (a failed save used to delete the licence that was already on file) and resets the verdict to "not checked yet", because the old answer described a different document.

**Still open, owner decision.** The licence verdict stays write-once apart from replacing the file. `a-licence-verdict-is-permanent-and-has-no-correction-path` asks that the owner be asked before the first one is recorded. The first one is recorded by a Super Admin or CEO ticking the box in the Approve dialog.

## Marketing Requests hold only venues that carry a distributor code — owner, 2026-10-21

**His words.** "in direct orders we can validate a nursery without a distributor code — any thing with no distributor code never reach the marketing requests".

**What it replaces.** Three marketing rules: a nursery validated in Marketing on location and live photo alone (2026-08-23); a pharmacy with no code saved on its licence, held, and released by a Super Admin or the CEO as a request target (2026-10-14, the section above); and the codeless request target, `no_distributor_account` / `licence_released` ("spend allowed, sales can never be matched").

**How it works.**
- One sentence and one code for every refusal: `venueWithoutDistributorCodeMessage` and `venue_without_distributor_code` in `src/lib/marketing-requests/coded-venues-only.ts`. The sentence names the venue and says venues without a code (nurseries included) are validated in Direct Orders.
- Request targets: `requestTargetKind` in `code-link-reach.ts` answers `"coded"` or null. The picker offers only coded links, lists only customers holding one, and the server's draft guard refuses a codeless target before anything else.
- Capture: the customer-validation save refuses a nursery and a pharmacy with no code (with or without a licence), on a new venue and on a "My Pharmacies" reuse; `venueCodeSlots` refuses a codeless venue at the write loops too, and neither promotion sweep validates a codeless link. The reusable-pharmacy list no longer offers a codeless venue. The form shows Nursery disabled, says where codeless venues go, and the save gate names the same sentence.
- Admin paths: Customer Pharmacy Mapping's Approve refuses a codeless link (Reject stays open). The manual Transfer refuses a nursery answer before any read, and a customer whose link carries no code; the dialog keeps Yes disabled on Nursery.
- The automatic carry-over (`direct-order-venue-sync.ts`) skips a codeless link or a nursery with `no_distributor_code`, as a ruling rather than a retry.
- Direct Orders is untouched: its desk still routes a codeless nursery to `admin` and never refuses it for a missing code.

**Rows already in production.** Codeless links written before this rule stay as rows (nothing was deleted or rewritten); they are simply never targets and never promoted. Pinned by `tests/marketing-coded-venues-only.test.ts`.

## A resubmit that changes the money, the customer or the venues restarts the approval chain — owner, 2026-10-14

**The gap.** A returned request used to resume at the rung that returned it with every earlier approval kept, whatever the requester had changed. A request the District Manager approved at one cost, returned by a later approver, could be edited to a larger cost or another customer and resumed one rung up, so his earlier yes now covered something he never saw.

**His ruling (chat, multiple choice).** *"Restart at the first approver."* when a returned request is resubmitted with a changed cost, customer or targets.

**How it works.**
- `src/lib/marketing-requests/resubmit-rule.ts` holds the rule as pure functions. `resubmitBasisChanges` compares what was approved against what is resubmitted on exactly three facts: the customer, the estimated cost (anything under half a piastre is float noise) and the SET of targets (order does not matter; the same venue through a different distributor code is a different target). `planRestartedApprovalSteps` returns only the rungs that must change: the first real gate opens as `current`, every later gate goes back to `pending`, every earlier decision is cleared.
- A resubmit that changes none of the three still resumes at the rung that returned it, earlier approvals kept.
- CC rows and a skipped self-approval rung are never reopened. The self-approval rung is `skipped` with a note saying why; reopening it would park the request on a rung its own assignee is forbidden to decide.
- A restart writes an audit row (`marketing_request`) naming what changed, where the chain restarted, and which earlier approvals were cleared and by whom. The per-step history stays on the request timeline.
- The first approver is told again: the notification key carries the rung's recorded reopening (the same epoch the decision path and the daily backfill compute, `resolveMarketingStepReopenEpoch`), so the earlier "assigned" message does not suppress it and the next sweep does not send it a second time, and its text says the request restarts because the cost, customer or targets changed.
- **A decision that advances onto a rung that has opened before carries the same epoch.** A restarted chain reopens rungs that already told their approver once, and the delivery key is unique per rung, so without it the second and later approvers of a restarted chain heard nothing until the next daily sweep. A failed epoch read never fails a decision that already committed; it degrades to the ordinary key and the sweep catches the approver up.

**One transaction: `phx_resubmit_marketing_request`.** The service decides WHAT to write (the restart rule, the plan of rungs, the customer-scope and requester checks) and the function makes it all-or-nothing: it locks the request row, requires `returned` and the requester, replaces the products and targets, rewrites the rungs the plan names (gating rungs of this request only), and **refuses to commit unless exactly one gating rung is `current`**. Granted to `service_role` only. A second tab or a double tap waits on the row lock, finds the request no longer `returned` and is refused with `marketing_resubmit_conflict`.

**Why not a client-side claim and rollback.** That was built first and rejected in review. Its rollback could not re-insert the products (`marketing_request_products.expected_value` is `GENERATED ALWAYS AS (forecast_quantity * factory_price_snapshot)`, so naming it in an insert is refused and the old products were lost exactly when they were needed), a second resubmit could claim on top of the first, and a final write that committed but errored to the client was rolled back around. Six sequential client writes cannot be made safe; one transaction can. The function inserts the products without `expected_value` and the targets without `tracking_status` (a new row starts as `pending_validation`, as a new request's does). Pinned by text in `tests/marketing-request-service.test.ts` (row lock before the status read, the single-current guard, the generated column left out, the REVOKE/GRANT).

**Three smaller fixes in the same pass.**
- The overdue-invoice nudge (`invoice-overdue-nudge.ts`) now ignores a request whose own status is not one that still owes an invoice. A cancel flips the request's status and nothing else, so the finance row survived and the requester and finance were told every morning that a cancelled request's invoice was "18 days late". The list is an allow-list (`approved`, `active`, `roi_tracking`, `closed`, `finance_hold`, `archived`); `archived` stays in on purpose.
- A cancelled request no longer raises an overlap warning on a new one (`INERT_MARKETING_REQUEST_STATUSES` gains `cancelled`). Its money is never committed, so there is nothing to double-count, and the warning was one an approver could not clear.
- Changing a marketing control setting, a request type or an approval step now writes a required audit row (entity type `marketing_control`) with the before and after of the columns touched. Before, who re-pointed an approval step left no trace.

**Deliberately not done.** Cancelling does not close the request's open approval step. Everything that lists work for an approver already filters on the request's status (the badge, the inbox, the orphan board), and flipping a step to `skipped` would write a timeline entry attributed to the person it was assigned to, as though they had decided it.

## Kafr El-Sheikh 2 counts to Dina Fadel the manager, never to Ragaa the rep — owner, 2026-10-15

His words, across two messages the same afternoon:

1. **"only stores split in kafr el sheikh 2 count her to dina fadel"**
2. **"doinot count kafr el sheikh 2 store splitting to ragaa the rep count it to din a fadel the manager only"**
3. **"i want this change to be starting from july 2026 counted to her"** — after reading the October
   shape back, the same afternoon.

The second message is the operative one on *who*; the third is the operative one on *when*. Neither
is a new ruling: the second corrects the first answer's **shape** and the third corrects its **date**,
and the three together are what this section exists to keep straight.

**The defect he was pointing at.** `AREA_CITY` groups `D16` and `D17` as one city, Kafr El-Sheikh, so
under the city rule every wholesaler there divides 50/50 between them. Dina Fadel holds
`SEAT-AIF-DM-D1` (Anti Infective, Delta (1)) and her district is Menoufia 1-2, Gharbia 1-2 and Kafr
El-Sheikh **1**; her rep there is **Ragaa Mosaad Mahmoud Ahmed Shabaan, B-107, `SEAT-AIF-REP-D16`**.
Kafr El-Sheikh 2 (`D17`) sat in the line's Others bucket — `SEAT-AIF-OTHERS`, no rep,
`carries_target` false — so the half landing there reached no manager at all. Measured on production
2026-10-15 for the **published** September 2026 Anti Infective closing:

| | Published | Moved | If the half had stayed in Kafr El-Sheikh 1 |
| --- | --- | --- | --- |
| Kafr El-Sheikh 1 (Dina Fadel) | EGP 40,361.38 | **+24,709.25** | EGP 65,070.63 |
| Kafr El-Sheikh 2 (Others) | EGP 27,261.38 | **−24,709.25** | EGP 2,552.13 |

**EGP 24,709.25 of the EGP 27,261.38 credited to Kafr El-Sheikh 2 — 90.6% of it — was her
wholesalers' money**, and the area's own sales were EGP 2,552.13. The wholesalers: ايةام جروب
للاستثمار وتجارة الادوية (290 Saginko + 100 Royafloxacin) and الفتح لتجارة وتوزيع الأدوية (100
Saginko) in Kafr El-Sheikh 1, and مخزن كابيتال (5 Saginko) in Kafr El-Sheikh 2. July and August
carried no Anti Infective wholesaler movement in that city at all, which is why September looked
like a sudden jump.

### The first answer was the wrong shape, and shipped

🔴 **#5926 answered the first message by refusing `D17` a share of the split** —
`OTHERS_EXCLUDED_AREAS_BY_LINE` resolved by `excludedSplitAreasFor`, Pedia's `OTHERS_EXCLUDED_LINES`
shape narrowed to one named area. It was merged and live on production as `c95543f3a` before his
second message arrived.

**Refusing the area a share does not credit a manager — it credits the REP.** With `D17` excluded,
the whole city lands on `D16`, which is Ragaa's area, so every pound of it reaches his rep number.
That is the opposite of *"count it to Dina Fadel the manager only"*, and it is the general lesson
worth keeping: **the only thing that can move money from a rep to a manager in this system is the
area map.** `au.monthly_attribution_rollup` is keyed `(period, line, area, product)` with no manager
column at all, and `au.f_monthly_attribution` fuses the store-split net into the area's base sales
**before** the seat join, so a row cannot carry a DM of its own. Area → DM is the whole mechanism;
there is no row-level override to reach for, and inventing one would mean a new column, a changed
rollup function and every DM surface re-checked.

### What is built instead

Kafr El-Sheikh 2 **joins Dina Fadel's Delta (1) district on Anti Infective from 2026-07-01** (first
built at `2026-10-01` by `20261015145000`, re-dated the same day by `20261015153000` on his third
message), as a dated pair in `au.line_area_map`: `operational_region_code` `D1`, `dm_seat_id` `SEAT-AIF-DM-D1`,
`rep_seat_id` **NULL**, `area_state` still `other_line_specific` so the generated `carries_target`
stays **false**. The 50/50 split is untouched — only the district reading `D17`'s half changes. So
her district total carries both halves, no rep is credited with the second one, and Ragaa keeps
`D16`'s own half and nothing more. The #5926 exclusion is reverted in the same pull request.

**This is the Luxor shape, not a new kind of row.** `au.line_area_map` already holds `OT6` on
`UE-2` under `SEAT-PED-DM-UE-2` with no rep seat and no target (owner, 2026-09-09). An area can sit
in a real district, carry sales and carry no target.

**Anti Infective only.** CNS and Pedia keep Kafr El-Sheikh 2 in Others. On Pedia that is a money
fact, not tidiness: El Qema's divisor is every Pedia area the organogram does not park in Others, so
pulling `D17` out there would take it from 39 to 40 and move every El Qema number. On Anti Infective
nothing is divided by the Others set — `OTHERS_EXCLUDED_LINES` holds `pedia` alone — which is
precisely why the area was receiving a half with no manager, and why the organogram is the only
lever.

### The two things he was asked, and chose

- **Move the area, not just the split share.** Because the area map is the only thing that reaches a
  manager, moving it brings مخزن كابيتال's own sales in `D17` (EGP 277.88 in September terms) to her
  as well, not only the split's half. The alternative was a row-level manager override — a new
  column, a changed rollup and every DM surface re-checked, against EGP 277.88 a month. He chose to
  move the area.
- **Count it inside her achievement.** `D17` carries no target and none is being invented, so the
  sales join her district total while nothing joins the divisor and her percentage rises. That is
  how every Others area behaves once it joins a real district, and it is his decision rather than a
  side effect.

### July is his date, and the publication freeze is what still stands in front of it

🔴 **The boundary is `2026-07-01`, and that does NOT by itself move July, August or September.** Read
live 2026-10-15: all three are published on Anti Infective — 2026-08-08, 2026-09-07 and 2026-10-05,
every one by B-10 — and `au.f_refresh_monthly_attribution` **refuses a published period**, raising
*"leaving its attribution rollup frozen"*. The territory sync button and the nightly
`/api/cron/territory-restamp` refuse the same months from the other side, reading
`monthly_closing_publications` rather than the lock. So the map now resolves `D17` to Delta (1) from
July on (verified live: June → `OT`, July/August/September/October → `D1`), while the three stored
rollups still read Others — EGP 2,729.10, 3,630.15 and 27,261.38 — until **he** unlocks and
unpublishes each month on the Monthly Closing screen himself. All three were locked on 2026-10-13.

What each month moves when he does it, measured 2026-10-15 (Anti Infective, her district total):

| Month | Delta (1) now | Kafr El-Sheikh 2 | Delta (1) after | Others after |
| --- | --- | --- | --- | --- |
| July 2026 | EGP 239,667.40 | **+2,729.10** | EGP 242,396.50 | −2,729.10 |
| August 2026 | EGP 179,233.60 | **+3,630.15** | EGP 182,863.75 | −3,630.15 |
| September 2026 | EGP 191,084.28 | **+27,261.38** | EGP 218,345.66 | −27,261.38 |

**No rep loses a pound in any of them.** In the published months `D17` sits in Others, not with
Ragaa, so the restatement moves money out of the Others bucket and into her district; Kafr El-Sheikh
1 keeps its own half untouched and the national total does not change. Her percentage rises, because
`D17` brings no target with it.

🔴 **The Others row is dated back to `2026-01-01`, and that is load-bearing.**
`au.f_line_area_map_asof` prefers the row covering the date and otherwise **falls back to the row
with the smallest `effective_from`**. The Others row began on the map's own floor, `2026-07-13`, so
once the Delta (1) row started `2026-07-01` it would have become the earliest row for this area —
and January to June 2026, which match no interval at all, would have fallen back to it and counted to
her as well. Those six months carry real sales in `D17` (EGP 788.30, 1,758.70, 1,505.65, 1,788.65,
1,667.25, 1,031.10) and carry **no publication row**, so nothing would have refused them: the
nightly stale-attribution sweep would have restated all six on its own. Re-dating the Others row
keeps it earliest and keeps every pre-July month exactly where it is.

**Nothing needs rebuilding after it is applied.** The stored net (`au.monthly_store_split_net`) is
area-keyed and the split is unchanged, so the move takes effect on the next read; what moved is the
area → DM resolution, and that is resolved live. After each unpublish,
`select au.f_refresh_monthly_attribution('<period>')` rebuilds that month at once instead of waiting
for the nightly sweep.

### Pinned by

`tests/anti-infective-kafr-el-sheikh-2-delta-1.test.ts`, re-dated to the July boundary with the
pre-July months asserted month by month. Breaks watched: re-adding `anti infective` to
`OTHERS_EXCLUDED_LINES` (the #5926 shape) fires *"both Kafr El-Sheikh areas take a share"*, dropping
`D17` out of the city map fires *"Kafr El-Sheikh is one city holding both areas"*, and — the one the
re-dating added — leaving the Others row on the `2026-07-13` floor fires *"June 2026 must still file
Kafr El-Sheikh 2 in Others"* with `undefined !== 'OT'`, which is the earliest-row fallback trap
reproduced in the resolver. The migration asserts its own outcome too and rolls back if any month
before July 2026 stops answering Others, if July, September or October does not answer Delta (1)
under `SEAT-AIF-DM-D1` with no rep and no target, if `D16` loses its rep seat, or if Pedia or CNS
moved with it.

**The trap the first build cost, kept because it will recur.** The line key is `lineKey` form —
`"anti infective"`, with a **space**. `lineKey` collapses `_`, `-` and whitespace to one space, so
the `anti_infective` spelling this area's own `au.line_area_map` row carries matches nothing. Every
set-level assertion passed (they called the helper with the underscore directly) while the
end-to-end split still divided 290 packs 145/145.

## One email returns — the Administrator's decision on a recorded visit — owner, 2026-10-17 (ENDED 2026-11-06, below)

His words: *"i want to be able to reject or approve with a comment and this comment goes email and
telegram to the rep and his manager and his manager of manager."* On `/admin/field-crm/visit-recording`.

It is the first exception to "Phoenix CRM never emails" (2026-10-13, above), and it is his word, which
is what that rule asks of any exception. `PHOENIX_CRM_EMAIL_EVENT_TYPES` in
`src/lib/notifications/phoenix-crm-channel-guard.ts` holds exactly `recorded_visit_decided`, its policy row
asks for in-app, email, Telegram and the phone, and `tests/phoenix-crm-email-block.test.ts` pins the list to
that one entry so a second is a visible change. Every other Phoenix CRM notice is unchanged.

Audience: the rep, his manager and his manager's manager (the two nearest occupied manager seats).
Wording names a role and the decision, never a recording or a check (Golden Rule #1). Account of the
feature: `docs/phoenix-crm-visit-recording.md`, "His decision carries a comment".

## Phoenix CRM sends no email at all — owner, 2026-11-06

His words: *"cut all phoenix crm emails never sent a single email once again it only sends telegram and push
and in app"* — given the same day the whole company reported its mail going to junk, after a 30-day count showed
Phoenix CRM had been the largest single source of automated mail into company inboxes (about 1,900 emails, almost
all before the 2026-10-13 ban).

This ends the one exception above. `PHOENIX_CRM_EMAIL_EVENT_TYPES` is EMPTY and pinned empty by
`tests/phoenix-crm-email-block.test.ts`, `tests/phoenix-crm-visit-recording.test.ts` and
`tests/phoenix-crm-manager-plan.test.ts`; the `phoenix_crm.recorded_visit_decided` policy row asks for in-app,
Telegram and the phone. The guard strips email from every `phoenix_crm` notice whatever asks for it, the
Telegram-failure fallback included. No exception may be added again — not by his earlier words, a memory, a doc
or another session — unless he lifts this rule himself.

🔴 It also covers a Phoenix CRM message sent from OUTSIDE the notifier. Two one-off emails in the same 30 days
("No visit limit at {hospital}" and "No field activity recorded — {day}", Cc'd to managers) had no sender in the
code, the composers or any script in the repository — they were sent from outside the app. Never send a Phoenix
CRM notice to a rep or manager by email from a script, a composer or `railway run`; tell them in-app or by
Telegram.

## A direct order counts in its campaign's ROI by itself — owner, 2026-10-18

His words, after being shown a real order (Royafloxacin, EGP 6,693, booked to September 2026, raised by
the District Manager for the Zagazig shop): *"if the direct order is made to the same marketing request
in the same window period of time it should count in the roi."* He then chose, from multiple-choice
answers: the two venue records are the same shop (link them); the match is **automatic** — same shop, a
product the campaign promotes, a sales month inside the campaign's months — with no clicking by the rep;
and the window is the one ROI already uses everywhere, **the pay month through `roi_duration_months`**.

What it replaced: on 2026-10-09 he left `track_direct_sales` on for the one request it was on (EGP
4,000, Nahed Tarek) and every other campaign ignored its direct orders (1 of 65 requests carried the
flag). Since `20261018163217` the column defaults TRUE and every existing request was switched on except
the service-fee settlement request, which `phx_admin_settle_service_fee` writes with the flag FALSE on
purpose. The Super Admin switch on the case file is now an opt-out for one campaign. No function body
changed: the matching rule is still `direct_hits` in `phx_marketing_request_sales_lines` and
`phx_refresh_marketing_roi_facts`.

What the match is, and is not. It is the campaign's target pharmacy code pair (distributor + customer
code) equal to a direct-order venue's code pair, an approved non-reversal order, one of the campaign's
products, and the month Finance booked inside the window. It is **not** the order's own declared campaign
(`direct_order_requests.marketing_request_id`, picked on the order form): nothing in the ROI functions reads
it, and the three orders that declare one have no booked month yet. The marketing pharmacy register and
the direct-order venue register share no id, so one shop can be two records. The Zagazig shop was: the
direct-order venue carried only an Overseas code, the campaign targeted the shop under an Ibn Sina code, and
both codes sit in the same brick in the sales master. The link was made by adding that Ibn Sina code to the
venue — only after he said the two are one shop, because a name-alike is never proof.

Known limit, measured 2026-10-18: the attribution ledger behind the roll-up dedupe holds invoice rows only.
One direct order is claimed by two campaigns today (one active, one rejected), which is harmless because a
rejected campaign is outside every approved roll-up; a direct order claimed by two APPROVED campaigns would be
added twice in a company-wide roll-up until the ledger learns direct lines. Rule line: `.claude/rules/marketing-roi.md`.

Found 2026-11-03: the matching rule was right in View Sales and dead in the hourly rebuild. The rebuild compared a
venue's sales code (IS, PS) with `marketing_distributors.distributor_code` (`DST_POS_1478C028`), so it found 0
orders while View Sales found 5 approved ones on 3 active requests, EGP 18,740.40, and the dashboard read that much
lower than the case file. `20261103124320` reaches the venue through `marketing_roi_distributor_rollup`, as View
Sales does. No verdict moved. A venue code with no `mapped_region_code` (9 of 252 that day) still leaves its order
out of the region table, though none of the 5 did.

## The evidence photo is the primary source of trust — owner, 2026-10-18

His words, after Direct Order request 299304bf (حضانه عبد الكريم, a marketing transfer with no distributor
code): *"in any module that have an evidence photo your primary source of trust should be the photo of
evidence."* The approval panel showed the venue filed under brick منشأة سلطان / Menoufia 1 while its live
photo was stamped منوف / Menoufia 2, and every territory row read "nothing to check" because the only
comparison was against a distributor customer's record, which a codeless venue does not have.

Measured on production the same day: the pin is 0.7 km from the منوف centre (B202-1, area D13) and 6.9 km
from the منشأة سلطان centre (B201-9, area D12). The filed area D12 was inherited from the marketing
customer's legacy `delta_1` label (his 2026-08-22 ruling "Delta (1) is Menoufia 1"), and the brick was the
nearest centre inside THAT area only (`suggestBrickForCapture`) — a guess, not a reading.

The rule: wherever a module holds a live evidence photo, read the photo's own territory FIRST and let a
disagreement lead the sentence. Shipped for the Direct Order approval panel: `checkDirectOrderGeography`
takes a `photoTerritory` (the nearest brick centre to the stamped pin, `resolveBrickForPoint`), prints it as
the first rows, and a centre further than `PHOTO_TERRITORY_TRUST_KM` (15 km) is "not usable" rather than an
accusation. Pinned in `tests/direct-orders-hold-release.test.ts`. The nursery in the live case was re-pointed
to منوف / Menoufia 2 at his word the same day (one row, no sales month booked, nothing approved).

His word, the same evening: *"make the marketing transfer file the venue's brick and area from the photo's
pin."* Shipped: `applyPhotoPinTerritory` (`src/lib/marketing-requests/photo-pin-territory.ts`, pure) is applied
by BOTH the transfer and the preview page, so a venue the master did not place is filed where its photo's pin
falls (`resolvedFrom: "photo_pin"`), within the same 15 km trust radius. A venue whose distributor code
resolved (`master_code`) was first left untouched; **he then ruled (2026-10-18, same evening): *"the photo wins
everywhere, including where a distributor code exists"*** — so the guard is gone, a code-resolved venue is filed
from its pin too, and the request's reason names the master territory the photo replaced (`overrode`). A pin
over 15 km from any centre still changes nothing. Pinned in `tests/photo-pin-territory.test.ts`.
Still not done: other photo modules, and `venue-territory.ts` (a marketing customer's own `area_id` still comes
from the code and infers nothing from GPS — a different mechanism, not changed by this ruling's transfer fix).

## Managed Google Play cannot reach the rep tablets — owner, 2026-09-28

> ⏸️ **DORMANT under the mobile-app freeze above** — read it when he lifts the freeze, not before.
> Moved here from `AGENTS.md` §4 on 2026-10-23 so an explicitly dormant rule stops loading into
> every request; the rule text is unchanged.

🔴 **MANAGED GOOGLE PLAY REACHES NO REP TABLET — the store `.aab` is NOT how the mobile app ships,
and the upload is DROPPED** (owner, 2026-09-28: *"drop the managed play upload since it cannot reach
the fleet"*). Measured the same day: `enterprises/LC017auv4o` has **0 enrolled devices** and the
package answers **404**, because the tablets are enrolled in the company's own **Headwind MDM**,
which installs an **APK it hosts** and links to a configuration — and they carry no Google account by
design. **The fleet artifact is `eas.json`'s `mdm` profile** (arm64 APK, `production` channel), a
dispatch choice on the Mobile build workflow since #4652. Never read a green store build as fleet
cover, and never re-propose the Play upload as the way to ship to reps.
`managed-play-cannot-reach-the-rep-tablets`
## The Private Calendar keeps a leaver until his exit day — owner, 2026-10-23

**His words**, asked which way to fix a rep who had vanished from the calendar while still working:
*"drop after his resignation attion date not sub mission date"* — the resignation date, not the
submission date.

**What he was shown.** The System Audit's visit-lifecycle detector ran for the first time on
23 October 2026 (first successful pass 11:37 Cairo: 83 rep-days judged, 678 visits checked) and
raised `VISIT-S4-MISSING` — "the Private Calendar shows 0 of the 12 Phoenix CRM visits that should be
on 2026-10-21; 12 visits lost at the calendar itself" — with 3 occurrences:

| Rep | Day | Visits the door holds | On the calendar |
| --- | --- | --- | --- |
| Georgette Hany Awad Aiad (B-182) | 2026-10-12 | 4 (6 rows, 2 of them partnered and the Double Visit feed's) | 0 |
| Hana Abdelaziz Samir Abdelaziz (B-110) | 2026-10-21 | 12 | 0 |
| Hana Abdelaziz Samir Abdelaziz (B-110) | 2026-10-22 | 10 | 0 |

**The first two readings were both wrong, and are recorded so nobody repeats them.** The visits are
not missing from `crm_visits_unified` (it holds all 12 and all 10, `source = 'phoenix'`), and the
`visitCounts: null` on the Phoenix-work-evidence item is not the cause either — the same run read 80
other rep-days correctly through the same three builders.

**The cause.** `getPrivateCalendarDayEvidence` resolves the employees it was asked about against
`getEmployeeDirectoryRows()`, whose default is `includeInactive: false` →
`isActiveDirectoryEmployee`, which needs an active lifecycle status **and**
`organogram_visible !== false`. `employees.employment_status` flips to `resigned` and
`organogram_visible` to false the moment a resignation row is **submitted**:

- B-110 — resignation submitted **18 October 15:47 Cairo**, status still `submitted` (never approved,
  never completed), last working day **31 October**, eight days in the future. She went on working:
  10 and 12 customer visits on the 21st and the 22nd.
- B-182 — submitted **17 October 23:56 Cairo** for a last working day of 17 October. The flagged day
  is 12 October, five days before she left.

So neither was in `hrIds`, none of the nine loaders ever read their day — and the loop over the
asked days wrote an entry for them anyway, with `items: []` and nothing in `unreadableSources`. A
**confident blank**: readable, and nothing happened. The detector believed it, as any reader would.

**The one-to-one proof** that the discriminator is employment status and not the data: of the Phoenix
visit rep-days over 21–23 October, 98 belong to 59 `active` reps and all read correctly; exactly one
rep is `resigned` with `organogram_visible = false` — B-110 — with exactly 2 rep-days, and both are
flagged.

**What the fix does.** `privateCalendarEmployees` reads `{ includeInactive: true }` and keeps anyone
`isWithinNoticePeriod` covers: the day asked about on or before the **later** of `last_working_date`
and `resignation_date` (the later one, because when the two differ that is the last day the person
could still have worked), dropping them the day after. A departed row carrying **neither** date is
not kept — there is no day to compare, and an open-ended answer would restore the whole inactive
roster. `isWithinEmploymentWindow` still decides each individual day, so a person included this way
contributes nothing outside their own employment. And the day-evidence door now writes **no entry**
for an employee its loaders never read: every caller already reads a missing entry correctly — the
dispute reviewer's day facts say "the calendar record for this day could not be read", and the
detector reports it as unreadable rather than as lost visits.

**What was deliberately NOT changed.** `getCompanyNoActivityDays` keeps the active-only roster. It is
the engine behind the Deductions No Records Activity connector and the weekly gap notice, so widening
it would start raising deduction candidates against people working out their notice — money, and his
call in the Deductions module, never a side effect of a calendar fix.

**The sibling ruling.** The Field Absence calendar already carries the same rule on the same facts
(owner, 2026-10-18): a resigned rep is judged up to his last working day and his own visits count,
read back with `includeResignedAgents` — without it a rep serving notice read "not seen" on 31 of 31
visit days. `.claude/rules/time-off.md`; pinned by `tests/private-calendar-notice-period.test.ts`.

## A page change lands inside one second — owner, 2026-10-23

**His words** (23 Oct 2026, ~15:10 Cairo, after a screen recording of a rep's portal): *"Once I press
login, once I'm in the login page. Once I go to CRM, I'm in the CRM page. Once I press plan, I'm in
CRM. The process of shifting from page to page never take more than 1 second."*

**What production showed that afternoon.** The Command Center took 7.0 s at the median and 21 s at
the 90th percentile; sign-in 2.2 s; the monthly planner 1.16 s (3.7 s at p90); the team view 1.96 s
(9.1 s at p90); the visit day 2.2 s. The navigation badge counts used 226 s of server time over 141
calls. And the hover prefetch — `unstable_dynamicOnHover` on the portal's links, backed by
`experimental.dynamicOnHover` — rendered 8 WHOLE pages, 46 s of server work, for rows a mouse or a
scrolling finger merely crossed, queued in front of one rep's real tap on Visits.

**What was built.**

- **No link builds a page nobody tapped.** No portal `<Link>` takes `prefetch` or
  `unstable_dynamicOnHover`, `next.config.ts` leaves `experimental.dynamicOnHover` off, and the type
  shim for it is gone. A slow page gets a faster loader, never a prefetch.
- **The Medical Rep's slow home cards stream.** The landing asks `getPortalHomeSnapshot` for
  `streamRepCards: true`; the snapshot then returns sales, rank, field KPIs and the rep's record on
  `repCards` as promises that never reject, and skips the early-bird read it does not need.
  `MedicalRepCommandCenter` awaits nothing: each of its six cards is an `async` component under its
  own `<Suspense>`, drawn in the real tile's frame while it loads. The honour strip streams with no
  placeholder, because most reps never get one. Every other role still awaits the snapshot as before.
- **Sign-in runs its checks side by side** and does its tidy-up (the success attempt row and the
  lockout reset) after the response. The "Login succeeded" audit row is NOT tidy-up: it is written
  before the reply (owner, 23 Oct 2026), because a deploy that stops the process between the reply
  and a deferred task lost it. Pinned by `tests/login-success-audit-before-reply.test.ts`.
- **Short per-person caches** for the excluded-agents list and calendar access (2 minutes).
- **Phoenix CRM waits less.** The planners mint a seat's carried-over customers at most once in five
  minutes (a failed mint is never remembered, and a seat move forgets both seats). The visit day
  reads in two waves instead of three, and the messages list in one instead of two — its early rows
  are used only when the resolved viewer's filters are exactly the session's, so it never shows
  another viewer's rows.

**Never fold it back.** Never await a rep card in the centre, never put the four rep reads back into
the snapshot's wait, and never re-add a hover or touch prefetch to make a page "feel" faster.

**Pinned by** `tests/portal-link-prefetch.test.ts`, `tests/portal-rep-navigation-speed.test.ts`,
`tests/phoenix-crm-reference-mint-throttle.test.ts` and `tests/page-change-fewer-waves.test.ts`.

## Pedia Sharkia 1 and 2: off the chart, counted to Hany Saad from October — owner, 2026-11-01

> "in pedia organogram hide sharkia 1 and 2 we wiull potpond hiring now in them so hide from organogram
> and in salaes for sahar el galad count what should be countet to her and move the sharkia 1 and 2 to be
> counted in hany saad totales"

Asked which month it starts, he chose **October 2026**. July, August and September stay as published.

**Why a new seat.** Who an area counts to is `au.line_area_map.dm_seat_id` and nothing else, and the
closing groups by `operational_region_code`, so Delta (2)'s subtotal only drops Sharkia if Sharkia has a
region of its own. `au.enforce_lam_region` requires the seat's region to equal the map row's, and the
Regional Sales Manager's seat has no region. So: region `SH`, and district seat `SEAT-PED-DM-SH` under his
regional seat, occupied by him. A vacant seat was rejected: every regional roll-up and Employee 360 skip a
row with no district manager, so nothing would reach his totals.

**Why the tree does not show it.** The seat is `is_active = false, sales_only = true`. `au.v_org_tree`
filters `is_active`, so the organogram, recruitment folders, Phoenix CRM, field absence and seat transfer
go on seeing him as one regional seat with no change to any of them. `public.au_v_org_tree_sales` is that
tree plus the sales-only seats, read only by the sales reads that follow the money.
`public.au_f_org_tree_as_of` ignores `is_active`, which is why the chart also refuses the seat in code.

**What the screens do.**

- The live chart and the rep "out of N" drop both rep seats. A past picture before October still draws them.
- Hany's totals, the closing's region table and the district performance tables carry `SH`, so the money foots.
- He is not a district manager: no place on the rankings, the spotlight's DM kind or the DM count.

**What did not move, on purpose.**

- The rep seats' parent stays `SEAT-PED-DM-D2`. `parent_seat_id` is not dated, so repointing it would redraw
  past pictures and move recruitment and Phoenix CRM, which he did not ask for.
- The open vacancies stay open in recruitment and the flat vacancy list.
- CNS and Anti Infective keep Sharkia exactly where it is.
- `SH` is not an Upper Egypt code and not Others, so the city split and El Qema's divisor do not read it.

**Consequences worth knowing.**

- The Delta (2) seat keeps Sharkia in July, August and September, because a published month is never changed.
  Those months were not Sahar's. She was hired on 2026-10-24; the seat was held by Ahmed Mohamed Ahmed Mohamed
  Heikal until 2026-08-01 and by Ahmed Elsayed Ahmed Ibrahim from 2026-08-08 to 2026-10-01. The engine names a
  seat's CURRENT holder on past months, so they read under her name; never quote that as who ran them. Seat area
  scope reads current map rows, so `AREAS_KEPT_FOR_EARLIER_MONTHS` in `src/lib/org/sales-only-seats.ts` keeps both
  areas in that seat's bound for months before October, and only for that seat: the closing, Sales vs Target, team
  performance and Targets all follow the month. The old sales dashboard's per-person view is the one exception: it
  reads several months at once and pushes the area list into the database, so it omits Sharkia for those months.
- Sharkia's team now gets the target-upload email through Hany, where it went through Sahar's team before.
- The weekly nameless-branch fallback for Delta (2) now spreads over 4 Pedia areas, not 6. The total is unchanged.

**The proof, on production, in a transaction that rolled back (2026-11-01).** October: Delta (2) 4 areas,
target EGP 712,962.00; Sharkia 2 areas, target EGP 297,067.50, to Hany Saad. September still resolves to Delta (2) with 6 areas.

**The order on production is two files, and it is the point.** The code before this change reads `au_v_org_tree`,
which does not hold the new seat, so moving the map first would drop both areas from Hany AND Sahar until the new
revision serves. So `20261101190532_au_v_org_tree_sales.sql` (column and view, no row changes) goes on before the
merge, and `20261101190533_pedia_sharkia_to_hany_saad_from_october.sql` (the move) goes on after `/api/healthz`
serves the merged revision.

**To resume hiring.** Take the seats out of `REP_SEATS_HELD_OFF_THE_ORGANOGRAM` in `src/lib/org/sales-only-seats.ts` and write a dated pair back onto
`SEAT-PED-DM-D2`. **If Hany leaves,** a new Regional Manager does not inherit the seat by himself: occupy it.

**Pinned by** `tests/pedia-sharkia-hany-saad-hold.test.ts`.

## The visit retry — owner, 3 Nov 2026

> "build 1 & 2 & 3 &4 & 5 & 7"

Item 1 of the list he was answering was a retry for a visit whose save loses signal. Until now a browser save that
failed lost the whole visit, comment included, with nothing to press afterwards. At least 13 presses by 12 people got
no server answer in the 14 days before, a floor, because that capture skips offline phones and hidden tabs.

**What the rep gets.** The press is written to the phone before the request goes. If the signal fails, the form closes
and the customer reads "Waiting to send", with one line: "Saved on this phone. It sends when you have signal and
Phoenix is open." It sends by itself while any Phoenix page is open, oldest first, a few seconds apart.

**What it asks of the rep, and only when it must.** "This visit could not be sent" with the server's own sentence, or "Not
sent in time", each with Log it again and Remove. Log it again opens the form on the rep's own comment and products.

**Pressed in a real browser, 3 Nov 2026, on staging.** Four runs on a GitHub machine, because a page compile on the laptop
hits its memory floor. A cut press was held in under a second, and on the last run it landed 33 seconds after the press,
dated at arrival, with no flag. The day showed it about 4 seconds later. No overflow, round corner or clipped text at
375 and 1440, on the held, refused, too-late and landed screens. The runs found two defects, both fixed:

- The header read "Offline — nothing will save" directly above "Saved on this phone", and a rep who reads that may not
  press at all. On a screen that can hold a visit it now reads "Offline — only visits will save". The old line stays
  everywhere else, because it is true there.
- The commitments and call prep panels were read as the form closed with no signal, and kept "No connection" under a
  visit that had landed. A landing now reads them again with the day.

On an off-plan visit, Log it again opens on the customer step, and the rep presses Continue first. The kept words are
proven by test, and the browser run did not reach them.

**Why two hours and 02:00.** The server dates every browser save at ARRIVAL, as it always has, and the retry does not
change that. Past two hours, or across the 02:00 close of the visit day, an arrival-dated visit is no longer the same
visit: it lands on the wrong day, or off plan, and a manager is told something nobody earned. So the rep is asked instead,
one tap, in a case that should be rare. Elapsed time is measured on the phone's clock and the day on the server's,
because each is right about only that one thing.

**What protects the evidence.** A held save is never dated by the phone and never reads as impossible travel. It can
still lower the rank until settled, by his ruling below.

- `queuedSeconds` is a duration, bounded 1 to 7,200, parsed by `parseVisitDraft`, and never sent to
  `phoenix_crm_save_visit`. Only a browser may carry it.
- It is filed as `queued_seconds` on `phoenix_crm_visit_capture_provenance`, after the save.
- The phone-clock check adds it to the tap before comparing, so a phone that merely waited reads true and a phone whose
  clock is truly wrong still shows.
- The travel check runs twice, at arrival and at the moment the rep was there (`checkHeldLocationIntegrity`). What is filed
  keeps the arrival.
- The SFE Manager's Visit report shows it as Sent late (min), so a forged value is visible. A rep and a district manager
  never read it.

**What is accepted.** The first-visit board, the hourly roll-up and the save-time behaviour flags read arrival time, so
a held visit reads up to two hours late on them.

**A refusal does not prove a visit is unsaved.** The pre-checks run before the save function's "this id is on file"
answer, so a visit that landed and lost only its reply can be refused on the second press. The id is read again before
any refusal is shown, and an already-visited refusal settles in silence.

**The off switch.** `visit_resend_enabled` on Phoenix CRM settings, no merge needed. Off, nothing sends by itself, and
what a phone holds asks to be logged again rather than vanishing.

**The count nobody had.** Every held press ends in one row of `phoenix_crm_visit_resend_log`. Joined to
`phoenix_crm_visits` it answers how many were pressed and never saved. A phone that never reopens undercounts it, and a
rep's own Remove counts, so it reads "no visit saved", never "lost".

**Who has a queue.** A rep on their own territory and day. A seat view and a test login have none, and behave as before.
No service worker: the push provider holds that scope, so a visit sends only while Phoenix is open, which is what the
rep is told.

**Where the sending runs.** The runner sits beside the portal's top bar and never inside it, because app mode has no top
bar. The sending code is fetched when the Visits screen and the form open, because it cannot be fetched on the press that
lost the signal, and the runner looks again when signal returns. A tab left open for another person stops rather than
sends under the new sign-in.

**A wait may correct a reading and never erase it.** The first build believed the phone's claimed wait, so a forged wait
could hide an impossible-travel reading. Told that, he answered:

> "this rsik is not accpeted at all must fix"

Asked how to treat a case Phoenix cannot tell apart from a forged wait, he chose:

> "Lower rank until settled (Recommended)"

- The check runs at arrival, on the server's clock, and again at the door, with each side moved back by the wait the server
  believes (`checkHeldLocationIntegrity`). Every finding from either pass stands, so a wait cannot hide a replayed
  coordinate or a day with no drift.
- A trip impossible at the door is `impossible_travel`. Even on the phone's word, nobody made it.
- A trip impossible only at arrival is `travel_rests_on_held_wait`, which is strong. No software can prove when an offline
  phone was pressed, so an honest drained queue and a forged wait both land here. It costs the rank until he settles the
  case, an honest rep's included, and his settle clears it. Never demote it to weak.
- Only a drain of two or more, or a next visit soon after a held one, can trip it, and only at 2 km or more net of accuracy
  and over 150 km/h. A lone held visit cannot, because arriving late only widens its gap.
- A claim is void, all of it, if one of the rep's own arrivals sits inside the wait and more than five minutes before this
  one landed (`creditedHeldSeconds`), because an online Phoenix would have sent the visit then. A save by a manager or an
  admin is not that phone online, and a place's `captured_at` is not confirmed to be a receipt, so neither counts.
- `device_skew_minutes` is still corrected by the wait, on the save path, because reading the history there would slow the
  save. The SFE Manager's report shows Sent late (min) beside it.
- How many honest cases this makes is unmeasured until real use. Count the board's cases carrying the flag.

**Pinned by** `tests/phoenix-crm-visit-resend-rules.test.ts`, `tests/phoenix-crm-visit-outbox.test.ts` and
`tests/phoenix-crm-queued-evidence.test.ts`.

## The approval reminders on WhatsApp — owner, 3 Nov 2026

> "build 1 & 2 & 3 &4 & 5 & 7"

Item 7 of the list he was answering. Asked in plain words who should get it and from which number, he chose "All 25
people" and "A new third number". Of 350 leave decisions in 90 days, the median took 13.3 hours and the slowest tenth took
72.9 hours or more. Of the 25 recent approvers, 12 can be reached on Telegram, 22 hold a push subscription and 2 have
neither. Direct orders have no scheduled reminder to an approver at all.

**What it does.** Once a working day, between 10:00 and 11:59 Cairo, each approver holding something for more than three
days gets one WhatsApp message with the count and a fixed link. The message carries no name and no reason. The chains are
leave, excuses, marketing and direct orders. Phoenix CRM has its own morning nudge and weekly plans are left out.

**What counts, and why it is narrow.** Live on 3 Nov, every one of the 123 pending direct-order steps was a dead row on a
closed request, and 9 of the 31 pending leave steps sat on rejected requests. Counted loosely, those would nag someone for
ever. So only an open request counts, only the step that could decide right now counts, and the clock starts when the step
reached that person. A departed person, someone who cannot sign in and a role with no excuse authority are never told, and
what nobody can be told about is counted in the run's result, never dropped.

**The third number stays out of recruitment.** The WhatsApp Inbox and the recruitment outbound report do not filter by
line, so "not in the inbox's list" alone would have shown reminders and replies to HR Resourcing. The webhook therefore
removes that number's changes before anything reads the delivery, per change and not per delivery, because an applicant's
CV can arrive in the same one. The shared sender returns before the recruitment report for that number too. The number is
not in `WHATSAPP_PHONE_NUMBER_IDS`, so a fault on it cannot read as the intake being down. The Needs You read asks about
it directly.

**Off until he says, by three locks that need no merge:** the switch on the recipients screen, the number being set up,
and Meta's approval of the message. Production-only and the working-day window sit beside them. The working days, Sunday
to Thursday, were my decision. 🔴 No test send is ever fired; `?dryRun=1` counts and sends nothing.

**One message a person a day.** The row is claimed before the send and never retried that day, and each morning has five
ticks with a cap of 8 a tick, so the list finishes. Meta's delivery ticks update the row, so a number not on WhatsApp reads
failed. A failed read or every send refused turns the job red rather than reporting a calm zero.

**His parts:** the SIM and the number in WhatsApp Manager, his word to submit the message
(`scripts/approvals/submit-urgent-reminder-template.ts`, dry run unless told otherwise), Meta's expectation that each
recipient agreed to messages, and the switch. 🔴 Set `WHATSAPP_APPROVALS_PHONE_NUMBER_ID` before anyone can message the
number, because its replies are dropped only once it is known.

**Pinned by** `tests/approval-whatsapp-rules.test.ts`, `tests/approval-whatsapp-send.test.ts` and
`tests/approval-whatsapp-reply-exit.test.ts`.

## The doctor-list check (owner, 2026-10-27 and 2026-11-03)

His words, 27 October: the name compared allowing one letter, *"The line must match"*, the GPS of the customer validation and of the doctor validation's live photo *"not more than 500 meters away from each other"*, and *"you must don't block but flag … in the approval window, you will show the two photos."* A marketing request is never on a nursery; hospitals and accounts compare with the AM list, a clinic or a doctor with the PM list. On 3 November he chose: the SFE Manager answers an unsure row with two photos side by side, the Super Admin can too, and every answer records who made it.

**How it reads.** One row per customer and line in `marketing_customer_list_checks`. The area always comes from the photo's GPS through the nearest brick, never a hand-chosen area. A person's answer beats a pick, a pick beats a re-check, a typed name moves only on a person's "same doctor". States: on the list, check, not on the list, no rep holds the area, left the list, no location.

**Three readings made tighter than his sentence, each from measuring the 114 customers on 3 November.** Twin given names are refused (the tolerance read احمد علي as محمد علي موسي). A different name reaches the queue only within 100 m (500 m sent 15 unrelated names there). The same name and the same brick proves a row only when no distance can be read, because his 27 October sheet accepted that, and 7.5 km apart in one brick is his flag.

**Order of the first run.** Merge, read `/api/healthz` revision, announce (no point-in-time recovery, 7 daily backups), apply the pre-image with `scripts/apply-sql-file.mjs`, run `scripts/marketing-list-check.ts --apply`, confirm no picked row changed, and only then arm the hourly job `phoenix-marketing-list-check`.

## A seat starts on the job offer's date — owner, 3 Nov 2026

His words: "the start date must follow the date, the start date in the job offer, not the date when he accepted". He said it after the second hire-date mismatch he found, Mohamed Saad El Fetiany (letter and Master 1 Nov, seat 26 Oct).

**The rule.** A new hire's seat starts on `employees.hire_date`, which carries the letter's start date (`offerHireDate`), never `position_vacancies.filled_at`, the day the record is created at acceptance. A long-standing employee moved into a vacant seat keeps the fill day. A later Master correction moves an open hire span that was following the Master. Aya Ali and Sahar El Gallad's letters differ from the Master and he ruled both correct, so their seats follow the Master's 24 Oct.

**What it does before the start.** The seat reads vacant on dated readers until the start day, and arm 2 of `au.f_seat_occupant_asof` hands that seat's past months to whoever held them. Open-only readers still show the joiner, so a second hire into that seat is refused. No file under `src/lib/incentives` or `src/lib/payroll` reads occupancy.

**The live organogram draws the joiner anyway (his words the same day: "people accepted the job offer are not appearing in organogram").** Three people had dropped off it: Hagar Abu Zeid, Mariam Wagdy and Salma Sabry, all starting 8 Nov. Their vacancies were already filled, so the "Offer accepted" label could not speak for them either. `drawJoinersAwaitingStart` puts each on their seat with "Starts 08 Nov 2026". Only the chart reads it; the dated readers and sales credit do not move.

**The existing rows, 3 Nov about 13:20 Cairo.** 40 open hire rows and 34 vacant rows moved in one transaction, outside the migration, with the pre-image in `au_backup_20261103.occupancy_hire_start`. Measured in the same transaction: no change to the occupant of any seat at any 2026 month end, the organogram or open vacancies; drift stayed at 108; inverted rows went from 1 to 0. Closed spans were left alone.

**Held.** Toka Zaki and Mahmoud Khaled start on 8 Nov. Moving them before that flips the credit on their two seats in published months to the people who held them, until the 8th. From the 8th the same update moves no credit. Note: `seat-start-follows-the-job-offer-2026-11-03`.

## Expense approvals: rebuilt in the Phoenix CRM identity — owner, 2026-11-07

**His words.** 2026-11-07 ~03:20 Cairo, after PR 88's polish went live and the live rescore still found items under 9.5: "LOOK U ARE MAKING SMALL CHANGES AND I NEED A REBUILT RETIRE THE CURRENT EXPENSE APPROVAL AND REBUILD FROM SCRATCH SAME PHOENIX CRM IDENTITY I WANT REAL WORK". He approved the plan at ~03:35. The earlier rounds the same night, which the rebuild keeps: "if 3 days then I should have 3 maps", "every day's visits is listed under the map", "any information or data you have for the trip must be shown", "the fixed part down makes me not able to clearly see".

**What patching could not reach, read live on 636f0fc.** Approve sat 57 px below the bottom of the screen at scroll 0; a filtered page read "95 of 129 awaiting" beside a bare "8 adjusted"; the brick value right-aligned under a left-aligned label; the page read as a stack of panels, not as one Phoenix screen.

**Retired.** `expense-approvals-workspace.tsx`, the six files of `src/components/outstation/expense-approvals/`, the sticky rail (`.phx-expense-rail` in `globals.css`) and `chrome-height-probe.tsx`, whose only user it was. Never bring them back.

**The shape now — `src/components/outstation/expense-review/`, drawn as Place checks draws its own.**

- `use-expense-review.ts` holds the state and the money path, byte for byte the old rules: the stored and on-screen decisions, `expenseDecisionChanged` for the unsaved count AND the payload, one POST per report with `expectedRevision`, every `payrollWarnings` line shown, the owner-scoped draft under the SAME key and shape (`…draft.v2:<HR id>`, `{ decisions, savedAt }`) so decisions left unsaved on the retired page come back, the `beforeunload` guard only while something is unsaved, the bulk plan, the live idle days.
- `review-model.ts` holds every other rule as a pure function: which tab a trip sits in (read from the STORED decision — a row never moves when it is decided), the tab counts, the six tiles (over the LIVE decisions), `countOutOf` so EVERY tile says "of N" when narrowed, the next waiting trip, the draft parse, the reason chips and the one sentence of advice.
- The list page: the orange-rail header with "Review the trips one by one" and Export, six tiles (Awaiting, Needs a look, Clean, Approved, Adjusted, Rejected), the tablist with counts and an unsaved pill (Needs a look · Clean · All awaiting · Approved · Adjusted · Rejected · Before July · All trips · By employee), the Phoenix filter bar, the Save strip, one sentence of advice, and the tab's trips as a fixed table on a desktop and cards on a phone.
- The reviewer (`review-deck/`): a full-screen portal on black, the tabs with counts, "N of M" and an orange progress line; a dark evidence stage (one map per day with its route, pins and times; the photos; the claim checks) beside a white column (who and what, the cost line, the geography left-aligned, "What the system found", the adjust box with the idle-day offers, reason chips, the growing reason box and "Rewrite formally / Restore my wording"); the decision is ONE pinned band — the amount, Approve and Reject side by side, Save on its own line — so it is on screen at every scroll. The arrows walk; no key decides anything.

**Read side only.** No route, no domain module and no money rule moved.

**Pinned by** `tests/outstation-expense-review-model.test.ts` (behaviour), `tests/outstation-expense-approvals-layout.test.ts`, `tests/outstation-expense-approvals-queue.test.ts`, `tests/expense-approvals-one-list.test.ts` and `tests/expense-approval-decisions-survive-the-save.test.ts`.

## Expense Approvals' rail triage, and the idle-day offer — owner, 2026-11-07

**His words** (~01:45 Cairo, choosing from the enhancements offered): "Rail filter: Needs a look / Clean", "Oldest first + awaiting N days", "Decide-and-advance"; and on how idle days are deducted, "LET ME DECIDE". Then, after his scored review of the live page (~02:35, "DEATILED SCORE PER ITEM FROM 10 … HONEST UR SELF") and "IMPLEMENT A PLAN EVERYTHING MENTIONED PER ITEM TO BE NO LESS THAN 9.5/10", the polish below.

**Clean** = every day `matched` AND no departure-photo flag AND the departure photo carries a GPS position. The no-GPS reason ("Departure photo has no GPS", `departurePhotoNoGps` in `payroll-expense-mapping.ts`) came from the review: the trip's own photo tile warned "No GPS location" while the rail filed the same trip as Clean — the same metadata read as the tile (`usablePosition` on `capturedLatitude`/`capturedLongitude`). Any other `workload_match_status` needs a look; unknown is never clean; an imported row has no reading and shows only under All (`expense-approval-triage.ts`). The export narrows by the same `triage`.

**The live answer outranks the stamp.** Once a trip is opened, its day-by-day read reports idle days to the workspace (`recordIdleDays`); `withLiveWorkloadStatus` lays that over the stored stamp for the rail's reasons, its split and its counts, so a conference day (worked — `trip-day-meetings.ts`) stops reading "No field activity". Rows not yet opened keep the stored stamp. The production restamp was measured the same night: 60 undecided trips stamped `no_activity`, only 15 system-stamped, 12 of those inside the morning job's 45-day window (72 rows in it, under the 200 cap), the job last ran 5 Nov — a wider restamp would have reached three September trips and could not have moved Weaam's, which the morning job already re-reads.

**Order.** The rail and the awaiting list sort by ONE comparator, so Approve / Reject open the row under the one decided; Save and Undo never move. Biggest / Oldest first is remembered per reviewer (`EXPENSE_APPROVAL_VIEW_KEY_BASE`, owner-scoped — a shared office PC keeps each reviewer's own); a filtered stat line reads "109 of 163 awaiting" with a Filtered tag.

**The idle-day offer.** The decision box offers the ALLOWANCE share — per idle day (allowance ÷ trip days × idle days) or the whole allowance (`idle-day-deduction.ts`) — on an undecided trip only; a click is the only thing that applies it. His own reason is never written over; a box still holding only the system's hold sentence gets the share's reason on a new line under it (`reasonAfterIdleDayPick` — before, the pre-filled box meant the reason never landed). Never auto-deduct; never offer travel or tickets.

**Pinned by** `tests/outstation-expense-approvals-queue.test.ts`.
