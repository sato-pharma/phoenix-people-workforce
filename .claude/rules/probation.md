---
paths:
  - "src/lib/{probation,milestones}/**"
  - "src/components/{probation,milestones}/**"
  - "app/**/{probation,probation-settings,probation-tools,ceo-probation,milestones}/**"
  - "tests/*{probation,milestone}*"
  - "supabase/migrations/*{probation,milestone}*"
---

# Module memory — Probation and employee milestones

**Scope:** Probation tracking, the Day 30/60/75 milestone emails, probation settings, milestone cards.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

### Owner rules (moved from AGENTS.md §4)

- 🔒 **THE PROBATION DAY 30 / 60 / 75 EMAILS GO TO OMAR GAWISH (`B-10`) ALONE — no BCC, no CC** (owner, 2026-09-29 to Yasmeena Elsafory; changed 2026-10-20, "To you only", when she moved seats) — never the retired stakeholder fan-out. 🔴 **The dedup key still ends `:HR-009` and is FROZEN** (`PROBATION_MILESTONE_KEY_SUFFIX` names the milestone, not the recipient), and because a delivery is keyed per recipient the sweep SKIPS a key an earlier recipient already holds (`milestoneKeysToSend`, failing closed on a read error) — never "tidy" either away, or every due milestone is sent again. 🔴 **This does NOT re-open probation email: the `probation` policy stays `enabled = false`** (it still drives the legacy per-manager reminders); the milestones carry their own type, `probation_milestone`. An older memory reading "probation email stays OFF" is about that policy, not these three. Due = crossed AND still on probation, never a grace window and never past day 90. Account: `docs/agents-owner-rules.md`, "The probation Day 30 / 60 / 75 emails". `src/lib/probation/intelligence/milestone-emails.ts`, pinned by `tests/probation-milestone-emails.test.ts`.
- 🔴 **THE REP'S CARD EDITOR IS A COPY OF THE ADMIN ONE, SO ANY DRIFT BETWEEN THEM IS A DEFECT** — `my-milestones.tsx` (portal) duplicates the framing geometry of `milestones-workspace.tsx` (admin) deliberately, and its header claimed the two were pinned equal when nothing pinned the geometry at all. It had drifted in one token: `setZoom` fell through to `CENTRE` instead of `current ?? focusDefault ?? CENTRE`, so the first touch of the Zoom slider snapped the picture back to the middle and silently discarded the SERVER's resolved crop — the face-aware framing the printed card uses. Nothing failed and nothing logged. `FRAME_RATIO`, `MAX_ZOOM` and that fallback are now pinned in BOTH files by `tests/rep-milestones-portal.test.ts` (2026-10-03).
- 🔒 **THE REGIONAL SALES MANAGER'S DOUBLE VISIT WITH A PROBATION REP IS AN EVALUATION, COUNTED IN THE NSM BUCKET** (owner, 2026-10-20, multiple choice: *"Yes, count it like the NSM"*). `resolveEvaluatorRole` maps app role Regional Manager to `nsm`; no new evaluator role, no new requirement. The probation reminder list (`loadFeedbackAuthUsers`) was NOT widened — that is an email audience. Pinned by `tests/probation-dv-validation.test.ts`.
- 🔴 **`getProbationRows` IS READ ONCE PER REQUEST — `cache(loadProbationRows)` from React, and no caller may sort or edit its rows in place** (2026-10-26). The admin home called it twice in the same instant (the lifecycle-risk tiles and the Needs You `probation-decisions` row) and on a loaded minute both copies queued past the eight-second budget; the row went amber with every query under 132 ms. Never write it back as a plain `export async function`, never swap React `cache` for a module-level memo (that hands one viewer's list to the next), and never fix the amber row by raising the budget. Pinned by `tests/probation-rows-one-read-per-request.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (6)

- `hire-date-change-doubles-probation-reminders` — Correcting employees.hire_date re-keys every scheduled probation reminder, because notification_events.event_key embeds the DERIVED scheduled_for date - so the dedupe upsert inserts a fresh set while the stale rows stay pending, and the manager is asked to review the same person twice.
- `probation-email-controls-mod1-4` — Probation email controls (weekly digest, SLA ladder, daily cap, pre-send audit) — PR #1094 MERGED+LIVE 2026-07-17; emails still PAUSED, PHX-1 work_email unset
- `probation-module-is-field-force-only` — The probation Decision Intelligence module is MEDICAL-REPRESENTATIVES-ONLY (owner corrected 2026-07-17; NOT DMs/managers); fingerprint attendance is head-office-only and is NOT a probation input
- `probation-premerge-audit-fixes-2026-07` — Probation Decision Intelligence pre-merge adversarial audits (2 rounds) + 23 fixes; NOT merged; migrate-first; blocker was HR_ID casing
- `probation-scope-broader-than-generic-canseeemployee` — Do not thread access into applyDecisionSideEffects/resignEmployeeAndOpenVacancy for probation terminations — canReadProbationEmployee is deliberately broader than canSeeEmployee for PM/GPM/NSM/RM
- `probation-workflow-notification-line-leak` — Probation case-status in-app notifications leaked company-wide (206 rows -> 97 wrongly-notified people) via a broad department-scope governance match; fix MERGED+LIVE PR #1199 (commit 080e7dbe), historical backlog cleaned
<!-- module-memory:notes:end -->
