---
paths:
  - "src/lib/{coaching,visual-aids}/**"
  - "src/components/{coaching,visual-aids}/**"
  - "app/**/{coaching,coaching-analytics,coaching-skills-survey,field-coaching,training-manager,visual-aids}/**"
  - "tests/*{coaching,visual-aid,training}*"
  - "supabase/migrations/*{coaching,visual_aid,training}*"
---

# Module memory — Coaching, training and visual aids

**Scope:** Field coaching and coaching analytics, the training manager, visual aids.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

_No module rules yet. Add one here, in the PR that teaches it._
- 🔒 **THE SFE MANAGER READS COACHING COMPANY-WIDE, AND THE ANALYTICS ARE BUILT FROM THE VIEWER'S OWN SCOPE** (owner, 2026-10-20). His seat sits on the Head Office line, so as a line role he saw no field coaching at all — he is in `coachingOversightRoles` now. A Product Manager reads his line like a Group Product Manager (`sameWorkforceLine`), never above or beside him. The rep comparison and filter options on both analytics pages and the API come from `scopeCoachingDirectoryForAccess`, never the unscoped directory. Pinned by `tests/coaching-access-scope.test.ts`, `tests/coaching-analytics.test.ts`, `tests/double-visit-downward-scope.test.ts`.
- 🔒 **THE 2026-09-29 PORTAL COACHING HIDE IS LIFTED (owner, 2026-10-24) — a Training Manager reads every coach's reports and the archived evaluations, predecessors included.** Salma Labib took over from Ahmed Elkawas and reads his 122 reports and 69 resigned-rep evaluations for reference. Field Coaching carries no coach lock, the export and analytics API no longer pin her to her own HR ID, and `/employee-portals/training-manager/field-coaching/archived` is her portal twin of `/coaching/archived`. The coaching tiles and catalog rows are back for every portal role; the sidebar rail keeps the owner's sheet ruling, so the pages are reached from the command-centre tiles and Cmd+K.
- 🔒 **STARS OF THE MONTH SKIPS A RESIGNED REP AND TAKES THE NEXT SCORE DOWN** (owner, 2026-10-24). The Training Manager card ranks the previous month's top three, and a rep whose status is resigned, terminated or not renewed is removed BEFORE the slice (`buildTopCoachingScores`'s `excludeHrIds`), so the card still shows three names. The page reads the directory with `includeInactive: true`, because the default read drops exactly those people. Pinned by `tests/coaching-stars-skip-resigned.test.ts`.
- 🔒 **TOP ACHIEVERS · PER LINE READS EACH LINE'S LATEST PUBLISHED MONTHLY CLOSING AND PRINTS THE MONTH** (owner, 2026-10-24). `getCompanyLineTopAchievers` ranks reps by the closing engine's figures (`loadAchievementRange`) for the newest published period of that line, never from the portal sales records or a rolling window; the card prints the month beside each line. Pure ranking: `src/lib/employee-portal/line-top-achievers.ts`. Pinned by `tests/line-top-achievers-closing.test.ts`.
- 🔒 **THE TEAM COACHING SKILLS SURVEY IS NEVER SHOWN TO THE PERSON RATED** (owner and Salma Labib, Training Manager, 2026-10-31). The District Manager rates his own Medical Reps once a quarter, editable until the quarter ends; the Regional and National Sales Managers read their chain; the Training Manager, SFE Manager, CEO and Super Admin read the company; only the Training Manager and the Super Admin change the settings and the skills. `isSkillsSurveySubject` is asked before any role, a rep's own pages never carry the survey, and nothing in it sends an email, a bell or a Telegram. Every word is the workbook's (`src/lib/coaching/skills-survey/vocabulary.ts`), every figure its formula (`calculations.ts`). Pinned by `tests/coaching-skills-survey-access.test.ts`, `-calculations` and `-vocabulary`.
- 🔒 **THE OLD COACHING FORM TAKES NO NEW REPORTS — the Team Coaching Skills Survey replaced it** (owner, 2026-10-31). `createDraftCoachingReport` and `commitCoachingImport` call `refuseOldCoachingFormCreate()` first and the routes answer 410 `retired`; `/coaching/new`, `/coaching/import` and the Training Manager's create page redirect to the survey. The 122 old reports, acknowledging one, the archive, the analytics and Stars of the month keep working. Years in Role is `employees.total_experience_years`, copied onto the survey when it is saved: HR fills it on the Employee Master, AND the team member's own District Manager may fill or correct it on the survey form (owner, 2026-10-31: "make hr or dm can fill years of experience of the rep") — `saveSkillsSurvey` writes it only after `canRateSkillsSurveyMember`, and the form sends it only when changed, pinned by `tests/coaching-skills-survey-access.test.ts`. Pinned by `tests/coaching-old-form-retired.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (3)

- `coaching-analytics-shared-dashboard` — Coaching analytics is ONE shared component (3 surfaces); rebuilt as a corporate-report layout in PR
- `coaching-dates-legitimately-predate-the-hire-date` — OWNER RULED 2026-09-01: trust the hire date. 13 coaching reports dated before their rep's hire_date are CORRECT on both sides — never 'fix' either the coaching date or the hire date.
- `product-and-medical-knowledge-belong-to-the-product-manager` — GOLDEN RULE — product and medical knowledge (training, testing, key messages, diseases) is the Product Manager's job, never the Training Manager's.
<!-- module-memory:notes:end -->
