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
  required CI `validate` check — pins both the arithmetic and the fact that the publish path
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

### Still open

The Source of Sales dashboard's distributor breakdown and the import batches list were not covered by
this change. The batches list is Super Admin only already; the dashboard breakdown has not been
checked and may still name El Qema.

## The priority ladder — owner ruling, 2026-09-09 (CURRENT, and it replaced everything)

This is the live El Qema rule. Every El Qema section below it is history.

> what I want is that the qalubeya be qalubeya, then the Monofiua and the gharbia one and two, okay,
> then cairo, then any rearrangement after this. But I don't want the areas I mentioned to be far
> away from the others — I want them to be exceeding them, but with a very small scale.

El Qema's whole Pedia book is divided across every area the line has. Four named rungs take one 2%
step more each, in his order.

| Rung | Areas | Weight | August packs each |
| --- | --- | --- | --- |
| Qalubeya | 1 | 1.08 | 253.33 |
| Menoufia 1, Menoufia 2 | 2 | 1.06 | 248.64 |
| Gharbia 1, Gharbia 2 | 2 | 1.04 | 243.95 |
| Cairo | 5 | 1.02 | 239.26 |
| Everyone else | 27 | 1.00 | 234.56 |

The arithmetic is one division. The 37 weights add to 37.38, and 8,768 over 37.38 is 234.56, which
is one unit of weight. Top to bottom is 18.77 packs, which is what "a very small scale" bought.

### What it discarded, and why none of it is a bug

Five rules, all of them his, all made in the two days before it:

| Rule | Given | Gone because |
| --- | --- | --- |
| Up to 200 stays in the governorate | 09-08 | the ladder has no governorate and no threshold |
| 201–999 splits half and half | 09-08 | same |
| 1,000 and above spreads flat | 09-09 | same |
| Upper Egypt pooled with Fayoum - Beni Suef | 09-09 | the ladder levels everything already |
| Qalubeya + Cairo, weighted 75/25 | 09-07, 09-09 | Cairo is now a rung, not a block |

🔴 **A session finding any of these missing is looking at a decision.** They are dense, they
were each argued for, and each has its own measured account in this file. Restoring one reverses him.

### The two things a reader disbelieves

**Where a warehouse sits decides nothing.** Benha sold 6,656 of August's 8,768 packs and takes
253.33, exactly what it would take if it had sold none. The only reason it leads the table is that
it is on the top rung. The El Qema test asserts this twice, from two directions, because
reintroducing an origin preference is the obvious "fix".

**Others keep nothing, including their own sales.** Every earlier rule let an area in Others keep
what it sold itself, because a home half had to land somewhere. There is no home half. On August
that moves Ismailia's own 24 packs out, and he asked for exactly that: *"neglect others, don't add
others"*.

### Where the numbers live

`QEMA_PRIORITY_RUNGS` and `QEMA_PRIORITY_STEP` in `src/lib/sales/store-sales-city-split.ts`. The step
is the only dial: at 2% each rung is 4.69 packs above the next, at 5% about 12. Cairo is listed with
all six codes and Down town drops out through the Others exclusion, so moving it in the organogram
rejoins it without a code change.

## The unified distribution (نظام توزيع القمه الموحد) — owner ruling, 2026-09-09 (SUPERSEDED the same day)

🔴 **Replaced by the priority ladder above, hours later.** Kept as a dated record of what the three bands were and why, because the ladder's own documentation refers back to them.

This is the live rule. Everything below it in this file is the history that led here, kept dated and
unrewritten; where the two disagree, this section wins.

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
| 2 | 201 to 999 | half the local block, half evenly over the rest of the country |
| 3 | 1,000 and above | flat: every area in play takes an identical share, origin included |

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

## 🔒 The weekly attendance digest is silent, passive and private — owner ruling, 2026-09-08

Asked directly, after being shown what each option cost, and answered in one line:

> "no one is notified, silence means nothing, only me sees it"

Three rules, and all three were built the OTHER way earlier the same day and removed on his
instruction. A session reading git history will find a 48-hour auto-confirm, a three-channel
notifier and a portal nav row: **those are reversed decisions, not unfinished ones.**

### 1. It notifies nobody, in any channel

Not the employee, not a reviewer, not the owner. `src/lib/attendance/digest-notify.ts` is
**deleted** and the `channel_in_app` / `channel_telegram` / `channel_email` columns are **absent
from `attendance_digest_settings`** — dropped by
`20260908163000_weekly_digest_silent_and_unpriced_days.sql`.

That shape is deliberate: a switched-off sender is one edit away from sending, while restoring
this one takes a migration *and* a module. Verified 2026-09-08: **0 channel columns, and 0
`attendance%digest%` notification events since the original module died on 2026-07-22.**

The earlier build had all three channels ON at his own instruction that morning. It was live for
two minutes and sent nothing, only because no scheduler existed yet.

### 2. Silence settles nothing

There is no auto-confirm. `auto_confirm_hours` is gone from the settings table and
`auto_confirmed` is **not a permitted value** of `attendance_digest_lines.action` or
`attendance_settlements.action` — the check constraints refuse it.

An unanswered day writes **no settlement**, never reaches `digest-bridge.ts`, and arrives in the
month-end Deductions queue as **Pending**, exactly where it would have been if the module did not
exist. The reasoning is not squeamishness: **a response window can only run against someone who
was told it had started**, and rule 1 means nobody is told. Silence from a person who was never
asked cannot be read as agreement.

### 3. Only he may open it

`canOpenDigestPortal` (`src/lib/attendance/digest-service.ts`) admits Super Admin or a name in
`dispute_reviewer_hr_ids` — currently `B-10` alone, which is the owner himself. It is asked by
**four** surfaces, not one: the portal page, `GET /api/attendance/digests`, and both the confirm
and dispute routes. Confirm is the one that matters most, because a confirmation is what turns a
flagged day into an approved deduction.

Every one fails **closed**: a lookup that throws means *not verifiably allowed*, never *let them
in*. `tests/attendance-weekly-digest.test.ts` asserts all four ask the gate and all four fail
closed; removing it from the dispute route alone turns the suite red naming that file.

The portal nav row was removed separately (#3520) — but **hiding a nav row is UX only**, and the
page answered by direct URL until the gate shipped (#3525).

### What is NOT forbidden

The module still generates a digest every week and still applies a confirmed day to its month-end
candidate. What is forbidden is **telling anyone, timing them out, or showing it to them**.

### Why this is not a hook in AGENTS.md

Measured on 2026-09-08: `CLAUDE.md + AGENTS.md` stood at **125,587 bytes against a 125,600-byte
ceiling — 3 bytes of headroom.** A 1,145-byte hook took it 1,142 bytes over and turned
`the-whole-auto-loaded-footprint-is-budgeted` red. The rule lives here instead, which costs
nothing per request, and it is enforced **mechanically** rather than by memory: a dropped column,
two check constraints, a gate and a test. A session cannot rebuild any of the three without
hitting a constraint or a red suite first.

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

El Qema's priority ladder spreads that distributor's whole Pedia book across every area the line has except those parked in Others, and the exclusion keys on `operational_region_code = 'OT'` **alone** — never on `area_state`, never on `carries_target`. Qena 2 and Luxor leave Others here, so:

| El Qema divisor, Pedia | Areas |
| --- | --- |
| August | 37 |
| September | 39 |

**Luxor still takes a share even though it carries no target**, because the ladder counts areas and not reps. That is not a defect. It is the same shape OT9 Ismailia rode into Delta (3) with: `other_permanent`, no rep seat, inside a real district.

### The seat caveat, which cannot be dated away

`au.seats` has `seat_id` alone as its primary key, so a seat **cannot** be forward-dated the way a map row can. The four new seats carry `effective_from = 2026-09-01`, but re-pointing the existing Upper Egypt rep seats to their new district happens the moment the migration is applied. That is chart metadata only — every number the closing produces comes from `au.line_area_map`, which is dated. Do not "fix" this by writing a second seat row; the primary key forbids it.

⚠ When he adds the two district managers, an `employees` insert auto-seats them and flips `line_area_map.area_state`, which is hashed into the attribution fingerprint. **Re-stamp after the hires.**

### Two things found on the way, neither fixed

- The `runTest` label for `runQemaWarehouseSplitTests` still describes the 200 and 1,000 pack bands that #3583 deleted. The test itself pins the ladder; only its name is stale.
- `buildOperationalRegionMap` resolves overlapping rows to the **latest** `effective_from`; `au.f_line_area_map_asof` orders `effective_from asc` and so takes the **earliest**. The TypeScript comment claims the two match. No overlap is written by this migration, so nothing here depends on it, but they disagree and a future overlapping pair would resolve differently in the sheet and in achievement.

### How it is held

`tests/pedia-upper-egypt-split.test.ts`, in the required CI `validate` job. Its headline assertion is the golden rule itself: August's El Qema distribution built **with** the September rows present is `deepEqual` to August's built **without** them. Proved red by dating the pair to 2026-08-01, the real failure mode.
