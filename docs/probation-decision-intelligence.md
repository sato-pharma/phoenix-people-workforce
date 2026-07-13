# Probation Decision Intelligence System — Completion Report

Branch: `codex/probation-intelligence` · PR #1041 · Status: **Phases 1–11 complete, staging-verified, not yet on production.**

## 1. Executive summary

A rebuild of the probation module into an evidence-based **Decision Intelligence System** for the
**field force (Medical Reps + District Managers)**. Each employee has one central Probation Case;
Double-Visit Days are captured from CRM as the source of truth, validated, and evaluated with a
structured scorecard; SFE (data-driven) and HR assessments feed a transparent weighted score with
contradiction detection; a live consolidated report and a CEO exception dashboard surface decision
readiness; event/milestone emails keep stakeholders informed; and an authorized human makes the
final Pass/Terminate decision with exactly-once side effects. **The system never decides
automatically.**

Fingerprint attendance is a head-office concept and is **not** an input here — field presence is
CRM activity. `extend` was removed by owner policy.

## 2. Architecture — reused vs new

| Reused unchanged | Reused with modification | New |
| --- | --- | --- |
| Notification outbox + `createSystemNotification`; email-template engine; `ireports360_visits/_checkins` sync; audit (`writeAuditLog`/`writeRequiredAuditLog`); `resignEmployeeAndOpenVacancy`; employee directory; admin design system | `probation_reminder`/`workflow` templates coexist; scheduled-processing cron (added SLA + milestone sweeps); ireports360 sync cron (added DV capture); `hire`-path provisioning (added DB trigger); `probation_history` (+case_id) | `src/lib/probation/intelligence/*` (cases, config, dv-source/detection/validation/persistence/review/sync, feedback-workflow, feedback-sla(+reminders), scorecard, sfe-/hr-evidence, assessments, scoring, contradictions, scoring-service, report-metrics, consolidated-report, dashboard(+classify), probation-emails, decision); 6 migrations; admin report + dashboard pages; 4 email templates |

## 3. Database changes (6 migrations — all additive, idempotent, service-role-only RLS)

1. `20260713130000_probation_intelligence_domain` — 8 core tables + `probation_history.case_id`.
2. `20260713131000_probation_provision_trigger` — hire trigger + `probation_provisioning_failures`.
3. `20260713132000_probation_dv_ingest_issues` — CRM review-queue table.
4. `20260713133000_probation_scorecard_config` — `scorecard_dimensions`.
5. `20260713134000_probation_hr_assessment_flag` — `hr_assessment_enabled` (default true).
6. `20260713135000_probation_decision_snapshot_and_extend_teardown` — `decision_snapshot` + registry `probation_extended` removal.

All 10 new tables: **RLS enabled, 0 policies** (server-only via service role). No destructive DDL.

## 4. Security & data integrity

- Every API route permission-gated (`assertPermission` / `canReadAllProbation`); every mutation CSRF-guarded (`assertSameOriginMutation`).
- **Row-level auth**: feedback = evaluator ownership (or audited admin override); decision = CEO + Super Admin/HR + in-scope NSM.
- **Confidential redaction**: HR/SFE confidential notes + DV comments visible only to HR/CEO.
- **Idempotency everywhere**: case provisioning (`ON CONFLICT`/trigger), DV capture (crm_visit_id + DV-Day unique), feedback (one per DV-Day), emails (per-recipient idempotency key), decision side effects (atomic `side_effects_applied_at` claim).
- **No silent swallow**: `probation_provisioning_failures`, `probation_dv_ingest_issues`, DV review-status rows all surface problems.

## 5. Acceptance-criteria evidence matrix

| # | Criterion | Evidence |
|---|---|---|
| 1 | New eligible hire → one Probation Case | hire trigger (verified live); `ensureProbationCase` |
| 2 | Unified date formula | `date.ts` hire+90; provisioning switched off +3mo; date tests |
| 3 | Employee appears in dashboard | `getProbationDashboard` (active cases) |
| 4 | CRM DV Day detected correctly | `dv-detection`; 62 DV-Days on staging |
| 5 | DV Day contains visit details | `probation_dv_visits`; 427 visits captured |
| 6 | Same DV Day cannot import twice | DV-Day unique + crm_visit_id unique; idempotency test |
| 7 | Invalid CRM data surfaced not dropped | ingest-issues + review-status rows |
| 8 | Feedback task assigned to correct evaluator | `listFeedbackTasks` owner = evaluator |
| 9 | Evaluator submits without permission errors | row-level auth (fixes prior contradiction) |
| 10 | Unauthorized users cannot submit | `resolveFeedbackAuth` tests (unrelated mgr ✗) |
| 11 | One consolidated feedback per DV Day | `probation_feedback.dv_day_id` unique + dedup |
| 12 | Feedback versioned on edit | `probation_feedback_versions`; edit-reason required |
| 13 | SLA dates correct | `computeFeedbackSla` tests (due/escalate/overdue) |
| 14 | Reminders/escalations don't duplicate | state-keyed idempotency |
| 15 | HR can submit HR assessment | `submitHrAssessment` (enabled by default) |
| 16 | SFE reviews evidence + submits | `sfe-evidence` + `submitSfeAssessment` |
| 17 | DM progress = 3 required | `computeDvProgress` (config dm:3) |
| 18 | TM progress = 1 | config tm:1 |
| 19 | PM/GPM shared = 1 | pm_gpm:1; role resolution |
| 20 | NSM progress = 1 | config nsm:1 |
| 21 | Total required = 6 | `totalRequired` test |
| 22 | DM score = avg of 3 | `computeProbationScore` DM-average test |
| 23 | Role weights configurable | `probation_config.role_weights` |
| 24 | Missing components → provisional | `finalScore` null unless decision-ready |
| 25 | Contradictions visible | `detectContradictions`; report + dashboard |
| 26 | Report updates after every change | computed-on-read |
| 27 | CEO opens report anytime | report route + page |
| 28 | Dashboard prioritizes exceptions | exception-first sort + filters |
| 29 | DV snapshot email to stakeholders + CEO | `sendDvSnapshotEmail` (confirmed recipients) |
| 30 | Repeat sync doesn't resend | per-recipient idempotency key |
| 31 | Day 30 = early progress | `probation_day30` template |
| 32 | Day 60 = escalation/planning | `probation_day60` template |
| 33 | Day 75 = decision readiness | `probation_day75` template |
| 34 | No automatic decision | `decideProbation` is human-only; Day-75 no-decide |
| 35 | Pass side effects run once | atomic claim; **proven on staging** |
| 36 | Terminate side effects run once | same claim guard; reuses resignation flow |
| 37 | Extend fully operational or removed | **removed** (types + registry) |
| 38 | Existing prod data handled safely | backfill dry-run + idempotent write (staging) |
| 39 | Backfill idempotent + dry-run | `backfill.ts`; re-run → 0 new rows |
| 40 | Lint/typecheck/test/build pass | gate green; CI preview-smoke build green |
| 41 | No permission contradiction | row-level feedback auth (fixed) |
| 42 | No conflicting date formula | single `probationEndDate` |
| 43 | No silent provisioning failure | `probation_provisioning_failures` |
| 44 | No dead workflow path | `probation_extended` removed |
| 45 | Final report documents everything | this document |

## 6. Production rollout checklist

**Migrations to apply to production (`ozucdzovmcqvepbozvqf`), in order** — all additive/idempotent, separate explicit approval required:
1–6 as listed in §3 (timestamp order). After each: `notify pgrst, 'reload schema'` is included.

**Post-migration verification (prod):**
- Confirm 10 tables exist + RLS enabled; hire trigger present; registry `probation_extended` gone; config singleton seeded (`hr_assessment_enabled=true`).
- **Backfill (prod)** — run the dry-run first, review counts, then the idempotent write (separate approval). Re-run to confirm 0 new rows.
- Verify `https://phoenix-hr.satopharma.com/probation/dashboard` and a case report render.
- Confirm the ireports360 sync cron captures DV-Days and the notifications cron runs SLA + milestone sweeps (check logs; idempotency prevents duplicates).

**Feature-flag / kill switches:**
- `probation_config.hr_assessment_enabled` — HR assessment on/off.
- DV capture + emails are additive to existing crons; to pause, revert the cron wiring (dv-sync snapshot / scheduled-processing milestone+SLA calls) — the legacy probation flow is untouched and keeps working.

**Monitoring:**
- `probation_provisioning_failures` (unresolved) — alert if non-empty.
- `probation_dv_ingest_issues` (unresolved) — admin review queue.
- Notification delivery logs for the 4 new templates.

## 7. Rollback plan

- **Code**: revert the PR (branch is isolated; the legacy probation module — `probation_evaluations`, tracker UI, reminders — was left intact and functional throughout, so reverting the new surface restores prior behavior).
- **DB**: migrations are additive; the new tables/columns can be left in place (inert) or dropped in a follow-up. The only data mutations are (a) case backfill and DV capture (deletable by `source='backfill'`/case scoping) and (b) the registry `probation_extended` removal (re-addable). No existing data was altered destructively.
- **Decision side effects** are the only irreversible actions and require explicit human action per case.

## 8. Known limitations

- SFE **plan-adherence** metric is unavailable (weekly_plans data empty) — surfaced honestly, not faked.
- ~6.7% of CRM rows lack `agent_hr_id`; an unmapped probation rep earns no DV credit until mapped (enhancement: unmapped-agent badge — planned).
- **Development Actions** table exists but the workflow is not yet wired (planned enhancement).
- Admin config is DB-backed but editable only via SQL today (admin config-editor UI — planned enhancement).
- Local `next build` cannot run in the worktree (Turbopack node_modules junction) — build verified via CI `preview-smoke`.

## 9. Test & gate summary

- **363 unit test files pass**; typecheck + lint clean; CI `lint-typecheck` + `validate` + `preview-smoke` green on every push.
- New suites: date, provisioning, migration-readiness, DV source/detection/validation/persistence/sync, feedback-workflow, assessments, scoring+contradictions, report, dashboard, emails, decision.
- Staging validations: 15 cases backfilled; 62 DV-Days + 427 visits captured (idempotent); hire trigger proven; decision exactly-once side-effect + Pass activation proven on a disposable fixture (cleaned up).
