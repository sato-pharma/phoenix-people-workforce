---
name: probation-module-is-field-force-only
description: "SUPERSEDED ON SCOPE 2026-11-14: automatic probation now covers the FIELD ROLES (Medical Reps + District/Regional/National Sales Managers; REC-074). History of the 2026-07-17 Medical-Reps-only rule; fingerprint attendance is head-office-only and is NOT a probation input"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8c826290-3610-4c5c-80f9-d84104d12c1c
---

**🔴 SUPERSEDED 2026-11-14 (owner, REC-074: "Field roles only", then "All sales managers"): automatic probation covers Medical Reps AND District, Senior District, Regional and National Sales Managers; office roles never. One list, `PROBATION_FIELD_ROLE_TITLES` in `cases.ts`, and the hire trigger (migration 20261114021245). The rest of this note is the July history.**

**SCOPE CORRECTED 2026-07-17: MEDICAL REPRESENTATIVES ONLY.** The owner flagged that the live
module had enrolled non-reps. Root cause: provisioning had NO job-title filter — the AFTER INSERT
hire trigger + `ensureProbationCase` + backfill provisioned EVERY active in-window employee. Prod
had 15 cases: 11 Medical Representatives + 4 out-of-scope (2 District Sales Managers, 1 Regional
Sales Manager, 1 Admin Assistant). The 4 were deleted from prod (+3 history rows; they had zero
DV/feedback data). Fix = med-rep-only guard in all 3 paths: `isMedicalRepresentativeTitle` (substring
`"medical rep"`, covers variants, excludes managers/admin) in `cases.ts` + `backfill.ts`, and
migration `20260717140000` on the hire trigger (load-bearing — app guard alone leaks via the DB
trigger). Shipped in **PR #1098** (bundled with the B-10 System-Admin CC routing). Managers (DM/RSM/NSM)
are EVALUATORS in the module, never SUBJECTS. See [[probation-email-controls-mod1-4]].

**SECOND leak found in a live dev-auth walkthrough 2026-07-17 → PR #1107 (OPEN, not merged):** the
`/probation` dashboard, tracker, **Export PDF/Excel**, API route, and manager portal build from
`getProbationRows()` (`src/lib/probation/service.ts`), which lists the employee-directory **hire+90
WINDOW** (NOT `probation_cases`) and had NO job-title filter — so the 4 non-med-reps still showed (with
Pass/Terminate/Feedback actions) even after their cases were deleted. Fix = add `isMedicalRepresentativeTitle`
filter in `getProbationRows` (one choke point for all those surfaces); dashboard 15→11 verified live.
**SFE evidence 0-sentinel bug (PR #1109 MERGED+LIVE 2026-07-17, commit cec307a2, prod 200):** `ireports360_visits.contact_crm_id = 0` is the CRM "unspecified/unmapped contact" SENTINEL (convention: `crm/master.ts` `contact_crm_id !== 0 ? … : null`) — ~33k visit rows / 208 agents in prod. `computeSfeEvidence` (`sfe-evidence.ts`) filtered only `!= null`, so an all-unmapped rep (e.g. ai-0002: 420 visits all contact=0) showed "Distinct customers: 1" instead of 0. Fixed: exclude `=== 0`, add `unmappedContactVisits` + a customer_coverage note. Co-observed "GPS check-ins: 0" is NOT a bug — those reps have zero check-in rows (verified by agent_hr_id AND agent_crm_id); honest upstream iReports360 gap. Any CRM aggregation counting distinct contacts must exclude 0.

**Training Manager feedback OPTIONAL + DM requires 2 not 3 (owner rule 2026-07-18; PR #1148 MERGED+LIVE commit 93cf2229, prod config row `{dm:2,tm:0,nsm:1,pm_gpm:1}` LIVE):** DM requirement was already 2 in the live config (admin-HR); code default aligned 3→2. TM:** `requirements.tm = 0` makes TM complete-by-definition (scoring.ts `required<=0 → complete`; keeps roleWeights.tm so it still counts IF a TM submits — score normalizes over PRESENT components). Set in `DEFAULT_PROBATION_CONFIG` (code) AND the prod `probation_config` row (jsonb_set tm=0, updated_by claude-tm-optional 2026-07-18 — LIVE now, ~30s config cache). `feedback-sla-reminders.ts` filter excludes `evaluatorRole==="tm"` → no SLA reminders/escalation for TM DV-days. Inbox panel: TM tasks render "Optional" (not "missing"), excluded from overdue/worst-SLA. Tests that broke on tm=0: probation-scoring (missingByRole.tm, missingComponents), probation-report (tm.complete, totalRequired 6→5) — all updated. When making a role optional, change BOTH the code default AND the live DB config row (DB wins once present).

LESSON: probation surfaces split between `probation_cases`-based (dashboard analytics E4, case report — already med-rep-scoped) and employee-directory-window-based (`getProbationRows` — needed its own guard); check BOTH when scoping.

**PR #1107 MERGED+LIVE 2026-07-17 (commit 91900ada; deploy promoted, prod 200) bundles 3 live-walkthrough fixes:** (1) the getProbationRows med-rep guard above; (2) **feedback inbox grouped BY PROBATIONER** (`probation-feedback-tasks-panel.tsx` `groupByProbationer` — one card per rep + numbered "Feedback N — missing" items, NOT one flat row per DV-day repeating names); (3) **Probation Analytics audience widened** via new `canViewProbationAnalytics` (service.ts) = NSM + Product Manager + Group Product Manager + SFE Manager + Super Admin + CEO (plus existing canReadAllProbation roles). NSM/PM/GPM are PORTAL-mode (in `portalNavigationRoles`) so analytics is rendered inside their portal `/employee-portals/probation` page; SFE Manager/Super Admin/CEO are admin-mode → admin `/probation/analytics`. All verified live via dev-auth (`?role=&hrId=`) on the demo worktree dev server pointed at prod DB.

The probation rebuild (Probation Decision Intelligence System, PR #1041, branch
`codex/probation-intelligence`) originally described the target as "field force (Medical Reps +
District Managers)" — that "+ District Managers" was WRONG and is superseded by the med-reps-only
rule above.

**Consequence for the HR assessment:** fingerprint / settlement **attendance is a
head-office concept and does NOT apply to this population**. A field rep's "presence" is
their CRM field activity (ireports360 visits/check-ins), which already feeds the SFE
evidence. So the HR probation assessment is **NOT** gated on the attendance-ingestion
backfill.

**Why this matters:** an earlier AskUserQuestion answer ("Block HR assessment on
attendance backfill") was chosen under the mistaken premise that attendance data was
needed. The owner corrected this (2026-07-13). Corrected design: HR assessment is
**available by default** (`probation_config.hr_assessment_enabled` default TRUE, an admin
toggle only), scored by HR using the field-relevant auto signals (leave requests,
deduction decisions) plus HR judgment (conduct/documentation/warnings, entered manually).
`hr-evidence.ts` marks fingerprint attendance as "not applicable to field roles", not
"pending backfill".

**How to apply:** do NOT reintroduce an attendance-backfill dependency into the probation
HR assessment. If scaling probation to other populations later, revisit — but for now the
scoring engine ([[probation-module-is-field-force-only]]) should treat HR as a normal,
available component (weight ~0.10). Relates to the SFE component, which is data-driven from
CRM visits/check-ins.
