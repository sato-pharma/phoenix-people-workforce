# Module memory

**Owner decision, 2026-10-02.** Each module of Phoenix Workforce carries its own memory — its rules
and every memory note about it — in `.claude/rules/<module>.md`. Claude Code loads that file by
itself the moment a session opens a file of the module. The startup files (`AGENTS.md`, the laptop's
`MEMORY.md` index) keep only what is true everywhere. AGENTS.md §2.2 holds the hooks; this file is the
account.

## Why it exists

The startup files have hard ceilings: `MEMORY.md` is truncated by the loader at 25 KB / 200 lines,
and `CLAUDE.md` + `AGENTS.md` are held to their CI share. Every new rule pushed an older one out of
sight, sessions kept asking the owner to trim, and a session returning to an old module no longer
knew its rules. Measured on 2026-10-02, before this change:

| | Before |
| --- | --- |
| Memory notes on the laptop | 1,064 (4.8 MB) |
| Notes pointed to by anything a session reads at startup | 233 (22%) |
| Notes listed only in `MEMORY-ARCHIVE.md`, which no session opens unless it thinks to | 831 (78%) |
| `AGENTS.md` | 113,652 bytes, with 2,989 bytes left in its CI share |
| `MEMORY.md` | 21,206 bytes of a 25 KB loader cliff |

Storage was never the problem — the notes were on disk and mirrored into the repo. **Recall** was:
nothing told a session a note existed. A database "brain" would have failed the same way, because an
agent only queries for what it already knows exists.

## How it loads

**Claude Code's own path-scoped rules.** A `.claude/rules/*.md` file with a `paths:` frontmatter is
not loaded at startup; it is loaded when the session READS a file matching one of its globs. Proven on
Claude Code 2.1.284 (the desktop app's version) on 2026-10-02 with a throwaway module carrying a
codeword: no file read → not loaded; another module's file read → not loaded; this module's file
read → loaded (3 of 3 runs, two of them with the owner's full hooks and settings on).

`node scripts/module-memory/proof.mjs` repeats that proof for **every** module in a real headless
session (Haiku, project settings only, a prompt with no module keyword so the hook cannot be what
delivered it). **Re-run it after a Claude Code update** — the loader is Claude Code's, not ours.

**The hook covers work that opens no file.** `.claude/hooks/module-memory-injector.mjs` runs on
UserPromptSubmit and PreToolUse. It matches the owner's message against each module's keywords;
shell commands by the module paths they name plus a short list of command words (`railway`,
`gh pr merge`, `new-session.mjs`, `apply_migration` — `COMMAND_MODULES` in the hook, never a
module's business keywords); Grep/Glob by their `path` and `glob` only; Edit/Write of a new file;
and SQL text (Supabase MCP or `psql`) against each module's table names. **What it ignores, since
2026-10-08** (`.claude/hooks/lib/harness-text.mjs`): any harness envelope in the prompt
(`<task-notification>`, `<system-reminder>`, any lower-case hyphenated tag) and the
`[SYSTEM NOTIFICATION …]` banner, because those are the app speaking, not the owner; a Grep
`pattern`, which is what is hunted for, not where the work is; and every quoted string or heredoc
body in a shell command that is not a path, so `git grep "railway run"` or a commit message naming a
module routes nothing. A quoted path still counts. `.claude/hooks/trap-injector.mjs` reads commands
through the same helper. Measured the day it changed: one settings audit that touched no module was
handed six modules and six trap clusters, about 25,000 tokens. It injects a **pointer**: the module's
title, the bold headline of each of its rules, and the file to Read. It never pastes the file —
Claude Code persists any hook context over ~10 KB to disk and shows the model a 2 KB preview
(observed 2026-10-02 on the trap hook's 12.5 KB clusters), and a truncated rule reads complete. A
Read of a module file is recorded but never injected, because Claude Code already loaded it.

## The files

| File | Role |
| --- | --- |
| `scripts/module-memory/modules.mjs` | The module map: id, title, scope, globs, keywords, table names. The one definition everything reads. |
| `scripts/module-memory/assignments.json` | Every memory note -> a module, `global` (stays in `MEMORY.md`) or `history` (never loaded). |
| `scripts/module-memory/build.mjs` | Writes each rules file's frontmatter, header and notes block, the history list and the AGENTS.md directory. `--check` is the CI gate. |
| `.claude/rules/<module>.md` | The module memory. `## Rules` is hand-written and preserved; the notes block is generated. |
| `docs/module-memory/history.md` | Notes about retired platforms and frozen areas. Never loaded; never act on it. |
| `.claude/hooks/module-memory-injector.mjs` | The pointer hook above. Also records the modules each session touched. |
| `scripts/module-memory/fold.mjs` | The fold below — three times a day. |
| `scripts/module-memory/proof.mjs` | The live per-module proof above. |
| `tests/module-memory.test.ts` | Runs `build.mjs --check` and pins the glob dialect, the hook's routing, the pointer size and the no-regrowth rule, in the required `validate` job. |

## The module directory

**This table used to sit in `AGENTS.md` §2.2, where it cost 5.4 KB of the always-loaded share on every
single request.** It moved here on 2026-10-06 because nothing reads it to *reach* a module: Claude Code
loads `.claude/rules/<id>.md` by itself the moment a session opens a file matching that module's
`paths:`, and `module-memory-injector.mjs` matches work that opens no file. `ls .claude/rules/` lists
the same ids, and each file's own `paths:` holds every glob — so the table is a convenience for reading
about the system, not a dependency of it. §2.2 keeps the pointer and the module count.

🔴 **Generated — never hand-edit it.** Edit `scripts/module-memory/modules.mjs`, then run
`node scripts/module-memory/build.mjs`. A stale block fails `build.mjs --check` in the required
`validate` job, exactly as the AGENTS.md block did.

<!-- module-memory:directory-table:begin — generated by scripts/module-memory/build.mjs -->
| Module | Loads when a session touches |
| --- | --- |
| `payroll` — Payroll, salaries and deductions | `src/lib/{payroll,automated-payroll,deductions,daily-deductions,finance,reconciliation,calculator,dispute-center}/**` and 4 more |
| `payroll-disputes` — Payroll — disputes and the Dispute Center | `src/lib/dispute-center/**` and 3 more |
| `payroll-files` — Payroll — the files that leave, and their download record | `src/lib/automated-payroll/{download-log,bank-file-downloads}.ts` and 3 more |
| `payroll-automated` — Payroll — the automated payroll run | `src/lib/automated-payroll/**` and 3 more |
| `sales-closing` — Monthly Closing, the Office and El Qema money rules, the Business Review | `src/lib/sales/*` and 6 more |
| `sales-closing-exports` — Monthly Closing — the exports, the premium workbook and the Performance Review pack | `src/lib/sales/{closing-consolidated-premium-export,closing-export-filename,closing-export-payload,closing-matrix-without-office,closing-performance-review,closing-performance-review-access,closing-performance-review-export,closing-performance-review-portal,closing-performance-review-regions,closing-performance-review-scope,closing-ranking-dress,closing-rep-ranking,closing-rep-ranking-export,closing-rep-ranking-filter,closing-rep-ranking-legacy-shape,closing-rep-ranking-line,closing-rep-ranking-workbook,closing-review-sheets,closing-workbook-lock,monthly-closing-consolidated-export,monthly-closing-export,rankings,rankings-page,sales-workbook-kit}.ts` and 5 more |
| `sales-closing-screens` — Monthly Closing — the screens, the deep links and the drift detectors | `src/lib/sales/{closing-deep-link,closing-details-span,closing-filter-narrowing,closing-load-gate,closing-publication-drift,closing-publish-destination,office-allocation-drift,source-coverage,source-quiet-periods,sos-month-complete,sos-dashboard,portal-sos-dashboard}.ts` and 10 more |
| `sales-imports` — Source of Sales — distributor imports, customer mapping and rollups | `src/lib/sales/{normalizer,master-data,master-map,ai}/**` and 5 more |
| `sales-master-map` — Source of Sales — the Master Map sheet and its feed | `src/lib/sales/master-map/**` and 2 more |
| `sales-attribution` — Attribution, achievement, targets and sales territory | `src/lib/sales/territory/**` and 7 more |
| `weekly-sales` — Weekly sales and stock | `src/lib/sales/weekly/**` and 3 more |
| `direct-orders` — Direct orders | `src/lib/direct-orders/**` and 5 more |
| `incentives` — Incentives and targets payout | `src/lib/incentives/**` and 2 more |
| `production-planning` — Production Planner (toll manufacturing — Ivyronc and Guamusin) | `src/lib/production-planning/**` and 5 more |
| `phoenix-crm` — Phoenix CRM (the reps' own CRM) | `src/lib/phoenix-crm/**` and 4 more |
| `phoenix-crm-approvals` — Phoenix CRM — lists, validation, plans and approvals | `src/lib/phoenix-crm/{adoption-rules,approval-nudge-rules,customer-list-grouping,entry-rules,list-request-rules,list-row-facts,list-sheet-hours,list-template-rules,monthly-plan-rules,offplan-day,pharmacy-call-rules,plan-board-answer,plan-edit-rules,plan-review-rules,plan-rules,unplanned-rules,validate-next}.ts` and 4 more |
| `phoenix-crm-week-plan` — Phoenix CRM — the rep's weekly plan, its review and asking to edit it | `src/lib/phoenix-crm/{monthly-plan-rules,plan-board-answer,plan-edit-rules,plan-review-rules,plan-rules,approval-nudge-rules}.ts` and 4 more |
| `phoenix-crm-boards` — Phoenix CRM — the silent detectors and the SFE's boards | `src/lib/phoenix-crm/{behaviour-integrity,duplicate-photos,location-integrity,refused-readings-rules}.ts` and 12 more |
| `phoenix-crm-visit-report` — Phoenix CRM — the Visit Report generator | `src/lib/phoenix-crm/{visit-report-*,server/visit-report*}.ts` and 4 more |
| `phoenix-crm-refused-readings` — Phoenix CRM — the refusals a capture leaves behind | `src/lib/phoenix-crm/refused-readings-rules.ts` and 22 more |
| `phoenix-crm-requests` — Phoenix CRM — how a request answers the screen | `src/components/phoenix-crm/api.ts` and 10 more |
| `phoenix-crm-manager-plan` — Phoenix CRM — the district manager's weekly plan | `src/lib/phoenix-crm/manager-plan-rules.ts` and 11 more |
| `phoenix-crm-manager-customer-marks` — Phoenix CRM — the marks on each customer of a manager's plan board | `src/lib/phoenix-crm/manager-customer-marks-rules.ts` and 9 more |
| `phoenix-crm-manager-ride-alongs` — Phoenix CRM — a manager's half-day with another manager | `src/lib/phoenix-crm/manager-plan-rules.ts` and 12 more |
| `phoenix-crm-manager-plan-conversation` — Phoenix CRM — the conversation on a manager's week | `src/lib/phoenix-crm/server/manager-plan-conversation.ts` and 4 more |
| `phoenix-crm-manager-plan-training-manager` — Phoenix CRM — the Training Manager's weekly plan | `src/lib/phoenix-crm/manager-plan-rules.ts` and 6 more |
| `phoenix-crm-manager-week-glance` — Phoenix CRM — a manager's week at a glance and its Excel file | `src/lib/phoenix-crm/manager-week-glance.ts` and 6 more |
| `phoenix-crm-validation` — Phoenix CRM — validating a place: the signboard, the refusal, the merge | `src/lib/phoenix-crm/{signboard-rules,schedule-rules,shared-place-rules,shared-place-groups,place-match-groups,validation-feedback,duplicate-merge-rules,validation-review-filters,place-photo-size,photo-reading-rules,pm-name-rules,trusted-point-rules,line-twins}.ts` and 8 more |
| `phoenix-crm-place-checks` — Phoenix CRM — the Place checks page: groups, the same-place comparison and the decisions | `src/lib/phoenix-crm/{shared-place-groups,place-match-groups,customer-match-groups,validation-review-filters,place-checks-on-demand}.ts` and 15 more |
| `phoenix-crm-signboard` — Phoenix CRM — the signboard reader: reading a photo and judging it against the list | `src/lib/phoenix-crm/{signboard-rules,place-check-advice}.ts` and 5 more |
| `phoenix-crm-reports` — Phoenix CRM — the reports, the boards and how every figure is counted | `src/lib/phoenix-crm/{brick-report,daily-plan-report,exceptions,report-guide,report-rules,samples-report,team-calendar}.ts` and 19 more |
| `phoenix-crm-reference-list` — Phoenix CRM — the reference list: the seat's customers and the mint that keeps them current | `src/lib/phoenix-crm/server/{list,visits,missed-records}.ts` and 4 more |
| `phoenix-crm-visits` — Phoenix CRM — the visit a rep records: the form, the day, the pharmacy call | `src/lib/phoenix-crm/{call-prep,day-activities,day-detail,day-start-rules,double-visit-request-rules,last-visit-products,pharmacy-call-rules,today-rules,visit-ask-rules,visit-company,visit-detail-edit-rules,visit-edit-rules,visit-kind-labels,visit-location-words,visit-outbox,visit-outcome,visit-resend-rules,visit-rollup-rules}.ts` and 8 more |
| `crm` — Field CRM analytics (iReports360) — visits, KPIs, reps lists and plans | `src/lib/{crm,crm-integrity,customer-360,customer-identity,customer-master,double-visit-analytics,visits-report,field-activity,weekly-planning}/**` and 10 more |
| `crm-board-reads` — Field CRM — how a board reads: the shared minute-old copies and the one-statement functions | `src/lib/crm/{shared-windows,reps-list,reps-list-board,contact-trade,rep-kpi-reports-data,region-brick}.ts` and 5 more |
| `crm-double-visit-focus` — Field CRM — the double-visit focus panel on a manager's home | `src/lib/double-visit-analytics/service.ts` and 1 more |
| `crm-unified-doors` — The CRM union doors — crm_visits_unified, crm_checkins_unified and the entry days | `src/lib/crm/{reads,master,phoenix-work-evidence,phoenix-vendor-leftovers,phoenix-team-starts,phoenix-kpi-data}.ts` and 9 more |
| `crm-kpis` — KPIs — the board, its three reports and the manager rows | `src/lib/crm/kpis*` and 5 more |
| `rep-ranks` — Phoenix Ranks — the rep board, its pillars and the certificate | `src/lib/rep-ranks/**` and 6 more |
| `weekly-planning` — Weekly and Monthly Plan — the Plans tab form | `src/lib/weekly-planning/**` and 2 more |
| `crm-doctor-lists` — Doctor lists — the contact master, its refresh and the list changes | `src/lib/crm/contact-lists/**` and 8 more |
| `crm-sync` — Field CRM sync — the retired iReports360 sync's record, the cutover switch and the housekeeping timer | `src/lib/crm/{sync-run-groups,cutover,housekeeping-scheduler,vendor-row-types}.ts` and 2 more |
| `marketing` — Marketing requests, venues, pharmacies and ROI | `src/lib/{marketing-requests,venues,pharmacy-master,pharmacy-search,customer-pharmacy-mapping,verified-captures,market-awareness,sales-marketing-intelligence,evidence}/**` and 4 more |
| `marketing-pharmacy-codes` — Marketing pharmacy codes — the resolver, not-found codes and the nightly sync | `src/lib/marketing-requests/sales-code-sync*` and 3 more |
| `marketing-functions` — Monthly Marketing Functions and the Marketing Field Visit Feedback | `src/lib/marketing-functions/**` and 4 more |
| `marketing-roi` — Marketing ROI — the fact rebuild, the verdict, the Tracker, the Coverage Report and the Scorecard | `src/lib/marketing-requests/{roi,coverage-report,manager-scorecard}*` and 4 more |
| `marketing-list-check` — Marketing doctor-list check and Finance Ageing | `src/lib/marketing-requests/{crm-list-check,crm-doctor-pick,finance-ageing}*` and 5 more |
| `marketing-approval-chain` — Marketing approval chain — deciding, cancelling, reopening and resubmitting a request | `src/lib/marketing-requests/{cancel,reopen-rule}*` and 2 more |
| `recruitment-job-posts` — Job Posts and the careers page — the picture, the Publish press and the guard | `src/lib/recruitment/job-posts/**` and 4 more |
| `recruitment` — Recruitment, CVs and offers | `src/lib/{recruitment,cv,offers,whatsapp-inbox,mailbox-monitor,zoom}/**` and 4 more |
| `recruitment-inbound` — Recruitment — the WhatsApp bot, the screening questions and the careers form | `src/lib/recruitment/inbound/**` and 4 more |
| `recruitment-interviews` — Recruitment — the interview calendar and interview outcomes | `src/lib/recruitment/interview*` and 3 more |
| `recruitment-offers` — Recruitment — the job offer letter, its email and the hand-off to the Employee Master | `src/lib/offers/**` and 4 more |
| `recruitment-cv-reading` — Recruitment — reading a CV file: its text, OCR, the rule pass and the model read | `src/lib/recruitment/cv-*` and 2 more |
| `recruitment-mr-hiring` — Recruitment — Medical Rep hiring, the 8 November 2026 workflow | `src/lib/recruitment/mr-hiring/**` and 4 more |
| `hiring-documents` — Hiring documents, contracts and company papers | `src/lib/{hiring-pack,hiring-documents,contracts,business-cards,email-signature,spotlight,pdf,export}/**` and 4 more |
| `employee-360` — Employee 360 — one person's report, its figures and who may open it | `src/lib/employee-360/**` and 3 more |
| `employees` — Employees and the HR lifecycle | `src/lib/{employees,employee-lifecycle,employee-360,hr,hr-reminders,hr-ops-reports,resignations,retention,retention-risk,lifecycle-risk,new-hire-mailbox}/**` and 4 more |
| `employees-hiring` — Employees — hiring a person: the two doors and the hand-off | `src/lib/employees/{hire-handoff,hire-handoff-reconciler,access-provisioning}.ts` and 6 more |
| `resignations` — Resignations — completing an exit and the seat it frees | `src/lib/resignations/**` and 4 more |
| `probation` — Probation and employee milestones | `src/lib/{probation,milestones}/**` and 4 more |
| `time-off` — Vacations, attendance and calendars | `src/lib/{vacation,attendance,excuses,early-birds,hr-calendar,private-calendar,calendar}/**` and 7 more |
| `private-calendar` — Private calendar — its sources, tiles, timeline and disputes | `src/lib/private-calendar/**` and 3 more |
| `expenses` — Expenses and outstation trips | `src/lib/outstation/**` and 5 more |
| `org` — Organogram, territory and geography | `src/lib/{org,workforce,field-workforce-compliance,territory-management,geo,geocoding,google-maps}/**` and 4 more |
| `portal` — Employee portal, dashboards and command centres | `src/lib/{employee-portal,navigation,overview,dashboard,action-center,needs-you,ceo,company-activity-report,support-requests,workspace,reports,activity}/**` and 5 more |
| `portal-manager-boards` — A manager's team boards on the portal home | `src/components/employee-portal/dashboards/**` and 4 more |
| `notifications` — Email, notifications and messaging | `src/lib/{email,email-templates,notifications,communication,internal-messages,distribution-lists,sato-email,ceo-email,personal-mailbox,mailbox-offboarding,conversations,whatsapp-videos}/**` and 5 more |
| `email-composers` — The two email composers — Sato and CEO | `src/lib/{sato-email,ceo-email}/**` and 3 more |
| `turbify` — Turbify mailbox console — the shared browser driver | `src/lib/turbify/**` and 3 more |
| `turbify-provisioning` — Turbify provisioning — creating a mailbox, its invitation and its app password | `src/lib/new-hire-mailbox/**` and 3 more |
| `coaching` — Coaching, training and visual aids | `src/lib/{coaching,visual-aids}/**` and 4 more |
| `report-it` — Report It (pharmacovigilance — patient data) | `src/lib/report-it/**` and 3 more |
| `approvals` — Approvals and workflow | `src/lib/{approvals-hub,workflow-control,workflow-registry,approvals}/**` and 6 more |
| `devices` — Devices and tablet management (Headwind MDM) | `src/lib/devices/**` and 4 more |
| `platform` — Platform — auth, security, cron, data access and shared UI | `src/lib/{auth,security,platform,cron-control,background-jobs,observability,error-monitor,system-audit,share-links,share,http,imports,uploads,ai,validation,qr,operations,synthetic-journeys,admin,format,i18n,ui,utils}/**` and 9 more |
| `platform-system-audit` — Platform — the System Audit board, its daily message and the error screenshots | `src/lib/system-audit/**` and 7 more |
| `platform-access` — Platform — passwords and access control | `src/lib/auth/{permissions,password-strength,leaked-password,change-password,password-setup,password-setup-no-script,password-setup-whatsapp,password-reset-code,temporary-password,seat-page-fences,seat-page-guard,signed-out-refusal}.ts` and 2 more |
| `platform-sessions` — Platform — the login check, the session copy, the heartbeat and the open tab's pulse | `src/lib/auth/{server,session,session-bundle-cache,session-heartbeat,session-lifecycle,session-token,app-sessions,client-session}.ts` and 13 more |
| `platform-ai` — Platform — the one door to an AI provider, the second provider and where an AI address comes from | `src/lib/ai/**` and 3 more |
| `platform-design-tokens` — Platform — design tokens, the form kit and the square-edge look | `src/components/ui/{form-kit,form-tokens,brand-tokens}*` and 3 more |
| `platform-observability` — Platform — structured logging, Sentry and the audit trail's own persistence | `src/lib/observability/**` and 17 more |
| `database` — Database, migrations and Supabase | `supabase/**` and 2 more |
| `database-migrations` — Database — migrations, their ledger and the routes that apply them | `supabase/migrations/**` and 11 more |
| `engineering` — Engineering — CI, tests, scripts and deploys | `.github/**` and 7 more |
| `engineering-tests` — Engineering — tests, and what makes a result evidence | `tests/support/**` and 2 more |
| `engineering-deploys` — Engineering — Railway deploys and what is actually serving | `Dockerfile` and 15 more |
| `engineering-railway-cli` — Engineering — the railway CLI, its two keys, and each service's source and trigger | `.railway/**` and 5 more |
| `engineering-field-day` — Engineering — the field day papers (scripts/field-day) | `scripts/field-day/**` and 2 more |
| `git-worktrees` — Git, worktrees and the shared primary checkout | `scripts/{new-session,sync-worktree-env,repo-doctor}*` and 1 more |
| `sessions` — Sessions — the Claude Code harness, this laptop and the memory system | `.claude/hooks/**` and 5 more |
<!-- module-memory:directory-table:end -->

## How memory stays current

1. **Work that ends in a PR.** A rule or fact learned in a module goes into that module's `## Rules`
   in the same PR as the work. A changed rule is an EDITED line, never a second line that
   contradicts it. It is live for every session the moment the PR merges.
2. **A ruling the owner gives in chat** goes in the same way, inside that session's PR.
3. **Work with no PR.** The note is written on the laptop as before, with its pointer under
   `## Inbox` in `MEMORY.md`, so every local session sees it at once. The fold
   (`node scripts/module-memory/fold.mjs --apply`) files each unfiled note under a module — by the
   modules its own session touched (`originSessionId` + the hook's record), else by its own words —
   refreshes the repo mirror, rebuilds, and opens ONE PR. After that PR merges, the next fold removes
   those pointers from the inbox. A note whose words match no module is filed under `sessions` and
   named in the PR so it can be moved.

The fold works in a temporary worktree from `origin/main`, never merges, never deletes a note, and
waits while an earlier fold PR is still open.

### The cadence: three times a day, not weekly

🔴 **The fold runs at 09:00, 15:00 and 21:00 Cairo, Monday to Saturday** — the owner's instruction
on 2026-10-03 ("this report needs to run twice or 3 times a day", and not on Sundays), replacing the
Sunday-only schedule it launched with on 2026-10-02.

The Windows task is **`Phoenix memory fold`**, installed by
`scripts/module-memory/install-fold-task.ps1`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\module-memory\install-fold-task.ps1
powershell -ExecutionPolicy Bypass -File scripts\module-memory\install-fold-task.ps1 -Remove
```

Three **weekly** triggers over Monday–Saturday, not one `-Daily` trigger: a daily trigger fires on
the Sunday he excluded and has no "except". It executes `node` directly against
`~/.claude/scripts/memory-fold-run.mjs`, a copy of `scripts/module-memory/run-fold.mjs` deployed
outside every checkout, which fetches and runs `origin/main`'s own `fold.mjs` in a throwaway
worktree and writes `~/.claude/scripts/memory-fold-task.log`. It sends no email and notifies nobody.
`tests/memory-fold-task.test.ts` pins both files in the required `validate` job.

🔴 **Until 2026-10-06 this section described a task called `module-memory-fold` running from a
worktree `_wt-memory-fold-runner`, and NEITHER EXISTED.** Nothing on the laptop was scheduled to run
the fold — no Windows task, no Claude scheduled task, no workflow cron; the only 21:00 task was the
CRM field day report, which names `fold.mjs` in a comment and does not run it. So from 2026-10-03 to
2026-10-06 every new note sat in the `MEMORY.md` inbox, re-charging every request in every session,
and reached its module only when a session happened to run the fold by hand. **A documented cadence
is not an installed job**, and nothing anywhere said otherwise — which is why the schedule now lives
in a committed installer with a test, rather than in a sentence.

**Why three runs a day cost no extra CI.** Two things in the script make the cadence free:

- **A run with nothing new opens no PR at all.** It prints `nothing to file — every note on this
  laptop is already filed on main` and exits. Most runs are this.
- **Only ONE fold PR is ever open.** A run that finds an open one prints
  `an open fold PR already exists (#N) — merge it first` and files nothing. So the number of fold
  merges is set by how many notes get written, exactly as it was when it ran weekly; what changed is
  the WAIT before a note reaches its module — up to seven days, now at most eight hours.

🔴 **That throttle keys on the BRANCH (`codex/memory-fold-<digits>`), never on the PR title.** The
title test it shipped with matched any open PR whose name contained "memory fold" — so a PR *about*
the fold silently stopped every run until it merged, which is what #5215 did to itself on 2026-10-03.
Only this script creates that branch, and the digits keep a human branch like
`codex/memory-fold-cadence` out of it.

**The inbox settle still happens on every run**, PR or no PR: it is a laptop-only edit to `MEMORY.md`
that removes pointers whose notes are already filed on `main`, so the index tidies itself three times
a day without anything to approve.

🔴 **The branch name carries the clock time** (`codex/memory-fold-<day>-<HHmm>`), because
`git worktree add -b` fails on a branch that already exists and the local branch outlives both the
temporary worktree and the PR's merge. A day-only name broke every second run of a day that filed a
note twice.

## What stays in AGENTS.md, and why

Only what applies to every session whatever its module: how to answer the owner, approvals and
money, git/CI/deploy safety, environment identity, worktrees and the machine, the mobile-app freeze
(and the two dormant mobile rules `tests/mobile-freeze.test.ts` pins there), the fits-the-screen,
square-edge and document-identity golden rules, the no-PITR warning, and the Monthly-Closing
source-of-truth golden rule, which the owner ordered "locked everywhere in the system".

`tests/module-memory.test.ts` refuses an AGENTS.md rule whose every cited code file belongs to a
business module — that rule belongs in the module. A rule that truly applies everywhere but cites
one module's code is listed, with its reason, in the test's `DELIBERATELY_GLOBAL`.

## After the change (2026-10-02)

| | After |
| --- | --- |
| Modules | 25, every one of the 121 `src/lib` domains owned |
| Notes filed | 1,064 of 1,064 — zero orphans (CI-enforced) |
| `AGENTS.md` | ~64 KB (was 113.7 KB); 117 rules moved into module files |
| Module memory on disk | ~400 KB, none of it loaded at startup |
| Largest module file | Monthly Closing, ~62 KB, loaded only when sales code is touched |

## Limits — say these plainly

🔴 **Plainly TO A SESSION, never to the owner.** Every limit below is a session's own problem to fix
and ship inside the PR it is already opening — the owner ruled on 2026-10-03, after one of these
reached his input box as "the Phoenix CRM notes file is full … your next CRM ruling cannot be
recorded until it's split": *"didn't you tell me no session will mention memory issue again"*. He is
right: module memory exists so he never thinks about memory capacity again, and that covers the
plumbing, not only the index. Each limit here already fails the required `validate` job, which is
where a session is meant to learn it. Never put one in a question, a `Next step:` line or a summary,
and never ask him to free space in `MEMORY.md`.

- A session that opens no module file AND whose words match no module's keywords gets nothing from
  that module. The AGENTS.md directory (§2.2) is the backstop: it lists every module and its file.
- The hook fails open and silent. If a module's memory has not appeared before you change it, open
  `.claude/rules/<module>.md` yourself.
- The first sort of 1,064 notes was done by eight Sonnet passes plus review; a note can sit in the
  wrong module. Moving it is one line in `assignments.json` and a rebuild.
- Claude Code updates can change how path-scoped rules load. `proof.mjs` is how you find out.
- 🔴 **THERE IS A THIRD LIMIT, AND IT IS THE SMALLEST OF ALL: THE INJECTED POINTER, 4,000 BYTES.**
  `renderPointer()` sends a module's title, its counts and the first bold span of each rule — so the
  pointer grows with the NUMBER of rules, not with the file. `tests/module-memory.test.ts` caps it,
  and the cap is **4,000 with the hard cliff at 4,500**, so a module goes over while there is still
  room for the rule in front of it. **Measured 2026-10-03:** `phoenix-crm` sat at **4,478 of 4,500**
  with 38 rules — 22 bytes of headroom, nothing warning anyone — and a real 39th rule took it to
  **4,518** and reddened the required `validate` job. Its FILE was at 70% of the 72,000-byte cap at
  the same moment, which is why a session reading only file sizes called the module "full at 4,478 of
  4,500 characters": it had read the pointer's number and the file's label. **The remedy is always to
  SPLIT the module, never to trim a rule** — `phoenix-crm` → `phoenix-crm` + `phoenix-crm-approvals`
  took the two pointers to 2,713 and 1,930, about forty rules of headroom each.
- 🔴 **TWO MORE SIZE LIMITS APPLY, AND THE SMALL ONE BITES FIRST.** `MODULE_FILE_MAX_BYTES` (72,000) caps
  the whole file; `tests/agents-long-hooks-cite-docs.test.ts` caps each **rule bullet** at
  `LONG_HOOK_BYTES` (1,200) unless that bullet names a `docs/<file>.md`. It measures every line
  starting `- ` inside the `rules:begin`/`rules:end` block, so a module file can sit at a third of its
  own cap while one bullet turns the required `validate` job red — which is how it was found, on
  #5169, by a session whose two new bullets were 1,243 and 1,376 bytes. **Relocate FIRST, trim
  second:** write the evidence into a `docs/` file, then cut the bullet to its cue plus that pointer.
  Trimming first destroys an account that exists nowhere else, while reading as a tidy-up. Every
  module file now carries this in its own header (generated by `build.mjs`), so a session adding a
  rule reads it before it writes one.
- 🔴 **ONLY A BULLET'S FIRST `**bold**` SPAN TRAVELS TO A SESSION THAT NEVER OPENS THE FILE.**
  `ruleHeadlines()` takes the first `**…**` match per bullet (`/\*\*(.+?)\*\*/`) for the hook's
  pointer, and nothing after it — so a boundary, an exception or a date written in a later bold
  clause of the same bullet is invisible to that session. Put the operative claim in the first span,
  and never let it state an absolute the rest of the bullet qualifies: that reads as the whole rule.
  🔴 **And do not reason about the pointer from the text's shape — run the extractor.** On 2026-10-03
  a correction to Phoenix CRM's Golden Rule #1 shipped carrying a sentence that called a mid-bullet
  clause "what a session sees in the pointer"; the pointer was in fact the bullet's opening headline
  all along, and a peer session caught it by running `ruleHeadlines()` over `origin/main`. The
  imperative it supported was right, the mechanism cited for it was not.
- 🔴 **THE TWO GATES PULL AGAINST EACH OTHER: SPLITTING A LONG BULLET GROWS THE POINTER, BECAUSE EACH
  NEW BULLET CONTRIBUTES ITS OWN HEADLINE.** Measured on the headroom pass of 2026-10-12, which split
  the ten longest rule bullets in the repo at their own clause boundaries (owner, 2026-10-12: *"raise
  the long-hook headroom by splitting the ten longest rules hooks"*): the 1,200-byte gate went from
  **52 long of 538 hooks (9.67%, one bullet of slack under its 10% ceiling) to 42 of 559 (7.51%, with
  thirteen)** — and the same 21 new bullets took `phoenix-crm` from 30 rules at 3,707 bytes to 37 at
  **4,303** and `sales-closing` from 31 at 3,699 to 36 at **4,114**, both over the 4,000 pointer
  margin, so both modules were SPLIT in the same PR (`phoenix-crm-visits`, `sales-closing-exports`),
  leaving them at 3,101 and 2,983. **So never shorten bullets without re-reading the pointers, and
  never answer a pointer that went over by re-joining the bullets** — the remedy for a pointer is
  always the module split, and the remedy for a long bullet is always its own clause boundaries.
  Nothing is reworded on either path: the split pass added line breaks only, proven by rebuilding
  every pre-existing bullet from the pieces, character for character (486 bullets before, 507 after).
  🔴 **And a split moves the SAFE half** — `sales-closing` kept every money and golden rule and gave up
  only the surfaces a closing is READ from, because a rule that decides a number must stay where the
  broad glob is.

## `AGENTS.md` — the full wording condensed out on 2026-10-08

AGENTS.md loads on every request and again after every compaction, so on 2026-10-08 these lines were shortened to their rule. Nothing was dropped: each block below is the wording as it stood, word for word, and the rule it carries is still in AGENTS.md. Search here for the evidence, the owner's words and the measurements behind a rule.

### Preamble — what this file holds

**This file auto-loads in full on every request, so it holds hooks only** — a hook is the rule plus
the one detail needed to obey it, never the evidence. **Adding a rule? If it belongs to ONE module,
it goes in that module's memory (`.claude/rules/<module>.md`, §2.2) — only a rule true everywhere
goes here — and the account goes in `docs/`, never here.** A section is the half that regrows and nothing gates
one: measure it before you add to it (`docs/memory-index-budget.md`). 🔴 **A session-level trap now
goes in [docs/agents-session-traps-clusters.md](docs/agents-session-traps-clusters.md), under its
cluster — never back into §2.1**, which the 2026-09-12 trim reduced to a pointer and a slug roster;
writing one here re-charges every request for it and the hook will never deliver it.

### §2.2 — A module-memory limit is never put to the owner

- 🔴 **A MODULE-MEMORY LIMIT IS NEVER PUT TO THE OWNER — IT IS THE SESSION'S TO FIX AND SHIP** (owner, 2026-10-03, after a session put "the Phoenix CRM notes file is full at 4,478 of 4,500 characters, so your next CRM ruling cannot be recorded until it's split" into his input box: *"didn't you tell me no session will mention memory issue again"*). Module memory exists so he never thinks about memory capacity again, and that promise covers the plumbing too. A pointer over its margin, a module file near its cap, an orphan note, a dead glob, a stale generated block, an inbox that will not settle: **split it, file it, rebuild it, and ship it inside the PR you are already opening** — never as a question, never in a `Next step:` line, never as a sentence in a summary, and **never as a request to free space in `MEMORY.md`**, which is not trimmed any more. Every one of those limits already fails the required `validate` job, so the SESSION is told and he is not. Account: `docs/module-memory.md`, "Limits".

### §2.2 — Module memory holds each module's rules and notes

- 🔒 **MODULE MEMORY HOLDS EACH MODULE'S RULES AND NOTES — `.claude/rules/<module>.md`, loaded BY CLAUDE CODE the moment a session reads a file of that module** (owner, 2026-10-02 — it ended the trim-and-forget cycle; proven: no file read → not loaded, another module's file → not loaded, this module's file → loaded). None of it costs a startup byte. Work that opens no file (a question, SQL, a shell `cat`) gets it from `.claude/hooks/module-memory-injector.mjs`, which matches the prompt, the command and table names. 🔴 **About to change a module and its memory has not appeared? Open `.claude/rules/<module>.md` yourself** — the hook fails open and silent.

### §2.2 — A new memory note and the fold

- **A new memory note still lands in the laptop index (`MEMORY.md`, under `## Inbox`), so every session sees it at once; the fold (`node scripts/module-memory/fold.mjs --apply`) files each note under its module in ONE PR and the inbox empties once that merges.** The note's `description` becomes its line in the module file — write it as the cue, and correct a wrong note at its `description` first. 🔴 **IT RUNS THREE TIMES A DAY — 09:00, 15:00 and 21:00 Cairo, not weekly** (owner, 2026-10-03). A run with nothing new opens NO PR, and only one fold PR is ever open at once, so the cadence costs no extra CI — it only shortens the wait before a note reaches its module.
