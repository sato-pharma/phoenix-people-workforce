---
name: anti-infective-canonicalization
description: "Anti-infective line display spelling standardized to 'Anti Infective' across code + 45k prod rows (PR #1125, 2026-07-18)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1f81d292-1528-4418-8ca1-a59a159d0cc0
---

Owner asked to eliminate the "Anti Inf" abbreviation and standardize the
anti-infective line to **"Anti Infective"** everywhere ("fix permanently",
2026-07-18). Note this is a NEW 4th variant — the system previously had "Anti Inf"
(abbrev), "Anti infective" (sales/SoS/master canon), and "Anti-Infective" (RBAC
bucket). Owner chose "Anti Infective" (both words capitalized) over aligning to the
existing "Anti infective".

**Key architectural fact:** every LINE-MATCHING path is case-insensitive
(`normalizeLineKey`, SoS RPCs' `lower(btrim())`, `normalizeDepartmentLookupKey`,
`canonicalSalesLine`) and all lowercase alias KEYS are load-bearing (they catch
legacy sheet data). So flipping DISPLAY casing is safe; NEVER change the lowercase
alias keys (`"anti inf"`, `"anti infective"` in access-scope/marketing/admin maps)
— they must keep matching historical uploads.

**Code (PR #1125 MERGED 2026-07-18, commit be195767, prod LIVE europe-west3, smoke passed, phoenix-hr.satopharma.com 200; branch `codex/anti-infective-canonicalization`):**
flipped canonical OUTPUT values only — `lineRules` (org-rules.ts), `OFFICIAL_LINE_BY_KEY`
values + `MARKETING_OVERSIGHT_OFFICIAL_LINES` (sales/access-scope.ts), `phoenixLines`
+ `normalizeLine` alias values (admin/access-control.ts, access-validation.ts), admin
UI option labels, rbac install SQL. Added `canonicalizeSalaryLineLabel` in
payroll/salary-import.ts (applied at both parse points) so payroll uploads can't
reintroduce "Anti Inf". Also made 2 case-sensitive line comparisons in
scope-visibility-manager case-insensitive. Guard test `imports-line-canonicalization.test.ts`
updated (still enforces lineRules value slugs to a real lines.code). Full gate green.

**Prod data (already applied, owner-approved):** normalized **45,186 rows across 27
tables** → "Anti Infective" via a `DO` loop with per-table exception isolation
(predicate: `col ~* '^\s*anti' AND col <> 'Anti Infective'`). Biggest: SoS
import_rows 11,778 + 3 rollups (~29k) + weekly 2,924. Also `lines.name` id 1, RBAC
`app_auth_users.line`/`user_access_profiles.line` (43 each; `users` had 0). Full
row-level backup in schema **`_anti_infective_rollback`** (27 snapshots + `_update_log`
+ `_residual*`) — DROP once stable. Post-sweep: zero residual across every line column.

**Payroll gotcha:** the 215 `salary_records` rows (95 "Anti Inf" + 120 "Anti inf.")
sit in approved/locked/paid batches and are blocked by trigger
`phx_prevent_closed_salary_detail_mutation`, which lists `line` as an immutable
Part-1 field. Owner approved bypass; done via a single txn with
`SET LOCAL session_replication_role='replica'` (auto-restores on commit). Use this
pattern for any future label-only fix to closed payroll rows — never leave the
trigger disabled outside a txn.

Related: [[lines-import-canonicalization]] (org-import recurrence guard),
[[incentive-policy-lock]] (payroll/policy.ts stays locked — salary-import.ts only
imports from it).

**Closed out 2026-07-18 same day:** `_anti_infective_rollback` schema dropped from
prod (backup no longer needed, data verified stable). Worktree `_wt-anti-infective`
removed + local branch `codex/anti-infective-canonicalization` deleted via the
CLEAN ritual (verified: clean status, ancestor-of-origin/main, xlsx/pdf scan —
4 root xlsx were git-tracked + byte-identical to their `xlsx/` copies, nothing to
rescue).

**CORRECTION — the "zero residual" claim above was wrong.** A later "verify the fix
on production" pass (same day) caught a real bug the original sweep missed: the
**"zero residual" query was scoped to `information_schema.tables where
table_type='BASE TABLE'` with NO schema filter reasoning applied — it happened to
only surface `public`-schema hits because I never thought to check for OTHER
schemas.** Production has a separate **`au` schema** (area-unification seat model:
`au.lines`, `au.seats`, `au.occupancy_history`, `au.sos_official_line_map`, etc.)
that duplicates line data independently of `public.lines`. `au.lines.line_name` was
still `"Anti infective"` (lowercase), which fed `au.v_org_tree` → public wrapper
view `au_v_org_tree` → `buildOrganogramSeatReport()` (src/lib/reports/organogram-au-source.ts)
→ the **live Organogram page's line picker and hierarchy labels** — a genuine
user-facing bug, caught by actually loading the page in a browser (curl/RSC-payload
checks on OTHER pages had all passed clean, which is what made this miss possible).

**Lesson: for any future "sweep every table" DB audit in this project, query
`pg_namespace`/`pg_class`/`pg_attribute` directly (or explicitly enumerate
`select distinct table_schema from information_schema.tables`) — do NOT default to
`information_schema.columns where table_schema='public'`. This DB has real
non-public schemas with independent copies of reference data:** `au` (area-unification
seats/org-tree/lines — see [[area-unification-42-areas-design]] / [[au-phase9-cutover-validation]]),
`analytics` (all views, safe — trace back to already-fixed `public` fact tables),
`supabase_migrations`. Also found and correctly did NOT touch:
`au.sos_official_line_map.official_line` (pure case-insensitive JOIN matching key,
same role as code's lowercase alias keys — matches regardless of casing),
`au.seats.seat_label` (not referenced anywhere in app source), `payroll_copilot_flags.question`
(historical audit-trail sentences literally describing a past detected line-value
change — rewriting would falsify history), `position_vacancies.vacancy_code`
(structural slug identifiers, not display text).

**Second fix pass (same day, owner-approved "fix all of it"):** backed up to
**`_anti_infective_rollback_2`** (au.lines, sales_import_batches,
source_of_sales_import_summaries, geo_locations address rows), then fixed 5 more
targets found only by a full cross-schema/all-columns sweep: `au.lines.line_name`
(1 row — the organogram root cause), `sales_import_batches.line` (1 row — inventoried
in the FIRST pass but accidentally left out of the update loop), `source_of_sales_import_summaries`
`.official_line`/`.group_label`/`.group_key` (65/23/65 rows — same accidental omission;
`group_key` is a composite `"CODE|Name|Line"` string requiring a substring `replace()`,
not a column overwrite), `geo_locations.address_text` (7 rows — a DIFFERENT column
than `geo_locations.line` which the first pass DID fix; a cached formatted address
string like `"Sohag 2, Anti Inf, Egypt"`, also needed substring replace). Re-verified
the Organogram end-to-end via a real authenticated browser session against prod data
(dev-auth on a disposable worktree's local dev server) — confirmed "Anti Infective
structure", correct line picker, real employee data. Also confirmed Marketing ROI
Tracking's line filter shows "Anti Infective (116)" matching the exact prod
`marketing_roi_request_facts` count.

`_anti_infective_rollback_2` dropped from prod 2026-07-18 (owner-approved, same day
as creation). Both backup schemas now gone; task fully closed, no follow-ups open.

**Payslip EMAIL checked 2026-07-18 — doesn't exist / can't fire.** `src/emails/payslip.tsx`
is a thin unused wrapper (zero real callers in src/app). Payslip notifications are
double-guaranteed email-free: policy.ts `"payroll.payslip_available"` channels =
`["in_app","telegram"]` only (owner request 2026-07-13 comment), AND
`enforcePayslipEmailBlock` in `payslip-channel-guard.ts` hard-filters email out of
ANY resolved channel list for a payslip eventType regardless of policy/explicit
channels/Telegram-failure fallbacks (system.ts `basePolicyChannels` always applies
it). `GeneralNotificationEmail` (the template payslip.tsx wraps) has zero hardcoded
line references anyway. Telegram delivery for payslips is `telegramGenericOnly`
(a generic nudge, no salary/line detail). No "Anti Inf" exposure possible on this
channel — not "checked and clean", but structurally can't happen.

**Offer-letter EMAIL checked 2026-07-18 — real live template, confirmed correct.**
Unlike payslip.tsx, `src/emails/offer-letter.tsx` IS wired to a real send path
(`src/lib/offers/email.ts` → `src/lib/offers/service.ts`, 3 call sites) and DOES
render a `{ label: "Line", value: props.reportingLine }` metadata row. Traced the
full chain: `reportingLine` = `hydratedOffer.lineName` = `lookups.lines.get(line_id)`
= `lines.name` (service.ts:1018, `loadAllOptions("lines")`) — i.e. resolved FRESH
from the master `lines` table at render/send time, zero snapshotting, zero local
alias map in `src/lib/offers/**`. `job_offers` only stores `line_id` (bigint FK) —
no separate line-name text column exists to go stale. Checked
`accepted_terms_snapshot` (jsonb, a plausible stale-snapshot risk) — it captures
`areaId` + salary fields only, no line name/id at all. Shared renderer
(`phoenix-email-layout.tsx` `renderPhoenixMetadataTable`) just escapes+isolates the
string, no truncation/mangling. Prod check: zero pending/existing job_offers
currently reference the anti-infective line (no live candidate-facing exposure
today). Conclusion: any offer sent now or in the future will correctly show
"Anti Infective" — verified by code trace, not just inspection.

**Offboarding emails checked 2026-07-18 — clean, and revealed a 2nd templating
engine.** Resignation notifications don't use a `src/emails/*.tsx` React file —
they use a DB-editable template (`email_templates` table, keys `resignation` +
`resignation_workflow`) with `{{token}}` substitution, built in
`resignations/service.ts` `notifyResignationWorkflow()`. `resignation_workflow`'s
body has a `{{line}}` token in a "Department" row; `resignation` has no line field
at all. The token resolves via `resignationDetail?.lineName` ←
`getEmployeeDirectoryRows()` (`employee-directory.ts:1001` `row.lines.name`) — same
clean live-join pattern as the offer letter, zero snapshotting, zero local alias
map. Swept the ENTIRE `email_templates` table (subject/body_html/body_text) +
`email_template_drafts` (edit-history snapshots) + `notification_templates`
(in-app/Telegram title/message templates) for literal "anti inf" text — zero hits
anywhere, and zero stale values in `target_lines` (a functional per-template
line-routing filter, not just display — also checked). `investigation-notice.tsx`
and `contract-renewal-alert.tsx` (other offboarding/lifecycle-adjacent React
templates) don't reference line at all. Conclusion: no offboarding email surface
was or can be affected.

**Probation emails checked 2026-07-18 — clean, but a genuinely different (riskier)
data path than resignations/offers.** `probation-alert.tsx` is dead code (zero
callers, no line ref) same as payslip.tsx. Real content: 3 DB templates
(`probation`, `probation_workflow`, `probation_reminder`) — `probation_workflow` +
`probation_reminder` have `{{line}}` tokens, `probation` has none, none hardcode
text. UNLIKE offers/resignations (which resolve line via a LIVE join to
`lines.name` at send time), probation's `{{line}}` resolves from
`record.lineName` ← a PERSISTED column read straight off `probation_evaluations`
(`service.ts:346` `.from("probation_evaluations")`) or `probation_cases.line_name`
(`probation-emails.ts:363`, weekly-digest path) — no join, no re-derivation. So
correctness here depends entirely on those exact stored values, not on the master
`lines` table being fixed. Re-verified LIVE (not just trusting the original Phase-B
fix): `probation_cases.line_name` = "Anti Infective" (4/4 rows), `probation_evaluations.line_name`
= "Anti Infective" (11/11 rows) — both fully canonical right now. `probation.*`
notification policy DOES include the `email` channel (unlike payslip) — this is a
real, live-firing risk surface, now confirmed clean. `probation_weekly_digest` has
no matching `email_templates` row; traced the code-default fallback path
(`defaultPolicyForType` in notifications/email.ts) and confirmed zero hardcoded
"Anti Inf" anywhere in `src/lib/notifications/**`. `target_lines` empty on all 3
probation templates (no functional routing risk).

**Vacation + excuse emails checked 2026-07-18 — clean.** No dedicated React email
file (same generic DB-template-engine architecture as probation/resignation). 5 DB
templates: `leave_request`, `leave_approval`, `leave_rejection`, `excuse_decision`
have **zero `{{line}}` tokens** — `line` is computed into templateContext in a
couple of call sites (vacation/service.ts:1894, excuses/service.ts:510) but never
rendered (same harmless "computed but unused" pattern as payslip email). Only
`excuse_request` actually renders `{{line}}`, sourced
`input.request.lineName ?? input.employee.lineName ?? "—"` (persisted-first,
live-fallback, same hybrid class as probation). Live check: `v2_excuse_requests.line_name`
and `v2_vacation_requests.line_name` currently hold ZERO anti-infective rows at all
(only Head Office/Pedia/null) — nothing was ever broken here. Write path confirmed
future-proof: both tables persist `employee.lineName` (a live employee-directory
lookup, itself now canonical) at request-creation time, not an independent/stale
map — so a future Anti-Infective vacation/excuse request will correctly show
"Anti Infective". `target_lines` empty on all 5 templates (no routing risk).

**Marketing request emails checked 2026-07-18 — clean, AND this closed out a full
sweep of literally every row in `email_templates`.** No dedicated React file.
Canonical key list lives in `src/lib/email-templates/service.ts` `emailTemplateKeys`
(35 valid keys) — `marketing_request` is one of them (confirmed via code comment
in `buildMarketingEmailContext`), but it has **no row in the DB at all**, so it
renders via the code-default fallback (`defaultPolicyForType` in
notifications/email.ts) — already confirmed zero hardcoded "Anti Inf" anywhere in
that file. Its `{{line}}` VALUE (`marketingNotificationVariables` in
marketing-requests/service.ts) is live-derived `requester?.lineName` — clean
regardless. The products-table HTML block (own line items) has no per-product Line
column, only Product/Qty/Value.

**Full `email_templates` table sweep (all 19 rows that actually exist, out of 35
valid keys):** queried every row for a `{{line}}` token AND literal "anti inf"
text in one pass. Zero hardcoded matches anywhere. Rows carrying a live `{{line}}`
token: `contract_renewal` (→ `employee.lineName`, live, in `src/lib/contracts/service.ts:302`),
`excuse_request`, `probation_reminder`, `probation_workflow`, `resignation_workflow`
— all already traced clean in earlier passes. All 19 rows have empty `target_lines`
(no functional routing risk anywhere). Found (unrelated, harmless) dead/orphaned DB
rows `job_offer`/`resignation`/`probation` whose keys don't match the code's actual
enum values (`offer`/`resignation_workflow`/no bare `probation`) — never resolved
by current code, moot either way since both are line-free anyway. **This means
every email template in the system, not just the ones explicitly asked about, is
now confirmed clean** — payslip/offer/offboarding/probation/vacation/excuse were
each individually verified in earlier passes; this final sweep covered the
remaining ~14 untouched keys (interview_*, birthday, leave_returned/leave_manager_step_decision/
leave_submission_confirmation/leave_resubmit_confirmation/vacation_balance_settlement,
password_setup/password_reset, user_created, weekly_plans, outstation, offer_status,
recruitment_update, coaching_report, payroll_update, attendance_digest/attendance_workflow,
general) confirming none of them exist in the DB or reference line at all.

**Payslip UI explicitly verified 2026-07-18** — admin Payslip Center
(`app/(admin)/admin/payslips-center/page.tsx`, the only payslip surface that
renders `line`; the employee-portal payslip view doesn't show it) checked live
against prod data via a disposable detached worktree + dev-auth. Employee B-176
(Eman Essam), all 3 locked/closed batches (Apr/May/Jun 2026) — the exact rows
patched via the `session_replication_role='replica'` bypass — show Line column =
"Anti Infective" in the actual parsed DOM. The 200+-employee dropdown on the same
page also shows "Anti Infective" for every anti-infective employee, zero bare
"Anti Inf" anywhere. One raw-fetch-grep false positive hit during this check: React
Server Components streaming split the word "Infective" exactly across two
`self.__next_f.push` chunk boundaries for an unrelated employee (B-104), producing
a literal "Anti Inf" substring in concatenated raw fetch text — reconstructs
correctly, not a real defect. Lesson: trust `read_page`'s parsed DOM over raw
fetch-text grep for streamed RSC pages; see [[local-browser-verify-gotchas]].

**Verification-method notes for this repo:** `preview_start`/`preview_*` binds to
the PRIMARY worktree, not wherever you `cd`'d — for a worktree-only change, start
`next dev` directly via backgrounded Bash with an explicit port, verify the
listening PID's `CommandLine` (via `Get-CimInstance Win32_Process`) is actually
rooted in your worktree before trusting anything it serves, and kill only that
verified PID when done. `.env.local` (synced via `pnpm run worktree:sync-env`)
points at PRODUCTION Supabase — page loads are read-only-safe, never click
Approve/Submit/Save. When the Browser pane's `navigate`/`computer` tools are
blocked by a transient tool-safety-classifier outage (distinct from a permissions
prompt — read-only tools like Grep/Read still work fine), a `curl -c cookiejar
.../api/dev-auth?role=...` + `curl -b cookiejar <page>` fallback against the local
dev server can verify server-rendered text content while waiting for the browser
tool to recover — but it CANNOT render client-fetched pages (e.g. ROI Tracking's
table only loads after "Apply Filters" is clicked, Organogram's tree is a client
component) — those need the real browser once available. Headless-preview
screenshots can render blank even when the page is genuinely fine
(`get_page_text`/`read_page` DOM text is the trusted source per this repo's own
`local-browser-verify-gotchas` memory).

**CORRECTION 2026-08-26 — the `au.sos_official_line_map` call above was wrong.** That column was
inspected and deliberately left alone as a "pure case-insensitive JOIN matching key — matches
regardless of casing". It held BOTH `Anti infective` and `Anti Infective`, and because the join
lowercases both sides, two colliding rows are a **fanout**: every Anti Infective fact row matched
twice, so `au.f_monthly_attribution` returned exactly **2×** the real units in all six months of
2026 and in both channels. It never shipped only because the attribution rollup had not been
refreshed since 2026-08-14 — the next refresh of any period would have doubled the line silently.
Fixed 2026-08-26: duplicate row deleted, plus a unique index on `lower(btrim(official_line))`.
Full account: [[a-case-duplicate-line-map-row-doubled-a-whole-line]].
