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
  2026-08-26). And the Weekly **Summarized Report's layout and scope are LOCKED**, learned over many
  rejected iterations — do not restyle it.
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
- 🔴 **The mailbox-monitor app-password entry is `___`, never "Phoenix".** Owner rule 2026-08-28:
  the entry name an employee types into Yahoo/Turbify is three underscores, and the monitor UI must
  never print the word Phoenix anywhere in that instruction.
  `mailbox-monitor-app-password-entry-is-three-underscores-never-phoenix`
- 🔒 **Turbify CANNOT issue app passwords centrally — the owner is STAYING, so do not re-pitch a
  migration.** There is no API and there never was one (a session claimed otherwise and was wrong):
  they are created browser-only, from inside each individual mailbox. That makes employee mailboxes
  **unmonitorable at scale**, and it is SETTLED — he was costed roughly $420/month for 60 seats on
  2026-08-28 and answered *"NO LEAVE ME AS I AM NOW."*
  `turbify-cannot-issue-app-passwords-centrally-owner-stays`

