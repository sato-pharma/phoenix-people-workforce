---
paths:
  - "src/lib/recruitment/job-posts/**"
  - "src/components/recruitment/job-post*"
  - "app/api/recruitment/job-posts/**"
  - "app/**/recruitment/job-posts/**"
  - "tests/recruitment-job-post*"
---

# Module memory — Job Posts and the careers page — the picture, the Publish press and the guard

**Scope:** The Job Posts page: titles, the drawn picture and its designs, the Publish press that makes one satopharma.com careers card, the Close press, the Arabic saved per title, and the guard of the careers page against open requisitions.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules
- 🔴 **THE JOB POST PICTURE IS THE LEFT, LARGER COLUMN AND IS SIZED FROM THE SCREEN'S HEIGHT, NEVER THE COLUMN'S WIDTH — A STICKY COLUMN TALLER THAN THE VIEWPORT PINS ONCE AND THEN SCROLLS AWAY** (owner, 2026-10-16: *"scrolling in job post page is frustrating"*, then *"make the post big in the screen"*). The picture is 4:5, so it takes its height from the viewport: `xl:h-[clamp(320px,calc(100vh-11rem),1350px)] xl:w-auto xl:max-w-full` in a sticky stage, with the controls (title, six designs, lists, areas) in the right column. Never hang its size on the column's width, and keep the 11rem reserve for the header and the buttons under it. Below `xl` the column stacks and the page scrolls. Pinned by `tests/recruitment-job-posts.test.ts`.
- 🔒 **ONLY A PERSON'S PRESS PUBLISHES A JOB TO THE CAREERS PAGE: ONE PRESS, ONE CARD, ONE AREA, SUPER ADMIN ONLY** (owner, 2026-11-03: he still presses publish). `publishJobCardToWebsite` (`src/lib/recruitment/job-posts/website.ts`) has one caller, `app/api/recruitment/job-posts/publish/route.ts`, pinned by `tests/recruitment-job-post-website.test.ts`: never a cron, an autopilot or a retry. The website answers 401, 422 `NO_APPLY_ROUTE` and 409 `ALREADY_OPEN`, so a repeat press is safe. The key is `SATO_WEBSITE_INTEGRATION_TOKEN` here and `PHOENIX_INTEGRATION_TOKEN` on the website's `api` service; blank refuses. Talent Acquisition builds and downloads, and sees the guard with no Close button. Nothing closes a card by itself: he has not ruled on it, and three live cards have no requisition.
- 🔴 **THE ARABIC ON A JOB TITLE IS TYPED BY A PERSON AND IS NOT PART OF A DRAFT** (`title_ar`, `description_ar`). The editor saves a whole row, so `toRow` must never carry them or a title save wipes them; `saveJobPostTitleArabic` is their own write, before the card is sent, so a refusal never costs the typing. No machine fill.
- 🔴 **THE CAREERS ROUTE LIST IN `website-cards.ts` IS A COPY OF THE WEBSITE'S `ROLE_ROUTES`, SAME ORDER, FIRST MATCH WINS.** It warns early; the website's 422 is the gate, so a drift shows as a refusal, never a card with no form. A new role changes both. The guard on the Job Posts page compares by ROLE, reads inside its own Suspense so a slow website never holds the builder, and a failed read says it could not check, never all clear.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (2)

- `a-careers-cards-english-title-routes-the-apply-form` — A satopharma.com careers card routes its Apply button to a Phoenix role by matching its ENGLISH TITLE, so the panel title must match the route regex — "District Sales Manager" fails /district\\s*manager/i and silently falls back to email
- `job-post-module-spec-before-build` — The job-post image module (recruitment, Super Admin + Talent Acquisition) as the owner specified it on 2026-10-15, before any code: title picker, saved duties/needs per title, 5 rendered templates, multi-area posts where one area = one rep, download = all-areas image AND one image per area, line name optional.
<!-- module-memory:notes:end -->
