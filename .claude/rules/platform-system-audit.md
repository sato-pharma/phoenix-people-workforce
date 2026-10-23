---
paths:
  - "src/lib/system-audit/**"
  - "src/lib/error-monitor/{screen-capture,screen-capture-rules,screen-intake,user-error-screens,capture-screenshot,screenshot-intake,screenshot-ticket}.ts"
  - "src/components/admin/system-audit/**"
  - "app/**/system-audit/**"
  - "app/api/errors/{screen,client/screenshot}/**"
  - "scripts/system-audit-*"
  - "tests/*{system-audit,user-error-screens,error-screenshot}*"
  - "supabase/migrations/*{system_audit,user_error_screens,app_error_events_screenshot}*"
---

# Module memory — Platform — the System Audit board, its daily message and the error screenshots

**Scope:** The Super-Admin System Audit board and its ledger, the nightly sweep and its one daily message, where the board starts, and the two pictures of what a person saw — the crash screenshot and the block screenshot — who may see them and how long they are kept.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

- 🔴 **THE SYSTEM AUDIT DAILY MESSAGE IS NEVER RE-ASKED THE SAME CAIRO DAY, AND `--apply` NEVER MARKS A LIVE FINDING AS TOLD** (23 Oct 2026). A re-run of `/api/cron/system-audit-sweep` reads `system-audit-daily:<day>:<HR ID>` first and skips anyone already told: the idempotency key stops the second delivery but the refused call still rewrites the stored notice the in-app bell shows (the 10:56 365-issue message became "3 issues" at 11:53). The historical `--apply` marks only the issues IT made waiting; one already waiting before the run stays for the next message. Never "simplify" either back. Account: `docs/system-audit.md`; pinned by `tests/system-audit-daily-message.test.ts` and `tests/system-audit-historical-runner.test.ts`.
- 🔒 **EVERY BLOCK OR FAILED REQUEST A PERSON MEETS LEAVES A SCREENSHOT — SHOWN AS-IS TO THE SUPER ADMIN ONLY, KEPT 90 DAYS** (owner, 23 Oct 2026). `screen-capture.ts` wraps `window.fetch` once, production builds only: a same-origin `/api/` 4xx is a refused request, a 5xx or no answer a failed one; a crash is photographed by #6358's crash screenshot instead, never twice. Never blur it, never show it to another seat, and never put a request a person made on purpose on `SCREEN_CAPTURE_SKIP_LIST` (it holds the capture's own path, sign-in and background polls only). The 90-day removal runs in the nightly System Audit sweep (`user_screens`), never a cron of its own. 🔴 **The crash pictures' 90 days are kept the same way: `pruneOldAppErrorEvents` removes each expired row's `error-screenshots` object FIRST, then the row** — deleting rows by age alone orphaned every picture in the private bucket for ever (review of #6358, 23 Oct 2026). 🔴 **Both captures keep the freeze guards** — `SCREEN_MAX_ELEMENTS`, the `onScreen` filter and the scroll-offset margin; html-to-image copies every kept node's computed styles on the main thread, and the timeout only stops WAITING, so a big page (the payroll grid, a CRM board) freezes the tab without them. Account: `docs/system-audit.md`, "What the person saw". Pinned by `tests/user-error-screens.test.ts`.
- 🔒 **THE CRASH SCREENSHOT IS UNMASKED, AND THAT WAS THE OWNER'S CHOICE** (owner, 23 Oct 2026 — *"the most important thing, I need a screenshot of the error appear to the employee"*, then "capture everything, mask nothing" when asked about payslips). The browser rasterises its own DOM AFTER the error UI paints, so the picture is the fallback card the employee is sitting in front of, not the torn tree behind it (`capture-screenshot.ts`; a page cannot photograph itself, so cross-origin images, iframes and tainted canvases are absent by construction — not defects to chase). Because nothing is masked, the `error-screenshots` bucket is PRIVATE and the drawer mints a five-minute signed URL per view against the viewer's own Super Admin session — never a URL rendered into the page. Do not add masking back without his word, and do not make the bucket public for any reason.
- 🔒 **THE SYSTEM AUDIT BOARD STARTS AT 23 OCT 2026 16:22 CAIRO AND ONLY GROWS FORWARD — THE HISTORY IS NOT REBUILT** (owner, 23 Oct 2026: *"I don't want old errors or issues. I want starting from when it reaches the live production, this is its start point. And when we're walking along"*). The 370 issues and 2,523 occurrences the historical seed had written were cleared that afternoon and the four time cursors in `system_audit_watermarks` (`app_error_fold`, `sync_runs`, `job_failures`, `visit_lifecycle`) fast-forwarded to `2026-10-23T13:22:38.477Z`, which is why the sweep does not re-fold them. 🔴 **That empty board is the intended state, not an incident to repair** — never re-run `scripts/system-audit-historical.ts --apply` over a past window, never rewind those cursors to recover the old rows, and never read a thin board as a broken detector. `app_error_events` keeps its own 90 days regardless; that table is the raw record, the board is only what has been folded since the start point.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
