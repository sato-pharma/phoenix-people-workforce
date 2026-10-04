---
paths:
  - "src/lib/{vacation,attendance,excuses,early-birds,hr-calendar,private-calendar,calendar}/**"
  - "src/components/{vacation,attendance,early-birds,hr-calendar}/**"
  - "app/**/{vacation-request,vacation-control,vacation-report,leave-management,finance-leave-management,attendance,fingerprint-analytics,excuses,early-birds,hr-calendar,company-calendar,team-calendar,private-calendar,private-calendars,private-calendar-disputes}/**"
  - "local-attendance-agent/**"
  - "tests/*{vacation,attendance,excuse,early-bird,calendar,leave}*"
  - "supabase/migrations/*{vacation,attendance,excuse,leave,calendar}*"
---

# Module memory — Vacations, attendance and calendars

**Scope:** Annual vacation requests and balances, attendance and fingerprints, excuses, Early Birds, the HR and team calendars, private calendars.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

### Production hooks (moved from AGENTS.md §2.3)

- 🔴 **A VACATION BALANCE IS RECOMPUTED, never read from a snapshot** — INSERT the missing days; a back-dated PAID insert RE-SEQUENCES every later row. **Never UNPAID — those zeros are deliberate** — and skip leavers (owner). `salary_records.unpaid_vacations` is a SECOND path that has really taken money: price it by `unpaid_duration_days`, never by dates. `vacation-balance-is-recomputed-live-snapshots-are-display-only`

- 🔒 **SICK EVIDENCE IS AN APPEND-ONLY DATED HISTORY — A LATER UPLOAD ADDS TO THE EARLIER FILES AND NEVER REPLACES THEM** (owner, 2026-10-03). One row per FILE in `v2_vacation_request_attachments` with its OWN `uploaded_at`, which is what lets the admin read "3 October this, 10 October those". 🔴 **The six legacy `sick_attachment_*` / `compensatory_attachment_*` columns are KEPT and keep naming the FIRST file — never tidy them away, and never let the add path write them**, or the first document vanishes from the evidence gate, the emails and the exports at once. The storage path carries a per-file unique id (`upsert: false`) because two phone photos are both `IMG_0001.jpg`; file 2+ opens through `/attachments/file/<attachmentId>`, never `/attachments/<kind>`. The employee who filed it and HR may add, at ANY status; adding decides nothing. Account: `docs/agents-owner-rules.md`, "Sick leave evidence is an append-only dated history". Pinned by `tests/vacation-sick-attachments.test.ts`.

### Owner rules (moved from AGENTS.md §4)

- 🔒 **YASMEENA ELSAFORY (`HR-009`) IS INFORMED OF EVERY ANNUAL VACATION REQUEST, AND HER LANDING PAGE NAMES WHO IS ON A VACATION TODAY** (owner, 2026-09-29). 🔴 **INFORMED IS NOT AN APPROVER — never add her to `approval-flow.ts`**, the obvious-looking implementation, which would make every annual vacation in the company wait on a third signature; it is ONE notice on submit, `normal` priority, no approve/reject button. 🔴 **IN-APP + EMAIL + TELEGRAM, all three** (owner, 2026-09-30) — removing a channel needs his word exactly as adding one did. **Pass NO `email` block** — `recipientHrId` alone resolves her own work address, and an empty `recipients` falls through to the shared `hr_notifications` inbox and still logs a success. Annual only; admin-RECORDED vacations notify nobody, by design. The panel is APPROVED leave covering the Cairo day, every type, as NAMED people and deliberately not a tile — and a failed read renders NOTHING, never "nobody is on a vacation today". `src/lib/vacation/informed-recipients.ts` · `src/lib/vacation/on-vacation-today.ts`, pinned by `tests/vacation-informed-hr.test.ts` in the required `checks` job. Account: `docs/agents-owner-rules.md`, "Yasmeena is informed of every AV".
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (19)

- `attendance-agent-crashes-at-logon-but-loses-no-attendance` — Phoenix.Attendance.Agent.exe dies at EVERY logon with 0xE0434352 (unhandled .NET), but no attendance is lost - the 2-hourly sync task restarts it on demand and those runs succeed. The ZKTeco device is only reachable ~11:00-18:00 Cairo, so overnight sync failures are the network, not a bug.
- `attendance-agent-device-unreachable-and-token-rotation-pending-restart` — RESOLVED / HISTORICAL (closed 2026-09-21) - the 2026-07-30 attendance outage and the ATTENDANCE_AGENT_TOKEN rotation that was pending an agent restart are both long finished; its Cloud Run and Secret Manager steps are dead-platform. Keep only for the /health checks reading procedure. Do NOT tell the owner a token restart is outstanding.
- `attendance-agent-needs-the-office-lan` — Punch ingestion silently stops whenever the owner's laptop leaves the office LAN — the ZKTeco device is at 192.168.100.52:4370 and nothing else can reach it
- `attendance-agent-x86-com-requirement` — ZKTeco attendance agent MUST run as 32-bit (win-x86); zkemkeeper.dll is x86-only COM, and the start-agent.ps1 dotnet-run fallback silently builds x64 and fails with 80040154.
- `attendance-eligibility-device-mapped` — Fingerprint Analytics was empty because attendance eligibility was field-role-only; fixed to device-mapping-based.
- `attendance-weekly-digest-selfsettlement-spec` — The weekly attendance digest + self-settlement was torn down 2026-07-22 (#1253) and REBUILT 2026-09-08 (#3495) at the owner's request — it is LIVE in src/lib/attendance/ (digest-service, digest-bridge, …). Releasing a flagged week starts a real deduction path; employees wait at awaiting_release and the owner releases them himself — never suggest it. The month-end Fingerprint connector stays the ONLY writer of deduction candidates. Holds the durable owner rulings and the code relics that survived the teardown.
- `company-vacation-report-crm-signals` — New /admin/vacation-report module — CRM (iReports360) visit_type=-4 "Annual Vacation" signals cross-checked against fingerprint attendance, surfaced for Super Admin human review, never auto-written to balances.
- `early-birds-is-in-app-and-telegram-never-email` — Owner rule — Early Birds is in-app + Telegram only, and a backfill WINDOW is not a floor
- `early-birds-runs-on-two-clocks` — Early Birds start score is GPS-only but its "#1 days" component still falls back to paperwork time — 12.2% of district-days crown a different rep.
- `excuse-decision-race-condition-fix` — TOCTOU race-condition bug class (read-check-write with no DB status guard) found in excuses service; established fix pattern + which domains are known-fixed vs unchecked.
- `excuse-module-excludes-dsm-rm` — Owner removed District Manager + Regional Manager from the Excuse module entirely (request AND approval) on 2026-07-30; excuse is a Head-Office/fingerprint concept, and prod data proved the field ladder never used it.
- `never-suggest-releasing-attendance-weeks-owner-releases-himself` — Never suggest releasing weekly attendance digest weeks — the owner releases what he wants himself; releasing is his decision, never a Next-step suggestion.
- `private-calendar-hidden-from-portal-nav` — Private Calendar hidden from ALL portal nav surfaces for every role; and the system-navigation seed → buildModuleCatalog coupling that ripples into the module-curation test
- `private-calendar-plan-sync-removed` — Private Calendar must show ONLY 5 real-recorded sources (attendance, CRM double visit, vacation, holiday, excuse) — Planning Calendar (plan) data was fully removed and must never sync back in, as a chip or as no-activity-suppression logic.
- `v2-vacation-prod-schema-drift` — Prod v2_vacation_requests was missing weekly_off_policy_snapshot col + dup-active index even though migration 20260523220000 was RECORDED as applied — schema drift. Backfilled 2026-06-10. Blocked all vacation submissions (0 rows in prod).
- `vacation-action-center-build` — Vacation Action Center + sequential approval workflow — 3 stacked PRs. PR1 (engine) shipped as PR
- `vacation-balance-is-recomputed-live-snapshots-are-display-only` — A vacation balance is RECOMPUTED from approved paid days at read time — there is no balance column, so correct it by inserting the missing approved day-rows (no deploy). The used/balance_before/balance_after columns are a display-only frozen snapshot; a back-dated insert makes every later PAID row stale, fixed by re-sequencing the whole period (never over unpaid rows). Two money traps: salary_records.unpaid_vacations is a SECOND, older deduction path that has already taken real money and is invisible to the deductions module (diff before publishing or people get charged twice), and a backfilled day inside the first six months lands UNPAID and consumes nothing. Price by unpaid_duration_days, never by counting dates. Weekly-off policy is keyed by SEAT title, not employees.job_title.
- `vacation-report-cross-request-cache-live-on-prod-2026-08-14` — Vacation report is served from a cross-request cache, NOT the phx_vacation_report_rows RPC per request — LIVE on prod, do not redo/undo
- `vacations-audit-coverage-is-complete-via-two-tables` — The vacation module has NO payroll-style audit gap — every human mutation names its actor, but 4 paths record it in v2_vacation_request_events, not audit_logs
<!-- module-memory:notes:end -->
