# Memory Archive — domain detail, read on demand

**This file is NOT auto-loaded.** `MEMORY.md` carries active work, standing rules and
cross-cutting traps. Everything here is per-module knowledge: open it (or grep it) once you know
which area you're touching — payroll, sales, portal, CRM, and so on.

Nothing here is retired or wrong. Most of these still contain open items and hard-won gotchas;
they simply aren't needed *before* you know the task. Same format as the index: hooks only, open
the file for detail.

## SoS / closing — open as of 2026-08-02
Moved out of `MEMORY.md` on 2026-08-02: all still open, but only relevant once you know you are
touching SoS, closing sheets, areas or bricks. 🔴 = read before acting.
- 🔴 [Analytics strips confidential = 5.76x gap](sos-analytics-excludes-confidential-5x-gap.md) ROOT CAUSE of "SoS miscalculates"; June 9.36M vs 53.89M
- 🔴 [13-phase remediation](sos-remediation-13-phase-plan-2026-07-31.md) 4 migrations on PROD 08-01; open P9–P12 + owner uploads
- 🔴 [AIF Upper Egypt = TWO districts UE-1/UE-2](aif-upper-egypt-splits-into-ue1-ue2.md) region-NAME scoping breaks on any split
- 🔴 [Splitting an area forces a BLOCK split](sos-area-split-requires-block-split.md) GZ6 → GZ8 Fayoum + GZ9 Beni Suef. `carries_target` is GENERATED · master-brick trigger order · `ims_ratio` 0.9503 invariant · `brick_scope` is NOT a brick list
- 🔴 [Closing groups on STATIC region_code](closing-sheet-groups-on-static-region-code.md) `isClosingRegionRefinement` never existed. **Adding a line to `CLOSING_ORGANOGRAM_REGION_LINES` moves 13 areas — ask first**
- 🔴 [July closing = Direct sheet, 3 of 8 regions](july-2026-direct-sheet-incomplete-3-of-8-regions.md) targets work (#1622); D2 15% vs ~64-86%. AB = only clean control. GZ4 ±400u reversal breaks June AND July
- 🔴🔴 [CLOSING: engine EXACT, July inputs short — full record + 7 shipped PRs](monthly-closing-audit-2026-08-04.md) **READ BEFORE TOUCHING THE CLOSING.** Verdict proven twice (aggregate + sub-aggregate: raw==rollup 8/8, distributor file value==closing value delta 0.00). July low because distributors haven't sent 14/18 files (owner 08-05), NOT a bug. Shipped 08-04/05: Source Coverage `314bc34b` · Closing Corrections `3da64eb2` · channel tabs `0210ea89` · empty-state `6cf1250c` · **store-split direct-area REAL number bug −22,336.87 `83a32c1a`** · Head Office+IGNORE out `d3e87888` · Dashboard/Store-Split-Detail/Direct-filter `d0b94f74`. Picker = 3 lines only. **Two lines agreeing proves nothing — AIF is the only line with organogram+direct+stores; always build a third.** Traps: `update-branch` breaks the local push · source-text tests never run the code · `grep -c` 0 exits 1. Open: صيدلية-named customers classified as STORES; publications table EMPTY
- 🔴 [An untargeted area is usually CORRECT](untargeted-area-taxonomy-and-closing-region-mismatch.md) check `au.f_line_area_map_asof`. Closing region ≠ seat-model region — don't "fix" it
- 🔴 [`p_exclude_codes` has TWO OPPOSITE defaults](p-exclude-codes-has-two-opposite-defaults.md) hides in `analytics_sos_*`, reveals in 18 others. LATENT (service_role-only)
- 🔴 [Import dashboard Head Office LINE lock](sos-import-dashboard-head-office-line-lock.md) fail-open leaked to SFE Manager; now a REQUIRED `viewer {role}` → [numbers](head-office-line-leak-is-ry001-not-212m.md)
- 🔴 [22/22 brick-pin corrections APPLIED to prod](brick-pin-corrections-2026-08-02.md) rollback inline. Out-of-territory flags did NOT collapse — 20 reps/150 rep-days may be REAL cross-working
- 🔴 [Ped S1=Q2](ped-line-closing-workbook-s1-quarter-bug.md)·🔴 [Closing matrix](closing-matrix-inclusion-rule.md)·🔴 [S1 review](s1-business-review-module.md)·[Manual closing gap](manual-closing-audit-sos-source-gap.md)

- Re-homed 08-04: [remove D3 = collapse grouping, NOT delete bricks](d3-over-deletion-and-rebuild.md)·[resolver: customer brick beats area alias](sos-area-alias-must-not-beat-customer-brick.md)

**Re-homed 2026-08-12 from `MEMORY.md` — all still true and still open, just not needed before you
know you are touching SoS, the closing sheet or an import.**
- 🔴 SoS/closing internals, read the file first: [per-distributor item codes](sos-item-codes-are-per-distributor-namespaces.md)·[address INFERRED](sos-client-address-is-inferred-not-from-distributors.md)·[brick move = 4 re-stamps](moving-a-sos-brick-between-areas-needs-four-restamps.md)·[block re-point → stale crosswalk](repointing-a-block-area-leaves-crosswalk-and-directory-stale.md)·[stale alias breaks WRITES](stale-alias-key-breaks-writes-not-reads.md)·[canary misses `source='manual'`](owner-ruling-canary-misses-source-manual.md)·[Channel Breakdown = 2 sources](closing-channel-breakdown-two-figures-two-sources.md)·[July overlay+rollup together](july-direct-overlay-and-rollup-must-move-together.md)·[export STORE SPLIT](closing-export-applies-a-store-split-the-frontend-does-not.md)·[`areaCode` = BRICK area](closing-detail-areacode-is-brick-not-fact-area.md)·🔒 [JULY/ANTI-INF ONLY: client 441164 ريونيون split 50/50 D22+D26](july-anti-infective-reunion-split-exception.md) — brick + `customer_map` say D21 ON PURPOSE, never reconcile
- 🔴 SoS imports: [`sato N-2026` folder ≠ month N](sos-distributor-folder-labels-are-unreliable.md), read invoice dates·["short month" is a lie](sos-file-vs-db-gaps-are-ignore-mapped-products.md), trust `rows_ignored`·[closing sums `total_qty`, not effective units](closing-uses-total-qty-not-effective-units.md)
- 🔴 [Manager closing export drops Matrix+Target sheets when (line,period) is UNPUBLISHED](portal-closing-export-is-publication-gated.md) — silent HTTP 200; Admin/MM skip the gate
- 🔴 [A-9 `product_scope_override` is STALE — misses TE006/TE007](marketing-manager-product-scope-override-is-stale.md) — free today (never sold); desyncs closing Matrix vs Data the moment they sell
- 🔴 [ALL sales PERFORMANCE pages read SoS+targets, not `sales_records`](portal-performance-sourced-from-sos-targets.md) — vacant-DSM reps group as "no DM" BY DESIGN
- 🔴 [Ahmed Sharaf B-155 is a TWO-LINE PM (Pedia + Anti Infective)](ahmed-sharaf-is-the-cross-line-product-manager.md) — his `employees` row says Pedia only; never infer PM scope from it
- 🔴 [Merging a `*-live-sheet.gs` ships NOTHING](live-sheet-gs-is-pasted-by-hand-and-needs-a-style-bump.md) — it is pasted by hand; also bump `STYLE_VERSION`
- ✅ CLOSED [`phx_office_brick_share` had NO line filter — #2015 shipped a 76% misplacement](office-brick-share-rpc-has-no-line-filter.md) — fixed by #2016 (`5aea06eb`, verified on `origin/main` 2026-08-12). Kept for the generalisation: **any period-scoped RPC feeding a per-line calculation is suspect here.**

## Deductions
- 🔴 [July RE-COLLECTED 08-01: 376 candidates, 398,331.35 EGP](deductions-crm-vs-no-records-overlap-is-by-design.md) `crm`+`no_records_activity` on one day is BY DESIGN — hard-blocks publish. "53,161 EGP" was never real. 62 NULL amounts block publish
- 🔴 [Rules ARE in the codebase — implemented HALF](deduction-rules-are-written-in-comments-implemented-half.md) punch CORROBORATES a CRM no-activity day. 54,827 EGP wrong — #1584
- 🔴 [Insert was 100% broken — `month_key` is GENERATED ALWAYS](deductions-module-god-mode.md) **a test ASSERTED THE BUG** and stayed green. Also the #1571 god-mode thread
- 🔴 [Module has ZERO consumers](deductions-module-has-zero-consumers.md) nothing reads its tables; Automated Payroll runs its own `p1_*` steps
- 🔴 [FIELD_WORKFORCE holds UNDECIDED July deductions on punched days](field-workforce-pending-deductions-dispute-attendance.md) 77 pending; verify the coverage rule first
- 🔴 [No-Activity report false-flagged 10 real punchers](no-activity-report-cross-employee-suppression-bug.md) `0dcca58b` — **STILL OWED: void the 07-22 clarifications**
- 🔴 [No Activity Days module RETIRED — #1588](no-activity-days-module-retired.md) `getCompanyNoActivityDays` SURVIVES as the Deductions connector engine; DB rows untouched

## Payroll cutover / audit remediation
- 🔴 [Phase 5 cutover PLAN APPROVED](start-implementing-a-plan-agile-kazoo-phase5.md) #1590/#1592/#1593/#1595 MERGED; #1604 `8e216497` = write-contract gate in CI. #1593's role-aware month is DEAD CODE. Decisions: ÷actual-days · HO 24→23 vs field 1→31 · one-part deducts Part1
- 🔴 [8-phase audit remediation — LIVE TRACKER](audit-remediation-phase-progress.md) Phase 1 MERGED `e2cd9007`, Phase 2 in flight
- 🔴 [Whole-codebase module audit 08-01](module-audit-2026-08-01-status.md) 74 domains · [digest](module-audit-2026-08-01-digest.md) · [verdicts](module-audit-2026-08-01-verdicts.md) · [gap-fill](module-audit-2026-08-01-gapfill.md). Patterns: nav-vs-gate drift · tested-engine≠running-code · fail-open guards. Also: **contract renewal is DEAD in prod** (both RPCs absent, 0 rows ever)
- 🔴 [Cairo timezone ROUND 2 — 7/10 HIGH merged](cairo-timezone-audit-round2-2026-08-01.md) open: WAU heatmap, report-it KPI, `au.f_seat_occupant_asof`, 9 SQL fns on unzoned `current_date`. **CRM/E360 stamps are already Cairo — never convert**·[round 1 CLOSED](cairo-utc-timezone-audit-and-fix.md)

## Org / email delivery / session mechanics (moved out of the index 2026-08-14 — all still current)
- 🔴 [Blank Area/Manager on Add Employee skips autofill](add-employee-blank-area-manager-skips-autofill.md)·[3 `employees` columns look missing but are NOT gaps](employees-null-columns-that-are-not-gaps.md)·[deleting an employee needs a FULL TEXT SCAN](deleting-an-employee-needs-a-full-text-scan.md)
- 🔴 [NEVER claim a notification was sent without querying `notification_deliveries`](verify-notification-deliveries-before-claiming-a-send.md), join on `notification_event_id`·[Telegram reaches exactly TWO accounts, zero managers](telegram-reaches-only-two-accounts.md)·[`general` policy routes to HR INBOX](general-email-policy-routes-to-hr-inbox.md)·[`work_email` UNIQUE-indexed](employees-work-email-is-unique-indexed.md)
- 🔴 [A scheduled task's SKILL.md on disk is NOT proof of what ran](ram-guard-routine-every-30-min.md) — verify via `list_scheduled_tasks` + a real transcript; a task named `ram` self-archived 2 sessions. 2 RAM guards exist, neither kills.
- 🔴 Railway ops detail: [`scale us-west=0` does NOT zero `sfo`](railway-scale-us-west-does-not-zero-sfo.md)·[the region must stay EU](railway-production-region-is-now-eu-west.md)·[a Railway var paste can swallow the next line's KEY=VALUE](railway-variable-manual-paste-can-corrupt-values.md)·["no exact recipient" kills WHOLE alert families](strict-recipients-silently-drops-whole-alert-families.md)
- Usage/session mechanics: [Sonnet @ `max` = 5.59x its default, Opus 5 = 1.91x](effort-multiplier-is-the-biggest-usage-lever.md), every session launches `--effort max`; NO hook can change it, only `/effort`·[an account switch NEVER loses the transcript](switching-max-accounts-never-loses-the-transcript.md), `--resume` works across `/login`·[the relay carries work+limits](relay-carries-work-and-limits-between-accounts.md), `/relay`

## Workflow / approvals / lifecycle — open
- 🔴 **[marketing events are TRIGGERS; notifications are NOT](marketing-events-are-triggers-notifications-are-not.md)** — a hand-run SQL decision gets a correct `marketing_request_events` trail for free (never hand-insert them), but the next approver is NEVER pinged — `notifyMarketingWorkflow` lives in the service. Holds the reopen+RPC recipe for advancing a `returned` request.
- 🔴 [Hiring a manager must RECLAIM their reports — #1747 LIVE](hiring-a-manager-must-reclaim-their-reports.md) resignation pushed reports UP, nothing brought them back: a new NSM had **0 direct reports** while running his line, CEO carried 21. Trigger + `au_v_employee_seat_drift` detector (0 drift / 103 seated)
- 🔴 [THE SEAT IS NOW A FOREIGN KEY of the hiring ledger — PR #1745, both DBs applied](seat-is-now-a-foreign-key-of-the-hiring-ledger.md) `position_vacancies.seat_id` FK + partial unique index = duplicates impossible; hire resolves by seat, not text. **`employees.area_id`/`region_code` are still un-derived copies — same disease**
- 🔴 [Org visibility + seat-vanish: Phase B + A LIVE (#1739, #1741 merged), C/E in #1745](org-visibility-and-seat-vanish-diagnosis-2026-08-04.md) "EU tables" = `au` schema; organogram is 100% au_v_org_tree; vanish was rowKey collision on double occupancy; 16/42 areas line-divergent; the diagnosis file maps all 5 line-blind resolvers
- 🔴 [Workflow-registry `allowedRoles` live in the DB, not the repo](workflow-registry-allowedroles-live-in-db-and-drift.md) a 2nd gate after `assertPermission`, invisible to grep/typecheck/tests. 13 modules audited. Open: nobody can self-submit a resignation · `"draft"` = a request that doesn't exist · one bad role string kills the WHOLE module
- 🔴 [A terminal write on `employees` OPENS the vacancy via DB trigger](resignation-vacancy-opened-by-db-trigger.md) **never add an app-side vacancy insert to a resignation path** — the two paths mint different code formats so the unique index misses it. #1599
- 🔴 [Seat-vacate: DB applied + code MERGED `ea404043`, NOT DEPLOYED](resignation-complete-au-seat-vacate-gap.md) verify with merge-base --is-ancestor, not timestamps
- 🔴 [New hire's account is EMPTY until 3 links are set](new-hire-account-is-empty-until-three-links-are-set.md) role/seat/manager live in different places. Role change needs an `app_sessions` revoke. Open: AI-0005/AI-0006 have NO login row
- 🔴 [Weekly-plan UI offered approvals the server rejects — #1589](weekly-plan-approver-ui-vs-server-drift.md) revise-collision NOT fixed; never demote an approved parent to `cancelled`·[4 gates](weekly-plan-four-gates-rm-dsm.md)·[dup-period](weekly-plan-duplicate-period-submission-fix.md)
- 🔴 [Outstation expense payout has THREE surfaces](outstation-expense-payout-has-three-surfaces.md) the real payer is a SQL RPC, not TS·[ticket-mandate bypass](outstation-ticket-mandate-bypass-and-dead-policy-knobs.md) don't "unify" `decision.ts`
- 🔴 [Managers log NO check-ins — borrow the rep's](dv-checkin-attribution-managers-borrow-rep-checkin.md) fixed in `visit-workload.ts` (#1598); FWC `crm/rep-day.ts:235` still filters to own crm_id
- [Employee area wrong = double-seat](employee-hire-auto-replacement-double-seat.md)·[Rep never visits same contact twice](rep-never-visits-same-contact-twice-dedup-rule.md) type 0 ONLY·[Import block](employee-import-payroll-ineligible-block-fix.md)·[Territory](territory-management-module-plan.md)

- Re-homed 08-04: [one bad registry row crashed ALL module transitions](workflow-registry-allornothing-loader-bug.md)

## Recruitment / WhatsApp CV
- 🔴 [CV extraction never applied](cv-extraction-never-applied-to-candidate-columns.md) 34/34 prod rows·[auto-apply](cv-extraction-auto-apply-high-confidence.md) never write applied_fields
- 🔴 [**TWO numbers — the ADVERTISED one is NOT on the API**](whatsapp-silence-alert-is-a-weekend-false-positive.md) — CVs enter ONLY when a human forwards; a forward RESETS every freshness clock. Silence PAGES again (#2334 reversed #2327); the Development-mode call was WRONG.·[silent since 07-25](whatsapp-cv-intake-silent-since-2026-07-25.md)·[observability](whatsapp-intake-observability-and-second-number.md)·[bulk](whatsapp-cv-bulk-import-forwarding.md)
- [CV viewer](recruitment-cv-viewer-and-extraction-accuracy-2026-07-26.md)·[CV source](recruitment-cv-viewer-and-source-context.md)

- Re-homed 08-04: [CV Database is client-side Excel, no table](cv-database-client-side-only.md)

## Payroll
- Copilot: [deductions](payroll-deduction-rules-owner-spec.md)·[exports](payroll-copilot-report-exports.md) OPEN·[sheet](payroll-copilot-sheet-redesign.md) OPEN·[design](payroll-copilot-design.md)
- Automated: [Part1](automated-payroll-part1-enhancements.md)·[4-tab](automated-payroll-part1-other-deductions-4tabs.md)·[restyle](automated-payroll-part1-premium-restyle.md)·[carry-fwd](automated-payroll-carry-forward-and-accuracy-nets.md)·[notice](automated-payroll-notice-period-population-bug.md)·[special](automated-payroll-special-situations-tab.md)·[non-emp](automated-payroll-non-employees-and-exec-summary.md)·[Incentive LOCKED](incentive-policy-lock.md)·✅ [CRM/vacation buckets miss one-part + leavers](automated-payroll-crm-bucket-misses-one-part-and-leavers.md) ACCEPTED 08-04, 0 EGP — do not "fix"

## Sales — areas / upload / analytics
- Area unif: [v2](area-unification-42-areas-design.md)·[cutover](au-phase9-cutover-validation.md) read before applying FIX-D/E·[audit](area-unification-42-areas-audit-findings.md)·[occupancy](au-occupancy-hiring-date-from-master.md)·[emp-master](au-postcutover-employee-master-audit.md)·[rollback](au-rollback-tables-pending-teardown.md)·[v1](area-unification-revert-settled.md)
- au: [org↔SoS](au-schema-is-the-org-sos-linkage.md) 1:1, use au_v_*·[area_state](au-area-state-follows-seat-occupancy.md)·[hire_into_seat](au-hire-into-seat-vacancy-wiring.md)·[Rep→area](rep-area-assignment-three-conflicting-sources.md)
- [DB Mapping](database-mapping-edit-delete-module.md)·[668-brick](reallocation-668-bricks-full-plan-live.md)·[14 uncovered](reallocation-14-uncovered-bricks.md)·[Cust mapping](customer-mapping-file-audit-and-fix.md)·[LocationIQ](locationiq-geocode-provider.md)·[AI-suggest](normalizer-ai-suggest-ratelimit-fix.md)·[Distributor](sofico-upload-template-recognition.md)·[PS mapping](ps-weekly-mapping-fix.md)
- SoS UI: [rebuild](sos-dashboard-rebuild-2026-07-02.md)·[perf](sos-dashboard-perf-and-0621-revert.md)·[block/warn](sos-upload-block-vs-warn-policy.md)·[brick=geo](sos-brick-authoritative-geography.md)·[portal](portal-source-of-sales-rebuild.md)·[import](source-of-sales-rebuild-rules.md)·[reset](source-of-sales-reset-and-missing-data.md)·[Bulk](sos-bulk-import-module-build.md)·[remove-card](sos-bulk-import-remove-card-fix.md)
- [3-way](field-sales-3way-report-spec.md)·[Direct Order](direct-order-request-module-build.md)·[Drilldown](territory-drilldown-module-build.md)·[Manual closing](manual-closing-audit-sos-source-gap.md)
- Analytics: [audit](analytics-module-audit-2026-07.md)·[open-to-all — RETIRED 2026-09-17, module deleted by Ruling 11](analytics-open-to-all-scoped-plan.md)·[schema](analytics-schema-postgrest-not-exposed-2026-07-18.md)·[multi-select](analytics-multi-select-time-filters.md)

- Re-homed 08-04: [canonical line names, code unchanged](anti-infective-canonical-line-name.md)·[customer_map.brick_id un-FK'd — repoint+rebuild](post-reallocation-stale-brick-audit.md)·[>4MB upload via Storage signed URL](sales-large-upload-via-storage.md)·[SATO EP-BK/EP-PHS distributors](sato-sector-distributors-ep-bk-ep-phs.md)·[exact-header match, 3 upload modules](sales-queue-upload-template-pr816.md)·[closing achievement = seat targets, not Sales Queue](sales-queue-retired-from-monthly-closing-analytics.md)

## SoS — applied state + data quality
- ✅ [Master 704 LIVE](sos-master-complete-704-applied-2026-07-28.md) undo + 3 open items·[dup bricks](sos-duplicate-brick-ids-same-place.md)·[Others split](sos-others-region-split-2026-07-27.md)·[IMS ratio](sos-ims-ratio-storage.md)·[unordered paging lost rows](sos-unordered-pagination-lost-mappings.md)
- ⚠️ [area_code unreliable](customer-area-code-is-inherited-and-unreliable.md)·[region cols ≠ routing](sos-per-line-region-columns-are-geographic-not-routing.md)·[FINAL NEW (4) pre-split](sos-final-new-4-xlsx-is-pre-split.md)

## Weekly Sales / Marketing / ROI
- Weekly: [map](weekly-sales-module-map.md)·[de-cumulate](weekly-sales-decumulation-plan.md)·[ExcelForge](weekly-excelforge-bi-hardening.md)·[SI](sales-intelligence-module-build.md)·[LA003/4](la003-la004-confidential-products.md)·[rollup](sos-fact-rollup-exec-si-dashboards.md)
- Marketing: [schema](marketing-request-schema-generated-cols-atomic-rpc.md)·[approver FK](marketing-approver-hrid-casing-fk.md)·[read-only](marketing-request-readonly-lockdown.md)·[workspace](marketing-personal-workspace-own-scope.md)·[product-line](marketing-product-line-matching-broken.md)
- ROI: [auto-apply](roi-auto-apply-single-value-guard.md)·[MM hidden](mm-incentive-hidden-policy.md)·[filters](roi-tracking-filter-engine-rebuild.md)·[reporting](roi-reporting-hardening-plan.md)
- Open 08-02: 🔴 [ROI 14-point](marketing-roi-14point-verified-audit.md) 6 unbuilt·[3 engines diverge](marketing-roi-three-engines-divergence.md)·[dup surfaces](marketing-duplicate-report-surfaces.md)·[archival+SLA](marketing-requests-archival-and-sla-guard.md)·[picker cutover](marketing-pharmacy-picker-1460-cutover-resume.md)

- Moved out of the index 2026-08-14, still 🔴: [TOP UP A-9's `product_scope_override` at EVERY launch on her 3 lines](marketing-manager-product-scope-override-is-stale.md) — also guards Head Office RY001, so NEVER clear it·[NEVER write a lower-cased HR_ID into an `employees(hr_id)` FK](marketing-approver-hrid-casing-fk.md) — use `resolveStoredHrId`; WRITE dies 23503·[the 216 xlsx_import requests deleted 08-09 were TEST DATA](marketing-xlsx-requests-were-test-data-deleted-on-purpose.md) — CLOSED, never re-raise as data loss; `/admin/archived-marketing-requests` is permanently empty, delete it.

## Worktrees & session isolation (moved out of the index 2026-08-14 — all still current)
- 🔴 [a collapsed Browser pane reads every layout as 0](collapsed-browser-pane-reads-zero.md) — LIVE RULE now in `AGENTS.md` §2.1 (`collapsed-browser-pane-reads-zero`, merged 2026-09-05). Kept here only so the file stays reachable from the 12 of 13 checkouts whose AGENTS.md predates that merge; drop this line once they carry it.
- 🔴 [can't remove the worktree you are IN](cannot-remove-the-worktree-you-are-running-in.md), the husk stays·[`pnpm run` in a junctioned one DELETEs main `node_modules`](pnpm-run-in-worktree-tries-to-purge-junctioned-node-modules.md)·[STRIP the payload BEFORE removing](strip-worktree-payload-before-removing-it.md)·[`remove` can time out MID-DELETE](git-worktree-remove-can-timeout-and-partially-delete.md)·[gitignored `.xlsx` is invisible to the safety checks](gitignored-xlsx-invisible-to-worktree-safety-checks.md)·[a nested one impersonates the PARENT](nested-worktree-without-git-impersonates-parent.md)
- 🔴 [a worktree session can Write into the PRIMARY checkout](worktree-session-can-silently-write-to-primary-checkout.md) — type the full path prefix·[another session can `checkout -b` the primary mid-merge](primary-checkout-branch-can-change-mid-merge-use-worktree-and-rerere.md)·[`Stop-Process` can't close a session, `archive_session` can](cannot-map-claude-sessions-to-worktrees.md)·[Copilot makes its OWN worktrees](copilot-worktrees-outside-agents-md-conventions.md)

## Portal / CEO / Action Center
- [DSM hyphen](dsms-performance-hyphen-stripped-hrid-bug.md)·[Weekly Sales](portal-weekly-sales-dashboard.md)·[CmdCenter](portal-overview-dashboard-build.md)·[CEO parity](ceo-field-sales-parity.md)·[NSM Cal](nsm-team-calendar-portal-build.md)·[MM audit](mm-portal-audit-2026-06-27.md)·[PM/GPM vacancy](pm-gpm-vacancy-line-scope.md)
- [DV Focus LOCKED](feedback-dv-focus-section-locked.md)·[E360](employee-360-module-design.md)·[E360 attend](e360-attendance-source-field-not-device.md)·[Med-rep dedup](portal-medrep-achievement-max-target-dedup-bug.md)·[Cal hidden](private-calendar-hidden-from-portal-nav.md)·[Plan-sync removed](private-calendar-plan-sync-removed.md) LOCKED
- Infra: [sidebar src](portal-sidebar-real-source.md)·[stale overwrites](portal-command-center-stale-file-overwrites.md)·[curation](admin-shell-sidebar-per-user-curation.md)·[gate bug](admin-shell-role-page-gate-bug.md)·[hub drift](hub-page-guard-vs-sidebar-role-drift.md)·[linkage](portal-linkage-phase1.md)
- Actions: [PHX-1](phx1-system-admin-identity.md)·[history tbl](approvals-history-table-name-bug.md)·[Weekly-plan](weekly-plan-approvals-in-action-center.md)·[consolidate](actions-center-consolidation.md)·[DSM eligib](dsm-plan-eligibility-fix-and-rm-gap.md)·[Planning Cal](planning-calendar-role-line-scope-2026-07-20.md)·[Other appr](other-approvals-history-duplication-fix.md)

- Re-homed 08-04: [shared admin/portal component redirect bounces users](portal-admin-shared-component-redirect.md)·[Direct Orders portal UI](direct-orders-employee-portal-ui.md)·[E360 subtree picker + PD-0001 excluded](employee-360-subtree-picker-and-exclusion.md)·[Monthly Closing module, published-only](portal-monthly-closing-module.md)·[RM vacancies need 4 gates — verify the reader](rm-vacancies-four-gates-and-lookalike-reader.md)

## HR lifecycle / leave
- Leave: [approver model](project-leave-excuse-approver-model.md)·[Hub V+E](approvals-hub-vacation-excuse-build.md)·[Action Ctr](vacation-action-center-build.md)·[HR authority](hr-approval-authority.md)·[Company rpt](company-vacation-report-crm-signals.md)·[CEO tabs](approvals-hub-ceo-oversight-tabs.md)
- Scope: [Resignation](resignation-employee-scope-check.md)·[HR_ID norm](hr-id-normalization-fix-2026-07.md)·[Probation](probation-scope-broader-than-generic-canseeemployee.md)·[line_name](employees-line-name-not-line.md)·[Directory](directory-active-filter-gate.md)·[Title≠perm](job-title-not-a-permission-source.md)·[Resign/ctr](resignation-contract-scope-check-audit-2026-07.md)
- [Seat-continuity](seat-continuity-resolver.md)·[Term login](auth-terminated-login-block.md)·[GoTrue resync](supabase-auth-bridge-password-resync.md)·[Resign RPC](resignation-transactional-rpc-authored.md)·[Excuse race](excuse-decision-race-condition-fix.md)·[Plan slot](plan-workspace-slot-workweek-linkage.md)·[Plans vacant](plans-single-visit-vacant-areas-fix.md)
- Probation: [field-force only](probation-module-is-field-force-only.md)·[email rules](probation-email-recipients-and-templates-rule.md)·[controls](probation-email-controls-mod1-4.md)·[pre-merge](probation-premerge-audit-fixes-2026-07.md)·[notify leak](probation-workflow-notification-line-leak.md)

- Re-homed 08-04: [DSM/RM removed from Excuse module entirely](excuse-module-excludes-dsm-rm.md)·[self-service photo — uploaded→static→initials; documents owner-locked identity-card.tsx](employee-self-service-photos.md)

## Coaching / attendance / CRM
- 🔴 [Attendance sync DOWN since 07-30](attendance-agent-device-unreachable-and-token-rotation-pending-restart.md) device off LAN
- [Coaching](coaching-analytics-shared-dashboard.md)·[Attendance](attendance-eligibility-device-mapped.md)·[digest](attendance-weekly-digest-selfsettlement-spec.md)·[agent x86](attendance-agent-x86-com-requirement.md)·[Outstation notif](outstation-expense-notifications-reject-only.md)·[Outstation audit](outstation-expense-deep-audit-2026-07.md)·[Expense Excel](expense-source-excel-vs-system.md)
- CRM: [iR360](ireports360-crm-integration.md)·[1-door](crm-single-source-door-guardrail.md)·[Visits](visits-checkins-accuracy-audit-2026-07-12.md)·[visit time](crm-single-source-visit-time-and-counts.md)·[resign slot](crm-resigned-slot-reused-for-new-hire.md)·[mod audit](crm-module-audit-and-filters-export-fix-2026-07-27.md)·[eff-view](crm-effective-view-column-order-trap.md)·[checkin geo](crm-checkin-address-reverse-geocode-backlog.md)
- DV: [Analytics](double-visit-analytics-live-rebuild.md)·[Report≠Analytics](dv-report-vs-dv-analytics.md)·[Scope leaks](dv-focus-scope-leak-and-fixes.md)·[Triple](crm-triple-visit-detection.md)·[GPM scope](double-visit-gpm-line-id-scope.md)·[FWC](fwc-godmode-export-and-exceljs-limits.md)

- Re-homed 08-04: [DV Analytics 1000-row cap; vacant HR-id recovery](double-visit-data-integrity.md)·[CRM current-brick via source_file blocklist](crm-brick-current-signal-fragility.md)·[never count raw queryVisits for double visits](crm-double-visit-audit-and-collapse-flag-2026-07-31.md)

## Email / notifications
- 🔴 [Outbox drain VERIFIED WORKING](outbox-drain-verified-working-dual-caller-401.md) every cron endpoint gets BOTH a 401 and a 200 — **a 401 alone proves nothing.** 66 rows terminally skipped. Never make the two cron secrets match. **NOT superseded - and the reason matters (2026-08-27).** The drain really does run: cron-job.org job 8200914 fires every 5 min and returns HTTP 200, so this memory and its dual-caller 401 finding both still stand. What it did NOT do between 2026-08-14 and 2026-08-27 is process anything, and that is a different fault: `loadDueNotificationOutboxRows` applies its SQL `.limit(50)` BEFORE the `attempts < max_attempts` filter runs in JS, so 50 exhausted rows filled the batch window and blocked every retryable row behind them. The rows were retired 2026-08-27 and the queue is clear, but the ordering bug is UNFIXED and will recur at 50 again: [the drain is healthy and does nothing](outbox-drain-is-blocked-by-50-exhausted-rows-head-of-line.md). An earlier note here called the drain "dead" and that was wrong - never infer a cron's health from database state alone
- ⚠️ [Bulk setup-link](bulk-setup-link-send.md) every send signs the user out
- [Confidence gate](notification-confidence-gate-and-paused-crons.md) 3 crons PAUSED·[OneSignal](onesignal-push-integration.md)·[Dup fan-out](notification-duplicate-email-fanout-fix.md)
- Templates=engine: [email](email-template-unification.md)·[Telegram](telegram-template-unification.md)·[probation gap](probation-email-no-data-token-gap.md)·[render≠hints](email-render-map-vs-placeholderhints.md)
- Outages: [spam/DNS](email-spam-dns-root-cause.md)·[Resend 100/day](resend-daily-100-cap-429-outage.md)·[env drift](notification-outages-cloudrun-env-drift-2026-07-11.md)·[HR dropped](hr-notification-emails-dropped-cloudrun.md)·[Telegram bot](telegram-bot-change-july9-chat-not-found.md)·[WhatsApp deferred](whatsapp-business-api-deferred.md)·[recipients](notification-recipients-and-migration-backlog-2026-07-19.md)

- Re-homed 08-04: [latency pinned at cap = platform timeout; parallelize](notification-cron-300s-outage-2026-07-16.md)·[CEO-approved order email via after()](direct-order-ceo-approval-email.md)·[recipient resolver org-scope removed](notification-governance-hierarchy-generalization.md)·[blank email field: check registry AND context literal](outstation-email-status-token-dump-bug.md)·[two unique indexes hostile to ON CONFLICT upsert](notification-user-states-dual-unique-index.md)

## GCP / infra detail
- GCP: [Cloud Run](gcp-cloud-run-migration-2026-07.md)·[Excellence](prod-excellence-waves-2026-07.md)·[health](gcp-supabase-health-audit-2026-07-25.md)·[stale tag](cloud-run-stale-tag-cpu-quota-exhaustion.md)·[p95](gcp-p95-latency-alert-storm-min-instances-zero.md)·[System Issues](system-issues-dashboard-gcp-supabase.md)·[cron timeout](notifications-cron-timeout-chain-2026-07-16.md)·[Perf audit](perf-audit-2026-07-04-root-causes.md)
- [MCP migrate](mcp-apply-migration-version-drift.md)·[CI billing](ci-billing-block-and-unprotected-main.md)·[CI docs gap](ci-docs-fallback-lint-typecheck-gap.md)·[GH Actions](github-webhook-ci-not-firing-recurring.md)·[Personal acct](github-personal-account-no-ghas-oss-scanning.md)·[Maps disabled](google-maps-legacy-places-disabled.md)·[Expired session](expired-session-page-guard.md)·[Heartbeat race](heartbeat-logout-race-force-refresh-403.md)
- Supabase: [advisors](supabase-advisor-by-design.md)·[dual-project](supabase-dual-project-schema.md)·[public ACL](public-schema-default-acl-grants-authenticated.md)·[staging URL](staging-cloud-run-url-2026-07-12.md)
- 🔴 **Railway, the whole account of the 2026-09-28 Headwind move to EU West** — [region is NOT inherited; a volume's region is fixed at creation](railway-services-are-born-in-sfo-and-volumes-are-region-pinned.md): a new service is born in `sfo`, `railway service scale <new>=1` ADDS a region rather than moving one (pass the old one `=0`), `railway ssh` JOINS argv so SQL with `||` returns empty with a null exit, `tcpProxyCreate` is `Not Authorized` over the API (use the CLI, delete by POSITIONAL id), `n_live_tup` invents drift right after a restore (use exact `count(*)`), an orphaned volume's purge date appears on a DELAY so read `railway volume list` twice, a backup schedule has to be ASKED FOR and `kinds` is the WHOLE SET, and the CI runner's labels live in one `RUNNER_LABELS` variable whose change re-registers every replica. Also the capacity ceiling that gates widening self-hosted CI.
- LIVE log noise (not a regression): [`The destination stream closed early` = a browser abort/HTTP 499](next-destination-stream-closed-early-is-a-browser-abort.md) — server-side twin of [Script error](script-error-is-never-app-code-65pct-of-client-errors.md); chase only a different digest, a 5xx, or the changed page's own path.

## HR forms — the stamp and signature marks (closed 2026-09-29)
- ✅ [salary-letter marks: RESTORED, this is closed](salary-letter-marks-owner-placed-restore-when-4771-serves.md) — his own hand-dragged stamp and signature positions on the Arabic salary letter, removed while a placed mark still printed automatically and put back the moment #4771 was serving. The file keeps the exact coordinates as a RECOVERY copy only; read the live `mark` rows before believing anything is missing, and never restore them twice.

## Closed 2026-08-10 (retired from the index)
- [SoS backfill checked `brick_id IS NULL` but unresolved rows are `''`](sos-backfill-checks-null-not-empty-string.md) — FIXED live on staging+prod; PR #1984 + #1985 both merged.
- [Outstation submit used to AUTO-APPROVE into payroll](outstation-submit-used-to-auto-approve-into-payroll.md) — fixed #1916; the accepted-only guard is the remaining back door.
- [`monthly-closing/go` split across 2 unmerged branches](monthly-closing-go-route-in-flight-two-branches.md) — re-verify against `main` before trusting; the branches may have landed.

## SoS / closing internals (moved out of the index 2026-08-10 — still current)
- 🔴 [A stale `normalized_alias` does NOT hide an alias from the importer](stale-alias-key-breaks-writes-not-reads.md) — reads recompute; it breaks upsert/deactivate and the DUPLICATE kills the key.
- 🔴 [An item code is meaningless outside its issuing distributor's numbering](sos-item-codes-are-per-distributor-namespaces.md) — test by COLUMN HEADER.
- 🔴 [SoS Client Address is INFERRED, not distributor-sent](sos-client-address-is-inferred-not-from-distributors.md)
- 🔴 [Moving a brick between areas = 4 re-stamps, not 1](moving-a-sos-brick-between-areas-needs-four-restamps.md)
- 🔴 [Re-pointing a BLOCK's area leaves the crosswalk + directory stale](repointing-a-block-area-leaves-crosswalk-and-directory-stale.md)
- 🔴 [The "rulings reverted" canary filters `source like 'owner-ruling%'` but real rulings are `source='manual'`](owner-ruling-canary-misses-source-manual.md) — reads 0 while 1,364 July units sit wrong; drop the source filter.
- 🔴 ["Frontend right, XLSX wrong" = the export-only STORE SPLIT](closing-export-applies-a-store-split-the-frontend-does-not.md) — fractional units (`182.333333`) are the tell; read his `Downloads` file with openpyxl.
- 🔴 [`ClosingDetailRow.areaCode` is the BRICK area; every closing RPC books the FACT area](closing-detail-areacode-is-brick-not-fact-area.md) — diverge on hand-splits only; use `sheetAreaCode` first.
- 🔴 [Channel Breakdown: `movedValue` and `movedFromBricks` are TWO SOURCES](closing-channel-breakdown-two-figures-two-sources.md) — split any gap into source-gap vs applier-loss before blaming negatives.
- 🔴 [July direct: the TS overlay and `fact_rollup` must move TOGETHER](july-direct-overlay-and-rollup-must-move-together.md) — a per-piastre mismatch silently drops every area, no error.
- Moved out of the index 2026-08-14, still 🔴 — **his sheet vs our areas:** [CNS closing=35=organogram non-OT](cns-closing-35-areas-are-the-organogram-non-ot.md)·[Ismailia-Suez absorbs N+S Sinai](his-ismailia-suez-absorbs-north-and-south-sinai.md)·[city-vs-markaz works Sohag, NOT Qena](qena-1-and-2-both-cover-qena-city.md)·[EP-PHS reuses 1 client_code, 2 pharmacies](epda-reuses-one-client-code-for-two-pharmacies.md)
- Moved out of the index 2026-08-14, still 🔴 — **pricing and scope:** [CNS factory price: Tebofortine SETTLED, Conviban ×4 + Rispadex ×2 still OPEN](cns-factory-price-basis-is-unresolved.md), never change a price without a fresh ruling·[closing RETAIL value = units × `factory_price`, not the row's `value`](closing-retail-value-is-units-times-factory-price.md), no period scoping, "fix one month" restates all·[ALL restricted SKUs sit on Head Office (~80% of value)](restricted-skus-are-all-head-office-line.md), the closing lock costs nothing·[Monthly Closing VIEW = 5 gates](monthly-closing-view-access-four-gates.md), gate 0 NAV MODE blocks portal-nav roles before any perm check.

## Migrations / CI / git / Validation / Search (moved out of the index 2026-08-14 — all still current)

**Migrations** — 🔴 [partial hand-run drift, check `pg_proc.proacl`](staging-migration-drift-from-partial-hand-run.md)·[`REVOKE FROM PUBLIC` strips service_role on a default ACL](revoke-from-public-strips-service-role-on-default-acl.md)·[MCP `apply_migration` stamps its OWN clock, versions drift from the filename](mcp-apply-migration-versions-drift-from-filename.md)·[`supabase db push` blocked by the archived baseline](supabase-db-push-blocked-by-archived-baseline.md)·[PGRST202 (missing RPC) reads as a missing SCHEMA](pgrst202-missing-function-reads-as-missing-schema.md), test missing-function FIRST·[`phx_customer_directory` lives ONLY in prod](phx-customer-directory-lives-only-in-prod.md)

**CI** — 🔴 [Sonar's fail condition is INVISIBLE and hotspots need a human](sonar-gate-conditions-are-invisible-and-hotspots-need-a-human.md), ask·["require branches up to date" is OFF since 08-05](branch-up-to-date-rule-disabled-2026-08-05.md)

**git** — 🔴 [`git fetch` won't prune a stale remote-tracking ref after a merge-delete](stale-remote-tracking-ref-after-merge-delete.md)·[`--not --remotes` FLIPS when remote refs are pruned](not-remotes-flips-when-remote-refs-are-pruned.md)·[a merged PR does NOT make a worktree retirable](merged-pr-does-not-make-a-worktree-retirable.md)·[`gh pr merge` local cleanup errors on SUCCESS in a shared worktree](gh-pr-merge-local-cleanup-fails-in-shared-worktree.md)

**Validation** — 🔴 [a background task's exit code is the WRAPPER's](background-task-notification-exit-code-is-the-wrappers.md)·[Monitor reads stdout only — jq isn't installed, so those scripts silently do nothing](jq-not-installed-monitor-scripts-silently-do-nothing.md)·[an agent's grep is NOT exhaustive](email-inventory-audit-2026-08-13.md)·[the phase24 RLS smoke ABORTS at startup locally and proves nothing](phase24-rls-smoke-cannot-run-locally.md)

**Search** — 🔴 [a permissions role block spills into the NEXT role](permissions-role-block-grep-spills-into-next-role.md)·[`Get-Process` returns silently EMPTY cross-session](powershell-get-process-silently-empty-cross-session.md)

**Search (2 more)** — 🔴 [Arabic ILIKE misses hits without orthographic normalization](arabic-name-search-needs-orthographic-normalization.md)·[a raw NUL byte makes a source file invisible to ripgrep](raw-nul-byte-makes-source-invisible-to-ripgrep.md)

**Owner rules already stated in AGENTS §4/§7 (moved out of the index 2026-08-14 — all still current)** — [every reply ends with ONE next step](every-reply-ends-with-next-step.md)·[no payslip on any landing page](portal-no-salary-on-landing.md)·[ask business facts as an XLSX with dropdowns](ask-business-facts-via-xlsx-dropdown-sheet.md)·[validate ONCE at "done", never per edit](validate-once-at-done-not-per-edit.md)·[owner working profile](owner-working-profile-audit-2026-08-01.md)·[SoS always attributes to TODAY's geography](sos-always-todays-geography-rule.md)

## Index caveats trimmed 2026-08-17 — the FULL wording (nothing here is retired)

`MEMORY.md` hit 20.9KB against a 24.4KB read ceiling and was compacted on 2026-08-17. Every line
below is the **verbatim pre-compaction index line**; the index now carries a short hook to the same
file. The hooks kept the "do NOT undo" flag — this section keeps the *specific* thing not to undo,
the numbers, and the PR ids. **Read the matching line here before touching or reverting any of
these.** All are still current; none were closed by the compaction.

### Applied to prod 2026-08-14 → 2026-08-16 — what exactly must not be restored
- 🔴 LIVE prod 08-14, do NOT undo: [Rule #1 — `closing_fact` reads SoS, floor January](rule1-sos-migrations-applied-to-prod-2026-08-14.md), never restore the gap column·[Channel Comparison](closing-channel-rollup-applied-to-prod-2026-08-14.md)·[Channel **Breakdown**](closing-channel-breakdown-rollup-applied-to-prod-2026-08-14.md) — never simplify `population`.
- 🔴 [`phx_rep_bulk_dependency` LIVE prod 08-14 (#2131)](phx-rep-bulk-dependency-live-on-prod-2026-08-14.md) — Office spread NOT re-simulated, EZ/CNS cases UNDERSTATED.
- 🔴 [Attribution rollup GATES `au.f_monthly_achievement`, LIVE prod 08-14 (#2138)](attribution-rollup-applied-to-prod-2026-08-14.md) — fp hashes `line_area_map` WHOLE-TABLE.
- 🔴 [Vacation report served from a cross-request cache, NOT the RPC — LIVE prod 08-14 (#2143)](vacation-report-cross-request-cache-live-on-prod-2026-08-14.md) — never restore the `.rpc()` call.
- 🔴 [Direct-order search = GIN trigram on `customer_code`, LIVE prod 08-14 (#2145)](search-direct-order-customer-code-trgm-live-on-prod-2026-08-14.md) — never restore a btree.
- 🔴 [CRM `loadBrickCentroids` → `unstable_cache`, LIVE prod 08-15 (#2150)](brick-centroids-cache-live-on-prod-2026-08-15.md) — catch stays OUTSIDE the cache, never restore `let cache`.
- 🔴 [Closing matrix folded into `phx_closing_distributor_product`, LIVE prod 08-15 (#2151)](closing-matrix-fold-live-on-prod-2026-08-15.md) — the distributor read is LOAD-BEARING now.
- 🔴 [`phx_closing_distributor_product` reads a UNITS-ONLY rollup, price joined LIVE — prod 08-16 (#2171)](closing-distributor-product-rollup-live-on-prod-2026-08-16.md) — NEVER bake a value/price column.
- 🔴 [Master Workbook export = ONE keyset pass, LIVE prod 08-15 (#2152)](master-workbook-keyset-live-on-prod-2026-08-15.md) — order is chunk-then-id; never restore `.range()`.
- 🔴 [Month vs Target bounded by `applyWeeklyAccessScope`, LIVE prod 08-16 (#2177)](weekly-month-vs-target-access-bound-live-on-prod-2026-08-16.md) — RM read 2.04x his target; Rep gets NO tab; never restore the Cairo-month fallback.
- 🔴 [Sales-vs-Target range on a self-invalidating TOKEN cache, LIVE prod 08-15 (#2161)](vs-target-achievement-cache-token-live-on-prod-2026-08-15.md) — never swap for TTL/tag, never filter `effective_to`.
- 🔴 [TWO period gates in `vs-target.ts`, NOT interchangeable](published-and-uploaded-period-gates-must-never-be-unified.md) — published=`line|period` LIVE, uploaded=bare period HISTORY.
- 🔴 [3 recruitment candidate migrations APPLIED to prod 08-16 before #2162](recruitment-candidate-migrations-applied-to-prod-2026-08-16.md) — backfill RAN: 219 `new`·7 `shortlisted`·1 `rejected`.
- 🔴 [Candidate phone backfill RAN prod 08-16: 33→140, do NOT re-run](candidate-phone-backfill-and-the-two-traps-2026-08-16.md) — `->'phone'` is an OBJECT; `phone_norm` UNIQUE, no trigger.
- 🔴 [POS ONLY zero-pads codes to 10 digits; `compact_pharmacy_code` LIVE prod 08-16 (#2173)](pos-pharmacy-codes-are-zero-padded.md) — resolver stays TWO-PASS, SAVE stores the padded code.
- 🔴 [OpenAI credits RESTORED 08-16; 9 large-PDF re-reads now TIME OUT, not credits](openai-credits-exhausted-429-reads-as-rate-limit-2026-08-16.md) — do NOT raise `OPENAI_ROUTE_BUDGET_MS`.
- 🔴 ["zoomed in"=iOS focus-zoom; 16px portal input floor LIVE prod 08-16 (#2174)](portal-16px-input-floor-live-on-prod-2026-08-16.md)·[110-page mobile audit](portal-mobile-audit-remaining-tables-2026-08-16.md)

### Retired from the index 2026-08-17 (CLOSED, kept for the generalisation)
- 🔴 [A session deleted 6 branches MID-AUDIT 08-14; tag before ruling](rescue-tags-hold-four-deleted-branches-2026-08-14.md) — CLOSED·`git rev-parse ref:path` ECHOES the ref back even when the path is absent, so it proves nothing — use `git cat-file -e <ref>:<path>`.

### In-flight lines whose numbers moved here
- 🔴 [NEW SYSTEM decided 08-17 — settled, do NOT re-litigate](new-system-decision-2026-08-17.md) — same DB, HR core first; Phoenix is 110 days old, fix:feat hit **2.02**, root cause = **83 domains**; new repo's rules are MECHANICAL (7 enforcement tests before any feature code).
- 🔴 Deductions: [2 engines = DELIBERATE cutover](two-live-deduction-engines-p0.md) — never quote "EGP 1.87M" (real July = 5,967.73)·[`deductions_*` is truth BUT only legacy has the daily cron](deductions-canonical-but-legacy-has-the-only-daily-cron.md)
- 🔴 Incentive: [H1-2026 engine OUTSIDE the repo, grain=area×line](h1-2026-incentive-sales-analysis-engine.md) — merging areas across lines invented 220%·[S1 = 3 layers](semester-1-incentive-three-layers.md)
- 🔴 [`expense_claims` is the ONE live RLS-read exception](expense-claims-rls-read-path-is-live-in-prod.md) — its `authenticated` SELECT grant is CORRECT.

### Owner rules whose detail moved here
- 🔴 [Early Birds scores on TWO clocks — start=GPS, "#1 days"=paperwork; 12.2% of district-days flip](early-birds-runs-on-two-clocks.md) — the clock itself is CORRECT; owner ruling needed.
- 🔴 [Territory preview link is Pedia-pinned but must NEVER show the line](territory-preview-link-must-never-show-the-line.md) — LIVE prod 08-15 (#2148).
- 🔴 [Recruitment "new CV received" is in-app+Telegram, NEVER email](recruitment-cv-received-is-in-app-and-telegram-never-email.md) — LIVE prod 08-15 (#2155), hard-guard like Early Birds.
- 🔴 [Organogram CHART = AU seat model, DETAIL popup = directory — two sources](organogram-chart-source-is-au-seat-model-not-directory.md) — LIVE prod 08-16 (#2164); new fields go in the seat report.
- 🔴 [Field-force titles auto-provision their real role, LIVE prod 08-14 (#2139)](field-force-provisioning-live-and-guard-relaxed-2026-08-14.md) — DSM+Medical Rep only, guard DELIBERATELY relaxed.
- 🔴 [A regional trip TO Cairo earns NO outstation per-diem — LIVE prod 08-15 (#2160)](cairo-trip-no-per-diem-allowance-live-prod-2026-08-15.md) — Cairo GOVERNORATE only, allowance-only.
- 🔴 [A weekly batch HEADER is a stored column, not a view over its rows](weekly-batch-header-drifts-from-its-own-rows.md) — value drift now 0/51, count drift UNEXPLAINED.
- 🔴 [Weekly module audit 08-15 — headers match rows on all 51 batches](weekly-module-audit-2026-08-15.md) — 2,667 "price mismatches" are HISTORICAL PRICING·[Direct is NOT cumulative (#2157)](direct-is-not-cumulative-but-is-de-cumulated-anyway.md)
- 🔴 [Weekly + monthly keep SEPARATE alias tables](weekly-ignore-aliases-can-contradict-monthly-sos.md) — 3 fixed in prod 08-15; 48 June rows still read `IGNORE` but ARE Royanoxicam.
- 🔴 [`au.area_migration_map` still folds "Bani suef" into Fayoum](area-migration-map-predates-the-beni-suef-split.md) — 7 rows are ambiguous merges he must rule on.

### Org-structure lines whose detail moved here
- 🔴 [Organogram has TWO data paths — `suppressFilledVacancyRows` misses the org-chart page](organogram-has-two-data-paths-suppress-only-hits-vacancies.md) — `position_vacancies` has no name cols.
- 🔴 [Phantom-seat Fix #2166 LIVE prod 08-16](organogram-phantom-seat-fix-2166-live-on-prod-2026-08-16.md) — DSM-only suppression, never over-suppress reps; vac 175/251/276.
- 🔴 [Nosiba B-1 elevated to District Manager, LIVE prod 08-15](nosiba-b1-elevated-to-district-manager-2026-08-15.md) — an `ACTING_DM` seat alone gives ZERO sales scope.
- 🔴 [`user_access_profiles` silent-skips NULL-authid accounts; AI-0007 synced prod 08-15](access-profile-sync-gap-and-ai0007-fix-2026-08-15.md) — CN-0006/PD-0007/admin-HR still need it.

### Traps whose detail moved here
- 🔴 [A rejected-CV audit must check the Bulk/Junk folder too](cv-intake-rejection-audit-must-check-bulk-folder.md) — an intake "rejection" is often just delivery, and INBOX-only searching reports a false clean.
- 🔴 [A write REVOKE does NOT make a table read-only](a-write-revoke-does-not-stop-a-cascade-or-a-secdef-function.md) — CASCADE + SECURITY DEFINER both run as OWNER. Fixes LIVE prod 08-14 (#2136, #2137).
- 🔴 [Recruitment INTAKE works, its PIPELINE never has](recruitment-intake-works-pipeline-never-used.md) — 202/203 on the default status, free-text status is the cause.
- 🔴 [125 candidates RENAMED onto the CV + 34 enriched, LIVE prod 08-16](candidate-name-fix-and-field-apply-prod-2026-08-16.md) — `selectAutoApplyFields` writes 22-digit "phones"; that fix is still OPEN.
- 🔴 [6 staff-mailbox records SPLIT prod 08-16; do NOT split the remaining 14](forwarded-cv-split-applied-to-prod-2026-08-16.md) — read the `notes` body first; clear the phone off the colleague or `phone_norm` rejects.
- 🔴 [`.gitignore`'s `_wt-*/` hides a worktree — `git status` says CLEAN](gitignored-wt-scratch-makes-a-worktree-look-clean.md) — scan the FILESYSTEM·[repo-doctor's "no origin ref" = squash residue](repo-doctor-no-origin-ref-is-usually-squash-residue.md)
- 🔴 [A bare `git worktree add` can COMMIT but never PUSH](bare-worktree-cannot-push-pre-push-gate-needs-node-modules.md) — budget the ~60k-file install first.
- 🔴 [`worktree remove` "Permission denied" STILL deregisters — that's an ORPHAN, not a KEEP](worktree-remove-permission-denied-still-deregisters.md) — check the COUNT, not the exit code.
- 🔴 [CV preview "Failed to fetch" = a DOWNLOAD MANAGER, serve base64](cv-file-route-downloads-unless-asked-inline.md) — LIVE prod 08-14.

## Index caveats trimmed 2026-08-19 — the FULL wording (nothing here is retired)

`MEMORY.md` had grown back to 23.3KB against a 24.4KB read ceiling and was compacted again on
2026-08-19. **Every link survived in the index** — only the trailing detail moved here. Each line
below is the **verbatim pre-compaction index line**. Read the matching line here before touching,
reverting, or re-deriving any of these. All are still current; none were closed by the compaction.

- 🔴 [NEW SYSTEM decided 08-17 — settled, do NOT re-litigate](new-system-decision-2026-08-17.md) — same DB, HR core first; the new repo's rules are MECHANICAL.
- 🔴 Email: [NEVER fire bulk/test emails — ever](never-fire-bulk-emails-ever.md), audit READ-ONLY·[both reduction cuts LIVE](email-inventory-audit-2026-08-13.md), probation email OFF is an OWNER RULE
- 🔴 Incentive: [H1-2026 engine OUTSIDE the repo, grain=area×line](h1-2026-incentive-sales-analysis-engine.md)
- 🔴 Office: [OWNER'S RULE (#2015), DOUBLES any placement error](owner-office-allocation-rule-value-share.md)
- 🔴 [EZ `1011654` is now HELIOPOLIS](ez-warehouse-1011654-is-nasr-city-locked.md), hold out of bulk loads·[his "Stores"=`Office`, his "UPA"=EG-HOS/SF-T channel](owner-sheet-vocabulary-stores-is-office-upa-is-a-channel.md)
- 🔴 Outstation: [approving a request MANUFACTURES a fake Excel upload](outstation-expenses-two-data-models.md)
- 🔴 LIVE prod, don't undo — **master data:** [Master Map sheet PULLS via its own Apps Script #2178/#2179/#2181](master-map-sheet-live-on-prod-2026-08-17.md) — Phoenix never pushes, no Google credential anywhere; never drop the hourly check or either merge guard; a shop has THREE district managers; `Upper Egypt 1`+`2` ≠ `Upper Egypt` BY DESIGN.
- 🔴 [SoS 20-agent audit PAUSED, 247 findings salvaged](sos-deep-audit-paused-checkpoint.md)
- 🔴 [Deploy applies NO migrations](railway-deploy-applies-no-migrations.md) — by hand BEFORE merge
- 🔴 [Google Maps keys in GCP `phoenix-hr-2026`](google-maps-keys-moved-to-phoenix-hr-2026.md), BUILD-baked
- 🔴 [`mcp__supabase-staging__*` FIXED 2026-09-12 — was a WRONG-ACCOUNT token, not a broken server](supabase-staging-named-server-broken-2026-08-10.md); now pinned to staging, call it DIRECTLY with **no `project_id`** — stop routing staging through the prod server·[`expense_claims` is the ONE live RLS-read exception](expense-claims-rls-read-path-is-live-in-prod.md)
- 🔴 [`sales_records` RLS hoisted to InitPlan](sales-records-rls-hoist-applied-to-prod-2026-08-13.md), do NOT undo — 4 Railway ops traps sit in § Org / email.
- 🔴 [DIRECT ORDER PRICING LOCKED](direct-order-pricing-rule-locked.md) — factory price BANNED
- 🔴 [Ready-sheet >25th FULL-PAY waiver = GENUINE resignations ONLY](resignation-full-pay-rule-is-resignation-only.md) — other leavers stay prorated + ZERO allowances.
- 🔴 [Early Birds scores on TWO clocks, 12.2% of district-days flip](early-birds-runs-on-two-clocks.md)
- 🔴 [Territory preview is Pedia-pinned, NEVER show the line](territory-preview-link-must-never-show-the-line.md)·[Organogram CHART = AU seat model, DETAIL popup = directory](organogram-chart-source-is-au-seat-model-not-directory.md)
- 🔴 LIVE prod, don't undo: [A District Manager's chain drops the CEO but NEVER the NSM](dm-approval-chain-drops-the-ceo-never-the-nsm.md) — #2149 skipped the step for all 17 DMs and deleted the NSM for the 3 under an RSM; #2196 + 2 repaired prod requests.
- 🔴 Approval chains: [the FULL sweep — prod has exactly 3, and `offer-approval.ts` is wired to NOTHING](approval-workflow-sweep-2026-08-19.md)·[a direct order with no manager on record climbs SFE→CEO with NO sales line, silently — #2198](direct-order-chain-drops-the-whole-sales-line-silently.md)
- 🔴 LIVE prod, don't undo: [Salim B-76 can raise a Direct Order in Alex-BHR via a CODE grant, never the seat map](direct-orders-extra-area-grant-live-on-prod-2026-08-19.md) — #2204; one seat per area per line, so a seat-map move would strip Sara Samir B-156.
- 🔴 [Field-force titles auto-provision their real role](field-force-provisioning-live-and-guard-relaxed-2026-08-14.md), DSM+Medical Rep only·[a regional trip TO Cairo earns NO outstation per-diem](cairo-trip-no-per-diem-allowance-live-prod-2026-08-15.md), Cairo GOVERNORATE only
- 🔴 [`source_of_sales_bricks` is the AUTHORITY for branch→area](sos-bricks-are-the-authority-for-branch-to-area.md)
- 🔴 [4 brick names exist in 2 areas](sos-duplicate-brick-names-are-decoys.md)·[`au.area_migration_map` still folds "Bani suef" into Fayoum](area-migration-map-predates-the-beni-suef-split.md)·[`public.areas` had NO UE9 either — repaired in prod 08-19, don't undo](public-areas-never-got-the-beni-suef-split.md)·[the vacancy guard used to ABORT any HR edit it could not open a vacancy for — fixed #2195, `23505` meant TWO different things](terminal-vacancy-guard-makes-six-employees-uneditable.md)
- 🔴 [Organogram has TWO data paths, `suppressFilledVacancyRows` misses the org chart](organogram-has-two-data-paths-suppress-only-hits-vacancies.md)
- 🔴 [Phantom-seat Fix #2166 LIVE prod](organogram-phantom-seat-fix-2166-live-on-prod-2026-08-16.md) — DSM-only suppression, never over-suppress reps.
- 🔴 [`user_access_profiles` silent-skips NULL-authid accounts](access-profile-sync-gap-and-ai0007-fix-2026-08-15.md) — CN-0006/PD-0007/admin-HR still need it.
- 🔴 [`public.users` is DEAD and EMPTY — 0 rows](public-users-table-is-dead-and-empty.md) — querying it says "no account" for EVERYONE; login truth is `user_access_profiles` + `auth.users`.
- 🔴 [Error Monitor HIDES `environment IS NULL` rows](error-monitor-hides-null-environment-rows.md) — use `is distinct from`
- 🔴 [ONE `banned_until='infinity'` row 500s the WHOLE auth admin API](banned-until-infinity-breaks-the-whole-auth-admin-api.md) — page-shaped, so small probes falsely pass; repaired on prod admin-HR 08-19, the app only ever writes `876000h`.
- 🔴 [A write REVOKE does NOT make a table read-only](a-write-revoke-does-not-stop-a-cascade-or-a-secdef-function.md) — CASCADE + SECURITY DEFINER both run as OWNER.
- 🔴 Marketing, LIVE prod: [the `not_found` override finally has a UI #2185](marketing-unverified-code-override-has-a-ui-2026-08-18.md)·[the chain's stop role is SALES-ONLY — marketing submitters got MM+CEO twice, CEO first; #2190 + 2 prod requests repaired](marketing-manager-chain-target-is-sales-only.md)
- 🔴 Marketing, owner rule 08-19: [nothing may block a request once the CEO approves](nothing-blocks-a-marketing-request-after-the-ceo.md) — Finance Execution now has Return AND Reject off·[recording a decision by RPC fires NO alert and NO audit row](recording-a-marketing-decision-by-rpc-skips-audit-and-alerts.md)
- 🔴 LIVE prod, don't undo: [العروبة-عابدين is ONE shop — both codes restamped Sohag1→Girga, 507 units](orouba-abdeen-restamped-to-girga-2026-08-19.md) — a placement fix is a ROLLUP restamp not a map edit; FOUR layers move together (`_distributor_product_rollup` has no `client_code`); July unlocked+relocked, snapshots identical; NEVER repair a layer gap with `phx_refresh_sos_*_rollup`.
- 🔴 [The pharmacy code reference list is a STALE IMPORT, last loaded 07-29](marketing-reference-list-is-a-point-in-time-import.md) — a `not_found` is often OUR gap, not a typo; it BLOCKED a live DSM submission 08-19. Tell them apart by the numbering GAP, and name-match via `source_of_sales_customer_map` (the reference table has no name).
- 🔴 [A `not_found` code has THREE root causes — chimipharm can NEVER match (0 reference rows)](marketing-not-found-codes-have-three-root-causes.md) — try `ltrim(code,'0')` against OTHER distributors; GPS beats name beats code, and read the geocoded TOWN not the markaz; 23→8 on prod 08-19, the 8 left are seed rows with ZERO requests — UNPROVABLE not unexamined, only new field GPS can close them.
- 🔴 LIVE prod, don't undo: [the master resolver now runs at write time #2210](marketing-master-resolver-never-runs-automatically.md) — it sat uncalled 10 days and 28 codes piled up NULL; its 2 guards (never throws, never null `p_code_ids`) are load-bearing; `area_id` is the OWNER's area, not the shop's; nothing READS `mapped_*` yet.
- 🔴 LIVE prod, don't undo: [4 duplicate pharmacies merged 08-19, backup in `marketing_rollback`](marketing-pharmacy-duplicate-merge-applied-2026-08-19.md)·[a duplicate is proved by NAME+GPS+shared codes, NEVER by brick](duplicate-pharmacy-test-is-name-and-gps-not-brick.md) — البدراشين is ONE brick, `geo_bricks` is EMPTY.
- 🔴 [Marketing Manager A-9 OUTRANKS Product Manager A-10 — owner confirmed, do NOT invert](marketing-manager-outranks-product-manager.md) — a CC rung printing the reviewer's title made it look otherwise; #2209 fixed the label, 2 prod rows repaired.
- 🔴 [WhatsApp forwarder Omar `201280955558` collapses every CV onto ONE candidate; queue PARKED 08-18](whatsapp-forwarder-omar-collapses-cvs-onto-one-candidate.md) — fix = add him to `RECRUITMENT_WHATSAPP_IMPORT_SENDERS`, don't blind-release the 303 parked rows.
- 🔴 [PROD Supabase has PITR **OFF** — 7 daily snapshots only](production-supabase-has-no-pitr-only-daily-backups.md); never restore a daily in place.
- 🔴 Recruitment: [a candidate keeps the SENDER's name + NULL phone BY DESIGN](intake-candidates-never-get-phone-applied.md)·[125 renamed + 34 enriched, 22-digit phone fix still OPEN](candidate-name-fix-and-field-apply-prod-2026-08-16.md)·[the scripts are in `scripts/`, their run reports live OUTSIDE git](recruitment-cv-reread-run-reports-live-outside-git.md)
- 🔴 [a grid item holding NOWRAP text needs `min-w-0` or it eats the mobile column](portal-grid-items-need-min-w-0-for-nowrap-cards.md)·[renaming a nav label changes its persisted moduleId](renaming-a-nav-label-changes-its-persisted-moduleid.md)
- 🔴 [a role probe CANNOT trust the HTTP status](a-role-probe-cannot-trust-the-http-status-code.md) — grep the body.
- 🔴 CI: [`secret-scan` is OFF the PR; gate is 2](github-personal-account-no-ghas-oss-scanning.md)·[`gh pr checks` LAGS the real job state](gh-pr-checks-lags-behind-the-real-job-state.md)
- 🔴 git: [deleting a branch does NOT remove its commit — `refs/pull/N/head` keeps it forever](deleting-a-branch-does-not-remove-a-pushed-commit.md)·[never reuse a squash-merged branch](reusing-a-squash-merged-branch-makes-a-conflicting-pr.md)·[BLOCKED=BEHIND, not red CI](merge-blocked-says-checks-but-means-behind.md)
- 🔴 Validation: [**BOTH local gates REMOVED 08-18 — `check:harden` AND the pre-push hook; CI is the gate**](local-validation-gates-are-gone-ci-is-the-gate.md)·[`setState` in `useEffect`=lint ERROR](set-state-in-effect-is-a-lint-error-here.md)
- 🔴 [Another SESSION can remove a worktree under you — `.git` vanishing is NOT corruption](another-session-can-remove-a-worktree-under-you.md) — stop, do not race it; clear the husk after.
- 🔴 Worktrees: [`--strip-idle`/`--fix` need ONE session and `--force` is classifier-blocked](repo-doctor-strip-idle-cannot-run-with-sessions-open.md)
- 🔴 [Blind coordinate clicks fired PROD, click by TEXT](blind-coordinate-clicks-fired-a-production-collection-run.md)·[dev-auth is HEADER-only](dev-auth-is-header-only-browser-pane-cannot-use-it.md)

## Orphan sweep 2026-08-19 — every memory file that had no pointer anywhere

194 memory files existed on disk with **no link from `MEMORY.md` or from this archive** — they
were written, then became unreachable. This section gives every one of them a pointer, so the
whole memory directory is now reachable by grep. Each hook is the file's own `description`.
Nothing was deleted. The first group is history whose platform no longer exists — those files
also carry a `SUPERSEDED` banner at the top of the file itself.

### Dead platform — Vercel / Cloud Run / GCP / Sentry / npm era (history only, do NOT act on these)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — Config audit + Sentry retirement — what was APPLIED 07-31, what is still owner-only, Healthchecks gate before merging PR #1514](claude-config-audit-2026-07-31.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — phoenix-hr + phoenix-hr-staging Cloud Run now run as a dedicated least-privilege SA (phoenix-hr-run), split from the compute SA which stays the CI deployer/builder.](cloud-run-runtime-sa-least-privilege.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — CRON_SECRET rotation 401'd every cron for ~14 min. RESOLVED. Cloud Run was pinned to a secret version that got disabled — always use secretKeyRef latest.](cron-secret-rotation-broke-all-crons-2026-07-31.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — workflow_dispatch on deploy-cloud-run.yml silently skips unless CI has ALREADY concluded success on the current head of main](deploy-dispatch-gate-checks-ci-on-head-commit.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — Merge→live latency is dominated by the 2-hourly deploy cron, not compute — and both compute levers (E2_HIGHCPU_8, larger GitHub runners) are empirically unavailable on this project](deploy-speed-levers-audit-2026-07-30.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — Two gcloud commands print live secret values to stdout even with a restrictive --format: `run services describe --format=json` and `services api-keys create`. Both caused real exposures on 2026-07-31. Use the safe forms here.](gcloud-commands-that-leak-secrets-into-transcripts.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — 2026-07-16 GCP hardening pass — secrets to Secret Manager, min-instances=0 (near-free), budget, AR cleanup, unused APIs disabled, dual alert channel.](gcp-hardening-2026-07-16.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — Full-chain perf audit (22-agent workflow) — measured causes of prod slowness + prioritized fix plan; AWAITING owner approvals](gcp-speed-audit-2026-07-17.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — Healthchecks.io cron-liveness monitor is LIVE and configured (8 checks, Cairo cron, email+Telegram) — unblocks the Sentry-retirement PR](healthchecks-live-8-checks-configured.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — npm→pnpm 11 migration (PR](pnpm-migration-2026-07-17.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — Production Cloud Run deploy triggers on schedule + manual workflow_dispatch, NOT on push/merge — a merge is not live until the next scheduled or manual deploy](prod-deploy-scheduled-not-on-push.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — phoenix-hr prod's --min-instances was dropped from 1 to 0 for cost savings (2026-07-16), reintroducing the cold-start risk the setting was originally added to eliminate.](prod-min-instances-dropped-to-zero-2026-07-16.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — Verify prod Cloud Run traffic at europe-west3, NOT us-central1 (stale standby)](prod-verify-region-europe-west3.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — Removing Sentry.withMonitor left 7 server-side Sentry cron monitors alive — they now fire false "Cron failure" outage alerts. Must delete them in Sentry.](sentry-orphaned-cron-monitors-false-outage-alerts.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — Staging auto-deploys from main and wipes unmerged branch previews; pin the branch revision with a durable custom Cloud Run tag for a stable URL.](staging-churn-pin-branch-with-cloud-run-tag.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — Staging Cloud Run deploy failures are usually a transient Cloud Build get-requests 429 quota, not a code bug — they self-heal on retry.](staging-deploy-cloudbuild-429-transient.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — Staging does NOT auto-deploy on merge — it runs daily 03:40 UTC and reuses the prod-built image; prod ships every 2h. Corrects a stale AGENTS.md claim.](staging-deploys-daily-0340-utc-from-prod-image.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — Preview deploys now HAVE Supabase env (fixed as of 2026-07-04, was previously missing); use the deployment URL not the branch alias to avoid CSRF block.](vercel-preview-env-and-branching.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — Vercel plan tier has flip-flopped before — confirm live, don't trust old notes; plus how to manually push latest main to prod when auto-deploy lags](vercel-pro-and-deploy-recovery.md)
- [SUPERSEDED (Vercel/Cloud Run/GCP era) — TWO Vercel workspaces exist; live prod is under phoenix-hr-workspace-s-projects (AGENTS.md scope is stale). Stale old deployment deleted 2026-07-04. SMI fast-table flag already live; CEO center bypasses it.](vercel-workspaces-and-smi-flag.md)

### SoS, bricks, sales attribution & direct orders
- [Anti-infective line display spelling standardized to 'Anti Infective' across code + 45k prod rows (PR #1125, 2026-07-18)](anti-infective-canonicalization.md)
- [Brick lat/lng are Google guesses from the brick NAME, validated only at governorate level. 302 bricks sat on 94 shared fallback pins (16 on one). Real coverage is 34.8%, not 61%.](brick-coordinates-are-geocoded-guesses.md)
- [Admin Command Center slowness was an O(n²) sales-ownership re-indexing bug; fixed via WeakMap memo. Where to look if perf regresses.](command-center-perf-on2-sales.md)
- [How "Delta (3)" / D3 sales region was added (7th DSM) — forward-only brick carve-out, snapshot mechanism.](delta3-region-carveout.md)
- [A direct order's sales month is chosen by Ahmed El Maraghy (B-185) or Super Admin — never derived from the approval date. Changing it must rebuild BOTH periods.](direct-order-sales-month-is-finance-owned.md)
- [Phase C (direct-order sales injection) — owner wants ENGINE-accurate direct attribution (not the is_direct=false workaround) + weekly push. Design + owner decisions.](direct-orders-phase-c-injection-design.md)
- [Pre-July 2026 Direct orders are taken static/as-is from the MANUAL closing (manual wins over Phoenix's own import); from August Direct comes ONLY from Phoenix, finance-confirmed to correct brick/area/region/value](direct-orders-pre-july-from-manual-post-august-from-phoenix.md)
- [GAP (owner-flagged 2026-07-18) — Direct orders attribute at region level only; reps/DMs get ZERO direct share. ~25% Anti, ~30% Pedia value orphaned.](direct-orders-region-only-no-rep-attribution.md)
- [Direct sales rows carry area_code = '' (empty string), never NULL — an `is null` predicate silently routes 100% of direct money the wrong way](direct-sales-area-code-is-empty-string-not-null.md)
- [A DM/RM's sales scope is one geographic region name, so operationally-assigned out-of-region areas (e.g. Saad Salama's Kafr El-Sheikh) vanish from every SoS-driven surface](dm-sales-scope-drops-out-of-region-areas.md)
- [Never index GOVERNORATE_TO_REGION directly — use resolveGovernorateRegion. Raw exact-match lookups silently rejected 'Al-Sharqia'/'Kafr El-Sheikh'/Arabic names (PR #1414, MERGED).](governorate-region-canonical-resolver.md)
- [Employee-org import re-created the duplicate "Anti Inf" lines row; fixed at lineRules (PR](lines-import-canonicalization.md)
- [God-mode customer mapping build (geo cache, distance confidence, propagation, auto-apply, clusters) — shipped 2026-07-02, prod-live.](normalizer-godmode-customer-mapping.md)
- [/admin/sales-command 'Failed to load Source of Sales data' = Postgres 57014 statement timeout: authenticator role caps EVERY app query at 8s; exec aggregates were too slow + rpcAll re-ran them per page. Fixed via DB timeout override + indexes + single-pass rpcAll + lite comparison mode. PR #74.](sales-command-statement-timeout.md)
- [The SATO Pharma sales-consolidation task on the user's Desktop — two folders, data model, duplicate-folder map, canonical files, locked rules, and the repeatable-pipeline plan.](sales-consolidation-desktop-data.md)
- [Sales and Marketing product codes are UNIFIED (sales is canonical) as of PR #763 — history of the old divergence and the guard against regression](sales-marketing-product-code-namespaces.md)
- [Multi-finding security review of sales/export permission gates; tracks which findings are fixed vs still open.](sales-permission-security-audit-2026-07.md)
- [How to map a manual sales/collections sheet row to the medical rep who covers it — the proven join paths, and which ones actually work](sales-sheet-rep-mapping-join-paths.md)
- [Authoritative per-manager region scope (sales_manager_region_scope) drives weekly+monthly sales visibility; region-scoped roles fail-closed; SHIPPED PR #357.](sales-territory-scope-build.md)
- [Two sales upload pages exist; the sidebar 'Sales Upload' opens /sales/upload (NOT /sales/import). The weekly-style 3-step wizard now lives on /sales/upload.](sales-upload-two-pages-weekly-wizard.md)
- [THE RULE: a place name resolving to two different bricks must resolve to NOTHING, never to a guess. Egypt reuses names across governorates; 12 such pairs are live and correct.](sos-ambiguous-place-name-rule.md)
- [A Source-of-Sales client_code is only unique WITHIN a distributor — joining on it alone attributes one pharmacy's sales to another.](sos-client-code-is-not-unique-across-distributors.md)
- [SoS customers split into Stores vs Pharmacies by six Arabic name keywords, derived at read time — one constant re-classifies all history.](sos-customer-channel-store-vs-pharmacy.md)
- [SoS upload "Export unmapped (XLSX)" shipped to prod (PR](sos-export-unmapped-and-xlsx-pattern.md)
- [SoS import coverage read 100% by construction and wasn't recorded on the real path. Fixed by computeBrickCoverage + a row-reconciliation gate (PR #1451).](sos-import-coverage-metric-was-fake.md)
- [The owner-approved 7-phase plan to make the Source-of-Sales upload the "perfect module", with decisions + ship progress.](sos-perfect-module-plan.md)
- [All Source-of-Sales transaction data was purged from PRODUCTION on 2026-07-28 for a clean re-upload; RESOLVED — re-upload landed same day. Backup schema sos_backup_20260728 kept as a reference, not currently needed for recovery.](sos-sales-purged-for-fresh-upload-2026-07-28.md)
- [33 underscore-prefixed SoS scratch tables sat in public with RLS off and SELECT granted to anon — real data was readable over the internet with the publishable key until 2026-07-30](sos-scratch-tables-were-anon-readable.md)
- [The whole SoS stack — normalizer aliases, brick centroids, customer map, fact rollup — still points at the pre-2026-07-27 bricks, not the 627-brick master](sos-system-still-trained-on-old-bricks.md)
- [source_of_sales_territory_aliases IS the brick alias table (all target_type='brick'). Never build a second one — and repoint target_code when deleting bricks.](sos-territory-aliases-is-the-brick-alias-table.md)
- [Store customers' sales divide evenly across the AREAS of the store's city, per product per month — not 100% to the one area's rep.](store-sales-split-evenly-across-city-areas.md)
- [`db.<ref>.supabase.co` has NO IPv4 record for either Phoenix project — any direct Postgres connection dies with `getaddrinfo ENOTFOUND`. Use the session pooler; staging is aws-0, production is aws-1.](supabase-direct-db-host-is-ipv6-only-use-pooler.md)
- [Weekly Sales facts are at distributor-BRANCH (depot) grain with no area/brick/customer, so area scoping needs an owner-maintained branch→area mapping](weekly-sales-has-no-area-grain.md)

### Payroll, incentive, vacation & HR lifecycle
- [Amira.Samy (French Line / C) CRM agent maps to HR_ID CN-0005 — owner-provided fix for the unmapped-agent CRM issue.](amira-samy-crm-identity-cn-0005.md)
- [The B-157 NSM-resignation "stale occupant" audit — naive resolver never existed; real latent bug was line_area_map double-count; new canonical as-of resolvers](au-seat-occupant-period-aware-resolvers.md)
- [FAB + CIB literal bank-transfer sheet exports built for Automated Payroll, uncommitted, awaiting a Non-Employees Payroll edit before shipping](automated-payroll-fab-cib-bank-sheets.md)
- [Fixed leaver medical insurance silently never deducted when a resigned employee's whole settlement collapses into First Part with no Second Part left](automated-payroll-leaver-medical-insurance-fix.md)
- [New "Automated Payroll" HR wizard module — brand-new stepped Part1/Part2 monthly salary sheet, built from scratch, reuses payroll logic](automated-payroll-module-build.md)
- [Fixed real over-deduction bug in resignation CRM (was charging post-resignation days); new dedicated Resignations CRM tab, unified Base÷actual-month-days rate](automated-payroll-resignation-crm-bug-fix.md)
- [B-155 (Ahmed Sharaf) is the Product Manager for 2 SPECIFIC cross-line products (not a two-line PM) — LIVE in production since 2026-07-03](b155-two-line-pm-scope.md)
- [PR #1464's streaming CRM export shipped to prod and corrupted files on large exports — root cause + the general lesson on testing streaming code](crm-export-streaming-corruption-incident.md)
- [New /admin/crm-integrity report (PR](crm-integrity-module.md)
- [CRM read door now hides departed reps via live employment-status UNION static list; PR](crm-live-departed-agent-exclusion.md)
- [~80 iReports360 CRM agent display-names the owner flagged as RESIGNED — must be excluded everywhere in CRM data (incl. CRM Issues), as if invisible.](crm-resigned-agents-exclusion-list.md)
- [Employee 360 god-mode expansion — PR](employee-360-godmode.md)
- [System-wide audit found nickname-fallback display correct in only ~10% of the codebase; 4 root causes explain most of ~150 gaps; Phase 1 fix shipped as PR #1129](employee-nickname-display-audit.md)
- [Employee-portal responsive-table pattern + audit false-positive traps (nowrap, calendar UTC, month-year locale)](employee-portal-mobile-audit.md)
- [The incentive payout window was `allTimeTrend.slice(-6)` — the last six months of data that happened to exist — so 27 of 83 reps were scored over a shorter semester than their colleagues](incentive-semester-was-last-6-loaded-periods.md)
- [Adding an employee is a 6-step chain with three silent breaks; Talent Acquisition could never finish a hire alone](new-hire-gets-no-organogram-seat-unless-replacing-someone.md)
- [Anti Infective/Pedia/CNS organogram area reconciliation (2026-07-06) — fixed structure counts, shared-geography pattern, Nosiba Salah acting-DM, pending Pedia/CNS fix](organogram-3line-reconciliation-2026-07.md)
- [Organogram deep-audit god-mode fixes — branch/worktree, what shipped, what's deferred, rebase-needed drift.](organogram-godmode-fixes.md)
- [Organogram area seats are FIXED — filled/vacant is decided by live occupancy, never by the mutable position_vacancies.status. Two gates hid resigned areas.](organogram-vacancy-occupancy-truth.md)
- [Outstation SUBMIT notifies (`notifyOutstationSubmitted`, four call sites); the payroll-import sender was DELETED 2026-09-19 at the owner's instruction and a test pins it gone - `expenses.ts` sends nothing at all, and a new expense notification is new work with channels agreed first.](outstation-payroll-notifications-dead-code.md)
- [A salary batch's membership is fixed when the batch is built — never re-derive it from today's employment status, or leavers vanish from months they were paid for (incl. the bank file)](payroll-batch-membership-is-historical.md)
- [Payroll Copilot "1/10 → usable" recovery — audit findings, the confirm/hold DB-constraint bug, and the recommendation-engine rebuild](payroll-copilot-recovery-2026-07-07.md)
- [Full-codebase sweep (7 parallel agents) for resigned/terminated employees leaking as active; ALL items now shipped+merged to main 2026-07-18: 6 original fix PRs, sales/payroll resolver follow-up (#1151), CRM live-exclusion follow-up (#1153), and WP-6 flag flip (#1157) — audit fully closed](resignation-employee-leak-audit-2026-07-18.md)
- [Prod v2_vacation_requests was missing weekly_off_policy_snapshot col + dup-active index even though migration 20260523220000 was RECORDED as applied — schema drift. Backfilled 2026-06-10. Blocked all vacation submissions (0 rows in prod).](v2-vacation-prod-schema-drift.md)
- [Owner rule: Organogram/AU seat model is the fixed source of truth for org-structure+vacancy data — any future reconciliation fix must change the Vacancy Report / position_vacancies side, never Organogram.](vacancy-report-fixes-flow-away-from-organogram.md)
- [collectUnpaidVacationCandidates has two sources that can both claim one employee-day; the dedup guard is one-directional, so re-running it on a month that already has CRM-signal rows creates duplicates.](vacation-connector-two-sources-one-day-duplicate.md)

### Approvals, workflow, marketing & outstation
- [A 'complete'/'validated' status column earned from METADATA (a filename, a flag) while the artifact it claims was never stored — has hit marketing evidence and outstation photos](completeness-flag-granted-on-metadata-not-artifact.md)
- [Full worktree-orphan audit of F:\Phoenix Workforce + F:\ root (2026-07-31): 94 dead worktree folders verified safe, plus a critical unrotated-secrets folder found in passing. Deletion list presented as artifact, awaiting owner approval — nothing deleted yet.](disk-hygiene-sweep-2026-07-31-94-orphans-pending-approval.md)
- [SUPERSEDED 2026-09-16 — the old ask-before-every-git-action rule; commit, push and the PR are automatic now, merge still needs approval](feedback-auto-git-workflow.md)
- [How marketing notification emails are built — editable admin tokens + templateContext passthrough + sanitizer limits.](marketing-email-editable-tokens.md)
- [Prod marketing requests were wiped 2026-06-24 and restored from backups/json on 2026-06-28; how to redo it.](marketing-requests-prod-wipe-restore.md)
- [Report It pharmacovigilance ADR reporting module — current build state, files, and pending steps](report-it-module-build.md)
- [Approval chains have TWO sources of truth — TypeScript and the workflow_registry_modules table — and changing a chain in code without a registry migration silently wedges the module](workflow-registry-drifts-from-the-typescript-chain.md)
- [A BEFORE UPDATE trigger owns workflow_registry_modules.version — setting it in a migration is silently ignored, and splitting one change across N UPDATEs bumps it N times.](workflow-registry-version-is-trigger-owned.md)

### Migrations, Supabase, RLS & database behaviour
- 🔴 [Supabase BLOCKS the slow-query logging GUCs](supabase-blocks-slow-query-logging-gucs.md) — `log_min_duration_statement` and friends cannot be set, so profile from `pg_stat_statements` instead.
- [After EnterWorktree, ambient Bash/Glob/Grep cwd can silently revert to the primary repo mid-session — observed right after background Agent-task-failure notifications arrived, with no EnterWorktree/ExitWorktree call in between](bash-cwd-drift-after-background-notification.md)
- [Two parallel migrations that each drop+recreate the same CHECK constraint from an independently-hardcoded key list can collide — the second-applied one silently omits whatever key the other branch added, unless someone manually reconciles the lists before merging.](check-constraint-drop-recreate-collides-across-branches.md)
- [Docs described an old birthdays+contract-renewals cron pair; live vercel.json has evolved to daily-consolidator + 30-min outbox-drain. Fixed 2026-07-02.](cron-docs-drift-2026-07.md)
- [DB/data-model audit fixes shipped to prod 2026-06-15 (PR 182)](db-data-model-hardening-2026-06-15.md)
- [drift check RED twice for DIFFERENT reasons — 2026-08-01 anon-exposed backups (FIXED 08-04); 2026-08-11→08-23 was zz_ tables with NO anon grant + 22/29 ledger noise (PR #2328)](drift-check-red-is-a-live-prod-anon-exposure.md)
- [Keyset-paginating a Supabase/Postgres query by ORDER BY id is only fast if id is part of the query's actual filter index — otherwise it silently abandons the real index](keyset-pagination-orderby-id-trap.md)
- [The daily Migration Drift Check ran against STAGING only and was green for a week while production was missing a migration — the staging proxy is backwards, because staging-first means the normal drift is applied-on-staging/missing-on-production.](migration-drift-check-was-staging-only.md)
- [Concurrent Claude Code sessions on this repo can pick the exact same round migration timestamp independently, failing CI's duplicate-timestamp guard after merge](migration-timestamp-collision-hazard.md)
- [Deploying PR](pr24-supabase-bridge-prod-lockout.md)
- [Prod Supabase MCP token owns BOTH prod and staging projects — drive staging DB via prod MCP with project_id=staging when the staging MCP token is wrong-account; hold code-coupled destructive migrations until merge](prod-mcp-token-owns-staging-supabase.md)
- [❌ FULLY REFUTED 2026-08-01 by direct measurement — the old protected-files phrase authenticates NOTHING on staging (0/144, 0/12) OR production (0/144, 0/147), and it is NOT prod's ADMIN_USERNAME as claimed. Nothing is owed; the only rule left is never reuse the string. Filename kept so existing wiki-links resolve.](protected-files-phrase-was-a-live-credential.md)
- [Railway prod topology after the 2026-08-01 GCP cutover — two services, a hand-rolled cron, and the Railway CLI recipe that automates variable restores](railway-migration-live-topology-and-cli.md)
- [A reference/DTO builder that maps most fields but silently omits one causes that field to be null everywhere downstream, with no type error — verify end-to-end through the real pipeline, not hand-built mocks.](silent-null-field-reference-builder-bug.md)
- [✅ RESOLVED 2026-07-31. For three weeks (07-11 → 07-31) staging had ZERO RLS policies, FKs and triggers, so every staging RLS/preview-smoke pass in that window proved nothing. Repaired IN PLACE — not rebuilt — which matters for what it did and did NOT rotate.](staging-is-a-schema-skeleton-not-a-clone.md)
- [Full 10-dimension prod Supabase audit (ultracode, 22 agents): free-only fix plan + verified do-NOT-touch list so future audits don't re-flag healthy things.](supabase-deep-audit-2026-07-04.md)
- [How to unit-test Supabase-backed code in this repo — which functions ARE behaviourally testable, why you must never stand up a real client in a test, and the established source-shape convention for DB-backed paging loops](test-seams-for-supabase-backed-code.md)

### Worktrees, parallel sessions, git & CI
- [Hard rules every AI session must enforce to prevent Git/test/PR damage — root-caused from 2026-06-14 cleanup session where 15 orphaned worktrees, 3 broken tests, 1 DIRTY PR, and 2 unreleased features were recovered](ai-tool-damage-prevention.md)
- [GHSA-mh99-v99m-4gvg (brace-expansion DoS, patched >=5.0.8) — forcing an override to 5.x breaks minimatch@3.1.5, shared by eslint's config-array AND exceljs/archiver's zip handling (production xlsx export). Already fixed properly on main via pnpm.auditConfig.ignoreGhsas, not a version override.](brace-expansion-audit-fix-trap.md)
- [Worktree .claude/worktrees/sad-hopper-5d16b0 has no source files and no .git pointer — git commands run from it silently resolve UP into the primary checkout (another session's dirty branch). Verify before editing.](claude-worktree-sad-hopper-5d16b0-is-corrupt.md)
- [After context compaction, a replayed narrative of prior work can look like the current human turn — always re-verify against real git/process state before acting.](compaction-replay-mistaken-for-live-state.md)
- [A concurrent session checked out a different branch on the shared primary checkout mid-work, so my commit landed on the wrong branch — recovery recipe.](concurrent-session-branch-switch-recovery.md)
- [While fixing PR](concurrent-session-fixed-my-merge-bug-2026-07-19.md)
- [EnterWorktree switches the session's logical cwd, but Read/Edit/Write calls using an absolute primary-repo path still hit the primary repo, not the worktree](enterworktree-absolute-path-gotcha.md)
- [`git -C <dir> status --porcelain 2>/dev/null | wc -l` prints 0 when git FAILS, identical to a genuinely clean tree — it false-greened a worktree safety check before deletion. Test git's exit code, never count its output lines.](failed-git-piped-to-wc-l-reads-as-zero-dirty.md)
- [Doing everything right (isolated worktree, committed, pushed, PR opened) doesn't prevent collision when another parallel session fixes the same live incident first — check before merging](feedback-parallel-session-pr-collision.md)
- [User wants visible task tracking (TaskCreate + TaskUpdate) for every command, every session — permanently enforced via hook](feedback-task-tracker.md)
- [gh pr list's trailing timestamp column is createdAt, not mergedAt, even when the state column reads MERGED — use gh pr view --json mergedAt for the real merge time](gh-pr-list-timestamp-is-createdat-not-mergedat.md)
- [On this Windows machine, piping openssl/any generator into `gcloud secrets versions add --data-file=-` via the Bash tool appends \\r\\n — the stored secret is silently wrong and every consumer 401s. Caused a real ~14-min prod cron outage 2026-07-31. Always strip with tr -d '\\r\\n' and verify the byte length.](git-bash-crlf-corrupts-secrets-written-to-secret-manager.md)
- [The GitHub MCP server (plugin_github_github) authenticates as bot account Phoenix-HR, which has no access to it-gawish-hr/phoenix-people-workforce — use the gh CLI instead](github-mcp-token-wrong-account.md)
- [check:harden passed twice and then failed on the SAME code once the cache was cold — always confirm with `tsc --noEmit --incremental false` before claiming a branch is green](harden-can-false-green-on-a-warm-incremental-cache.md)
- [2026-06-27 — most "fix this part" tasks were already shipped by the parallel swarm; only line-scope was unique → PR](line-scope-fixes-pr544-and-swarm-redundancy.md)
- [CLOSED 2026-08-13 — _wt-office-lock is gone from disk and its 16 uncommitted files were committed and pushed as f2192ed6 on branch wip/office-differentiation. Nothing to protect any more; the general lesson (git status before retiring any worktree) still stands.](office-lock-worktree-is-live-do-not-retire.md)
- [A single terse approval ("merge 2480") reached THREE live sessions; one merged and shipped to production while this session still read validate as in progress. Hook now lives in AGENTS.md section 2.1 under Parallel sessions.](one-approval-can-reach-more-than-one-session.md)
- [Removed worktrees leave unregistered empty symlink skeletons under .claude/worktrees that git cannot see and that resolve git UP into the primary checkout](orphaned-worktree-symlink-skeletons.md)
- [Owner runs many concurrent threads at once and gets "condensed"/overwhelmed — minimize interruption cost per session and lean on existing multi-session safety rules rather than re-litigating them.](owner-heavy-parallel-workload-reduce-friction.md)
- [Dispatching many parallel Agent-tool subagents into the SAME worktree (no isolation) is fine for disjoint-file edits, but one subagent running `git stash`/`git reset` mid-flight can sweep up every other subagent's uncommitted work](parallel-agents-shared-worktree-stash-incident.md)
- [Two sessions fixed the same P0 permissions/CLAUDE.md on 2026-07-31 — how the collision surfaced and the merge (not rebase) resolution](parallel-session-pr-collision-1506-1508.md)
- [Multiple concurrent agent sessions share the PRIMARY working tree and clobber each other's uncommitted edits; isolate in worktrees + commit/push fast](parallel-session-swarm-hazard.md)
- [Owner-approved workflow — one local boss session, cloud sessions for parallel tasks, ≤2-3 worktrees with delete-on-merge CLEAN ritual](parallel-work-model-2026-07.md)
- [A session's stated 'worktree path' under .claude/worktrees/<name> can be an empty directory that git itself has never registered — verify with `git worktree list` before trusting it](phantom-worktree-not-in-git-worktree-list.md)
- [Claude_Preview MCP preview_start always launches from the fixed primary working directory, never the worktree you cd'd into — silently tests the wrong code](preview-start-ignores-worktree-cwd.md)
- [Reverting a prove-it-fails break with `git checkout -- <file>` wipes your own UNCOMMITTED fix along with the break — restore from a copy instead](prove-it-fails-never-git-checkout-the-fix.md)
- [A parallel session can `git checkout` a different branch in the SHARED main-repo working tree while you're mid-edit — re-verify HEAD/branch before every edit; work in your own worktree.](shared-checkout-branch-switched-midsession.md)
- [My own Grep/Bash/Read tool calls default to the primary checkout's currently-checked-out branch, which can be stale vs. origin/main — verify with git show/git grep origin/main, not just the working tree](stale-checkout-verify-against-origin-main.md)
- [When to run validation — typecheck only while he is still editing; the full gate is now CI’s job](validate-once-at-done-not-per-edit.md) — absorbed `validation-cadence-preference.md`, retired 2026-08-23 as a thinner duplicate
- [GOTCHA — codex/work-from-production is stale (64 commits behind main) with a parallel session active; ship production work from a FRESH branch off origin/main, never by merging codex/work-from-production.](work-from-production-branch-is-stale.md)
- [Deep one-by-one audit of 18 stale worktrees and their PRs on 2026-06-26 — recurring pattern is squash-merge leaving dangling branches that look unmerged but aren't.](worktree-audit-20260626.md)
- [A committed-and-pushed worktree (_wt-ceo-nsm-parity) lost its .git pointer file mid-session while another Claude Code session was active in the primary folder — no work lost, but the worktree became unusable.](worktree-corruption-parallel-session-2026-07-05.md)
- [A node_modules junction into another tree lets tsc/eslint/test pass but FAILS `npm run build` (Turbopack); do a real npm ci per worktree.](worktree-junction-breaks-turbopack.md)
- [Counting traps that gave wrong answers when measuring repo bloat; the facts themselves now live in AGENTS.md](worktree-payload-is-the-repo-slowness.md)

### UI, design, portal & browser verification
- 🔴 [A MINIMIZED or occluded Chrome window makes every browser measurement lie](a-minimized-window-makes-every-browser-test-lie.md) — `visibilityState` reads `hidden`, so `setTimeout` throttles to ~1/s, `requestAnimationFrame` stops at **0 frames**, screenshots time out and dnd-kit cannot drag at all. Produced FOUR false diagnoses in one session (a 998ms "layout cost" that was really 5ms). Check `document.visibilityState` before believing any timing, hydration read or screenshot.
- 🔴 [An ExcelJS row OUTLINE makes Excel REFUSE the sheet and offer to repair it](exceljs-row-outline-triggers-excel-repair.md) — group rows a different way; pairs with [EVERY xlsx is RECALCULATED on open](exceljs-workbooks-are-recalculated-on-open.md).
- [Admin pages live under app/(admin)/ and get AppShell from the group layout — never re-add per-page AppShell.](admin-route-group-shell.md)
- [Admin-shell restyle scope (updated 2026-07-24) — ONLY sidebar, topbar/navbar, and CEO identity banner are locked; everything else (especially tables) is free to restyle.](admin-shell-design-rules.md)
- [The uncommitted _wt-admin-shell-restyle diff (employee-management.tsx bespoke mobile/table restyle) should NOT be resurrected — main already solved the same need with a different, broadly-adopted shared pattern](admin-shell-restyle-superseded-by-portal-primitives.md)
- ["AI unavailable — manual review" root cause = bad/missing OPENAI_API_KEY per environment; fix = Secret Manager key rotation + wiring](ai-unavailable-openai-key-rotation.md)
- [Claude_Browser tools can't actually render/screenshot local file:// paths outside the project folder (e.g. the scratchpad dir) in this environment — don't waste turns retrying.](browser-pane-cannot-preview-scratchpad-files.md)
- [Root components/ui/button.tsx shadcn scaffold was the REAL live Button all along; dead custom Button deleted, shadcn version is now canonical at src/components/ui/button.tsx](button-alias-collision-shadcn-canonical.md)
- [CEO Command Center — LIVE on main at /admin/ceo-command-center as the CEO landing (PR #408, 2026-06-21). Reuses the admin command center; gated CEO+Super Admin.](ceo-command-center-phase1.md)
- [Standing design rule for ALL admin-shell restyle work (2026-07-24) — desktop shows full tables/dashboards, mobile NEVER horizontal-scrolls a table (convert rows to stacked cards instead), avoid childish/colorful icons, favor a Linear.app-style aesthetic.](feedback-admin-shell-responsive-golden-rule.md)
- [A non-compositing browser never fires requestAnimationFrame, so React 19.2 Suspense boundaries never reveal — a correct streamed page looks permanently stuck on the loading spinner.](headless-browser-never-fires-raf-react-suspense-reveal.md)
- [The headless preview tab's useEffect never fires, so a data-driven layout bug cannot be measured there — an empty page reports zero overflow and looks like a pass.](headless-preview-cannot-measure-data-driven-layout.md)
- [How to browser-verify pages locally in this repo — local .env.local points at PRODUCTION (read-only discipline), headless-preview React-streaming/viewport quirks, and a pre-existing dev-mode-only puppeteer/fs client-bundle break on pages reachable from access-scope.ts.](local-browser-verify-gotchas.md)
- [Before building any new UI, inspect the sibling pages in that module and match their exact design identity — never one-off inline styling.](match-module-design-before-building-ui.md)
- [Sidebar nav logic is in src/lib/navigation/active-path.ts (data-driven); `npm run lint` is noisy from .codex-worktrees.](nav-active-path-and-lint-noise.md)
- [System-wide rule — never truncate text with ellipsis and never let text wrap to multiple lines](no-text-truncation-or-wrapping.md)
- [Front-end page-speed audit (portal/dashboards/shell): #1 free win is React cache() on the auth bootstrap (runs 2-3x/nav); verified facts + honest measurement caveat.](page-performance-audit-2026-07-04.md)
- [PR #1298 OPEN 2026-07-24 (branch claude/gifted-neumann-e9a137): all 4 public/brand/ assets rebuilt from the owner's official mark, 3/4 live-verified rendering in the running app. Owner-approved design decisions, pre-push checks passed. Merge still needs separate explicit approval.](phoenix-official-logo-mismatch.md)
- [THE reference design system for all Phoenix decks/handbooks/PPTX — derived from phoenix-workforce-phase-one-launch.pptx and vetted against live app tokens. Use this whenever asked to make any Phoenix presentation/document.](phoenix-pptx-design-reference.md)
- [Full role-by-role employee-portal tour before the 2026-07-30 account rollout — what was verified, the 2 bugs found/fixed, and the launch-day data blockers](portal-launch-readiness-tour-2026-07-30.md)
- [The portal bottom-nav sync test only checked registry->sidebar, so 5 sidebar tabs were unreachable on mobile for years; now checks both directions](portal-nav-registry-one-way-sync-test.md)
- [The "Report It" premium design recipe the user loves — reuse it when asked to premium-polish any module](premium-design-language.md)
- [This repo's ESLint (react-hooks/refs) errors on any .current read/write that executes synchronously during render — even inside a helper function called from JSX](react-hooks-refs-lint-rule-during-render.md)
- [Regional Manager is under-provisioned vs District Manager in the employee portal — empty landing (no getRoleSpecificExtras RM branch), plans paradox, missing team/vacancy/probation tabs — and RM sales region scope is resolved 4 inconsistent ways. Analysis 2026-07-30; no edits made.](rm-dsm-portal-provisioning-gaps.md)

### Machine, tooling & environment
- [Phoenix is 100% provisioned but only ~15% adopted; Medical Reps are at 4% and weekly actives have been flat for 10 weeks](adoption-is-the-gap-not-features.md)
- [Killing a Next.js dev server mid-write leaves a truncated .next/dev/types/routes.d.ts that fails typecheck and blocks git push — delete .next/dev, don't debug your own code](dev-server-kill-corrupts-next-dev-types.md)
- [RESOLVED 2026-07-11. Force-killing Docker Desktop mid-restart triggered a cascade: AF_UNIX socket deletion broken across AppData (except Temp), PLUS an accidentally-created admin-settings.json forcing sign-in enforcement, PLUS a junction workaround that broke WSL2 VHD mounting. Working fix: junction ONLY Docker\\run and docker-secrets-engine (not Docker\\wsl) out of AppData, delete admin-settings.json, enable ExposeDockerAPIOnTCP2375 for vector logs. Full working sequence documented below.](docker-desktop-force-kill-breaks-af-unix-sockets.md)
- [User wants cron/schedule/timestamp times reported in Cairo local time, not raw UTC](feedback-report-times-in-cairo.md)
- [Owner preference — always show human-readable names in UI and chat, never raw codes/IDs.](feedback-show-names-not-codes.md)
- [Machine-wide slowness on this 16 GB laptop is page-file thrashing from too many concurrent Claude sessions — diagnose with Pages Input/sec, not free RAM](laptop-thrashing-pagefile-feedback-loop.md)
- [(no description in frontmatter — open the file)](localappdata-temp-is-live-tool-state.md)
- [Owner rule — never skip/silently drop anything; ask as many questions as needed (even hundreds) to confirm the best result](never-skip-ask-until-resolved.md)
- [Missing data and a real zero are different facts — the audit found the same confusion in attendance, exports and KPI chips; always ask the canonical detector and say 'unavailable'](no-data-must-never-render-as-absence-or-zero.md)
- [RULE — only one production deployment per task; bundle all phases/steps into one PR, don't deploy each step.](one-prod-deploy-per-task.md)
- [Claude Code has no automatic main-session model switching — the only real lever is picking model/effort per subagent call based on task difficulty, done consistently by the orchestrator.](subagent-model-tiering-by-task-difficulty.md)
- [On the SATO sales-data consolidation the user gets genuinely overwhelmed/lost and needs me to take ownership and automate — not hand back manual steps or theory.](user-overwhelmed-needs-lead-and-automate.md)
- [Slow/non-responsive localhost on Windows was Defender scanning dev I/O; exclusions added.](windows-defender-dev-exclusions.md)
- [Windows pnpm run dev now uses Turbopack (not webpack) — PR #1435 MERGED; live-data manual verification done, no crashes, but cold compiles are very slow](windows-dev-server-turbopack-switch.md)

### Everything else
- [Canonical staging-Supabase-ref memory — staging is cifwmndunmlxjhyjugxa, izhmxvgiktiafqusolot is DEAD; never trust a ref from prose, resolve with list_projects; both MCP servers see both projects](agents-md-stale-staging-ref.md)
- [Root cause for recurring 'Session rejected: app session not found' (missing_app_session) audit noise for login_id a-12 in production — CI's Playwright login-smoke test, not a stale browser tab](ci-smoke-login-prod-audit-noise.md)
- [Company structure — Head Office (line_id=4, الإدارة) serves all lines; 3 business lines each have a PM/GPM reporting to the MM. Head-office managers' teams are defined by manager_hr_id, NOT line.](company-org-structure-head-office.md)
- [The live production scheduler is the third-party cron-job.org, not GCP and not Railway's phoenix-cron — proven by clientUa on the HTTP logs](cron-job-org-is-the-real-production-scheduler.md)
- [Prod Disk-IO budget drain is temp-file spill from work_mem=2MB, not shared-block reads; two SoS analytics RPCs = 85% of it.](disk-io-temp-spill-workmem.md)
- [ExcelJS omits a formula's cached result when it is exactly 0, so a round-tripped reconciliation cell reads back as a formula with NO result — asserting on it yields NaN, not 0.](exceljs-drops-a-cached-formula-result-of-zero.md)
- [Supabase get_logs' fixed row cap can silently shrink its "last 24h" coverage to 1-2 hours during high-activity periods — always cross-check app_error_events (or equivalent long-retention app table) before calling anything "clean"](feedback-get-logs-narrow-window-trap.md)
- [Permanent fixation of the 2026-06-15 repo/Vercel/Supabase health-check findings — branch protection now on main, advisor baseline doc, B+D prod migrations applied](health-fixation-2026-06-15.md)
- [iReports360 saveDate/checkDate are zone-less Cairo-local times stored tagged UTC — do NOT convert to Cairo again (double-shift bug).](ireports360-timestamps-cairo-local-mislabeled-utc.md)
- [main now lives at _wt-main, synced to production; new npm run sync:main tool; worktree-move stale node_modules gotcha](main-sync-and-wt-main.md)
- [Next.js/Turbopack inlines process.env.NODE_ENV to a build-time literal in server code too — any NODE_ENV runtime guard in route handlers is dead code on Vercel/CI builds.](nextjs-node-env-inlined-at-build.md)
- [Next.js 16 renamed middleware.ts → proxy.ts; Phoenix enforces global CSRF there. Grepping "middleware.ts" gives a false "no CSRF" finding.](nextjs16-proxy-csrf.md)
- [/api/notifications/process (the 5-min outbox-draining cron) 504'd on every invocation for 20+ hours; fixed via a per-step timeout budget + overlap guard.](notifications-process-cron-504-timeout-fix.md)
- [Production PDF CV text extraction was hard-failing due to a second Next.js file-tracing gap in pdfjs-dist (sibling to the DOMMatrix one) — PR #1362 MERGED+PROD-LIVE 2026-07-26](pdfjs-worker-tracing-gap-fix.md)
- [repo-doctor --strip-idle takes many minutes to delete ~900k paths; measuring mid-run reads as "it did nothing" — check for the live node.exe before concluding anything.](repo-doctor-strip-idle-runs-for-many-minutes.md)
- [CRITICAL — the ENTIRE 2026-06-21 production day was reverted on prod (code + DB). Most "shipped today" memories are now rolled back.](revert-2026-06-21-full-day.md)
- [Owner's 7-item role-access sweep (Direct Orders, ROI Tracker, Expenses, Plans, portal CRM, Targets, Territory Mgmt) — findings + 4 PRs #1489/#1491/#1493/#1495. The two-portal-nav-trees trap is the root cause of most gaps.](seven-module-role-access-audit-2026-07-30.md)
- [Staging finally got the Deductions module (2026-08-06) — and doing it exposed that marketing_request_report_share_links' RLS lives only in production, not in any migration](staging-deductions-module-applied-2026-08-06.md)
- [In .env.staging.rls.local the PHOENIX_NEW_STAGING_* vars point at the DEAD staging project, not the current one — the "NEW" prefix is historically inverted](staging-env-file-new-prefix-is-dead-project.md)
- [Smart Phoenix-branded targets template + inline grid units→value + region-names fix; PR #1140 MERGED+LIVE (prod 8c92cd1d); worktree _wt-targets-godmode awaits CLEAN.](targets-module-godmode.md)
- [Portal Team Calendar 'visit numbers doubled' = double-visit CO-CREDIT inflating manager rows; fixed portal-only via DV coaching marker + own-visit counts. Worktree portal-team-calendar-dv, PR pending.](team-calendar-visit-numbers-doubled-double-credit.md)
- [/admin/visits-report deep audit from 2026-07-04 — SUPERSEDED, most findings below fixed by PR #796 same day. See [[crm-integrity-module]] for the current dependent picture.](visits-report-module-audit.md)

### Applied to prod 2026-08-10 → 2026-08-19 — moved out of the index 2026-08-19

**All still current. Every one of these is live on production — do NOT undo any of them.** They were
one-off applied changes rather than standing rules, so they moved here to keep MEMORY.md inside its
one-read ceiling. The standing rule each one came from stayed in the index.

- [36 placement rulings + the `fact_rollup` RE-STAMP](placement-rulings-and-office-reimport-applied-2026-08-12.md)
- [The CNS July gap](cns-2026-08-10-production-changes-applied.md)
- [21 outstation B3 projection rows corrected](outstation-b3-projection-correction-applied-2026-08-12.md)
- [`sales_records` RLS hoisted to InitPlan](sales-records-rls-hoist-applied-to-prod-2026-08-13.md)
- [Organogram phantom-seat fix #2166 — DSM-only suppression, never over-suppress reps](organogram-phantom-seat-fix-2166-live-on-prod-2026-08-16.md)
- [Nosiba B-1 is now a District Manager](nosiba-b1-elevated-to-district-manager-2026-08-15.md)
- [`user_access_profiles` silent-skips NULL-authid accounts — CN-0006/PD-0007/admin-HR still need it](access-profile-sync-gap-and-ai0007-fix-2026-08-15.md)
- [Salim B-76's Alex-BHR Direct Order is a CODE grant, never the seat map — #2204](direct-orders-extra-area-grant-live-on-prod-2026-08-19.md)
- [العروبة-عابدين is ONE shop, restamped Sohag1→Girga — a placement fix is a ROLLUP restamp, FOUR layers move together](orouba-abdeen-restamped-to-girga-2026-08-19.md)
- [4 duplicate pharmacies merged, backup in `marketing_rollback`](marketing-pharmacy-duplicate-merge-applied-2026-08-19.md)
- [124 of 155 ownerless marketing customers got an owner across 3 batches; 31 still open and 16 of those must STAY unowned — a SEED gap, not a bug, and FOUR columns move together](marketing-customer-ownership-gap-is-by-design.md)
- [125 candidates renamed + 34 enriched; the 22-digit phone fix is still OPEN](candidate-name-fix-and-field-apply-prod-2026-08-16.md)
- [6 forwarded-CV records SPLIT — do NOT split the remaining 14](forwarded-cv-split-applied-to-prod-2026-08-16.md)
- [Weekly module audit 08-15 — headers match rows, 51/51](weekly-module-audit-2026-08-15.md)
- [Weekly dashboard KEYSET pagination](weekly-dashboard-keyset-pagination-applied-2026-08-14.md)
- [Achievement hashable `join_key`](achievement-hashable-join-key-applied-2026-08-14.md)
- [6 marketing config tables lost browser WRITE grants](marketing-config-tables-lost-browser-write-grants-2026-08-13.md)
- [Marketing reject terminalises](marketing-reject-terminalises-applied-to-prod-2026-08-13.md)
- [The `not_found` override finally has a UI — #2185](marketing-unverified-code-override-has-a-ui-2026-08-18.md)
- [The master resolver now runs at write time — #2210; its 2 guards (never throws, never null `p_code_ids`) are load-bearing](marketing-master-resolver-never-runs-automatically.md)
- [`public.areas` never got the Beni Suef split — repaired on prod 08-19](public-areas-never-got-the-beni-suef-split.md)
- [The terminal vacancy guard made six employees uneditable — fixed #2195; `23505` meant TWO different things](terminal-vacancy-guard-makes-six-employees-uneditable.md)

## Index caveats trimmed 2026-08-21 — the FULL wording (nothing here is retired)

`MEMORY.md` reached 23.7KB against a 24.4KB read ceiling — past that the index stops loading for
every session at once. Compacted again on 2026-08-21. **Every link survived in the index**; only the
trailing detail moved here, plus a few one-link lines that were merged into `·` clusters. Each line
below is the **verbatim pre-compaction index line**. Read the matching line here before touching,
reverting, or re-deriving any of these. All are still current; none were closed by the compaction.

- 🔴 **39 prod changes 08-10→08-19 (sales, targets, perf/UI, recruitment, marketing, org, outstation) — do NOT undo.** Detail: [ARCHIVE § Applied to prod 2026-08-14 → 2026-08-16](MEMORY-ARCHIVE.md) · [§ Applied to prod 2026-08-10 → 2026-08-19](MEMORY-ARCHIVE.md).
- 🔴 [A customer called on by TWO LINES is a "treasure" to HIGHLIGHT — "never shift", never reassign it](cross-line-shared-customers-are-never-reassigned.md) — only a SAME-line rival is a contest.
- 🔴 [A marketing customer belongs to an AREA, never a person — so it survives a resignation](marketing-customers-belong-to-areas-not-people.md) — #2223; `areas` has 2 generations, only the high ids are real.
- 🔴 PROD 2026-08-20: ["National Sales Manager" is held ONCE PER LINE — probation SCORING is now national for all 3](nsm-title-is-held-once-per-line-not-company-wide.md) — #2233; scoring only, the tracker is unchanged.
- 🔴 PROD 2026-08-21: [Weekly mapping-template = `update` PLUS an explicit CEO branch — deliberate, don't "simplify" it](weekly-mapping-template-is-update-plus-a-ceo-exception.md) — #2234/#2236; 16-role test pins the audience at 3.
- 🔴 [The MONTHLY normalizer (`/api/sales/normalizer/**`, unprefixed) is SUPER ADMIN ONLY — and 2 of its routes write with no input bail](monthly-source-normalizer-is-super-admin-only.md) — 16-role sweep 2026-08-21; 5 of 13 routes fell through the registry blanket, now declared (#2239).
- 🔴 [`access-registry.ts` is a TEST FIXTURE — an entry guards nothing and logs nothing](access-registry-is-declarative-and-writes-no-audit-row.md) — I claimed #2239 "added an audit trail". It did not. Only `assertPermission(`/`writeRequiredAuditLog(` in the handler do.
- 🔴 PROD 2026-08-21: [importing/replacing/DELETING a salary batch wrote NO audit row — 15 `payroll_batch` rows EVER, all workflow transitions](payroll-mutations-were-unaudited-until-2026-08-21.md) — #2241, LIVE; delete must read its before-image BEFORE the RPC.
- 🔴 [Vacations has NO such gap — history lives in TWO tables, don't open a PR for it](vacations-audit-coverage-is-complete-via-two-tables.md) — 313/320 have an `audit_logs` row; self-service submit is logged as a `submitted` EVENT. The one weak spot, the never-run retention purge, is fixed by #2243 and PROVEN on staging.
- 🔴 [Running a domain service standalone needs an EXTENDED alias loader — `next/cache` and the `.tsx` email templates both break it](running-vacation-service-standalone-needs-an-extended-loader.md) — every staging harness rediscovers these two failures.
- 🔴 **SoS/closing/Direct internals — 12 in [ARCHIVE § SoS/closing internals](MEMORY-ARCHIVE.md), 33 in [§ SoS, bricks & direct orders](MEMORY-ARCHIVE.md)** — grain (`client_code` unique only WITHIN a distributor), ambiguous names, Stores-vs-Pharmacies, Direct pricing are all in the SECOND. Read before touching SoS/imports.
- 🔴 [A notification script run LOCALLY writes to prod but sends NO email — and burns the idempotency key for good](local-run-against-prod-db-silently-skips-every-email.md) — `.env.local` has the Resend key, not the switch.
- 🔴 PROD 2026-08-19: [the sales→marketing code sync WAS unsafe to re-run — FIXED and RE-RUN on prod same day](sales-to-marketing-sync-creates-ambiguous-duplicates.md) — 44,244 codes went `ambiguous`; **five** defects, not one; now a measured no-op (`retained_linked: 2,671` is the expected steady state).
- 🔴 [A green STAGING rehearsal proves nothing about shapes that only PROD's manual surgery created](staging-cannot-rehearse-shapes-only-prod-surgery-made.md) — nearly deleted 2,671 merged rows.
- 🔴 [A customer+pharmacy pair with TWO codes has TWO link rows — that is the grain, not a duplicate](customer-pharmacy-link-grain-is-customer-plus-code.md) — unique on `(customer_id, distributor_code_id)`; prod has ZERO duplicate links.
- 🔴 PROD 2026-08-21: [a 2026-07-02 backfill cites requests that DON'T EXIST here — 39 links HELD, 154 left standing on rep-visit corroboration](marketing-links-were-backfilled-from-a-sheet-not-the-database.md) — a pharmacy merge unblocks NOTHING; evidence is needed on BOTH sides.
- 🔴 PROD 2026-08-21: [A link's status is FROZEN at write time — fixing a customer's evidence changes NOTHING until the links are re-decided](marketing-link-status-is-frozen-at-write-time.md) — #2237 `56a01af3`; promote only, never auto-release a human hold.
- 🔴 PROD 2026-08-21: [Marketing visibility is TERRITORIAL, not ownership — and every SEEDED pharmacy has `area_id` NULL, so it is invisible to every rep](seeded-marketing-pharmacies-have-no-area-and-are-invisible.md) — 4 tiers by note prefix: **200 corroborated · 22 single-source · 58 code-over-customer · 1 retired**; **every live shop (300/300) now has an area, all 131 pending links routable**. **Code beats customer (14/15 vs the captured ADDRESS)** — but never validate against captured `area_id`, it holds the CAPTURER's region. Join codes by `pharmacy_id`, not via the link; retire a shop's CODE rows with it. **CAPTURED rows fixed too 2026-08-21: all 20 retagged region→patch via `areas.code = mapped_area_code` (`GZ5` IS Helwan-Maadi — the letter is only the region). 0 shops left on a region.** 🔴 **OWNER RULE: a shop's REGISTERED DISTRIBUTOR CODE beats its own live GPS/Google area** — but only where the code RESOLVES; where it does NOT, the authority is `source_of_sales_bricks`, **never the GPS** (I inferred Kotour→D14 from coordinates; brick `B192-11` says **D15**, corrected on prod). Never fake a mapping to clear an `unresolved` — re-run `phx_resolve_marketing_pharmacy_codes(ids)`, never with NULL.
- 🔴 PROD 2026-08-21: [An Arabic-fold duplicate scan CANNOT see Latin-script twins — and a CROSS-LINE pair is NOT automatically a treasure](duplicate-customer-scan-misses-transliteration-and-cross-line.md) — only 5 of 162 were Latin-only; **both cross-line pairs MERGED on the owner's instruction** (I argued to keep one; overruled — the treasure rule bars REASSIGNING, not deduping a person). Carry the loser's evidence ONLY if it is a real field capture (`Hossam bosraty` yes, 18m GPS+photo; `Reda Solimany` no, desk map-search). 163→**160** customers, `usable_links` **180 across all 3 merges**.
- 🔴 [A shared DOCTOR proves nothing about two pharmacy records — **45.3%** of doctors have 2+ shops](duplicate-pharmacy-test-is-name-and-gps-not-brick.md) — owner 2026-08-21: *"maybe same dr have more than 1 ph around him"*; max is 8. مستشفي/مستشفى فيكتوريا stay SPLIT (two POS codes, two streets).
- 🔴 [WHO changed a prod row: `updated_by_hr_id` LIES, and a pure UPDATE leaves NO log line](how-to-attribute-a-production-write.md) — agent SQL is stamped `-- source: POST /mcp`.

Two lines were appended by a parallel session mid-compaction on 2026-08-21 and are trimmed here too:

- 🔴 [iReports360 dead columns are HIDDEN, not deleted — but `customer_name` must STAY in `VISIT_SELECT`](ireports360-dead-columns-are-hidden-not-deleted.md) — #2242/#2245; dropping it from the select silently breaks recognition scoring + search.
- 🔴 PROD 2026-08-21: ["Applying for" is DERIVED from 6 sources at read time, writes nothing — and the 159 it can't answer will NOT be fixed by AI spend](applying-for-is-derived-and-the-residue-is-genuinely-silent.md) — #2244/#2246; 204→396. The model already read 58 of them and found nothing. `->>'appliedForJobTitle'` returns the OBJECT, not the value.


## Index caveats trimmed 2026-08-21 (compaction #2)

MEMORY.md had grown back to 25,903 bytes — past its 24.4KB read limit, so its tail was being
silently dropped on load. These are the index lines VERBATIM as they stood immediately before
the second compaction. Every link in them survives in the live index; only the prose tails were
shortened. Nothing here was deleted from the index — this is the long form of what it now says
briefly. See [[memory-index-floor-is-13kb-dont-gut-it-chasing-17]] for why ~18KB is the floor.

- 🔴 **[COVERAGE vs FREQUENCY are two KPIs that DISAGREE — 68% vs 39%; `adherencePct` WAS coverage](crm-coverage-and-frequency-are-two-kpis-that-disagree.md)** — frequency = EXACT match, so OVER-visiting is a deviation too; scored on the PLAN, never the grade.·**[a CRM month-over-month trend does NOT compare the same reps](crm-month-over-month-does-not-compare-the-same-reps.md)** — leavers are dropped from HISTORY too, so the +24pt April jump is population; like-for-like is FLAT. Always cohort.
- 🔴 **[CRM mobile cards are MODULE-WIDE and CI-enforced — all 9 files split, whole-directory test](crm-mobile-cards-are-module-wide-and-ci-enforced.md)** — a new board under `src/components/crm` that ships unsplit turns the PR red on its own; caught Brick Coverage (#2261). Fix the board, not the test — EXCEPT where the test pins a spelling the file cannot use.
- 🔴 **[A SERVER component may never hand a function to a client one — #2264 500d BOTH Doctor Coverage routes](a-server-component-cannot-pass-a-function-to-a-client-one.md)** — the CRM test PINNED the board to a `"use client"` primitive, mandating the crash. Judge by the IMPORT GRAPH, never the directive.·**[a broken RSC page still returns 200](a-broken-rsc-page-still-returns-http-200.md)** — probe the streamed DIGEST from an authed tab + a control route.
- 🔴 **[SOLVED — the 23 WhatsApp "photo CVs" are CERTIFICATES; the model was right to return nothing](whatsapp-import-images-return-nothing-from-vision.md)** — 13 images, 10 imported twice. Never spend again; diagnose by DOWNLOADING the file and looking.·[an EMPTY extraction is "not a CV", not a failed read](an-empty-cv-extraction-is-the-designed-answer-to-a-non-cv.md) — stored in `is_cv` (#2271), badged (#2274); gate on `=== false`, NULL = unjudged.
- 🔴 **[A Windows `OPENAI_API_KEY` env var SHADOWS every `.env.local` — `--env-file` never overrides an already-set var](windows-env-var-shadows-every-env-local-key.md)** — 3 keys existed at once; editing `.env.local` changed nothing. Probe with `/v1/models` (200 vs 401), never print the value.
- 🔴 **[OpenAI key: rotated TWICE on 08-21 — the stored one is VALID (200)](openai-key-is-401-and-cv-extraction-silently-falls-back-to-rules.md)** — fingerprint `sha256:469EBD3D56`, never print it; verify by fingerprint, NEVER by asking the owner for a CV. No key = the FREE rules engine (38 fields → 11).
- 🔴 **[Rep visits CANNOT be placed on the brick map — BOTH CRM→brick tables are EMPTY](crm-visits-join-to-bricks-both-maps-now-filled.md)** — 0 of 302 regions, 0 of 14,451 customers; the admin UI shipped and was never worked. 302 region answers unlock it; the customer route is 48x the work for ~nothing.·[GPS check-ins are a PARTIAL feed — never score a rep on them](gps-checkins-are-a-partial-feed-never-score-a-rep-on-them.md) — 4 reps did 378/248/131/119 July visits with ZERO check-ins.
- 🔴 [#2237 Capture Evidence was DEAD for `doctor` = 81% of customers — PR #2249 fixes it; zero-usage looked like adoption](capture-evidence-was-dead-on-arrival-for-doctor-customers.md)
- 🔴 **[A reused CRM slot hides an ACTIVE rep company-wide — 6th case, FIXED 08-21 #2262](crm-resigned-slot-reused-for-new-hire.md)** — the hard-floor list OUTRANKS `employment_status`, hiding a working rep from DV Analytics AND payroll's FWC matrix. **Wrong 6× the same way — audit the WHOLE list whenever a rep looks impossibly idle.** `1436` stays; removing an id needs the owner's go.
- 🔴 [Public Holiday (-5) + Casual Leave (-6) = WORKING days, never AV](public-holiday-and-casual-leave-are-working-days.md) — `-4` is the ONLY leave type; AV eats the balance then SALARY. Only the **FWC** map reaches salary; the payroll one is DEAD.
- 🔴 [There are THREE visit-type maps, not the two every comment names](crm-visit-type-maps-there-are-three-not-two.md) — `crm-day-maps.ts` is a SET pair, greps differently, and already misses two owner rulings.
- 🔴 [A CONTACT-centric CRM read must opt in to `includeResignedAgents`](crm-door-resigned-exclusion-costs-a-contact-read-1100-doctors.md) — the default exclusion takes **1,100 of 15,125** GPS doctors to ZERO; extend the door's filters, never hand-roll a mirror query.
- 🔴 [NULL `agent_hr_id` on a PLAN row = a LEAVER, not a broken sync](crm-null-plan-hrid-means-leaver-not-defect.md) — 8 of 9 audited 08-21 were August resignations (`employees.crm_id` cleared on exit); excluding them is CORRECT, so the board's 69% is right and the 66% that included them was the artefact. Scope unmapped-agent checks on VISITS, not plans.
- 🔴 [A THIRD of target-carrying territories have NO rep — 33 of 107](a-third-of-target-carrying-territories-have-no-rep.md) — a picker built on `carries_target` shows a third empty, which reads as "covered nobody"; matches `area_state` exactly.
- 🔴 [Marketing visibility is TERRITORIAL — `area_id` NULL = invisible to every rep](seeded-marketing-pharmacies-have-no-area-and-are-invisible.md) — **OWNER RULE: the REGISTERED CODE beats live GPS**; where it doesn't resolve, `source_of_sales_bricks` decides, never the GPS.
- 🔴 [7 iReports360 visit-type codes are UNDOCUMENTED — but their labels were ALREADY owner-confirmed 2026-07-14; GREP BEFORE ASKING](ireports360-undocumented-visit-type-codes.md) — #2251 shares them via `src/lib/crm/visit-types.ts`; NEVER store a label in `visit_type_description` (the `%vacation%` ilike eats `-5`/`-6`); all 7 still count as WORKING time and that is the owner's open call.
- 🔴 [Two reps log ALL work as CAMPAIGN (-8) — they show 0% adherence but worked a full month](campaign-visits-make-a-working-rep-look-like-a-zero.md) — plan-vs-actual counts `visit_type = 0` ONLY; never widen that filter yourself, it moves Doctor Coverage too.·[Doctor Coverage keys a rep `hr:ai-0009`, Brick Coverage keys him `ai-0009` — crossing them matches NOTHING, silently](crm-boards-key-the-same-rep-two-different-ways.md)
- 🔴 [**19.7% of CRM "doctors" are NOT doctors** — `contact-taxonomy.ts` is the ONE authority; writing a second speciality list is the mistake it exists to stop](crm-speciality-has-one-authority-dont-build-a-second.md) — grep `classifyCrmContactSpeciality` BEFORE classifying one. Unclassified stays SCORED as a doctor on purpose; never "fix" that to a drop.
- 🔴 [A merge landing MID-SESSION orphans your next push — no CI ever runs on it and `gh pr checks` keeps showing the OLD green](a-merge-mid-session-orphans-your-next-push-silently.md) — verify `check-runs` for YOUR sha; `total_count: 0` is the tell.
- 🔴 [`check-runs: 0` ALSO means CONFLICTED — a DIRTY PR queues no CI ever, so polling burns the whole timeout](a-conflicted-pr-runs-no-ci-at-all.md) — read `mergeStateStatus` FIRST; `tests/run-tests.ts` collides on its tail constantly, so re-home your registration.
- 🔴 **[14 never-merged branches were DELETED 08-21 — every tip is preserved in `refs/deleted-branches/*` in the MAIN checkout only](deleted-branch-tips-live-in-refs-deleted-branches.md)** — invisible to `git branch -a`; no PR means no GitHub "Restore branch". Not pushed anywhere — a fresh clone loses them.
- 🔴 Validation: [**both local gates REMOVED — CI is the gate**](local-validation-gates-are-gone-ci-is-the-gate.md)·[RAM-saturated? WAIT](dont-skip-validation-for-ram-wait-instead.md)·[prove WHICH assertion fired](prove-it-fails-verify-which-assertion-fired.md)·[a heredoc ate `\b` → a test that can ONLY pass](heredoc-eats-backslashes-and-makes-a-test-that-only-passes.md)·[tsc false-greens warm](typecheck-incremental-false-green.md)·[`parseDiagnostics` is SYNTAX-ONLY — a clean parse still fails typecheck](parse-diagnostics-cannot-see-a-typecheck-error.md)·[`setState` in `useEffect`=lint ERROR](set-state-in-effect-is-a-lint-error-here.md)
- 🔴 [Blind coordinate clicks fired PROD — click by TEXT](blind-coordinate-clicks-fired-a-production-collection-run.md)·[browser dev-login = `GET /api/dev-auth?role=…&next=…`](dev-auth-is-header-only-browser-pane-cannot-use-it.md)·[**a saturated machine 500s EVERY page with a CSS-shaped Turbopack error** — `0xc0000142` = commit exhausted, not code](turbopack-500s-with-0xc0000142-when-commit-is-full.md)·[**verify a 375px layout with NO dev server** — verbatim-markup harness + `scrollWidth`](verify-a-mobile-layout-without-a-dev-server.md)·[16GB ceiling](laptop-m17r2-ram-soldered-16gb-ceiling.md)·[no foreground-watching](dont-foreground-watch-long-pipelines.md)

## Index caveats trimmed 2026-08-22

Verbatim `MEMORY.md` lines shortened during the 2026-08-22 compaction (22,863 bytes → see below).
Every link survived; only these trailing clauses were relocated here.

- 🔴 **[COVERAGE vs FREQUENCY DISAGREE — 68% vs 39%](crm-coverage-and-frequency-are-two-kpis-that-disagree.md)** — frequency = EXACT match, so OVER-visiting deviates too; score the PLAN, never the grade.·[a MoM trend does NOT compare the same reps](crm-month-over-month-does-not-compare-the-same-reps.md)
- 🔴 **[CRM mobile cards are MODULE-WIDE and CI-enforced](crm-mobile-cards-are-module-wide-and-ci-enforced.md)** — fix the board, not the test — EXCEPT where the test pins a spelling the file cannot use.
- 🔴 **[the offer chain was ALREADY in the registry, with a hole past approval](offer-chain-was-live-in-the-registry-with-a-hole-past-approval.md)** — enforced in `markOfferSent` on `approved_at`, NEVER by the stage.·[`ats_candidate_status_events` has NO FK **ON PURPOSE** — adding one BREAKS the delete, 23001; `..._source_context` is a VIEW](ats-candidate-children-one-has-no-fk-and-one-is-a-view.md)
- 🔴 **[`admin-HR` canary login: restore it with `hr_id = NULL`](admin-hr-cannot-be-recreated-hr-id-must-be-null.md)** — an FK to `employees` rejects staging's `PHX-1`; prod has NO employees row, staging has two. NEVER create a fake employee to satisfy it. Zero triggers ≠ nothing can reject a write.
- 🔴 **[a reused CRM slot hides an ACTIVE rep — 6th case](crm-resigned-slot-reused-for-new-hire.md)** — the hard-floor list OUTRANKS `employment_status`. **Audit the WHOLE list whenever a rep looks impossibly idle.** Removing an id needs the owner's go.
- 🔴 [Public Holiday (-5) + Casual Leave (-6) = WORKING days](public-holiday-and-casual-leave-are-working-days.md) — `-4` is the ONLY leave type; only the **FWC** map reaches salary, the payroll one is DEAD.
- 🔴 **SoS/closing/Direct internals — 45 more in [ARCHIVE](MEMORY-ARCHIVE.md).** Grain, ambiguous names, Stores-vs-Pharmacies, Direct pricing. Read before touching SoS/imports.
- 🔴 [Marketing visibility is TERRITORIAL — NULL `area_id` = invisible](seeded-marketing-pharmacies-have-no-area-and-are-invisible.md) — **OWNER RULE: the REGISTERED CODE beats live GPS**; else `source_of_sales_bricks` decides, never the GPS.
- 🔴 [CAMPAIGN (-8) makes a working rep look like a zero](campaign-visits-make-a-working-rep-look-like-a-zero.md) — plan-vs-actual counts `visit_type = 0` ONLY; never widen that filter, it moves Doctor Coverage too.·[the two boards key the same rep differently](crm-boards-key-the-same-rep-two-different-ways.md)
- 🔴 Validation: [**86 fixed-byte source windows** false-FAIL when a pinned fn grows](source-pinning-tests-slice-a-fixed-byte-window.md) — the "86" predates #2289, which fixed 73 of them.
- 🔴 **[14 deleted branch tips live in `refs/deleted-branches/*`](deleted-branch-tips-live-in-refs-deleted-branches.md)** — now 18, plus a new `refs/deleted-stashes/` holding 10.

## Moved out of the index 2026-08-23 — duplicated verbatim by AGENTS.md (all six still current)

Dropped from `MEMORY.md` at the owner's instruction 2026-08-23 00:45 Cairo, to get the index back
under the 24.4KB read limit past which the tail is silently dropped on load. **Nothing here is
retired and no file was deleted** — every one is still true. They earned the cut only because
`CLAUDE.md` includes `@AGENTS.md`, so AGENTS.md loads into context on every single session anyway;
carrying the same fact in both places cost bytes and bought no recall. The Railway section header in
the index already said as much: *"detail behind AGENTS §2/§3"*. Each line below was grep-verified
present in AGENTS.md before it was removed.

**If AGENTS.md is ever trimmed, these lose their only auto-loading home — put them back in the index.**

- [merge=prod](railway-merge-is-the-production-deploy.md) — AGENTS §2, *"A merge to `main` SHIPS TO PRODUCTION IMMEDIATELY"*
- [Cloud Run dead](railway-is-prod-cloud-run-workflow-is-dead.md) — AGENTS §3, *"GCP is DEAD, not standby"*
- [prod writes pre-authorized](supabase-mcp-and-cli-revoked-2026-08-02.md) — AGENTS §8, *"Supabase writes are pre-authorized end to end"* (note the standing condition: announce destructive/bulk PROD changes in plain words first)
- [`.env.local`=PROD](local-env-already-points-at-production.md) — AGENTS §3, *"`.env.local` points at PRODUCTION Supabase"*
- [visibility is app-scoped](app-visibility-is-application-scoped-not-rls.md) — AGENTS §8, *"Visibility in this app is application-scoped, not RLS-scoped"*
- [`defaultMode`=`auto`](permission-allowlist-user-level-2026-08-01.md) — AGENTS §1.5, *"`permissions.defaultMode` is `auto`"*

**Deliberately NOT dropped from the index, because AGENTS.md does NOT carry them:**
`railway-deploy-applies-no-migrations`, `railway-auto-deploy-can-silently-skip-a-race`,
`railway-stdin-bom-trap`, `railway-ssh-joins-argv-and-lands-as-root`,
`env-file-reads-fully-auto-approved-2026-08-09`, `supabase-staging-named-server-broken-2026-08-10`,
`expense-claims-rls-read-path-is-live-in-prod`, `google-maps-keys-moved-to-phoenix-hr-2026`,
`guard-every-prod-write-when-another-session-shares-the-queue`,
`force-logout-everywhere-needs-three-writes`.


## Index caveats trimmed 2026-08-23

Shortened in `MEMORY.md`; the original wording, verbatim:

- **[18 branch tips + 10 stashes live in `refs/deleted-*`](deleted-branch-tips-live-in-refs-deleted-branches.md)** — local only, never pushed.
- [`sharp` is a **devDependency** that TWO live routes import](sharp-is-a-devdependency-that-two-production-paths-import.md)
- ** — a % can only be re-aggregated by summing the parts it divides; 4 sites read 130.73% for a 50.67% window.
-  — its `rls_enabled_no_policy` INFO is CORRECT; 85 tables share it.
- ** — 3 roles shipped granted-but-bounced; probe both gates, never read the matrix.
-  — `validated_by_hr_id` is NULL on every one; the admin register checks the rest, never blocks, and is **SUPER ADMIN ONLY** (not SFE).
- ** — detached promise, uncatchable; gzip the rows and return null over the ceiling.
- ** — burned a prod deploy, FIXED 08-22; hoist in `pnpm-workspace.yaml` + a `*/**` glob, CI-gated.
-  — the hard-floor list OUTRANKS `employment_status`. Removing an id needs the owner's go.
- [a SERVER component may never pass a function to a client one]
- [the offer chain was in the registry, with a hole past approval]
- [`ats_candidate_status_events` has NO FK ON PURPOSE; `..._source_context` is a VIEW]
- [a MoM trend does NOT compare the same reps]
- [CRM mobile cards are MODULE-WIDE and CI-enforced]
- [Capture Evidence was DEAD for 81% of customers]
- [a reused CRM slot hides an ACTIVE rep — 6th case]
- [`deductions_*` is truth, legacy has the cron]
- [hiring scans: `hiring_document_files` + a PRIVATE bucket are LIVE in prod]
- [NEVER change the organogram SKELETON — nor propose it]
- [government Form 1 prints EXACTLY as issued — page 2 blank, CI-pinned]
- [payroll writes were unaudited until #2241]
- [`mobile_number` is NOT dialable — 71% lost the leading zero]
- [a THIRD of target territories have NO rep — 33 of 107]
- [an acting DM's authority is `app_auth_users.role`, NEVER `job_title`]
- [a LOCAL run writes prod, skips email, burns the key]
- [one `banned_until='infinity'` 500s the auth admin API]
- [STAGING cannot rehearse PROD-surgery shapes]
- [an UNRESOLVED code transfers a pharmacy that is INVISIBLE under a distributor]
- ["Applying for" is DERIVED at read time and writes nothing]
- [a >2MB `unstable_cache` entry KILLS the dev server, and prod just stops caching SILENTLY]
- [tracing an include copies FILES, never pnpm's SYMLINKS — the package still will not resolve]
- [push OOM = a 500MB `postBuffer`, and the retry cries AUTH]
- [a top-level `import sharp` 500s a whole PAGE — the standalone trace drops the `.so`]
-  Trimmed caveats: [ARCHIVE](MEMORY-ARCHIVE.md).
- **: 33 more traps, 10 worktree notes, 197 files by topic — incl. Excel row outline; the orphan-sweep group is dead-platform history, SUPERSEDED.
- ** — each hides the next; run the suite locally first.

## Index caveats trimmed 2026-08-23

Compaction pass #4 (25,293 -> 23,829 bytes, 230/230 hooks kept). A parallel session was compacting
the same file at the same time and its version dropped 6 hooks; those were restored and its two new
facts (refs/deleted-* now empty; sharp moved to deps in #2301) were carried across. Every index line
that changed in either version is preserved verbatim below, so no tail was lost, only relocated.

    - 🔴 **[achievement divides COVERED actual, never all sales](achievement-numerator-is-covered-actual-not-all-sales.md)** — a % can only be re-aggregated by summing the parts it divides; 4 sites read 130.73% for a 50.67% window.
    - 🔴 **[COVERAGE vs FREQUENCY DISAGREE — 68% vs 39%](crm-coverage-and-frequency-are-two-kpis-that-disagree.md)** — score the PLAN, never the grade.·[a MoM trend does NOT compare the same reps](crm-month-over-month-does-not-compare-the-same-reps.md)
    - 🔴 **[CRM mobile cards are MODULE-WIDE and CI-enforced](crm-mobile-cards-are-module-wide-and-ci-enforced.md)** — fix the board, not the test.
    - 🔴 **[a SERVER component may never pass a function to a client one](a-server-component-cannot-pass-a-function-to-a-client-one.md)** — judge by the IMPORT GRAPH, never the directive.·[a broken RSC page still returns 200](a-broken-rsc-page-still-returns-http-200.md)·[the primitive renders EVERY row TWICE — 19MB](portal-responsive-data-list-renders-every-row-twice.md)
    - 🔴 **[the offer chain was in the registry, with a hole past approval](offer-chain-was-live-in-the-registry-with-a-hole-past-approval.md)** — gated on `approved_at`, never the stage.·[`ats_candidate_status_events` has NO FK ON PURPOSE; `..._source_context` is a VIEW](ats-candidate-children-one-has-no-fk-and-one-is-a-view.md)
    - 🔴 **[rep visits CANNOT reach the brick map — both tables EMPTY](crm-visits-join-to-bricks-both-maps-now-filled.md)**·[GPS check-ins are PARTIAL — never score on them](gps-checkins-are-a-partial-feed-never-score-a-rep-on-them.md)
    - 🔴 [Capture Evidence was DEAD for 81% of customers](capture-evidence-was-dead-on-arrival-for-doctor-customers.md)
    - 🔴 **[`admin-HR` canary: restore it with `hr_id = NULL`](admin-hr-cannot-be-recreated-hr-id-must-be-null.md)** — NEVER create a fake employee to satisfy that FK.
    - 🔴 **[a reused CRM slot hides an ACTIVE rep — 6th case](crm-resigned-slot-reused-for-new-hire.md)** — the hard-floor list OUTRANKS `employment_status`. Removing an id needs the owner's go.
    - 🔴 [hiring scans: `hiring_document_files` + a PRIVATE bucket are LIVE in prod](hiring-document-files-table-and-private-bucket-live-in-prod.md) — its `rls_enabled_no_policy` INFO is CORRECT; 85 tables share it.
    - 🔴 [`railway ssh` JOINS argv and lands as ROOT](railway-ssh-joins-argv-and-lands-as-root.md)
    - 🔴 [put the precondition in every prod write's `WHERE`](guard-every-prod-write-when-another-session-shares-the-queue.md)·["Log out everywhere"=THREE writes](force-logout-everywhere-needs-three-writes.md)
    - 🔴 **[NEVER change the organogram SKELETON — nor propose it](never-change-the-organogram-skeleton.md)** — seats, reporting lines, `manager_hr_id`. A vacancy is a HIRE in progress, not a gap to patch. Only the Super Admin, by his own intent.
    - 🔴 [Public Holiday (-5) + Casual Leave (-6) = WORKING days](public-holiday-and-casual-leave-are-working-days.md) — `-4` is the ONLY leave type; only the **FWC** map reaches salary.
    - 🔴 **[government Form 1 prints EXACTLY as issued — page 2 blank, CI-pinned](government-form1-prints-exactly-as-issued.md)** — duplex, 3 copies; the contract is single-sided, 4.
    - 🔴 [NSM is held ONCE PER LINE](nsm-title-is-held-once-per-line-not-company-wide.md)·[weekly mapping-template = `update` + a CEO branch](weekly-mapping-template-is-update-plus-a-ceo-exception.md)
    - 🔴 [MONTHLY normalizer = SUPER ADMIN ONLY](monthly-source-normalizer-is-super-admin-only.md)·[`access-registry.ts` = TEST FIXTURE, no audit row](access-registry-is-declarative-and-writes-no-audit-row.md)
    - 🔴 [`employees.line_name` is NULL in prod — use `line_id`](employees-line-name-column-is-null-in-production.md)·[`mobile_number` is NOT dialable — 71% lost the leading zero](employees-mobile-number-is-not-dialable-as-stored.md)
    - 🔴 [store-split cache needs a trigger+version migration](closing-store-split-cache-cannot-be-keyed-on-timestamps.md)·[EVERY xlsx RECALCULATES on open](exceljs-workbooks-are-recalculated-on-open.md)
    - 🔴 **[a matrix grant is only GATE ONE of two](a-matrix-grant-is-only-gate-one-of-two.md)** — 3 roles shipped granted-but-bounced; probe both gates, never read the matrix.
    - 🔴 [a THIRD of target territories have NO rep — 33 of 107](a-third-of-target-carrying-territories-have-no-rep.md)
    - 🔴 **[an acting DM's authority is `app_auth_users.role`, NEVER `job_title`](acting-dm-authority-is-app-role-not-job-title.md)** — OWNER RULE: a rep acting as DM STAYS a medical rep; never promote her title or her seat. To give her reps, move the REPS.
    - 🔴 **7 more in [ARCHIVE § Org / email](MEMORY-ARCHIVE.md):** `notification_deliveries` gate · Telegram=2 accounts · `general`→HR inbox · `work_email` UNIQUE · delete = FULL TEXT SCAN.
    - 🔴 [a LOCAL run writes prod, skips email, burns the key](local-run-against-prod-db-silently-skips-every-email.md)
    - 🔴 [one `banned_until='infinity'` 500s the auth admin API](banned-until-infinity-breaks-the-whole-auth-admin-api.md)
    - 🔴 Marketing: [`marketing_request_events` = the only history](marketing-request-events-is-the-history-table.md)·[the stop role is SALES-ONLY](marketing-manager-chain-target-is-sales-only.md)·[MM A-9 OUTRANKS PM A-10](marketing-manager-outranks-product-manager.md)
    - 🔴 [sales→marketing sync was unsafe to re-run, FIXED](sales-to-marketing-sync-creates-ambiguous-duplicates.md)·[STAGING cannot rehearse PROD-surgery shapes](staging-cannot-rehearse-shapes-only-prod-surgery-made.md)
    - 🔴 [a `not_found` code has THREE root causes](marketing-not-found-codes-have-three-root-causes.md)·[codes are NOT geographic](pharmacy-code-numbers-are-not-geographic.md)·[an UNRESOLVED code transfers a pharmacy that is INVISIBLE under a distributor](marketing-transfer-writes-no-distributor-link-when-the-code-is-unresolved.md)
    - 🔴 [the 07-02 backfill cites requests that DON'T EXIST](marketing-links-were-backfilled-from-a-sheet-not-the-database.md)·[a link's status is FROZEN at write time](marketing-link-status-is-frozen-at-write-time.md)
    - 🔴 [Marketing visibility is TERRITORIAL — NULL `area_id` = invisible](seeded-marketing-pharmacies-have-no-area-and-are-invisible.md) — **OWNER RULE: the REGISTERED CODE beats live GPS**, never the GPS.
    - 🔴 [**`system_validated` means NO HUMAN LOOKED** — GPS + a timestamped photo, nothing else](marketing-system-validated-means-no-human-looked.md) — `validated_by_hr_id` is NULL on every one; the admin register checks the rest, never blocks, and is **SUPER ADMIN ONLY** (not SFE).
    - 🔴 [an Arabic fold misses Latin twins; cross-line ≠ treasure](duplicate-customer-scan-misses-transliteration-and-cross-line.md)
    - 🔴 [Omar's forwarder collapses CVs onto ONE candidate](whatsapp-forwarder-omar-collapses-cvs-onto-one-candidate.md)·[dead columns HIDDEN — keep `customer_name` in `VISIT_SELECT`](ireports360-dead-columns-are-hidden-not-deleted.md)
    - 🔴 [7 visit-type codes UNDOCUMENTED but owner-confirmed](ireports360-undocumented-visit-type-codes.md)
    - 🔴 [CAMPAIGN (-8) makes a working rep look like a zero](campaign-visits-make-a-working-rep-look-like-a-zero.md) — plan-vs-actual counts `visit_type = 0` ONLY; never widen it.·[the two boards key the same rep differently](crm-boards-key-the-same-rep-two-different-ways.md)
    - 🔴 [**19.7% of CRM "doctors" are NOT doctors** — ONE authority](crm-speciality-has-one-authority-dont-build-a-second.md)
    - 🔴 ["Applying for" is DERIVED at read time and writes nothing](applying-for-is-derived-and-the-residue-is-genuinely-silent.md)
    - 🔴 [PROD Supabase PITR is **OFF** — 7 daily snapshots](production-supabase-has-no-pitr-only-daily-backups.md)·[batch membership is FIXED when built](payroll-batch-membership-is-historical.md)
    - 🔴 DB: [round trips cross the Atlantic](every-db-round-trip-crosses-the-atlantic.md)·[`PARALLEL SAFE` is CORRECTNESS](public-functions-are-parallel-unsafe-by-default.md)·[>15s times out but COMMITS](supabase-client-15s-timeout-commits-anyway-half-applies.md)·[a slow `phx_*` is a WRAPPER — follow it into `au`](sales-vs-target-cost-is-inside-au-monthly-attribution.md)
    - 🔴 **[a >2MB `unstable_cache` entry KILLS the dev server, and prod just stops caching SILENTLY](next-2mb-data-cache-throws-only-in-dev-and-kills-the-server.md)** — detached promise, uncatchable; gzip the rows and return null over the ceiling.
    - 🔴 **[tracing an include copies FILES, never pnpm's SYMLINKS — the package still will not resolve](next-tracing-copies-files-not-pnpm-symlinks.md)** — burned a prod deploy, FIXED 08-22; hoist in `pnpm-workspace.yaml` + a `*/**` glob, CI-gated.
    - 🔴 **[ONE new hub page = FOUR separate CI gates](adding-a-hub-page-trips-four-separate-ci-gates.md)** — each hides the next; run the suite locally first.
    - 🔴 **[18 branch tips + 10 stashes live in `refs/deleted-*`](deleted-branch-tips-live-in-refs-deleted-branches.md)** — local only, never pushed.
    - 🔴 git: [deleting a branch keeps its commit](deleting-a-branch-does-not-remove-a-pushed-commit.md)·[never reuse a squash-merged branch](reusing-a-squash-merged-branch-makes-a-conflicting-pr.md)·[BLOCKED = BEHIND, not red CI](merge-blocked-says-checks-but-means-behind.md)·[push hangs, kill ~60s](git-push-to-origin-hangs-retry-immediately.md)·[push OOM = a 500MB `postBuffer`, and the retry cries AUTH](git-push-oom-is-a-500mb-postbuffer-in-repo-config.md)·[`--auto` never](gh-pr-merge-auto-merges-immediately.md)·[2 sessions, 1 bug](two-sessions-fixed-one-bug-main-was-never-ci-validated.md)
    - 🔴 Validation: [**both local gates REMOVED — CI is the gate**](local-validation-gates-are-gone-ci-is-the-gate.md)·[RAM-saturated? WAIT](dont-skip-validation-for-ram-wait-instead.md)·[prove WHICH assertion fired](prove-it-fails-verify-which-assertion-fired.md)·[fixed-byte source windows false-FAIL when a fn grows](source-pinning-tests-slice-a-fixed-byte-window.md)·[a heredoc ate `\b`](heredoc-eats-backslashes-and-makes-a-test-that-only-passes.md)·[tsc false-greens warm](typecheck-incremental-false-green.md)·[`parseDiagnostics` is SYNTAX-ONLY](parse-diagnostics-cannot-see-a-typecheck-error.md)·[`setState` in `useEffect` = lint ERROR](set-state-in-effect-is-a-lint-error-here.md)
    - 🔴 [click by TEXT — blind coordinates fired PROD](blind-coordinate-clicks-fired-a-production-collection-run.md)·[browser dev-login = `GET /api/dev-auth?role=…`](dev-auth-is-header-only-browser-pane-cannot-use-it.md)·[`0xc0000142` 500s EVERY page = commit exhausted](turbopack-500s-with-0xc0000142-when-commit-is-full.md)·[verify 375px with NO dev server](verify-a-mobile-layout-without-a-dev-server.md)·[16GB ceiling](laptop-m17r2-ram-soldered-16gb-ceiling.md)·[no foreground-watching](dont-foreground-watch-long-pipelines.md)
    - 🔴 [WHO changed a prod row: `updated_by_hr_id` LIES](how-to-attribute-a-production-write.md)
    - 🔴 [`activity_events.hr_id` is MIXED case — a lowercase `.eq` reads 3%](activity-events-hr-id-is-mixed-case-not-lowercase.md)
    - 🔴 **[a top-level `import sharp` 500s a whole PAGE — the standalone trace drops the `.so`](next-standalone-trace-misses-a-native-librarys-so-dependency.md)** — load native modules ON DEMAND; assert them at BUILD time.
    - 🔴 [`sharp` is a **devDependency** that TWO live routes import](sharp-is-a-devdependency-that-two-production-paths-import.md) · [`.extract().stats()` measures the SOURCE, not the crop](sharp-extract-then-stats-measures-the-source-image.md)
    **Hooks only — the label is the cue, the FILE is the fact.**
    - 🔴 **[ARCHIVE](MEMORY-ARCHIVE.md)**: 33 traps, 10 worktree notes, 197 files by topic — incl. Excel row outline; the orphan sweep is dead-platform history, SUPERSEDED.
    - 🔴 **[achievement divides COVERED actual, never all sales](achievement-numerator-is-covered-actual-not-all-sales.md)** — a % re-aggregates only by summing its parts; 4 sites read 130.73% for 50.67%.
    - 🔴 **[COVERAGE vs FREQUENCY DISAGREE — 68% vs 39%](crm-coverage-and-frequency-are-two-kpis-that-disagree.md)** — score the PLAN, never the grade.·[a MoM trend compares DIFFERENT reps](crm-month-over-month-does-not-compare-the-same-reps.md)
    - 🔴 **[CRM mobile cards: MODULE-WIDE, CI-enforced](crm-mobile-cards-are-module-wide-and-ci-enforced.md)** — fix the board, not the test.
    - 🔴 **[a SERVER component can't pass a fn to a client one](a-server-component-cannot-pass-a-function-to-a-client-one.md)** — judge by the IMPORT GRAPH, never the directive.·[a broken RSC page still returns 200](a-broken-rsc-page-still-returns-http-200.md)·[the primitive renders EVERY row TWICE — 19MB](portal-responsive-data-list-renders-every-row-twice.md)
    - 🔴 **[the offer chain had a hole past approval](offer-chain-was-live-in-the-registry-with-a-hole-past-approval.md)** — gated on `approved_at`, never the stage.·[`ats_candidate_status_events`: NO FK on purpose; `..._source_context` is a VIEW](ats-candidate-children-one-has-no-fk-and-one-is-a-view.md)
    - 🔴 [Capture Evidence: DEAD for 81% of customers](capture-evidence-was-dead-on-arrival-for-doctor-customers.md)
    - 🔴 **[a reused CRM slot hides an ACTIVE rep](crm-resigned-slot-reused-for-new-hire.md)** — the hard-floor list OUTRANKS `employment_status`; removing an id needs the owner's go.
    - 🔴 Deductions: [2 engines = DELIBERATE](two-live-deduction-engines-p0.md)·[`deductions_*` is truth; legacy has the cron](deductions-canonical-but-legacy-has-the-only-daily-cron.md)
    - 🔴 [hiring scans: `hiring_document_files` + PRIVATE bucket LIVE](hiring-document-files-table-and-private-bucket-live-in-prod.md) — `rls_enabled_no_policy` INFO is CORRECT; 85 tables share it.
    - 🔴 [Deploy applies NO migrations](railway-deploy-applies-no-migrations.md)·[auto-deploy can silently SKIP](railway-auto-deploy-can-silently-skip-a-race.md)·[`--stdin` stores a BOM](railway-stdin-bom-trap.md)
    - 🔴 [Maps keys in `phoenix-hr-2026`](google-maps-keys-moved-to-phoenix-hr-2026.md)·[`.env*` reads auto-approved](env-file-reads-fully-auto-approved-2026-08-09.md)
    - 🔴 [`mcp__supabase-staging__*` broken](supabase-staging-named-server-broken-2026-08-10.md)·[`expense_claims`=the ONE live RLS read](expense-claims-rls-read-path-is-live-in-prod.md)
    - 🔴 **[NEVER change the organogram SKELETON, nor propose it](never-change-the-organogram-skeleton.md)** — seats, reporting lines, `manager_hr_id`. A vacancy is a HIRE in progress, not a gap to patch. Only the Super Admin, by his own intent.
    - 🔴 **[Form 1 prints EXACTLY as issued — page 2 blank, CI-pinned](government-form1-prints-exactly-as-issued.md)** — duplex, 3 copies; the contract is single-sided, 4.
    - 🔴 Audit: [payroll writes unaudited until #2241](payroll-mutations-were-unaudited-until-2026-08-21.md)·[vacations: no gap, TWO tables](vacations-audit-coverage-is-complete-via-two-tables.md)·[standalone needs an EXTENDED loader](running-vacation-service-standalone-needs-an-extended-loader.md)
    - 🔴 [`employees.line_name` is NULL in prod — use `line_id`](employees-line-name-column-is-null-in-production.md)·[`mobile_number` NOT dialable — 71% lost the leading zero](employees-mobile-number-is-not-dialable-as-stored.md)
    - 🔴 **[a matrix grant is only GATE ONE of two](a-matrix-grant-is-only-gate-one-of-two.md)** — 3 shipped granted-but-bounced; probe both gates, never read the matrix.
    - 🔴 [a THIRD of target territories have NO rep — 33/107](a-third-of-target-carrying-territories-have-no-rep.md)
    - 🔴 **[an acting DM's authority is `app_auth_users.role`, not `job_title`](acting-dm-authority-is-app-role-not-job-title.md)** — OWNER RULE: a rep acting as DM STAYS a medical rep; never promote her title or her seat. To give her reps, move the REPS.
    - 🔴 [a LOCAL run writes prod and skips email](local-run-against-prod-db-silently-skips-every-email.md)
    - 🔴 [`banned_until='infinity'` 500s the auth admin API](banned-until-infinity-breaks-the-whole-auth-admin-api.md)
    - 🔴 [sales→marketing sync was unsafe to re-run, FIXED](sales-to-marketing-sync-creates-ambiguous-duplicates.md)·[STAGING can't rehearse PROD-surgery shapes](staging-cannot-rehearse-shapes-only-prod-surgery-made.md)
    - 🔴 [a `not_found` code has THREE root causes](marketing-not-found-codes-have-three-root-causes.md)·[codes are NOT geographic](pharmacy-code-numbers-are-not-geographic.md)·[an UNRESOLVED code hides the pharmacy under a distributor](marketing-transfer-writes-no-distributor-link-when-the-code-is-unresolved.md)
    - 🔴 [**`system_validated` means NO HUMAN LOOKED** — GPS + a timestamped photo, nothing else](marketing-system-validated-means-no-human-looked.md) — `validated_by_hr_id` NULL on every one; the register never blocks, **SUPER ADMIN ONLY** (not SFE).
    - 🔴 ["Applying for" is DERIVED at read time, writes nothing](applying-for-is-derived-and-the-residue-is-genuinely-silent.md)
    - 🔴 **[a >2MB `unstable_cache` entry KILLS dev; prod silently stops caching](next-2mb-data-cache-throws-only-in-dev-and-kills-the-server.md)** — uncatchable; gzip the rows, return null over the ceiling.
    - 🔴 **[tracing an include copies FILES, not pnpm's SYMLINKS — it still won't resolve](next-tracing-copies-files-not-pnpm-symlinks.md)** — FIXED 08-22: hoist + a `*/**` glob, CI-gated.
    - 🔴 git: [deleting a branch keeps its commit](deleting-a-branch-does-not-remove-a-pushed-commit.md)·[never reuse a squash-merged branch](reusing-a-squash-merged-branch-makes-a-conflicting-pr.md)·[BLOCKED = BEHIND, not red CI](merge-blocked-says-checks-but-means-behind.md)·[push hangs, kill ~60s](git-push-to-origin-hangs-retry-immediately.md)·[push OOM = a 500MB `postBuffer`; the retry cries AUTH](git-push-oom-is-a-500mb-postbuffer-in-repo-config.md)·[`--auto` never](gh-pr-merge-auto-merges-immediately.md)·[2 sessions, 1 bug](two-sessions-fixed-one-bug-main-was-never-ci-validated.md)
    - 🔴 **[a top-level `import sharp` 500s a PAGE — the trace drops the `.so`](next-standalone-trace-misses-a-native-librarys-so-dependency.md)** — load native modules ON DEMAND; assert them at BUILD time.
    - 🔴 [`sharp`: TWO live routes import it, moved to deps #2301](sharp-is-a-devdependency-that-two-production-paths-import.md) · [`.extract().stats()` measures the SOURCE, not the crop](sharp-extract-then-stats-measures-the-source-image.md)

> Correction, same date: the `refs/deleted-*` line above was first re-written to claim "0 left, verified 08-23". That was FALSE — a bad `for-each-ref` glob. 19 branch tips and 10 stashes are intact; the index line now records the glob trap instead.


## Archived from the index 2026-08-23 — 15 pointers whose fact is ALREADY auto-loaded

Moved out of `MEMORY.md` at the owner's instruction ("archive the settled pointers"), 2026-08-23.
**Nothing here is retired and no file was deleted — every one is still true, and every one is still
reachable through this file.** They earned the move on one test only, applied per pointer and
grep-verified before the cut: *is this fact already in context on every single turn without the
index carrying it?* `CLAUDE.md` line 10 is `@AGENTS.md`, so AGENTS.md loads every session — a
fact stated there and echoed here cost bytes in the file with a hard read cutoff and bought no
recall. Index saved **1,017 bytes** (24,069 → 23,052).

**Restoration trigger — if AGENTS.md or CLAUDE.md is ever trimmed, these lose their only auto-loading
home and must go straight back into the index.** Re-check with the phrase in the right-hand column
before assuming any line here is still covered.

| Index label as it read | File | Fact still auto-loads from |
| --- | --- | --- |
| merge=prod | [railway-merge-is-the-production-deploy.md](railway-merge-is-the-production-deploy.md) | AGENTS §2 — *"A merge to `main` SHIPS TO PRODUCTION IMMEDIATELY"* |
| Cloud Run dead | [railway-is-prod-cloud-run-workflow-is-dead.md](railway-is-prod-cloud-run-workflow-is-dead.md) | AGENTS §3 — *"GCP is DEAD, not standby"* |
| prod writes pre-authorized | [supabase-mcp-and-cli-revoked-2026-08-02.md](supabase-mcp-and-cli-revoked-2026-08-02.md) | AGENTS §8 — *"Supabase writes are pre-authorized end to end"* |
| `.env.local`=PROD | [local-env-already-points-at-production.md](local-env-already-points-at-production.md) | AGENTS §3 — *"`.env.local` points at PRODUCTION Supabase"* |
| visibility is app-scoped | [app-visibility-is-application-scoped-not-rls.md](app-visibility-is-application-scoped-not-rls.md) | AGENTS §8 — *"application-scoped, not RLS-scoped"* |
| `defaultMode`=`auto` | [permission-allowlist-user-level-2026-08-01.md](permission-allowlist-user-level-2026-08-01.md) | AGENTS §1.5 — *"`permissions.defaultMode` is **`auto`**"* (2 hits) |
| `list_migrations` lies | [list-migrations-reports-ledger-not-reality.md](list-migrations-reports-ledger-not-reality.md) | AGENTS §2 — *"`list_migrations` reports the migration ledger, not reality"* |
| `check:harden` ≠ CI | [ci-does-not-run-check-harden.md](ci-does-not-run-check-harden.md) | CLAUDE.md §Commands + AGENTS §7 — retired 2026-08-18 (2 hits) |
| `--auto` never | [gh-pr-merge-auto-merges-immediately.md](gh-pr-merge-auto-merges-immediately.md) | AGENTS §2 — *"Never use `gh pr merge --auto`"* |
| local gates REMOVED — CI is the gate | [local-validation-gates-are-gone-ci-is-the-gate.md](local-validation-gates-are-gone-ci-is-the-gate.md) | CLAUDE.md headline + AGENTS §7 — *"CI is the gate"* (3 hits) |
| prove WHICH assertion fired | [prove-it-fails-verify-which-assertion-fired.md](prove-it-fails-verify-which-assertion-fired.md) | AGENTS §2 — *"break the fix and confirm the new test's own headline assertion fires"* |
| tsc false-greens warm | [typecheck-incremental-false-green.md](typecheck-incremental-false-green.md) | AGENTS §2 — *"must not trust a warm TypeScript cache … `tsc --incremental false`"* |
| 16GB ceiling | [laptop-m17r2-ram-soldered-16gb-ceiling.md](laptop-m17r2-ram-soldered-16gb-ceiling.md) | AGENTS §5 — *"the laptop's RAM is soldered at 16 GB"* + the Machine-limits table |
| no foreground-watching | [dont-foreground-watch-long-pipelines.md](dont-foreground-watch-long-pipelines.md) | AGENTS §2 — *"Never foreground-watch a long pipeline"* |
| sales→marketing re-run was unsafe, FIXED | [sales-to-marketing-sync-creates-ambiguous-duplicates.md](sales-to-marketing-sync-creates-ambiguous-duplicates.md) | the file's own opening: *"IT IS FIXED ON PRODUCTION as of 2026-08-19 … it is history, not a live hazard"* |

Two candidates were **tested and kept** because the memory carries more than the doc does:
[dev-auth-is-header-only-browser-pane-cannot-use-it.md](dev-auth-is-header-only-browser-pane-cannot-use-it.md)
(AGENTS §2 covers header sweeps but never the browser-pane `GET /api/dev-auth?role=…` form) and
[repo-doctor-strip-idle-cannot-run-with-sessions-open.md](repo-doctor-strip-idle-cannot-run-with-sessions-open.md)
(AGENTS §5 documents `--fix`, never `--strip-idle`). Two more were tested and found **unique to
memory**, so they stay in the index: `railway-deploy-applies-no-migrations.md` and
`supabase-staging-named-server-broken-2026-08-10.md`.

This supersedes the analysis in *"Moved out of the index 2026-08-23 — duplicated verbatim by
AGENTS.md"* above, which was written when the same six were dropped and then restored. That section
is the reasoning; **this one is the action that actually happened.** The six appear in both.


## Archived from the index 2026-08-23 (pass 2) — 3 pointers already carried by the always-loaded docs

`CLAUDE.md` line 10 is `@AGENTS.md`, so **AGENTS.md and CLAUDE.md load into context every single turn.**
A fact stated there needs no index pointer to be recalled. Each row below was verified by searching
those two files for the memory's *distinctive* phrases — not generic tokens, which produce false positives.
**No memory file was deleted. Only the index line moved.**

| Index label | File | Why it is safe to archive |
| --- | --- | --- |
| CI-LOCKED, never hand-edit fingerprints | [office-golden-rule-is-mechanically-locked.md](office-golden-rule-is-mechanically-locked.md) | CLAUDE.md § Protected Files carries it verbatim: `office-golden-rule-lock.test.ts`, `pnpm run office-rule:unlock`, the scrypt verifier, and the required `validate` job. |
| ask/deny strip COMMITTED, not live | [ask-deny-strip-is-committed-not-live.md](ask-deny-strip-is-committed-not-live.md) | CLAUDE.md § Protected Files + AGENTS.md §1.5 carry the whole story, including the `6fd35986` recovery commit and 'emptied both lists'. |
| BLOCKED ≠ BEHIND since 08-05 | [merge-blocked-says-checks-but-means-behind.md](merge-blocked-says-checks-but-means-behind.md) | AGENTS.md §2 carries `strict: false`, 'require branches to be up to date' being OFF, and the ~16 Actions minutes cost. The trap it warns about cannot fire any more. |

**RESTORATION TRIGGER — read this before trimming AGENTS.md or CLAUDE.md.** All three above have
no auto-loading home *other than* those two files. If either is ever trimmed, shortened, or has the
`@AGENTS.md` include removed, these pointers must go straight back into `MEMORY.md`.

### Unreachable file rescued 2026-08-23

`repo:doctor` reported zero orphans because it counts a file reachable if **either** `MEMORY.md` or this
archive links it. Scanning the two files separately found one that neither did — invisible to every
future session, not merely hard to find.

- [visits-report-module-audit.md](visits-report-module-audit.md) — `/admin/visits-report` deep audit,
  2026-07-04. **Self-described SUPERSEDED**: PR #788 rebuilt Double Visit Analytics onto
  `ireports360_visits` (so its "Dependents = NONE" line is wrong), and PR #796 fixed items 4–7 the same
  day. Items 1/2/3/8 were never fixed — re-verify against current `main` before trusting either way.
  Archived rather than indexed: it is a point-in-time audit, not a standing rule.

## Index caveats trimmed 2026-08-23 (compaction #3) — the FULL wording (nothing here is retired)

Shortened in `MEMORY.md` on 2026-08-23 at the owner's instruction ("compact the memory index").
**No memory was deleted and no pointer was orphaned** — the link audit ran before and after:
221 unique pointers in, 218 out, and all three that left the index (`ask-deny-strip-is-committed-not-live`,
`merge-blocked-says-checks-but-means-behind`, `office-golden-rule-is-mechanically-locked`) were moved to
this file by a parallel session under the "already auto-loaded by AGENTS.md/CLAUDE.md" test, not dropped.
Index went 23,939 -> 22,916 bytes by compaction, then **landed at 23,249** — parallel sessions added ~330 bytes
during the pass and one orphaned memory needed indexing. **17.1KB remained unreachable**: filenames plus `[]()` syntax alone
cost 12,119 bytes, and the measured floor with every label cut to 25 bytes and every tail deleted was 20,256.

Tails that state an OWNER RULE or a SAFETY RULE were kept in the index verbatim and are not listed here.
The original wording of every line that changed:

- 🔴 **33 more traps + 10 on worktrees → [ARCHIVE](MEMORY-ARCHIVE.md)** — incl. Excel row outline.
- 🔴 **[achievement divides COVERED actual](achievement-numerator-is-covered-actual-not-all-sales.md)** — 7 sites, 3 modules; one DM read 48.5% for a 2.2% July.
- 🔴 **[COVERAGE vs FREQUENCY DISAGREE — 68% vs 39%](crm-coverage-and-frequency-are-two-kpis-that-disagree.md)** — score the PLAN, never the grade.·[MoM does NOT compare the same reps](crm-month-over-month-does-not-compare-the-same-reps.md)
- 🔴 **[a SERVER component can't pass a fn](a-server-component-cannot-pass-a-function-to-a-client-one.md)** — judge by the IMPORT GRAPH.·[a broken RSC page still returns 200](a-broken-rsc-page-still-returns-http-200.md)·[the primitive renders EVERY row TWICE](portal-responsive-data-list-renders-every-row-twice.md)
- 🔴 **[the offer chain had a hole past approval](offer-chain-was-live-in-the-registry-with-a-hole-past-approval.md)** — gated on `approved_at`, not the stage.·[ats children: NO FK BY DESIGN; one is a VIEW](ats-candidate-children-one-has-no-fk-and-one-is-a-view.md)
- 🔴 **[the 23 WhatsApp "photo CVs" are CERTIFICATES](whatsapp-import-images-return-nothing-from-vision.md)**·[an EMPTY extraction = "not a CV"](an-empty-cv-extraction-is-the-designed-answer-to-a-non-cv.md) — gate on `=== false`, NULL = unjudged.
- 🔴 **[a Windows env var SHADOWS every `.env.local`](windows-env-var-shadows-every-env-local-key.md)** — probe `/v1/models`, NEVER print the value.·**[OpenAI key: the stored one is VALID](openai-key-is-401-and-cv-extraction-silently-falls-back-to-rules.md)** — verify by fingerprint, never print it, never ask the owner for a CV.
- 🔴 **[rep visits CANNOT reach bricks (maps EMPTY)](crm-visits-join-to-bricks-both-maps-now-filled.md)**·[GPS check-ins are PARTIAL — never score](gps-checkins-are-a-partial-feed-never-score-a-rep-on-them.md)
- 🔴 Deductions: [2 engines = DELIBERATE](two-live-deduction-engines-p0.md)·[`deductions_*` is truth, legacy has the cron](deductions-canonical-but-legacy-has-the-only-daily-cron.md)·[**"6 connectors failed" = the month-guard WORKING**](deductions-collection-refuses-the-month-the-page-defaults-to.md)
- 🔴 Office: [OWNER'S RULE #2015](owner-office-allocation-rule-value-share.md)·🔒[CI-LOCKED, never hand-edit fingerprints](office-golden-rule-is-mechanically-locked.md)·[city split OFF](city-split-hides-same-city-customer-moves.md)
- 🔴 [`hiring_document_files` + PRIVATE bucket LIVE](hiring-document-files-table-and-private-bucket-live-in-prod.md) — its `rls_enabled_no_policy` INFO is CORRECT.
- (was a `##` section heading in the index) Prod & approval (Railway) — the 6 facts AGENTS §2/§3 already loads are in [ARCHIVE](MEMORY-ARCHIVE.md)
- 🔴 [put the precondition in every prod `WHERE`](guard-every-prod-write-when-another-session-shares-the-queue.md)·["Log out everywhere"=THREE writes](force-logout-everywhere-needs-three-writes.md)
- 🔴 [a CONTACT read needs `includeResignedAgents`](crm-door-resigned-exclusion-costs-a-contact-read-1100-doctors.md)
- 🔴 **[Form 1 prints EXACTLY as issued — CI-pinned](government-form1-prints-exactly-as-issued.md)** — duplex, 3 copies; the contract is single-sided, 4.
- 🔴 [organogram export CARRIES the mobile — owner override](organogram-export-carries-the-mobile-by-owner-override.md) — fetched at export time; NEVER move it onto the row.
- 🔴 [Territory preview: NEVER show the line](territory-preview-link-must-never-show-the-line.md)·[Organogram CHART=AU seats, popup=dir](organogram-chart-source-is-au-seat-model-not-directory.md)·[WhatsApp button STAYS on the CEO/NSM rows](whatsapp-button-on-leadership-rows-is-an-owner-decision.md)
- 🔴 [NSM is held ONCE PER LINE](nsm-title-is-held-once-per-line-not-company-wide.md)·[weekly mapping-template = `update` + CEO](weekly-mapping-template-is-update-plus-a-ceo-exception.md)
- 🔴 Audit: [payroll writes were unaudited until #2241](payroll-mutations-were-unaudited-until-2026-08-21.md)·[vacations: no gap, TWO tables](vacations-audit-coverage-is-complete-via-two-tables.md)·[standalone needs an EXTENDED loader](running-vacation-service-standalone-needs-an-extended-loader.md)
- 🔴 [NULL `agent_hr_id` on a PLAN row = a LEAVER](crm-null-plan-hrid-means-leaver-not-defect.md)
- 🔴 SoS: [never delete areas](sos-areas-must-never-be-deleted-au-linkage.md)·[standing rules](sos-owner-standing-rules-from-session-369dd08d.md)·[`source_of_sales_bricks`=branch→area AUTHORITY](sos-bricks-are-the-authority-for-branch-to-area.md)
- 🔴 **SoS/closing/Direct internals — 45 more in [ARCHIVE](MEMORY-ARCHIVE.md).** Read before touching SoS/imports.
- 🔴 [weekly + monthly keep SEPARATE alias tables](weekly-ignore-aliases-can-contradict-monthly-sos.md)·[`IGNORE` is the ONLY mapping that DELETES](ignore-alias-deletes-and-the-manual-closing-decides.md)
- 🔴 **[a matrix grant is only GATE ONE of two](a-matrix-grant-is-only-gate-one-of-two.md)** — probe both gates; never read the matrix.
- 🔴 **[an unauthenticated caller has role `Employee`, NOT null](an-unauthenticated-caller-has-role-employee-not-null.md)** — every `!access.role` 401 is DEAD; test `source === "guest"`.
- 🔴 [new accounts default to `Employee`](account-creation-defaults-role-to-employee.md)·[a role change takes FOUR writes](changing-a-user-role-needs-four-writes.md)·[`public.users` is DEAD and EMPTY](public-users-table-is-dead-and-empty.md)
- 🔴 [RAILWAY_TOKEN was fixed 08-09 — sync is PATHS-FILTERED](railway-token-expired-breaks-all-secret-sync.md)·[punch ingestion needs the office LAN](attendance-agent-needs-the-office-lan.md)
- 🔴 [Error Monitor HIDES `environment IS NULL`](error-monitor-hides-null-environment-rows.md)·[a `zz_backup_…` table is ANON-READABLE](ad-hoc-backup-tables-are-anon-readable.md)
- 🔴 [one `banned_until='infinity'` 500s the auth API](banned-until-infinity-breaks-the-whole-auth-admin-api.md)
- 🔴 Marketing: [nothing blocks a request after the CEO](nothing-blocks-a-marketing-request-after-the-ceo.md)·[an RPC decision fires NO alert, NO audit](recording-a-marketing-decision-by-rpc-skips-audit-and-alerts.md)
- 🔴 [the pharmacy code list is a STALE IMPORT](marketing-reference-list-is-a-point-in-time-import.md)·[trust `raw_region`; `raw_area` DRIFTS](marketing-reference-raw-area-drifts-raw-region-does-not.md)
- 🔴 [STAGING cannot rehearse PROD-surgery shapes](staging-cannot-rehearse-shapes-only-prod-surgery-made.md)
- 🔴 [a `not_found` code has THREE root causes](marketing-not-found-codes-have-three-root-causes.md)·[codes are NOT geographic](pharmacy-code-numbers-are-not-geographic.md)·[an UNRESOLVED code hides the pharmacy](marketing-transfer-writes-no-distributor-link-when-the-code-is-unresolved.md)
- 🔴 [a duplicate is NAME+GPS, never brick](duplicate-pharmacy-test-is-name-and-gps-not-brick.md)·[customer+code is the link GRAIN](customer-pharmacy-link-grain-is-customer-plus-code.md)
- 🔴 [07-02 backfill cites requests that DON'T EXIST](marketing-links-were-backfilled-from-a-sheet-not-the-database.md)·[a link's status is FROZEN at write time](marketing-link-status-is-frozen-at-write-time.md)
- 🔴 [an Arabic fold misses Latin twins](duplicate-customer-scan-misses-transliteration-and-cross-line.md)
- 🔴 [Omar's forwarder collapses CVs onto ONE](whatsapp-forwarder-omar-collapses-cvs-onto-one-candidate.md)·[dead columns HIDDEN — keep `customer_name`](ireports360-dead-columns-are-hidden-not-deleted.md)
- 🔴 [CAMPAIGN (-8) makes a rep look like a zero](campaign-visits-make-a-working-rep-look-like-a-zero.md) — plan-vs-actual counts `visit_type = 0` ONLY.·[the two boards key the same rep differently](crm-boards-key-the-same-rep-two-different-ways.md)
- 🔴 [PROD PITR is **OFF** — 7 daily snapshots](production-supabase-has-no-pitr-only-daily-backups.md)·[batch membership is FIXED when built](payroll-batch-membership-is-historical.md)
- 🔴 Recruitment: [CV "Failed to fetch"=a DOWNLOAD MANAGER](cv-file-route-downloads-unless-asked-inline.md)·[INTAKE works, the PIPELINE never has](recruitment-intake-works-pipeline-never-used.md)·[a candidate keeps the SENDER's name](intake-candidates-never-get-phone-applied.md)·[40% of `full_name` is the envelope](ats-candidates-full-name-holds-the-whole-intake-envelope.md)
- 🔴 [`expenses` gates `/api/marketing-requests/**` too](expenses-permission-also-gates-all-marketing-requests.md)·[sidebar widths are test-enforced](portal-sidebar-label-width-budget.md)·[NOWRAP needs `min-w-0`](portal-grid-items-need-min-w-0-for-nowrap-cards.md)·[a responsive test proves LAYOUT, not content](a-responsive-primitive-test-proves-layout-not-content.md)
- 🔴 Claude config: [ask/deny strip COMMITTED, not live](ask-deny-strip-is-committed-not-live.md)·[both Max accounts share ONE config](both-max-accounts-share-one-local-config.md)·[a DENIED connector still LISTS](a-denied-mcp-connector-still-appears-in-the-tool-list.md)·[an allow-rule can bake in a LIVE secret](permission-allowlist-rules-can-embed-a-live-secret.md)
- 🔴 DB: [round trips cross the Atlantic](every-db-round-trip-crosses-the-atlantic.md)·[`PARALLEL SAFE` is CORRECTNESS](public-functions-are-parallel-unsafe-by-default.md)·[>15s times out but COMMITS](supabase-client-15s-timeout-commits-anyway-half-applies.md)·[a slow `phx_*` is a WRAPPER → `au`](sales-vs-target-cost-is-inside-au-monthly-attribution.md)
- 🔴 **[a >2MB `unstable_cache` KILLS dev, mutes prod](next-2mb-data-cache-throws-only-in-dev-and-kills-the-server.md)** — uncatchable; gzip rows, return null over the ceiling.
- 🔴 **[tracing copies FILES, never pnpm SYMLINKS](next-tracing-copies-files-not-pnpm-symlinks.md)** — burned a prod deploy, FIXED 08-22; hoist + `*/**` glob, CI-gated.
- 🔴 [`grep -r` hangs — use `git grep`](shell-grep-unusable-use-git-grep-or-rg.md)·[**`pnpm run` PURGES node_modules**](pnpm-run-tries-to-purge-node-modules-when-the-lockfile-moved.md)·[a role probe can't trust the status](a-role-probe-cannot-trust-the-http-status-code.md)·[`git show REF:path` mangles on MSYS — DOT-leading paths only](git-ref-colon-path-is-mangled-by-msys-returns-empty.md)
- 🔴 [a sweep scoped by TOPIC misses the dangerous claims](staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones.md) — sweep by CLAIM; retarget dead TODOs, never rewrite dated records.
- 🔴 **[ONE new hub page = FOUR separate CI gates](adding-a-hub-page-trips-four-separate-ci-gates.md)** — each hides the next; run the suite first.
- 🔴 [a merge MID-SESSION orphans your next push](a-merge-mid-session-orphans-your-next-push-silently.md)
- 🔴 **[deleted tips+stashes live in `refs/deleted-*`](deleted-branch-tips-live-in-refs-deleted-branches.md)** — the ONLY copy, never pushed; count LIVE (it grows); **`for-each-ref refs/deleted-*` reads 0** — full prefix.
- 🔴 git: [deleting a branch keeps its commit](deleting-a-branch-does-not-remove-a-pushed-commit.md)·[never reuse a squash-merged branch](reusing-a-squash-merged-branch-makes-a-conflicting-pr.md)·[BLOCKED ≠ BEHIND since 08-05](merge-blocked-says-checks-but-means-behind.md)·[push hangs, kill ~60s](git-push-to-origin-hangs-retry-immediately.md)·[push OOM = a 500MB `postBuffer`](git-push-oom-is-a-500mb-postbuffer-in-repo-config.md)·[2 sessions, 1 bug](two-sessions-fixed-one-bug-main-was-never-ci-validated.md)
- 🔴 Worktrees: [another SESSION can remove one](another-session-can-remove-a-worktree-under-you.md)·[`_wt-*/` hides one](gitignored-wt-scratch-makes-a-worktree-look-clean.md)·[a bare one can't PUSH](bare-worktree-cannot-push-pre-push-gate-needs-node-modules.md)·["Permission denied" still deregisters](worktree-remove-permission-denied-still-deregisters.md)·[`--fix` needs ONE session](repo-doctor-strip-idle-cannot-run-with-sessions-open.md)·[**`pnpm run` PURGES `node_modules`** once the lockfile moves](pnpm-run-tries-to-purge-node-modules-when-the-lockfile-moved.md)
- 🔴 [click by TEXT — blind clicks fired PROD](blind-coordinate-clicks-fired-a-production-collection-run.md)·[browser dev-login = `GET /api/dev-auth?role=…`](dev-auth-is-header-only-browser-pane-cannot-use-it.md)·[`0xc0000142` = commit exhausted](turbopack-500s-with-0xc0000142-when-commit-is-full.md)·[verify 375px with NO dev server](verify-a-mobile-layout-without-a-dev-server.md)
- 🔴 [`updated_by_hr_id` LIES about who wrote](how-to-attribute-a-production-write.md)
- 🔴 [`activity_events.hr_id` is MIXED case (3% on `.eq`)](activity-events-hr-id-is-mixed-case-not-lowercase.md)
- 🔴 **[a top-level `import sharp` 500s a PAGE (no `.so`)](next-standalone-trace-misses-a-native-librarys-so-dependency.md)** — load native modules ON DEMAND; assert at BUILD.
- 🔴 [`sharp`: TWO live routes import it, moved to deps #2301](sharp-is-a-devdependency-that-two-production-paths-import.md) · [`.extract().stats()` measures SOURCE, not crop](sharp-extract-then-stats-measures-the-source-image.md)


## Archived from the index 2026-08-23 (pass 4) — 51 pointers demoted from five low-traffic topic groups

`MEMORY.md` had crossed the **24.4KB read ceiling** (25,002 bytes) — past it a session loads the
index *partially*, so its tail silently stops existing. `repo:doctor` reported **zero orphans and zero
broken pointers**, so there was nothing dead to reclaim; label text already averaged **33.8 bytes**, which
[[memory-index-floor-is-13kb-dont-gut-it-chasing-17]] measured as the floor (a trim pass returns ~5 bytes
an edit). The only lever left with real yield was demoting whole topic groups.

**No memory file was deleted and nothing here is retired — every line below is still true.** They moved
because `repo-doctor.mjs` counts `INDEX_FILES = ["MEMORY.md", "MEMORY-ARCHIVE.md"]`, so a pointer in this
file keeps its memory *reachable*; it is no longer *auto-loaded*, which is the whole cost and the whole
saving. Each group left a pointer line in the index naming what is down here.

Selection rule, applied per line: **demote reference-grade detail, keep every owner rule, safety rule, and
destructive-action guard.** `system_validated` = NO HUMAN LOOKED, the REGISTERED-CODE-beats-GPS owner rule,
PROD PITR OFF, the 15s-timeout-commits-anyway trap, and the allow-rule-bakes-a-live-secret hook were all
tested against this rule and **kept in the index**.

Index: **25,002 → 20,908 bytes** (24.42KB → 20.42KB), **231 → 180 unique pointers**. Counting note
(the trap [[memory-index-floor-is-13kb-dont-gut-it-chasing-17]] step 8 names): **51** unique pointers left the
index — 46 link *occurrences* sat on the fully-removed lines below, and 5 more came off the two split
lines. All 51 resolve from this file; `repo:doctor` reports **832 files, 833 pointers, zero orphans**.

### SoS / weekly / closing internals

- 🔴 [store-split cache needs a version key](closing-store-split-cache-cannot-be-keyed-on-timestamps.md)·[EVERY xlsx RECALCULATES on open](exceljs-workbooks-are-recalculated-on-open.md)
- 🔴 [NEVER silent-drop a sales row — FLAG it](never-silent-drop-count-and-flag-instead.md)·[PS/PS-T ship the same UPA line twice](ps-and-ps-t-carry-the-same-upa-tender-line-twice.md)
- 🔴 [weekly batch HEADER is a stored column](weekly-batch-header-drifts-from-its-own-rows.md)·[Direct is NOT cumulative](direct-is-not-cumulative-but-is-de-cumulated-anyway.md)
- 🔴 [weekly+monthly: SEPARATE alias tables](weekly-ignore-aliases-can-contradict-monthly-sos.md)·[`IGNORE` is the ONLY mapping that DELETES](ignore-alias-deletes-and-the-manual-closing-decides.md)

### Org structure / role-write detail

- 🔴 [read `au_v_employee_seat_drift` FIRST](au-seat-drift-view-is-the-org-truth-check.md)·[Organogram has TWO data paths](organogram-has-two-data-paths-suppress-only-hits-vacancies.md)
- 🔴 [a THIRD of territories have NO rep (33/107)](a-third-of-target-carrying-territories-have-no-rep.md)
- 🔴 [new accounts default to `Employee`](account-creation-defaults-role-to-employee.md)·[a role change = FOUR writes](changing-a-user-role-needs-four-writes.md)·[`public.users` is DEAD and EMPTY](public-users-table-is-dead-and-empty.md)
- 🔴 [RAILWAY_TOKEN fixed; sync PATHS-FILTERED](railway-token-expired-breaks-all-secret-sync.md)·[punch ingestion needs the office LAN](attendance-agent-needs-the-office-lan.md)

### Marketing pharmacy-code internals

- 🔴 Marketing: [`marketing_request_events` = history](marketing-request-events-is-the-history-table.md)·[the stop role is SALES-ONLY](marketing-manager-chain-target-is-sales-only.md)·[MM A-9 OUTRANKS PM A-10](marketing-manager-outranks-product-manager.md)
- 🔴 Marketing: [nothing blocks a request after the CEO](nothing-blocks-a-marketing-request-after-the-ceo.md)·[an RPC decision: NO alert, NO audit](recording-a-marketing-decision-by-rpc-skips-audit-and-alerts.md)
- 🔴 [pharmacy code list = STALE IMPORT](marketing-reference-list-is-a-point-in-time-import.md)·[trust `raw_region`; `raw_area` DRIFTS](marketing-reference-raw-area-drifts-raw-region-does-not.md)
- 🔴 [`not_found` has THREE root causes](marketing-not-found-codes-have-three-root-causes.md)·[codes are NOT geographic](pharmacy-code-numbers-are-not-geographic.md)·[UNRESOLVED code hides the pharmacy](marketing-transfer-writes-no-distributor-link-when-the-code-is-unresolved.md)
- 🔴 [a duplicate is NAME+GPS, not brick](duplicate-pharmacy-test-is-name-and-gps-not-brick.md)·[customer+code = the link GRAIN](customer-pharmacy-link-grain-is-customer-plus-code.md)
- 🔴 [Arabic fold misses Latin twins](duplicate-customer-scan-misses-transliteration-and-cross-line.md)
- 🔴 [07-02 backfill cites requests that DON'T](marketing-links-were-backfilled-from-a-sheet-not-the-database.md)·[a link's status FROZEN at write time](marketing-link-status-is-frozen-at-write-time.md)

### Recruitment / ATS / CV intake + iReports360 reference

- 🔴 [Omar's forwarder collapses CVs to ONE](whatsapp-forwarder-omar-collapses-cvs-onto-one-candidate.md)·[dead columns HIDDEN — keep `customer_name`](ireports360-dead-columns-are-hidden-not-deleted.md)
- 🔴 [7 visit-type codes UNDOCUMENTED](ireports360-undocumented-visit-type-codes.md)
- 🔴 ["Applying for" is DERIVED, writes nothing](applying-for-is-derived-and-the-residue-is-genuinely-silent.md)
- 🔴 Recruitment: [CV "Failed to fetch"=DOWNLOAD MANAGER](cv-file-route-downloads-unless-asked-inline.md)·[INTAKE works, the PIPELINE never has](recruitment-intake-works-pipeline-never-used.md)·[a candidate keeps the SENDER name](intake-candidates-never-get-phone-applied.md)·[40% of `full_name` is the envelope](ats-candidates-full-name-holds-the-whole-intake-envelope.md)

### Workflow-registry & field-shape reference

- 🔴 [`employees.line_name` NULL — use `line_id`](employees-line-name-column-is-null-in-production.md)·[`mobile_number` NOT dialable (71%)](employees-mobile-number-is-not-dialable-as-stored.md)
- 🔴 [NULL `agent_hr_id` on a PLAN row = LEAVER](crm-null-plan-hrid-means-leaver-not-defect.md)
- 🔴 Chains have TWO truths: [TS + `workflow_registry_modules`](workflow-registry-drifts-from-the-typescript-chain.md)·[a trigger OWNS `version`](workflow-registry-version-is-trigger-owned.md)
- 🔴 [`raw_value` is FRACTIONAL days](deduction-raw-value-is-days-dates-is-not.md)·[NULL `crm_id` ≠ no CRM activity](employees-crm-id-null-does-not-mean-no-crm-activity.md)

### Split lines — the safety hook stayed in the index, these reference hooks moved

Both lines are reproduced **verbatim as they read before the split**, so the demoted wording is intact:

- 🔴 Claude config: [both Max accounts share ONE config](both-max-accounts-share-one-local-config.md)·[a DENIED connector still LISTS](a-denied-mcp-connector-still-appears-in-the-tool-list.md)·[an allow-rule can bake in a LIVE secret](permission-allowlist-rules-can-embed-a-live-secret.md)
- 🔴 DB: [round trips cross the Atlantic](every-db-round-trip-crosses-the-atlantic.md)·[`PARALLEL SAFE` is CORRECTNESS](public-functions-are-parallel-unsafe-by-default.md)·[>15s times out but COMMITS](supabase-client-15s-timeout-commits-anyway-half-applies.md)·[slow `phx_*` = a WRAPPER → `au`](sales-vs-target-cost-is-inside-au-monthly-attribution.md)

## Index caveats trimmed 2026-08-23 (pass 5)

Relocated from `MEMORY.md`, verbatim. Every pointer below stays reachable — `repo-doctor`
counts `MEMORY-ARCHIVE.md` as an index file, so these are demoted, not orphaned.

**Marketing evidence/validation internals**

- 🔴 **[the evidence gate NEVER checks photo AGE](marketing-evidence-gate-never-checks-photo-age.md)** — presence alone ⇒ `system_validated`; anything that RESTORES or REPLAYS a capture must expire it itself. 6h window, #2339.
- 🔴 **[a venue inherits the CAPTURER's area, not its own](a-marketing-venue-inherits-the-capturers-area-not-its-own-location.md)** — HO capture ⇒ nationwide `Egypt`; move the CUSTOMER rows too or it stays invisible; 7 staff on area 42. Fixed 08-23.
- 🔴 **[the Validated tab labels the LINK, not the CUSTOMER](marketing-validation-report-labels-the-link-not-the-customer.md)** — 154 backfilled links (2026-07-02, no author) ⇒ 82 `ROI-C-` customers read validated with NO photo; customer-status screens show 21. NOTHING lost; badge in #2339.

**Deductions engines, Incentive layers, Outstation models**

- 🔴 Deductions: [2 engines = DELIBERATE](two-live-deduction-engines-p0.md)·[`deductions_*` is truth; legacy has cron](deductions-canonical-but-legacy-has-the-only-daily-cron.md)·[**"6 connectors failed" = guard WORKING**](deductions-collection-refuses-the-month-the-page-defaults-to.md)·[**a LEAVER candidate has NO NAME**](crm-connector-leaver-branch-attaches-no-employee-name.md)
- 🔴 Incentive: [H1-2026 engine is OUTSIDE the repo](h1-2026-incentive-sales-analysis-engine.md)·[S1 = 3 layers](semester-1-incentive-three-layers.md)
- 🔴 Outstation: [payroll import LOCKED OUT](outstation-payroll-import-is-locked-out-by-batch-status.md)·[approving FAKES an Excel upload](outstation-expenses-two-data-models.md)·[`accepted_*` filters are DEAD](outstation-nothing-ever-reaches-accepted-status.md)

**Geocoding incidents (safety clauses kept in the index)**

- 🔴 **[a roadless coord = 200 with ZERO routes](google-routes-returns-zero-routes-for-a-governorate-centroid.md)** — EITHER endpoint; placeId/address fail too; a MISSING key looks identical. Faiyum centre routes FINE. #2338.
- 🔴 **[23 residences were saved at the EGYPT CENTROID](employee-residences-were-saved-at-the-egypt-country-centroid.md)** — the ORIGIN, not the destination; **Google answers OK with the COUNTRY when nothing matches**; a WRONG coord never self-heals — leave it NULL. 19 fixed 08-23, 0 active left; source hole closed #2340. "شيراتون" alone = the DOKKI HOTEL, 22km wrong.

**WhatsApp coexistence backlog (PostgREST trap kept in the index)**

- 🔴 **[coexistence: the BACKLOG rides `history`, not `messages`](whatsapp-coexistence-backlog-arrives-on-a-different-webhook-field.md)** — the 08-23 scan NEVER bound the handset: 0 deliveries on 201159888247, re-proven 2026-09-06 (1,362 events, ALL on the Cloud line). `history` NOT subscribed either. #2336.·**[a PostgREST `neq` on an ABSENT jsonb key matches ZERO rows](postgrest-neq-on-an-absent-jsonb-key-matches-nothing.md)** — 0/390 vs 19/390; use `is.null` OR-form.


## Index signposts consolidated 2026-08-23 (pass 6)

Nine pure signpost lines were merged into one `ARCHIVE by topic` line in `MEMORY.md`. They carried NO
memory hooks — only counts and section names. Recorded verbatim:

    - 🔴 **33 more traps + 10 on worktrees → [ARCHIVE](MEMORY-ARCHIVE.md)**
    - 🔴 **197 more files, by topic, in [ARCHIVE § Orphan sweep 2026-08-19](MEMORY-ARCHIVE.md) — first group dead-platform history, SUPERSEDED.**
    - 🔴 **Deductions engines, Incentive layers, Outstation models — 9 hooks in [ARCHIVE § 2026-08-23 pass 5](MEMORY-ARCHIVE.md)**
    - 🔴 **SoS/closing/Direct internals — 53 more in [ARCHIVE](MEMORY-ARCHIVE.md)**
    - 🔴 **15 more in [ARCHIVE § Org / email](MEMORY-ARCHIVE.md).**
    - 🔴 **Marketing pharmacy-code internals — 15 hooks in [ARCHIVE § 2026-08-23 pass 4](MEMORY-ARCHIVE.md)**
    - 🔴 **Marketing evidence/validation internals — 3 hooks in [ARCHIVE § 2026-08-23 pass 5](MEMORY-ARCHIVE.md)**
    - 🔴 **Recruitment/ATS/CV + iReports360 detail — 8 hooks in [ARCHIVE § 2026-08-23 pass 4](MEMORY-ARCHIVE.md)**
    - 🔴 **Registry, field-shape, Claude-config & DB-perf detail — 12 hooks in [ARCHIVE § 2026-08-23 pass 4](MEMORY-ARCHIVE.md)**

## Session traps relocated to AGENTS.md §2.1 — 2026-08-23 (pass 7)

Moved into the repo, where they auto-load via `CLAUDE.md`'s `@AGENTS.md` and are reviewed like code
(PR #2349). Kept verbatim here so every memory file stays reachable and nothing orphans.

- 🔴 **[a >2MB `unstable_cache` KILLS dev](next-2mb-data-cache-throws-only-in-dev-and-kills-the-server.md)** — mutes prod, uncatchable; gzip rows, null over ceiling.
- 🔴 **[tracing copies FILES, not SYMLINKS](next-tracing-copies-files-not-pnpm-symlinks.md)** — FIXED 08-22; hoist + `*/**` glob, CI-gated.
- 🔴 [`grep -r` hangs; use `git grep`](shell-grep-unusable-use-git-grep-or-rg.md)·[**`pnpm run` PURGES node_modules**](pnpm-run-tries-to-purge-node-modules-when-the-lockfile-moved.md)·[a role probe can't trust status](a-role-probe-cannot-trust-the-http-status-code.md)·[**POST to ANY api path 403s, even fake**](a-post-to-any-api-path-returns-403-even-if-it-does-not-exist.md) — probe deploys with GET: 404/405/403·[`git show REF:path` mangles on MSYS — DOT-leading paths only](git-ref-colon-path-is-mangled-by-msys-returns-empty.md)
- 🔴 Migrations: [a FILE written ≠ applied](migration-file-written-is-not-migration-applied.md)·[merged file ≠ live grants](merged-migration-file-does-not-mean-grants-are-live.md)·[timestamps COLLIDE](migration-timestamp-collides-across-parallel-branches.md)·[ledger version ≠ filename](migration-ledger-version-never-matches-the-filename.md)
- 🔴 CI: [failing in SECONDS = billing](ci-jobs-failing-in-seconds-means-billing-not-code.md)·[`secret-scan` is OFF the PR; gate is 2](github-personal-account-no-ghas-oss-scanning.md)·[`gh pr checks` LAGS](gh-pr-checks-lags-behind-the-real-job-state.md)
- 🔴 **[ONE new hub page = FOUR CI gates](adding-a-hub-page-trips-four-separate-ci-gates.md)**
- 🔴 [a merge MID-SESSION orphans your push](a-merge-mid-session-orphans-your-next-push-silently.md)
- 🔴 [`check-runs: 0` ALSO = CONFLICTED](a-conflicted-pr-runs-no-ci-at-all.md)
- 🔴 **[deleted tips+stashes: `refs/deleted-*`](deleted-branch-tips-live-in-refs-deleted-branches.md)** — the ONLY copy, never pushed; count LIVE; **`for-each-ref refs/deleted-*` reads 0** — full prefix.
- 🔴 git: [deleting a branch keeps its commit](deleting-a-branch-does-not-remove-a-pushed-commit.md)·[never reuse a squash-merged branch](reusing-a-squash-merged-branch-makes-a-conflicting-pr.md)·[push hangs, kill ~60s](git-push-to-origin-hangs-retry-immediately.md)·[push OOM = a 500MB `postBuffer`](git-push-oom-is-a-500mb-postbuffer-in-repo-config.md)·[2 sessions, 1 bug](two-sessions-fixed-one-bug-main-was-never-ci-validated.md)
- 🔴 Validation: [RAM-saturated? WAIT](dont-skip-validation-for-ram-wait-instead.md)·[fixed-byte source windows false-FAIL](source-pinning-tests-slice-a-fixed-byte-window.md)·[a heredoc ate `\b`](heredoc-eats-backslashes-and-makes-a-test-that-only-passes.md)·[`parseDiagnostics` is SYNTAX-ONLY](parse-diagnostics-cannot-see-a-typecheck-error.md)·[`setState` in `useEffect` = lint ERROR](set-state-in-effect-is-a-lint-error-here.md)
- 🔴 Worktrees: [another SESSION can remove one](another-session-can-remove-a-worktree-under-you.md)·[`_wt-*/` hides one](gitignored-wt-scratch-makes-a-worktree-look-clean.md)·[a bare one can't PUSH](bare-worktree-cannot-push-pre-push-gate-needs-node-modules.md)·["Permission denied" still deregisters](worktree-remove-permission-denied-still-deregisters.md)·[`--fix` needs ONE session](repo-doctor-strip-idle-cannot-run-with-sessions-open.md)·[**self-cleanup MUTES the exit guard**](self-removing-a-worktree-mutes-its-own-session-end-guard.md)
- 🔴 **[`--fix` can NEVER clear a `_wt-*` husk: EPERM on pnpm junctions](repo-doctor-fix-cannot-delete-a-wt-husk-pnpm-junctions-eperm.md)** — use `rmdir /s /q`; re-check the folder, an OLD CreationTime proves it never went.
- 🔴 [click by TEXT; blind clicks fired PROD](blind-coordinate-clicks-fired-a-production-collection-run.md)·[dev-login = `GET /api/dev-auth?role=`](dev-auth-is-header-only-browser-pane-cannot-use-it.md)·[`0xc0000142` = commit exhausted](turbopack-500s-with-0xc0000142-when-commit-is-full.md)·[verify 375px, NO dev server](verify-a-mobile-layout-without-a-dev-server.md)
- 🔴 **[a top-level `import sharp` 500s a PAGE](next-standalone-trace-misses-a-native-librarys-so-dependency.md)** — no `.so`; load native modules ON DEMAND, assert at BUILD.

## Demoted from MEMORY.md 2026-08-25 — reference-grade + AGENTS-redundant (reachable here, not auto-loaded)
Relocated to restore headroom below the 24.4KB loader cliff. 4 of these were already archived above; kept verbatim so every annotation travels. `a-red-main-ships` also auto-loads from `AGENTS.md` §2.1.
- 🔴 **[CRM mobile cards are MODULE-WIDE](crm-mobile-cards-are-module-wide-and-ci-enforced.md)** — fix the board, not the test.
- 🔴 **[`data-portal-desktop-table` is INERT on admin pages](data-portal-desktop-table-is-inert-on-admin-pages.md)** — portal shell injects the CSS; `AppShell` never does. All 5 admin uses DO carry a real `md:` gate — I claimed otherwise once. Read the WRAPPER.
- 🔴 **[a SERVER component can't pass a fn](a-server-component-cannot-pass-a-function-to-a-client-one.md)** — judge by the IMPORT GRAPH.·[a broken RSC page returns 200](a-broken-rsc-page-still-returns-http-200.md)·[the primitive renders EVERY row TWICE](portal-responsive-data-list-renders-every-row-twice.md)
- 🔴 [Railway HTTP logs = CURRENT DEPLOY only (~20 min)](railway-http-logs-only-cover-the-current-deployment.md) — empty ≠ never called; use `-f '@path:…'`.
- 🔴 **[a RED main ships and LOOKS FINE](a-red-main-ships-and-looks-fine-build-ignores-type-errors.md)** — check CI on main's head.

## Session traps relocated to AGENTS.md §2.1 — 2026-08-25 (the pointers that were never written)

Pass 7 (2026-08-23) moved the session/tooling traps out of `MEMORY.md` into `AGENTS.md` §2.1, which
auto-loads in full via `CLAUDE.md`'s `@AGENTS.md` with **no 24,400-byte cliff**. Four trap memories
written *after* that pass were named in §2.1 but never given an index pointer anywhere, so
`repo:doctor` reported them as orphans — nothing recalls an unlinked file, and the next session
re-derives what it already knows. Their **facts already auto-load in full from §2.1**; what was
missing is reachability, not knowledge. Pointing them here rather than at `MEMORY.md` costs the index
**zero bytes**, which matters because it was 31 bytes from the cliff earlier today. `MEMORY.md`'s own
last line says these must not be re-added to it, and `repo-doctor.mjs` reads both files as
`INDEX_FILES` — so a pointer here clears the orphan and keeps the fact one hop away.

No 🔴 on these four: those markers are the owner's, and none of these lines ever sat in `MEMORY.md`.

- [a GREEN test run carries NO type signal](a-green-test-run-carries-no-type-signal-at-all.md) — `pnpm run test` strips types without checking them, so a whole suite goes green against code that fails `typecheck`; only the PR's `typecheck` job answers.
- [an exhaustive `Record` does NOT gate the build](an-exhaustive-record-does-not-gate-the-build-here.md) — `next.config` sets `ignoreBuildErrors: true`, so a `Record` missing a key compiles, builds and DEPLOYS. Back it with a RUNTIME assertion in a registered test.
- [git "Authentication failed" can be the credential HELPER going OOM](git-auth-failed-can-be-the-credential-helper-going-oom.md) — GCM dies on low RAM and git then retries ANONYMOUSLY, so the token is never presented. Look UP for a Go panic; change NO credentials.
- [a PostgREST `.in()` fails THREE ways, only one quietly](postgrest-in-with-hundreds-of-ids-silently-returns-nothing.md) — 409 ids gave `{ data: [], error: null }`, indistinguishable from a true empty answer; ONE null id fails the whole request with `22P02`; and past ~395 ids the read SUCCEEDS but its echoed `Content-Location` blows the 16KB header cap as `fetch failed`/`UND_ERR_HEADERS_OVERFLOW`, which reads as a network fault. Chunk every `.in()` at ~50, drop nulls, and print the intermediate row count.

## Machine ceiling corrected 2026-08-25 — pagefile raised, and AGENTS.md §5 is now stale

A session/tooling trap, so by pass 7's rule it does NOT go in `MEMORY.md` — its proper home is
`AGENTS.md` §2.1, and the rule it corrects lives in `AGENTS.md` §5. **That edit was NOT made**: a
peer session held the repo folder at the time and edits are not made blind in a shared checkout.
Pointer parked here so the fact is reachable until someone moves it into `AGENTS.md`.

- [the freeze ceiling is COMMIT, not RAM — pagefile now 16GB](commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb.md) — commit limit **31.79 GB** since the 2026-08-25 14:14 boot (was ~19.79 GB), so §5's "keep sessions at 4 or fewer" is roughly 12 GB conservative. Verified live: 14 `claude.exe`, 10.23 GB committed, **21.56 GB free**. A commit-limit hang writes NO dump — an empty `Minidump` folder is the expected signature, not an all-clear; the tell is `dwm.exe` dying with `0xC00001AD`. `VirtualSize` is address-space RESERVATION and is useless here (Edge: 3,621 GB reserved vs 503 MB committed) — judge by commit. The `repo-doctor.mjs` accusation was raised and then WITHDRAWN on both points.

## Index caveats trimmed 2026-08-26

Trimmed from `MEMORY.md` to restore headroom under the loader read-ceiling. Every link stayed in the index; only the prose below was removed. Verbatim:

- ** — `applied_fields` is NOT the writer; intake was always fine. Diagnose by extraction-MINUS-candidate time. Fixed #2359, 2,032 backfilled 08-24.·

- ** — 141 candidates have NO job title and can never be judged for another role; re-read only AFTER #2359. NEVER raw-SQL

- ** — an import dumped **34 strangers' CVs** on one row and renamed it (real owner existed nowhere else); repaired 08-24, code fixed by #1357. **Detect with a per-candidate SENDER COUNT — healthy is 1.**

- ** — matched **0 of 634**; FIXED #2388 (`@domain` match) — **Railway does NOT restart on a var change; redeploy or it stays inert.** Never resolve a CV by its sender; a re-read is gap-fill only and CANNOT repair it.
  - **[EDITORIAL 2026-08-28 — the quoted line above is preserved verbatim as the record of what the index said, but its Railway clause is WRONG: a variable change DOES trigger a deploy, within seconds. Proven on staging that day; see `AGENTS.md` §2.3. Everything else in the line stands.]**

- ** — the Send button emailed UNCONDITIONALLY until #2372; Telegram added #2373 but only **2 people company-wide are `connected`** (the status is `connected`, NOT `linked`) — never fire it from the laptop (burns the idempotency key).

- ** — grep `dwm.exe` + **BOTH** `0xc00001ad` **and** `0xc000012d`; `Application Popup 26` counts freezes. `nvlddmkm`/2021 Intel driver are DECOYS. **Event 2004 node.exe GB are REAL `<CommitCharge>` — the “reservation” call was OVERTURNED 08-26** (22.3GB in 17s; the culprit dies with the freeze, so sampling survivors clears nothing). Pagefile SYSTEM-MANAGED, limit 43.16GB.

- ** — fix by INSERTING the missing days; a back-dated PAID insert must re-sequence later rows, but **NEVER re-sequence UNPAID rows — their zeros are deliberate.** CRM backfill 08-24 DONE; **OWNER RULE "skip everyone who left".** **`salary_records.unpaid_vacations` is a SECOND path that HAS taken EGP 32,253.08** (2 over-charges found). **PRICE BY

- ** — portal ≠ admin; both widths DERIVE from their aside. Portal span has NO `truncate` — a long label WRAPS, never ellipsises; 12.33px = ONE `n`·

- ** — the 125px read was REAL, the repo MODEL wrong (#2353). Re-measure, never retract; dev-auth pane traps live here too.

### pass 2, same date

- ** — 197 orphan-sweep (1st group dead-platform, SUPERSEDED)·53 SoS/closing/Direct·33 traps+10 worktrees·15 Marketing codes·15 Org/email·12 registry/field-shape/Claude-config/DB-perf·9 deductions/incentive/outstation·8 Recruitment/ATS/CV+iReports360·3 Marketing evidence

- App Review `1750808742793861` blocked on **2 SCREENCASTS (a HARD gate)**. TP = two steps: identification DONE+irreversible; **Access verification SUBMITTED 08-24, in review** — answered honestly as an END business, no clients, may be REFUSED.

- [a nightly-failing cron alerts NOBODY — or alerts EVERY night and is IGNORED](a-cron-that-fails-nightly-can-do-so-forever-unwatched.md)

- ** — 10,743 vs 1,231 rows; per DEVICE, not per server.

- **`salary_records.unpaid_vacations` is a SECOND path that HAS taken EGP 32,253.08.**

- ** — the 125px read was REAL, the repo MODEL wrong (#2353). Re-measure, never retract.

## Demoted from MEMORY.md 2026-08-26 (pass 10)

Detail relocated to `AGENTS.md` §2.1 (PR #2424) — repo-operating machine facts, which auto-load
in full with no cliff. The `MEMORY.md` hook was shortened, not removed. Original line, verbatim:

- 🔴 **[the black-screen freezes are the COMMIT limit — ONE node.exe, not RAM/GPU](commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb.md)** — grep `dwm.exe` + `0xc00001ad`/`0xc000012d`; `nvlddmkm` = DECOY; Event 2004 node.exe GB are REAL. **LIVE 08-26: 32768/65536 MB — a RANGE, so limit = RAM + ALLOCATED pagefile and it FLOATS: 47.79 GB is the FLOOR, ~79.79 grown. HIGHER = ordinary growth (that IS the 53.83 below), only BELOW 47.79 = reset. Read `AllocatedBaseSize`.** A reset does NOT fix it: Windows reinstalled 08-26 06:19, still crashed 10:57 + 15:15. **The LEAK is ExcelJS in a `tests/_tmp-run-*.mjs` probe (OFF-heap, `--max-old-space-size` cannot cap): 22->41 GB in 40s, 99.7% of 53.83 GB even WITH the fix.**

## Demoted from MEMORY.md 2026-08-26 (pass 11)

Both facts now auto-load in full from `AGENTS.md` §2.1, merged to main as `839e4248` (PR #2424)
and verified present there before this cut. `AGENTS.md` has no truncation cliff, so the index hook
was redundant, not load-bearing. Originals, verbatim:

- 🔴 **[black-screen freezes = the COMMIT limit, not RAM/GPU](commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb.md)** — grep `dwm.exe` + `0xc00001ad`. **READ the limit live, never quote it** — reset twice. Full account, live numbers, the `nvlddmkm` decoy and the off-heap ExcelJS leak: `AGENTS.md` §2.1.

- 🔴 **[an interrupted session leaves the tree BROKEN ON PURPOSE](an-interrupted-session-leaves-the-tree-deliberately-broken.md)** — grep BREAK- before acting on "commit it"; the source-pinning test states the fix verbatim.

## Index tails trimmed 2026-08-26 (pass 12)

Bullet TAILS only — no pointer, hook, or marker moved (167 unique pointers before and
after; 101 🔴 / 2 🔒 / 1 🥇 unchanged). What came out of each line is
EVIDENCE — counts, dates, PR numbers, identifiers — which is exactly what the linked file holds.
Every owner rule, safety rule and destructive-action guard was tested and kept, including the whole
of the vacation-balance line, the cron REST-API limits, the DB-password rule and the two token
lengths on the cron-401 line. 23568 → 23143 B. Originals, verbatim:

- 🔴 **[WhatsApp coexistence verified state 08-24](whatsapp-coexistence-verified-state-2026-08-24.md)** — **Tech Provider IS needed** (the "NOT needed" call was wrong twice, off a tooltip). App Review `1750808742793861` blocked on **2 SCREENCASTS (a HARD gate)**. TP identification is DONE and IRREVERSIBLE; Access verification submitted 08-24, may be REFUSED.

- 🔴 **[a WhatsApp apply link attributes NOTHING yet](a-whatsapp-apply-link-cannot-be-attributed-yet.md)** — 434 events/**11 senders** vs email 276/**213**; a forward drops the msg holding the code. Adverts default to WHATSAPP (owner override 08-25, number SET). 43 channels seeded, 25 postable.

- 🔴 **[FB group auto-posting is IMPOSSIBLE — he asked TWICE](facebook-group-posting-cannot-be-automated-ever.md)** — Groups API DELETED 2024-04-22, no personal-account publishing since 2018, no FB Jobs in Egypt. Built tracked `PX-` apply links instead (#2400). **OWNER RULE 08-25: post NOTHING until he says.**

- 🔴 **[the 08-23 cron-job.org batch 401s — RESOLVED 08-24](cronjob-2026-08-23-batch-401s-with-a-byte-identical-header.md)** — closed by the console's **TEST RUN** (sends the stored header, settles auth in seconds — but it REALLY runs the job, weigh side effects). Rotate NOTHING. **Always print `len`: fp = `Bearer …` len 71, sibling note token len 64.**

- 🔴 **[candidate Region = the COMPANY's regions, not geography](candidate-role-and-region-filters-use-company-regions.md)** — owner call 08-24: Beni Suef/Fayoum are **Giza**, Aswan/Luxor **Others** (40 vs 56 geographic). Role filter exists because the search box misses 9 of 27 DMs — "District **Manger**" ×3, "District **Sales** Manager" ×6.

- 🔴 **[Contact Review's "one click" count ignores duplicates](contact-review-acceptable-count-ignores-duplicates.md)** — 229 offered, **66 applied / 163 duplicate RECORDS**; merged 08-24, 2 refused as **DIFFERENT PEOPLE** — a shared phone is not the same person. Join on `email_norm`/`phone_norm` before quoting a number.

- 🔴 **[the Sato logo wordmark is WHITE](sato-logo-wordmark-is-white-invisible-on-paper.md)** — "SATO" vanishes on white paper; reverse it on a navy band or recolour the 9,525 near-white px before any document export.

- 🔴 **[an OPTIONAL field written unconditionally = SILENT ERASE](optional-field-written-unconditionally-is-a-silent-erase.md)** — hunted repo-wide 08-23; `.update()`⇒OMIT the column, `.upsert()`⇒before-image. 1 fixed #2326, 1 open, 4 cleared.

- 🔴 **[a venue's evidence was WRITE-ONCE](marketing-venue-evidence-was-writable-only-at-insert.md)** — nothing could complete a shop after insert; fixed #2352. **AREA governs sight+reuse — never backfill ownership.**

- 🔴 **[a duplicate merge STRANDS the desk validation](a-duplicate-merge-strands-the-desk-validation-on-the-retired-row.md)** — links move, `validation_status` doesn't; survivor sits `pending` = invisible in every dropdown. Hand SQL, no code to fix. Repaired 08-23.

- 🔴 **Session/tooling traps — git·CI·migrations·validation·worktrees·Next·browser — now live in `AGENTS.md` §2.1**, which auto-loads via `@AGENTS.md`. Do NOT re-add them here.

## Demoted from MEMORY.md 2026-08-26 (pass 13) — reference-grade subsystem detail, reachable here

Pass 12 trimmed tails the same day and got **425 B**; the index was back over the cliff within hours
(23,143 → 24,323 B, of which ~600 B is 7 new pointers). Tail-trimming is therefore spent — the lever
used here is topic-group demotion, the one measured at ~86 B a pointer. **20 pointers moved.**
Selection rule applied line by line: every owner rule, safety rule and destructive-action guard was
tested and KEPT in the index — the Office `do NOT restamp` guard, `Rotate NOTHING`, the cron-API
`100/day CANNOT be rolled back` limit, the `4 OFF iReports360 jobs are DELIBERATE` note, the
`ALTER ROLE` password rule, `leave it NULL` on a wrong coordinate, PROD PITR OFF, and the
15s-timeout-commits-anyway trap. Mixed lines were **split**: the guard stayed inline, the
reference hooks moved, and the original line is reproduced verbatim below so no annotation is lost.

`repo-doctor.mjs` reads `INDEX_FILES = ["MEMORY.md", "MEMORY-ARCHIVE.md"]` (verified live this pass at
`scripts/repo-doctor.mjs:704`), so every pointer below stays reachable — it stops being auto-loaded,
not findable. Originals, verbatim:

- 🔴 [NEW SYSTEM 08-17 — settled](new-system-decision-2026-08-17.md)·[SoS 20-agent audit PAUSED](sos-deep-audit-paused-checkpoint.md)·["continue verifying"=RESUME](continue-verifying-resumes-sos-audit.md)·[`n_live_tup` is STALE](n-live-tup-is-stale-use-real-count.md)

- 🔴 **[the import RPC would ZERO the sheet expenses](outstation-import-rpc-would-zero-the-sheet-uploaded-expenses.md)** — EGP 258,748 came from the XLSX, not outstation; July sim = **-EGP 18,849**. Never open the gate as a convenience.

- 🔴 [ONLY CNS July was re-stamped](pedia-and-anti-infective-july-are-correct-do-not-restamp.md)·[Office RE-RUN Mar-Jul](july-cns-office-override-and-main-store-bucket.md)·**[Feb HELD: net-negative product DROPS](office-rerun-drops-a-net-negative-product.md)**·[military Ivyronc=14](ivyronc-military-price-is-14-main-store-only.md)

- 🔴 [`hiring_document_files` + PRIVATE bucket](hiring-document-files-table-and-private-bucket-live-in-prod.md) — its `rls_enabled_no_policy` INFO is CORRECT.

- 🔴 **[the 08-23 cron-job.org batch 401s — RESOLVED 08-24](cronjob-2026-08-23-batch-401s-with-a-byte-identical-header.md)** — closed by the console's **TEST RUN** (sends the stored header — but it REALLY runs the job; weigh side effects). Rotate NOTHING. **Always print `len`: fp = `Bearer …` len 71, sibling note token len 64.**

- 🔴 **[`CRON_SECRET` in TWO stores; half-rotation 401s](github-actions-cron-secret-went-stale-after-a-railway-rotation.md)**·**[a nightly-failing cron alerts NOBODY, or is IGNORED](a-cron-that-fails-nightly-can-do-so-forever-unwatched.md)**·**[a wired SLUG ≠ anything CALLS it](a-wired-healthchecks-slug-does-not-mean-anything-calls-the-route.md)** — failover keepalive NEVER ran; 4 OFF iReports360 jobs are DELIBERATE.·[both sheet-token rotations DEAD 18 days](sheet-token-rotations-had-no-schedule-for-18-days.md)

- 🔴 **[cron-job.org has a REST API, not a black box](cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui.md)** — 16 jobs, `Africa/Cairo` field; **`curl -d "@-"` creates NOTHING on Windows.** · **[100 requests per DAY](cron-job-org-rest-api-is-100-requests-per-day.md)** — 429 on EVERY endpoint, no `Retry-After`; a bulk edit costs ~34 and CANNOT be rolled back.

- 🔴 **[all 14 Healthchecks sit on DEFAULTS — sync them from the doc table](healthchecks-schedules-are-synced-from-the-doc-table.md)** — the PING key CANNOT set a schedule; a project API key does not exist yet.

- 🔴 **[a roadless coord = 200 with ZERO routes](google-routes-returns-zero-routes-for-a-governorate-centroid.md)** — a MISSING key looks identical.·**[residences saved at the EGYPT CENTROID](employee-residences-were-saved-at-the-egypt-country-centroid.md)** — Google answers OK with the COUNTRY; a WRONG coord never self-heals — leave it NULL.

- 🔴 [Maps keys in `phoenix-hr-2026`](google-maps-keys-moved-to-phoenix-hr-2026.md)·[`.env*` reads auto-approved](env-file-reads-fully-auto-approved-2026-08-09.md)

- 🔴 [`mcp__supabase-staging__*` broken](supabase-staging-named-server-broken-2026-08-10.md)·[`expense_claims`=the ONE live RLS read](expense-claims-rls-read-path-is-live-in-prod.md)

- 🔴 Audit: [payroll writes unaudited to #2241](payroll-mutations-were-unaudited-until-2026-08-21.md)·[vacations: no gap, TWO tables](vacations-audit-coverage-is-complete-via-two-tables.md)·[standalone needs an EXTENDED loader](running-vacation-service-standalone-needs-an-extended-loader.md)·[hiring docs unaudited to #2315](hiring-document-writes-were-unaudited-until-2026-08-23.md)

- 🔴 **[iReports360 = 9 endpoints, NO audit trail](ireports360-api-is-nine-endpoints-and-has-no-audit-trail.md)** — Swagger IS public now; a `-4` leave row has a DATE-ONLY saveDate — bracket it by the `id` sequence.·**[vendor stamps run 1h BEHIND Cairo in summer](ireports360-timestamps-cairo-local-mislabeled-utc.md)** — per DEVICE, not per server.

- 🔴 [`expenses` gates `/api/marketing-requests/**`](expenses-permission-also-gates-all-marketing-requests.md)·**[sidebar: TWO rails, TWO budgets](portal-sidebar-label-width-budget.md)** — portal ≠ admin; portal span has NO `truncate` → a long label WRAPS, never ellipsises.·[NOWRAP needs `min-w-0`](portal-grid-items-need-min-w-0-for-nowrap-cards.md)·[responsive test proves LAYOUT only](a-responsive-primitive-test-proves-layout-not-content.md)·🔴 **[a HIDDEN pane MIXES correct rects with 0×0](dev-auth-is-header-only-browser-pane-cannot-use-it.md)** — the 125px read was REAL, the MODEL wrong — re-measure, never retract.

- 🔴 [`sharp`: 2 live routes, in deps #2301](sharp-is-a-devdependency-that-two-production-paths-import.md) · [`.extract().stats()` measures SOURCE](sharp-extract-then-stats-measures-the-source-image.md)

## Session traps relocated to AGENTS.md §2.1 — 2026-08-26 (pass 13)

Six agent-operating traps had crept back into `MEMORY.md`, which pass 7's standing rule forbids —
they are not Phoenix business rules, and `AGENTS.md` §2.1 auto-loads in full via `CLAUDE.md`'s
`@AGENTS.md` with **no 24,400-byte cliff**. Each fact was added to §2.1 verbatim before its index
line was cut. Pointers live here so `repo:doctor` reports no orphan; the knowledge is one hop closer
than it was, not further away.

The `dev-auth` one is the clearest case: §2.1 already named that exact file under **Browser and
dev-auth**, so the index line was a duplicate pointer carrying a *second* fact (the 0×0-rect
measuring trap). That second fact now sits beside the first in §2.1 instead of alone in the index.

- 🔴 **[a HIDDEN pane MIXES correct rects with 0×0](dev-auth-is-header-only-browser-pane-cannot-use-it.md)** — the 125px read was REAL, the MODEL wrong — re-measure, never retract. Now in §2.1 under **Browser and dev-auth**.

- 🔴 [an allow-rule can bake in a LIVE secret](permission-allowlist-rules-can-embed-a-live-secret.md) — 2 more Claude-config hooks archived. Now in §2.1 under **Shell and tooling**; the secret-handling clause travelled verbatim.

- 🔴 [a sweep by TOPIC misses danger](staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones.md) — sweep by CLAIM; never rewrite dated records. Now in §2.1 under **Memory and this index**.

- 🔴 [`.env*` reads auto-approved](env-file-reads-fully-auto-approved-2026-08-09.md) — Claude permission config, not a Phoenix rule. Now in §2.1 under **Shell and tooling**.

- 🔴 [`mcp__supabase-staging__*` broken](supabase-staging-named-server-broken-2026-08-10.md) — MCP tooling. Now in §2.1 under **Shell and tooling**.

- 🔴 **[`F:\PHX backup` = the DR set; a bundle restore silently gives ZERO refs](phx-backup-disaster-recovery-set.md)** — needs `core.longpaths`; 3 copies; 3 sections hold LIVE keys. Now in §2.1 under **Git**.

- The Windows `curl -d "@-"` trap from the cron-job.org REST-API line also moved to §2.1 under **Shell and tooling**; that line's own pointer is in the demotion section above.

## Orphans adopted 2026-08-26 (pass 13) — 4 memory files that had no pointer anywhere

`repo:doctor` reported these while verifying pass 13. None came from this pass — all four were
written by peer sessions today and never given an index line, which makes them invisible rather than
merely hard to find (§5). Triaged by what each one is, not by where it was found:

- **`venue-validation-rule-gps-photo-then-code-or-licence`** — an OWNER RULE dated today and already
  enforced in production, so it went into `MEMORY.md` proper, not here.
- **`every-automated-email-also-mirrors-to-the-admin-telegram`** — it changes what "fire an email"
  now costs, so it was folded onto the index's existing Email line rather than archived.
- **`a-test-can-never-hand-a-function-a-process-env-literal`** — a TypeScript/testing tooling fact, so
  by pass 7's standing rule its home is `AGENTS.md` §2.1 (Validation), with the pointer below.
- **`doctor-coverage-scores-only-doctors-already-visited`** — reference-grade: the index already
  carries the principle on the COVERAGE-vs-FREQUENCY line, and this is a third board wearing the same
  word. Reachable here.

- [a test can NEVER hand a function a `process.env` literal](a-test-can-never-hand-a-function-a-process-env-literal.md) — Next declares `NODE_ENV` as required on `NodeJS.ProcessEnv`, so a function taking an env bag for injection cannot be typed here, and the narrow stand-in trips the weak-type rule from the other side. **Take the value, not the bag.** Fact now also in `AGENTS.md` §2.1 under **Validation**.

- [`/doctor-coverage` scores only doctors ALREADY VISITED](doctor-coverage-scores-only-doctors-already-visited.md) — its denominator is built FROM visits, so a doctor nobody visited is invisible to it: it measures visit FREQUENCY, not the owner's coverage KPI. **44% there vs 70% on the plan-based board for Aug 2026** — say which board before quoting either. HCP norms are 0 in live prod, so its Account-mix section can never populate.

## Pointers added 2026-08-27
- 🔴 **[Excel REFUSES a workbook LibreOffice calls perfect](excel-rejects-a-workbook-libreoffice-calls-perfect.md)** — LibreOffice reported 540 formulas / 0 errors while Excel offered to "recover" the file, which STRIPS content on Yes. A `beginsWith` rule must not be a `cellIs` rule. LibreOffice validation cannot certify a workbook for Excel; find the fault by zip-surgery bisection.
- 🔴 **[the `supabase-staging` MCP server sees ZERO projects](supabase-staging-mcp-server-sees-zero-projects.md)** — every call, READ included, answers `-32600 no permission`; verified 2026-08-27. **SUPERSEDED 2026-09-12 by PR #3726:** it WAS the account — `SUPABASE_STAGING_TOKEN` belonged to a different Supabase account holding 0 projects. The server now runs on `SUPABASE_PROD_TOKEN` pinned with `?project_ref=cifwmndunmlxjhyjugxa`; **call it directly and pass NO `project_id`** (it is refused with `unrecognized_keys`), and stop reaching staging via `supabase-production`.

## Prod & approval hooks relocated to AGENTS.md §2.3 — 2026-08-27

Moved into the repo, where they auto-load via `CLAUDE.md`'s `@AGENTS.md` and have no truncation
cliff. Kept verbatim here so every memory file stays reachable and nothing orphans — `a-partial-cron-secret-rotation-leaves-two-fingerprints` and `never-rotate-the-supabase-db-password-with-alter-role` held their ONLY pointer on these lines and orphaned the instant the index lines were removed.

The move happened because compression was exhausted, not to tidy up: `MEMORY.md` sat at 24,234
bytes against a 23.8KB read ceiling with **137 bytes** of headroom, and a full documented trim pass
— every remaining em-dash, all bold beyond the first per line, a filler sweep — yielded **27
bytes**, against 389 bytes of live orphan pointers waiting to be added. Removing these seven lines
freed **1,174 bytes** and took the index to 22.5KB. Two lines under the same heading did NOT move
and are still in the index: the Egypt-centroid geocoding hook and the brick-mapping hook are
data-quality facts that were only ever filed under a Railway heading.

- 🔴 [Deploy applies NO migrations](railway-deploy-applies-no-migrations.md)·[auto-deploy can silently SKIP](railway-auto-deploy-can-silently-skip-a-race.md)·[`--stdin` stores a BOM](railway-stdin-bom-trap.md)
- 🔴 [`railway ssh` JOINS argv, runs as ROOT](railway-ssh-joins-argv-and-lands-as-root.md)
- 🔴 [a PARTIAL rotation leaves TWO fingerprints](a-partial-cron-secret-rotation-leaves-two-fingerprints.md) - Healthchecks `up` ≠ authenticated (grace hides it). The 08-23 401s are RESOLVED - **rotate NOTHING**; always print `len` (fp = `Bearer …` 71).
- 🔴 [`CRON_SECRET` in TWO stores; half-rotation 401s](github-actions-cron-secret-went-stale-after-a-railway-rotation.md)·[a nightly-failing cron alerts NOBODY, or is IGNORED](a-cron-that-fails-nightly-can-do-so-forever-unwatched.md) - 4 OFF iReports360 jobs are DELIBERATE.
- 🔴 [cron-job.org REST API = 100 requests per DAY](cron-job-org-rest-api-is-100-requests-per-day.md) - 429 on EVERY endpoint, no `Retry-After`; a bulk edit costs ~34 and CANNOT be rolled back.
- 🔴 [NEVER rotate the DB password with `ALTER ROLE`](never-rotate-the-supabase-db-password-with-alter-role.md) - Supavisor holds its own copy; dashboard only. `28P01` vs `XX000` tells stale-password from wrong-host; nothing off-laptop uses it.
- 🔴 [`expense_claims`=the ONE live RLS read](expense-claims-rls-read-path-is-live-in-prod.md)·[precondition in every prod `WHERE`](guard-every-prod-write-when-another-session-shares-the-queue.md)·["Log out everywhere"=THREE writes](force-logout-everywhere-needs-three-writes.md)

## Environment-identity hooks relocated to AGENTS.md §2.3 — 2026-08-27 (second pass, same day)

Same reason as the pass above, same destination. `MEMORY.md` had **234 bytes** of headroom and a
live orphan waiting — `app-env-unset-on-staging-made-it-look-like-production`, which is not filler:
staging identified itself as PRODUCTION, defeating the email fail-safe and masking that ~18 cron
routes fall open without `CRON_SECRET`. Adding its hook alone would have left the index a few dozen
bytes from the cliff, where the next append truncates the tail silently.

`repo-doctor.mjs` scans **only** `MEMORY.md` and `MEMORY-ARCHIVE.md` (`INDEX_FILES`) — `AGENTS.md`
is NOT a reachability source. So relocating a hook without leaving a pointer here converts it into
an orphan; this pass would have traded one orphan for three. These three moved together because
they answer one question — which environment does the running code think it is in:

- 🔴 [a LOCAL run writes prod, skips email](local-run-against-prod-db-silently-skips-every-email.md)·[the local Resend key CANNOT send](local-resend-key-is-restricted-use-railway-run-to-send-from-production.md) - restricted key, unverified domain; send via `railway run`.
- 🔴 [STAGING can't rehearse PROD shapes](staging-cannot-rehearse-shapes-only-prod-surgery-made.md)

## Agent-operating hooks relocated to AGENTS.md §2.1 — 2026-08-28 (PR #2511)

`MEMORY.md` sat at **24,298 bytes of the 24,400-byte ceiling — 102 bytes of headroom**, less than
one hook line, with every formatting lever §2.2 names already spent: **1** em-dash left of the
original 102, zero trailing whitespace, zero double spaces. §2.2's instruction for that state is to
relocate rather than compress, so three agent-operating hooks left the index and two memory files
that had **no pointer anywhere** were given a home in the same pass.

Pointers live here because `repo-doctor.mjs` reads only `MEMORY.md` and `MEMORY-ARCHIVE.md`
(`INDEX_FILES`) — `AGENTS.md` is NOT a reachability source, so a relocation with no line here
converts the hook into an orphan.

Moved out of the index; the fact now lives in §2.1, which auto-loads in full and has no cliff:

- 🔴 [the attendance agent dies at EVERY logon and loses NOTHING](attendance-agent-crashes-at-logon-but-loses-no-attendance.md) - `0xE0434352` every boot; the 2-hourly task restarts it and those runs INSERT. Overnight `503`s are the DEVICE. Never disable the task; never launch a 2nd agent - it can fire a PROD sync.
- 🔴 [a Windows env var SHADOWS every `.env.local`](windows-env-var-shadows-every-env-local-key.md) - `--env-file` only fills in what is MISSING. Which copy is valid has already flipped once; re-probe all three, never print the value.
- 🔴 [a Supabase request that times out at 15s STILL COMMITS](supabase-client-15s-timeout-commits-anyway-half-applies.md) - a silent half-applied state with no audit row, not a clean failure. Do heavy multi-step mutations in ONE `plpgsql` function.

Had no pointer anywhere until this pass — written, then unreachable:

- 🔴 [`next dev` CANNOT run in a worktree](turbopack-cannot-resolve-a-junctioned-node-modules-here.md) - Turbopack reads §5's prescribed junction as a symlink escaping the project root and fatals on the first route. Verify against the primary checkout, or prove the change at data level.
- 🔴 [`unstable_cache` SERIALIZES, so a returned `Map` comes back `{}`](unstable-cache-serializes-a-map-into-an-empty-object.md) - works on exactly ONE render, throws on every one after, and reads as a permission redirect rather than a crash. No unit test can see it - the reload IS the test.

**This file was truncated to 0 bytes during this pass and rebuilt byte-for-byte.** A Python append
opened it `"w"` and then threw `UnicodeEncodeError` on lone surrogate escapes (`\ud83d\udd34` is two
unpaired surrogates in Python 3, not an emoji) — the open had already emptied it. Recovery was
`MEMORY-ARCHIVE.md.bak-before-index-2026-08-27` (215,104 B) plus two changes replayed out of other
sessions' transcripts: a 1,329-byte `cat >>` append and a 278-byte `Edit`, reproducing 216,711 bytes
exactly. **Never build this file with a Python `open(..., "w")`** — use `cat >>` with a literal
emoji, take a `.bak` first, and treat an exact byte-count match as the proof of a restore.

## 2026-08-28 - retired to hold the 22,000-byte cap (AGENTS.md 2.2)

Both duplicated content that `AGENTS.md` already carries IN FULL and with no cliff - the
outbox drain in section 3, the `APP_ENV` staging account in section 2.3, which also holds the
`isForceTestingDelivery` email fail-safe this hook never mentioned. Reach is identical; only
the index's scarce bytes were being spent. Nothing here is retracted.

- 🔴 [the outbox drain was HEALTHY and did NOTHING - FIXED 08-27](outbox-drain-is-blocked-by-50-exhausted-rows-head-of-line.md) - #2462+#2464 cured all 3 drains; alarm #2468 `c943d46f`. **`attempted:0` is ALSO what IDLE looks like - read `drainHealth` in the response body, never DB state.**
- 🔴 [staging called itself PRODUCTION](app-env-unset-on-staging-made-it-look-like-production.md) - `APP_ENV` unset ⇒ `NODE_ENV=production` on staging too; fixed 08-27.

## 2026-08-28 - relocated to `AGENTS.md` 2.1 by PR #2547 (7ceebe0b)

Four database/grant mechanics, now under **Database, grants and RLS** in `AGENTS.md` 2.1,
which auto-loads in full with no 24,400-byte cliff. Platform mechanics rather than Phoenix
business rules, so they failed the index's own negative test. Reach is identical; only the
capped index bytes were freed. Verified present on `origin/main` before these lines were
removed - the both-halves rule in 2.2. Nothing here is retracted.

- 🔴 [`banned_until='infinity'` 500s auth](banned-until-infinity-breaks-the-whole-auth-admin-api.md)
- 🔴 [append-only needs a TRUNCATE trigger](append-only-tables-need-a-truncate-trigger.md)·[RLS on + no grant is the NORM](rls-policy-without-an-authenticated-grant-is-usually-correct.md)·[a write REVOKE ≠ read-only](a-write-revoke-does-not-stop-a-cascade-or-a-secdef-function.md)

## Orphans adopted 2026-08-28 — repo-doctor found 8 memory files with no pointer anywhere

`repo:doctor` reported **8 orphans, 0 broken pointers** (929 files, 922 pointers), the oldest written
2026-08-27 and the rest that same morning — all by parallel sessions that wrote the file and never
wrote the line. Four were Phoenix business or permission facts and took index lines in `MEMORY.md`.
These four did not, for three different reasons. **Nothing here is retracted** — an archive line is
reach, not demotion.

**Two belong in `AGENTS.md`, not the index, by the index's own last line** (*"prod & approval in
§2.3 … Do NOT re-add any here"*). Pointered here so neither is invisible while that relocation is
prepared; the memory file is the fact either way.

- 🔴 [`service source connect -e staging` DEPLOYED TO PRODUCTION](railway-service-source-connect-is-not-environment-scoped.md) - the git source is a SERVICE-level setting and `-e` only resolves *which service*, so one command repoints every environment. It served an unmerged branch at full traffic and silently rolled back two merged PRs. **A branch cannot be staged here without shipping it**, so AGENTS.md §7's "smoke-test on staging before a risky deploy" cannot be done this way — it needs a separate Railway service. Read `healthz` **revision**, never `status`.
- 🔴 [an unbounded PostgREST `.select()` STOPS at 1000 rows](postgrest-unbounded-select-silently-stops-at-1000-rows.md) - no error, no marker, the array just ends, so a truth set built from it misclassifies silently. `count(*)` before trusting one; page with an explicit `.order()` + `.range()`. Sibling of the `.in()` URL-length trap already in §2.1 — **that one EMPTIES, this one TRUNCATES.** #2456.

**One is self-defending.** Both of its dangerous properties are pinned by a registered test in the
required CI `validate` job, so a session that "improves" either goes red rather than shipping it.

- 🔴 [the personal nav layout is per-caller, never a targeting matrix](nav-personal-layout-is-per-caller-never-a-targeting-matrix.md) - it REARRANGES an already-gated set and can never introduce an href; the `hr_id` always comes from `access.hrId`, never the request. Looking pages up from `system-navigation.ts` would turn a cosmetic preference into an access-control bypass. #2516.

**One is already carried by `AGENTS.md` §2.1**, which auto-loads; the file is the diagnosis depth
behind the hook, which is exactly what belongs here.

- 🔴 [ExcelJS emits 2 schema-invalid OOXML bits](exceljs-writes-two-schema-invalid-ooxml-fragments.md) - `<sheetPr>` child order and `editAs` on a one-cell anchor; fix by post-processing the zip. Four diagnosis decoys inside, incl. a clean `testzip()` proving nothing.

## Agent-operating hooks moved from the index 2026-08-28 (RESOLVED - live in `AGENTS.md` §2.1)

The index hit **15 bytes** of headroom under the 24,400-byte loader cliff, with every compression
lever already spent, so these eight came out under §2.2's negative test: each is an agent-operating
or tooling fact, not a Phoenix business rule, and so belongs in `AGENTS.md` §2.1 rather than here.

**RESOLVED 2026-08-28 12:24 Cairo - PR #2556, merge `cdf31f18`.** All eight now live in `AGENTS.md`
§2.1 (two in **Validation**, six in the new **Probing, attributing and reporting production**
block), which auto-loads in full via `CLAUDE.md`'s `@AGENTS.md` and has no cliff - so they reach
every session again, with review and version control on top. All eleven memory files behind them
are named there and all eleven are still on disk.

**The index lines below are kept ONLY as the record of what left `MEMORY.md` and how it read.**
They are not a to-do and not a second copy to consult - read `AGENTS.md` §2.1 for the live text.
**Do NOT re-add any of them to the index**, for the same reason §2.1's own tooling traps are not
there: an agent-operating fact in a file with a silent 24,400-byte cliff is a fact waiting to be
dropped. Verbatim, as they stood:

- 🔴 [OpenAI: `/v1/models` 200 is a FALSE green](openai-key-is-401-and-cv-extraction-silently-falls-back-to-rules.md) - blind to the BALANCE; probe a completion. No AI failure is logged. **The FILENAME is stale - the key WORKS**.·[the BILL can't be read from the API](openai-spend-cannot-be-read-from-the-api-reconstruct-it.md) - costs 403, usage 200-but-EMPTY; count `ats_candidate_cv_extractions`.
- 🔴 [a narrowed SELECT disarms the gate below it](a-narrowed-select-disarms-every-gate-downstream-of-it.md) - test the SELECT, not the branch.
- 🔴 [an OPTIONAL field written unconditionally = SILENT ERASE](optional-field-written-unconditionally-is-a-silent-erase.md) - `.update()`⇒OMIT the column, `.upsert()`⇒before-image. Both real ones FIXED (#2326, #2329).
- 🔴 [the Sato logo wordmark is WHITE](sato-logo-wordmark-is-white-invisible-on-paper.md) - "SATO" vanishes on white paper; reverse it on a navy band or recolour the near-white px before any export.
- 🔴 [`app_error_events` 0 rows = QUIET, not broken](app-error-events-is-user-triggered-zero-is-not-broken.md) - real users' browser errors, in BURSTS (7 rows/46s). Prove the route with **405 vs a 404 control**; NEVER POST a synthetic error to prod.
- 🔴 [Error Monitor HIDES NULL `environment`](error-monitor-hides-null-environment-rows.md)·[`zz_backup_…` tables are ANON-READABLE](ad-hoc-backup-tables-are-anon-readable.md)
- 🔴 [`updated_by_hr_id` LIES about the writer](how-to-attribute-a-production-write.md)
- 🔴 [`activity_events.hr_id` MIXED case](activity-events-hr-id-is-mixed-case-not-lowercase.md)·[direct-order hr-id cols: BOTH cases](direct-order-hr-id-columns-are-mixed-case-and-access-hrid-is-lowercase.md) - `.eq` hid 28% of reps own orders.

**Joined by PR #2558, merge `42424317`, 2026-08-28 12:34 Cairo** - same relocation, second pass.
The Capture Evidence hook's real lesson (a feature can ship green and be reachable by nobody;
zero usage and a 100% rejection rate look identical) and the payroll-audit half (now carrying the
live finding that the fixed path has never actually written a row) are both in `AGENTS.md` §2.1.
The vacations half stayed in the index - it is a Phoenix lookup fact, not a verification lesson.

- 🔴 [Capture Evidence was DEAD for 81%](capture-evidence-was-dead-on-arrival-for-doctor-customers.md)
- (half of the Audit hook) [payroll writes unaudited to #2241](payroll-mutations-were-unaudited-until-2026-08-21.md)·

## Marketing validation hooks relocated to `AGENTS.md` §4.1 — 2026-08-28 (PR #2565, merge `b1684807`)

**Why §4 and not §2.1:** these eight are Phoenix product rules, not agent-operating traps — three of
them are explicit owner rules (GPS + a live picture ALWAYS; the REGISTERED CODE beats live GPS; ask
before the first licence verdict is ever recorded). §4 is where product rules that must not be
"fixed" back already live, and it auto-loads in full via `CLAUDE.md`'s `@AGENTS.md`, so reach is
identical to the index — only scannability changed.

**What forced it:** `MEMORY.md` crossed its 24,400-byte loader cliff, measured at 24,605 with the
tail already dropping silently, and every compression lever was spent (1 em-dash left, 0 trailing
spaces, 0 double spaces, 0 duplicate pointers). §2.2's prescribed remedy for exactly that state is to
move guidance into `AGENTS.md` rather than delete a hook. The 8 index lines were 1,775 bytes; they
became one signpost line.

These pointers exist so the files stay reachable: `AGENTS.md` names them in backticks, not as
markdown links, so repo-doctor's orphan check does not count that as reachability. Five of the eight
were already pointed at from elsewhere in this file; three were not, and would have become orphans.

- 🔴 [venue validation: GPS + photo, THEN code OR licence](venue-validation-rule-gps-photo-then-code-or-licence.md)
- 🔴 [Marketing TERRITORIAL; NULL `area_id`=invisible](seeded-marketing-pharmacies-have-no-area-and-are-invisible.md)
- 🔴 [a licence verdict is PERMANENT - no correction path](a-licence-verdict-is-permanent-and-has-no-correction-path.md)
- 🔴 [`system_validated` = NO HUMAN LOOKED](marketing-system-validated-means-no-human-looked.md)
- 🔴 [a venue's evidence was WRITE-ONCE](marketing-venue-evidence-was-writable-only-at-insert.md)
- 🔴 [the badge read a FROZEN note, never the evidence](marketing-badge-read-a-frozen-note-not-the-live-evidence.md)
- 🔴 [a duplicate merge STRANDS the desk validation](a-duplicate-merge-strands-the-desk-validation-on-the-retired-row.md)
- 🔴 [the screen that SHOWS a badge ≠ the screen a rep can OPEN](the-screen-that-shows-a-badge-is-not-the-screen-a-rep-can-open.md)

## Owner product rules relocated to AGENTS.md §4 — 2026-08-28 (PR #2566)

Seven index lines carrying fifteen hooks, moved into §4 "Product rules that must not be 'fixed'
back" because `MEMORY.md` had crossed its 24,400-byte cliff again and compression was spent — zero
em-dashes, zero trailing whitespace, zero double spaces left, and two prose passes had already freed
888 bytes against a 2,400-byte shortfall. Every one is an owner DECISION rather than a measurement,
so each belongs in a file that auto-loads in full instead of one that drops its tail without saying
so. Removing them took the index from 22,138 to 20,534 bytes.

These pointers exist so the files stay reachable: `AGENTS.md` names them in backticks, not as
markdown links, so repo-doctor's orphan check does not count that as reachability. Nine of the
fifteen were already pointed at from elsewhere in this file; six were not, and would have become
orphans — `an-export-must-match-the-screen-never-different-data`,
`dv-evidence-window-same-day-submits`, `never-auto-publish-deductions-owner-confirms-first`,
`system-flags-expenses-never-rejects`, `unmapped-products-must-never-reach-a-report` and
`weekly-summarized-report-owner-rules`.

Unlike the relocations above it, this one was NOT verbatim. #2556 moved eight hooks across without
re-reading their claims and #2559 had to correct one, so every claim here was checked against the
current code first: `TERRITORY_PREVIEW_DEFAULT_LINE_CODE = "pedia"`, `VISIT_TYPE_TO_STATUS`'s
`[-4, "AV"]` / `[-5, "CP"]` / `[-6, "CP"]`, `INITIAL_ACCESS_ROLE_BY_TITLE`, `render-form1.ts`'s
duplex note, the organogram mobile route, and three independent statements of flags-never-rejects.

- 🔴 [EVERY weekly export: `excludeUnmapped`](unmapped-products-must-never-reach-a-report.md)
- 🔴 [an export must MATCH the screen](an-export-must-match-the-screen-never-different-data.md)
- 🔴 [Summarized Report layout LOCKED](weekly-summarized-report-owner-rules.md)
- 🔴 [expenses: system FLAGS, never REJECTS](system-flags-expenses-never-rejects.md)
- 🔴 [NEVER auto-publish deductions](never-auto-publish-deductions-owner-confirms-first.md)
- 🔴 [same-day CRM reads empty](dv-evidence-window-same-day-submits.md)
- 🔴 [Public Holiday (-5) + Casual Leave (-6) = WORKING](public-holiday-and-casual-leave-are-working-days.md)
- 🔴 [>25th FULL-PAY waiver = resignations only](resignation-full-pay-rule-is-resignation-only.md)
- 🔴 [a Cairo trip earns NO per-diem](cairo-trip-no-per-diem-allowance-live-prod-2026-08-15.md)
- 🔴 [field-force titles self-provision](field-force-provisioning-live-and-guard-relaxed-2026-08-14.md)
- 🔴 [Form 1 prints EXACTLY as issued](government-form1-prints-exactly-as-issued.md)
- 🔴 [organogram export CARRIES the mobile](organogram-export-carries-the-mobile-by-owner-override.md)
- 🔴 [Territory preview: NEVER show the line](territory-preview-link-must-never-show-the-line.md)
- 🔴 [Organogram CHART=AU seats, popup=dir](organogram-chart-source-is-au-seat-model-not-directory.md)
- 🔴 [WhatsApp button STAYS on CEO/NSM rows](whatsapp-button-on-leadership-rows-is-an-owner-decision.md)

## Session traps whose home is `AGENTS.md` §2.1 — pointers only, 2026-08-28

`AGENTS.md` §2.1 carries these facts in full and auto-loads with no cliff. Per §2.2 an agent-operating
fact never earns a line in `MEMORY.md` itself — that is the rule the index signpost enforces.

**CORRECTED 2026-08-29 — the reason this section was created is gone.** It used to say repo-doctor's
orphan check does not count a backticked slug in `AGENTS.md` as reachability, so these pointers
existed purely to satisfy the doctor. PR #2615 taught it otherwise: it now reads `AGENTS.md` from the
primary checkout as a third reachable home alongside this file and `MEMORY.md`, so a relocated memory
named there is no longer reported as an orphan. **A doctor run from a checkout older than #2615 will
still flag every one of them** — six were flagged that way on 2026-08-29 and all six were false
positives. Check the run's own commit before acting on its orphan list. The pointers below are kept
because they help a human reader find the file; they are no longer load-bearing.

- 🔴 [a UTC timestamp compared against Cairo manufactures a false signal](a-utc-timestamp-compared-against-cairo-manufactures-a-false-signal.md) - full account in `AGENTS.md` §2.1 (Git). It INVERTED a merged/stranded verdict and nearly pushed two already-merged branches into conflicting PRs.

## Orphan sweep 2026-08-29 — one genuine orphan, six false positives

repo-doctor reported seven unlinked memory files. Six were named in `AGENTS.md` and only looked
unlinked because the run came from a checkout predating #2615 (see the correction above). **One was
genuinely unreferenced anywhere**, and it is history rather than a live rule, so it is linked here
rather than in `MEMORY.md`. This file has no cliff and no budget, so the pointer costs the index
nothing and the displacement rule needed no hook retired to make room — that is what the archive is
for, and it is the right home for anything dated whenever the index is near its budget.

- [a mock name generator reproduces real employees' names by chance](a-mock-name-generator-reproduces-real-employee-names.md) - HISTORICAL: the staging mock it describes was reversed 2026-08-29 and staging re-cloned from production, so read it as method, not as state. Kept for the **anonymisation method**, which must be redone from scratch for any future scrub: sweep by **SUBSTRING** against production (Egyptian patronymic chains mean a real 4-token name *contains* a plausible 2-token one, so an exact-match sweep reports success having matched nothing), `auth.users` is a **second identity store** a scrub will miss entirely, and a name is denormalised across ~30 tables so it must be found by scanning columns rather than listed from memory. **Two agent-operating traps were lifted OUT of it into `AGENTS.md` §2.1 on 2026-08-29** (PR #2617, `98432ce87`) — the lowercased `occupant_canonical_hr_id` that makes a join return 0 of 120 rows and reads as a vacant seat, and this MCP returning only the LAST result set of a multi-statement call. Do not relocate those twice.

## Retired from the index 2026-08-29 — two hooks whose PR is merged and serving

Both were fuel for a displacement pass under `AGENTS.md` §2.2: the index sat at 21,795 bytes
against its 22,000-byte cap with 205 bytes of headroom — less than one hook line — and every
compression lever was already spent (0 em-dashes, 0 trailing whitespace, 0 double spaces). Both
items shipped on 2026-08-23 and were verified merged before the hooks were pulled. **Nothing here
is retired as wrong** — the pointers live on, and this file has no cliff and no budget.

- 🔴 [nursery INVENTED codes; RETIRED 08-23](nursery-venues-were-saved-as-pharmacies-with-invented-codes.md) - deactivate, NEVER delete (FK CASCADE). Shipped as [PR #2320](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2320), merged 2026-08-23T07:09:04Z; the file's own header reads RESOLVED and is kept for WHY the shape existed.
- 🔴 [one_part has NO Part 2 for deductions](one-part-employees-have-no-part-2-for-deductions-to-land-in.md) - carry fwd; a LEAVER has no later run. FIXED by [PR #2318](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2318), merged 2026-08-23T05:56:37Z. **The "a leaver has no later run" half is NOT lost from the index** - it still reads on the held-payroll line ("A leaver has NO later run - transfer only") and on the leaver's-earlier-months line.

### The six-people hook was CORRECTED, not retired

Its index line asserted "**6** people have NO salary figure at all - Aug 2026" while its own memory
file, modified 2026-08-28, says in its description that **the original six are NOT the current
six** - A-12/A-9/B-10 were restored on 2026-08-28 and the live risk is now AI-0009 and AI-0013. A
hook whose whole content is a number is one that will one day be wrong, and this one was: a stale
hook costs more than a missing one because it gets defended rather than looked up. The mechanism
half (`recommend.ts` pricing a no-figure person at nothing) was dropped from that line only
because the employee-import line already carries it verbatim. Old wording, for the record:

> - 🔴 [6 people have NO salary figure at all - Aug 2026](people-with-no-salary-figure-are-priced-at-nothing.md) - base/basic/gross/net ALL null ⇒ `recommend.ts` prices them at NOTHING, no error; some of them drew a full July salary. **`payroll_eligible is true` shows ZERO Aug leavers and is WRONG** - key on last working date.

## Demoted from the index 2026-08-29 (pass 2) — two reference hooks, and one over-long line trimmed

Same displacement pass as the section above. Nothing here is retired as wrong.

- 🔴 [the FULL sweep - prod has 3](approval-workflow-sweep-2026-08-19.md) - the complete inventory of Phoenix approval workflows as swept **2026-08-19**: production has exactly three chain-shaped ones and offer-approval config is wired to nothing. Demoted because it is a dated INVENTORY - a count, which §2.2 says is the hook shape that will one day be wrong. The two live chain RULES stayed in the index beside it.
- 🔴 [vacations: no gap, TWO tables](vacations-audit-coverage-is-complete-via-two-tables.md) - the vacation module has NO payroll-style audit gap; every human mutation names its actor, but four paths record it in `v2_vacation_request_events` rather than `audit_logs`. Demoted because it is a finding of NO defect: a session that never reads it re-derives "nothing is wrong here", which costs minutes, not money.

### The held-payroll line was TRIMMED, and it carried a wrong number

Its index line said the full net "double-pays part 1 (**9,800** on the one I got wrong)". The
memory file says otherwise, and the file is the fact: Gerges (`B-112`) was quoted **16,500**
against a true **6,021.39**, an overpayment of **10,478.61**. The 9,800 exists nowhere else and
matches nothing in the file - an earlier estimate that outlived its correction. It is not carried
forward here except as this record of its removal.

The formula statistics also dropped from that line - "the obvious one hits 76/105, `expenses`
being the big miss, the complete one 103/105" - are **not** lost: the file states them in full
("**76 of 105**, worst error **5,330**" and "**103 of 105**"), together with the three missing
terms and the reason the last two fail. Every safety clause stayed on the index line: no
`salary_record` is written, nothing records an out-of-system payment, second part only, validate
against published rows, a leaver has no later run, `payroll_eligible=false` is normal, and read
`hold_reason` before re-raising a hold.

## Index caveats trimmed 2026-08-29 — the FULL wording (nothing here is retired)

One line, the employee-import hook, at **603 bytes** the longest left in the index after the two
passes above. Every clause dropped was verified present in
[[employee-import-blanks-salaries-and-job-title-creates-positions]] **before** it was cut — all
nine of them, including the `ecol`+`fuel` tell, the 184,000/mo consequence and "keeps no
history". Nothing moved here that the file did not already hold; this is the record, not the copy.

What stayed on the index line is what a session must see *before* it knows it needs the file: that
"never overwrites" covers org entities only, that a blank cell nulls real money silently, that the
importer keeps no history, the snapshot instruction, and the second hazard where `Job Title`
substitutes for `Position`. What left is detail the file states more fully — the 2026-08-10
16:16 timestamp, the count of **7**, the `ecol`/`fuel` survival tell, the `recommend.ts`
pricing mechanism (still carried verbatim on the no-salary-figure line), the **184,000/mo** figure,
the 2026-08-28 restore, and "with NO department".

> - 🔴 [the employee import BLANKS a salary the sheet leaves empty](employee-import-blanks-salaries-and-job-title-creates-positions.md) - **"cannot overwrite" is ORG ENTITIES ONLY.** 08-10 16:16 nulled base/basic/gross/net/medical/social/taxes on **7** head-office rows (ecol+fuel survived - the tell); `recommend.ts` then prices them at NOTHING, silently - NSM+Marketing+HR Mgr = **184,000/mo**, restored 08-28 from their July payslips. **Snapshot those columns before any upload.** `Position` is OPTIONAL and **Job Title substitutes**, inserting a seat with NO department. Importer keeps NO history.

### pass 2, same date — the CRM rep-list line

Its dated sweep statistics moved to the file, which states every one of them more fully. Verified
present in [[crm-contact-list-comes-from-contactslist-aspx-not-the-api]] before cutting: **7,667**
distinct doctors, **94.2%** already ours, **448** never touched, attribution **99.2%** right, and
**59 of 67** active reps in the owner's 90–120 PM band (the file writes that range with an
EN-DASH, so a hyphen grep reports it missing — that near-miss is why the check is worth doing
character by character rather than by eye).

What stayed is the part that is a RULE rather than a measurement: the endpoint is
`ContactsList.aspx` on **site10** and not the API, `t=Pharmacy` not `t=PH` (a wrong `t`
returns an EMPTY grid rather than an error), and `ID` = `contact_crm_id` so a list is never
name-matched again. Old wording:

> - 🔴 [the rep list IS fetchable - `ContactsList.aspx` on **site10**, not the API](crm-contact-list-comes-from-contactslist-aspx-not-the-api.md) - server login works; grid gives **ID + Address + Grade + Spec.**, LIVE list only. Swept all 82 current agents: **7,667 doctors, 94.2% already ours, 448 never touched, attribution 99.2% right**; 59/67 reps in his 90-120 band. **`t=Pharmacy` not `t=PH` - a wrong `t` returns an EMPTY grid, not an error.** `ID` = `contact_crm_id`; never name-match a list again.

### Two long lines deliberately NOT trimmed

- **The held-payroll line (679 B)** was already trimmed earlier in this same pass. What remains is
  every safety clause and nothing else — no `salary_record` written, no record of an
  out-of-system payment, second part only, validate against published rows, a leaver has no later
  run, `payroll_eligible=false` is normal, read `hold_reason` first. Thinning a money hook twice
  in one session to win bytes is how a real warning gets lost.
- **The recruitment cluster (571 B)** carries FOUR links, and §2.2 says the dominant cost is
  filenames plus `[]()` syntax, which shrinks only by deleting a memory. Its prose is already down
  to durable traps — gated on `approved_at`, `applied_fields` is NOT the writer, never
  raw-SQL `national_id`/`email`/`phone` because the `_norm` dedupe index is app-maintained.
  Trimming it would free roughly 60 bytes and cost three real traps.

## Relocated from the index 2026-08-31 — resolved/shipped (reachable here, not auto-loaded)
Displaced to make room for the chemistry-counts-as-science owner rule. Shipped, not retired.
- ✅ [CRM↔iReports360 parity SHIPPED 08-29](crm-parity-two-problems-set-and-attribution.md) - don't rebuild. TWO problems (COVERAGE vs attribution) - never conflate.

## Index caveats trimmed 2026-09-01 — the FULL wording (nothing here is retired)
Same pass as 2026-08-17/19/21: the index was at 21,991 bytes against a 22,000-byte budget — 9 bytes
of slack — so the wording below was shortened in `MEMORY.md` and preserved here in full. **Every
hook still has an index line and every memory file is still reachable.** What was cut from the index
is what AGENTS.md §2.2 says never earns index bytes in the first place: dates, PR numbers, cron-job
ids, and enumerations the memory file itself holds. Read this section when an index line feels
thinner than the claim behind it.

- **Head Office / weekly + monthly** — full: "GOLDEN RULE 08-26, monthly 08-30. Tracked = **CNS ·
  Anti Infective · Pedia** ONLY; HO (Lacto Basic 1+2, Satoslim, Royanoxicam) = **90% of weekly
  VALUE**. NEVER flag it, NEVER map it, ALWAYS filter before quoting a number."
- **Lacto family split** — full: "Lacto: family NAMES split 08-31; family_code still shared … now
  `Lacto Advanced` (Pedia) + `Lacto Basic` (HO); NO product carries a bare `Lacto`. **Both keep
  family_code=`LA` DELIBERATELY** - it is the direct-order basket allow-list; tidying it silently
  un-combines the order. Never key on family_code alone (`DO`=2 families)."
- **Units of different products** — full: "OWNER RULE 08-27. A unit total is valid for ONE
  product_code only; above that aggregate by **VALUE**. Same for TARGET units. Tebofortin=7 conc,
  Conviban=4, Rispadex=3."
- **Head Office absent from `phx_monthly_achievement`** — full: "no rows ≠ zero: it rendered
  **243,579 real July units as 0**. Royanoxicam DOES return (line NULL); Lacto Basic and Satoslim do
  not. `direct_value` is NOT the sales value. HO has NO price at all - units only, `-` not `·`."
- **staging is a real prod clone** — full: "staging is a REAL prod clone 08-29 … 161 real auth
  accounts + real payroll: NOT demo-safe. Storage FILES do not clone - 910 objects 404."
- **iReports360 re-saved days** — full: "nearly every 'removed' row is the same doctor re-planned;
  `plannedCalls` counts ENTRIES, so a sync that only adds inflates it. Hourly sync + prune are live."
  (In the index this line had lost its newline and had the staging-notify hook jammed onto its tail;
  the two are separate lines again as of this pass.)
- **Nobody with no salary figure** — full: "not refused, priced at zero, silently. **The original
  six are NOT the current six** - read the file, never quote a count. **`payroll_eligible is true`
  shows ZERO Aug leavers and is WRONG** - key on last working date."
- **A HELD payroll row** — full: "`publishToPayslips` filters `!onHold`: NO salary_record written,
  **nothing records the out-of-system payment** (`payroll_resignation_candidates` DETECTS, not a
  register). **HELD = OWED PART 2 ONLY** - full net double-pays part 1, some owed NOTHING; validate
  part-2 on PUBLISHED rows. Leaver has NO later run - transfer only. `payroll_eligible=false` NORMAL
  for executives. July holds ruled 08-28 - read `hold_reason`, never re-raise."
- **CV intake / ATS cluster** — full: "offer chain: hole past approval … gated on `approved_at`. ·
  ats children: NO FK; one is a VIEW · a CV RE-READ never wrote what it read - `applied_fields` is
  NOT the writer. · `medical_rep` reads 12 fields, `universal` 38 - NEVER raw-SQL
  `national_id`/`email`/`phone`: the `_norm` dedupe index is app-maintained."
- **CV import overwrote an identity** — full: "**detect with a per-candidate SENDER COUNT; healthy
  is 1.** the allowlist holds an INBOX, not a sender - never resolve a CV by sender. · the CV file is
  in `ats_files`, NOT `cv_external_url` - empty for EVERY candidate; reads `NO FILE`."
- **WhatsApp apply-link attribution** — full: "a forward drops the code-bearing msg: **11 senders**
  behind 434 events. Adverts default to WHATSAPP (owner override 08-25)."
- **WhatsApp intake counts** — full: "TWO forwarders carry 95% of events; real reach is a fraction of
  the total. ALWAYS split by sender."
- **6h CV digest** — full: "the 6h CV digest emails the MANAGER, not TA … Live #2438, cron-job
  8334658; NEVER fire from laptop."
- **Facebook group posting** — full: "FB group auto-posting is IMPOSSIBLE - he asked TWICE … Groups
  API deleted; no personal-account publishing; no FB Jobs in Egypt. Tracked `PX-` apply links exist
  instead. **OWNER RULE 08-25: post NOTHING until he says.**"
- **CRM contacts endpoint** — full: "CRM contacts endpoint EXISTS 08-29 - address still OURS …
  `agents-contacts?agentId=` live, doctor lat/lon 64.6%, NOT a scrape swap. Check-in address: vendor
  sends a MINORITY (empty STRING), Phoenix geocodes the rest - probe the COLUMN, where the REP
  STOOD."
- **`ContactsList.aspx`** — full: "the rep list IS fetchable - `ContactsList.aspx` on **site10**, not
  the API … grid gives **ID + Address + Grade + Spec.**, LIVE list only; all 82 agents swept,
  attribution checks out. **`t=Pharmacy` not `t=PH` - a wrong `t` returns an EMPTY grid, not an
  error.** `ID` = `contact_crm_id`; never name-match a list again."
- **CRM brick/GPS/catch-all cluster** — full: "brick map LIVE - HIGH only · GPS check-ins PARTIAL;
  never score · contact `100000` is a CATCH-ALL, not a doctor - exclude it or it poisons every
  per-contact figure. 70% of doctors sit at ONE place."
- **Weekly can't follow the organogram** — full: "depot data, no customer/brick. **What reaches no DM
  is nearly all AI tagged `UE`, when its org has only UE-1/UE-2**. · coverage by VALUE - rows and
  money disagree sharply."
- **Outstation import RPC** — full: "the import RPC would ZERO the sheet expenses … EGP 258,748 came
  from the XLSX, not outstation. Never open the gate as a convenience."
- **13 reps with no salary row** — full: "13 reps have NO salary row - Soad worked 2 CLOSED months
  unpaid … can't deduct 13,572.59 from pay never made."
- **EZ / closing-rollup cluster** — full: "EZ `1011654` splits EVENLY: Cairo+Giza CNS - roster
  FROZEN/month · the closing reads the OTHER rollup - fact_rollup alone is INVISIBLE · a case-dup
  line-map row DOUBLED a line · 'Stores'=`Office`, 'UPA'=channel."
- **Weekly Anti Infective UE** — full: "weekly: Anti Infective UE = 95.9% of ALL unmapped value … a
  null area is mostly HARMLESS; #2436 recovers 4.03M + fixes 5.30M mis-credited. **OWNER GAVE THE
  SPLIT RULE 08-27 - do NOT send a classification sheet; 161 branches, EGP 55.3M now reach reps.**"
- **No governorate layer** — full: "areas+bricks only; area NAMES can't derive it. **[[src/lib/geo/
  egypt-locations.ts]] is the place vocabulary - don't write a 4th copy** (I did). A district can BE
  an area: امبابه=GZ3, not 'somewhere in Giza'."
- **Brick mapping beats paid AI** — full: "brick mapping: FREE beats paid AI (85-88%); geocoding
  HURTS … never buy a map API. **The BRICK TABLE outranks your map of Egypt - Sharkia+Qena were
  REVERSED.** Gazetteer the ADDRESS, not the name. **SOFICO `GIZ…` codes map to NOTHING** - check the
  code SPACE first."
- **Direct-order cluster** — full: "DIRECT ORDER PRICING LOCKED · Finance ALONE books a sales month -
  NULL is not a bug, and never offer to fill it · the code half · ONE order makes a month look
  'uploaded' · 'not syncing' was a LABEL - `includedInClosing`='feeds the DISTRIBUTOR matrix'; NEVER
  flip it (4 callers double-count)."
- **Notification-channel cluster** — full: "sidebar look is ROLE-SCOPED · Recruitment: EGYPTIANS ONLY
  · 'new CV' in-app+TG - but the 6h DIGEST IS emailed · a candidate push: in-app+Telegram+push, NEVER
  email - `connected` is NOT `linked`; never fire from the laptop - burns the idempotency key."
- **Candidate Region filter** — full: "owner call 08-24: Beni Suef/Fayoum are **Giza**, Aswan/Luxor
  **Others**. The Role filter exists because misspelt titles hide 9 of 27 DMs from search."
- **Contact Review duplicates** — full: "229 offered but **66 applied / 163 duplicate RECORDS**; a
  shared phone is NOT the same person. Join on `email_norm`/`phone_norm` before quoting a number."
- **Attribution is `_asof`** — full: "`f_line_area_map_asof(period_end)`, so a FORWARD-DATED move
  leaves earlier months intact; AGENTS §4's 'always today's' is observed behaviour, not the
  mechanism. Date it the 1st of the target month - dating it TODAY flips the current month silently."
- **Main Store `OTMS`** — full: "1st money ever 07-26: 47,385 CNS, 109 customers, no rep/DM/target;
  NOT Office."
- **EP-PHS code reuse** — full: "168 concurrent codes, EGP 1.58M; never 'pick the newest name', it
  mis-credits the other's sales."
- **auth metadata key** — full: "a migration writing `role` matches 0 rows and VERIFIES ITSELF GREEN
  on the wrong key; sweep `like '%<old>%'`. · `banned_until` ≠ deactivated - authority = `is_active`
  + `employment_status`."
- **HR seats composed** — full: "OWNER RULE 08-28: never name a role after a job title; no literal
  role block - read `permissionMatrix[role]`. Retired seats alias to `Employee`. · **'Report It' =
  PATIENT DATA** - ADRs not HR; `report_it:export` reads EVERY report."
- **Hiring one person breaks achievement** — full: "an `employees` insert auto-seats them AND flips
  `line_area_map.area_state`, which is hashed into the fingerprint: **8/8 periods went stale off 3
  inserts**, no error, numbers just stop coming from the rollup. RE-STAMP AFTER ANY HIRE. Never
  hand-write occupancy after an insert - it is already written."
- **Hire-date fix / coaching dates** — full: "never key a dedupe on DERIVED mutable data. · coaching
  BEFORE hire is CORRECT - owner 09-01 'trust hiring date'; 13 workbook-confirmed, never 'fix' either
  side."
- **Vacation balance** — full: "fix by INSERTING missing days; a back-dated PAID insert re-sequences
  later rows, but **NEVER re-sequence UNPAID rows - their zeros are deliberate.** **OWNER RULE 'skip
  everyone who left'.** **`salary_records.unpaid_vacations` is a SECOND path that HAS taken money.**
  **PRICE BY `unpaid_duration_days`, never by counting dates.**"
- **Employee import blanks a salary** — full: "**'cannot overwrite' is ORG ENTITIES ONLY.** A blank
  cell NULLs base/basic/gross/net/medical/social/taxes over real money, silently, and the importer
  keeps NO history. **Snapshot those columns before any upload.** `Position` is OPTIONAL and **Job
  Title substitutes**, silently creating a seat."

### Retired from the index 2026-09-01 (CLOSED — verified in production, kept for the generalisation)
- ✅ [weekly branch map: CODE and NAME were swapped, 26 rows](weekly-branch-map-had-name-and-code-swapped.md)
  — fixed 2026-08-27 and **re-verified live in production 2026-09-01**: `0` of 920 rows in
  `weekly_sales_branch_region_map` still hold a bare number in `branch_header_raw`, and all 26
  Ibnsina `stock` rows are correctly oriented. The generalisation is what survives: **in any
  mapping table, check which column is the KEY and which is the LABEL before trusting a join** — here
  the number in the name column was not even that branch's own code but another branch's, so the
  rows resolved confidently to the wrong region. The owner spotted it by eye before any check did.

## Retired from the index 2026-09-12 — the FULL wording (nothing here is retired as a memory)

Displaced under the §2.2 rule to make room for the `git branch -d` trap, at the owner's explicit
instruction (*"yes, retire a resolved line and record it"*). **The memory files are untouched and
still recalled by their own frontmatter `description`** — only the auto-loaded index line is gone,
and `repo-doctor` counts a pointer from this file as reachability (`INDEX_FILES` is
`["MEMORY.md", "MEMORY-ARCHIVE.md"]`), so nothing is stranded.

- **Hossam cover REVERTED 09-07 - do NOT re-apply**
  ([hossam-vacation-cover-rasha-temporary-2026-08-30.md](hossam-vacation-cover-rasha-temporary-2026-08-30.md))
  — CLOSED, re-verified on prod 09-11. Pedia's GPM row is BY DESIGN; plans Rasha DECIDED stay hers -
  history, not residue.

  **Why it was the retirement chosen:** the cover is fully undone on production (routing on lines 1
  and 3 back to `Marketing Manager`, both `employee_plan_headers_cover_reroute_*` triggers and
  `phx_cover_reroute_hossam_plans()` dropped), so the line was no longer *in flight* — it had become
  a record. **Two traps survive it and are the reason the file stays:** Pedia (line 2) reads
  `Group Product Manager` and always did, so the post-revert mix of two `Marketing Manager` rows and
  one GPM row looks like a half-finished job and must not be "finished"; and B-155 reports to A-8,
  so his weekly-plan decisions in the cover window are Rasha's own work, not cover activity. Both
  are stated in the memory's `description`, which is what decides recall.

## Linked 2026-09-15 by the config audit (were reachable from nowhere)
- [CV feedback lock REMOVED 09-13; code at tag `backup/cv-feedback-lock-2026-09-13`](cv-feedback-lock-removed-backup-tag.md)
- [voice notes need two `next.config.ts` header changes (microphone + Supabase audio)](phoenix-blocks-the-microphone-app-wide-voice-notes-need-two-header-changes.md)
- [typed payroll Additions have NO ceiling - owner 09-15, never re-raise](typed-payroll-additions-have-no-ceiling.md) - hook also in `AGENTS.md` §4.

## Linked 2026-09-18 — the tablet control programme (reachable here, not auto-loaded)
- [new-hire reps get Lenovo Tab M11 tablets, CONTROLLED from Phoenix via the Android Management API](new-hire-medical-reps-get-company-tablets.md) - the owner chose the MANAGED PLAY route 2026-09-18 and the iframe door waives the US$25 fee, so no Play Console account, no card and no D-U-N-S. `/hr/devices` records custody and controls NOTHING; Action1 has no Android agent and never will.

## Linked 2026-10-01 — the small-PR merge deadlock (reachable here, not auto-loaded)
- 🔴 [a SMALL PR (≤ 4 files) cannot be merged from a session at all - TWO guards disagree](the-small-pr-merge-guard-and-the-classifier-deadlock.md) - `bash-guard` C10 blocks the plain `gh pr merge` and names `PHX_MERGE_OK=1`; the auto-mode classifier then refuses THAT as a `[Safety Bypass Flag]`, and the denial TIGHTENS the session's Bash so a plain `git status` comes back `[Auto-Mode Bypass]`. Run `rollup-prs.mjs`, then put the merge back to him and say in the prose that **his own Squash-and-merge click is the only path** - a fresh word re-authorizes the classifier but NEVER clears C10. Never read "already merged" as your command having worked: read `mergedBy`. Measured on #4988, which he merged himself.
