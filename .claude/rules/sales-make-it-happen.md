---
paths:
  - "src/lib/sales/make-it-happen/**"
  - "src/components/sales/make-it-happen/**"
  - "app/**/make-it-happen/**"
  - "tests/*make-it-happen*"
---

# Module memory — Make It Happen — the forecast planner, its team list and its Excel and PDF

**Scope:** The Make It Happen forecast: who plans which rows, the per-person team list, the per-brick forecast, and the Excel and PDF files — the brick tabs per District Manager, then per medical rep.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

🔴 **`sales-closing` KEEPS EVERY GLOB IT HAD, so a Make It Happen file loads the PAIR** — every money and golden rule (the closing is the only sales truth, units never added across products) stays THERE and still arrives. Make It Happen reads the closing; it never decides a closing number.

### Moved out of `sales-closing` on 2026-11-14 — the pointer split (see scripts/module-memory/modules.mjs)

- 🔴 **MAKE IT HAPPEN'S "YOUR TEAM" LISTS NO ONE WHO HAS LEFT UNLESS THEY HOLD A TARGET OR SALES IN THE SELECTED PERIOD ITSELF** (NSM report, 2026-10-26: nine of eighteen "No target" rows had resigned or declined their offer). The rep rows include the closed trend months that feed the pace, so `isListedOnTeam` (`make-it-happen/team-roster.ts`, over `isTerminalEmploymentStatus`) filters ONLY the per-person list and its counts — `lines`, `overall` and the pace still read every row. A Pedia row with no Sato product in scope reads "Sato · No target" (`teamRowSatoHalf`), never a bare meter. Pinned by `tests/make-it-happen.test.ts`.
- 🔴 **MAKE IT HAPPEN'S EXCEL HAS ONE TAB PER LEVEL — "District Managers", "Medical Reps", "Bricks" — NEVER ONE TAB PER MANAGER, NEVER ONE PRODUCT × BRICK LIST** (owner, 2026-11-14: first "per DSM … firstly then per MR not by brick name only", then "a tab called district managers and have his managers under it. Same for medical reps. Then for bricks … start from the big region … area brick"). District Managers: one row per manager per line (region, named reps, bricks, value). Medical Reps: one table per manager listing his reps (line, area, bricks, value). Bricks: per line a region table, then each region's areas, then each area's bricks — biggest level first. A level tab appears only when the file holds MORE THAN ONE of that level: a District Manager's own file has no District Managers tab, a rep's file only Bricks. `groupBricksByDistrict` / `groupBricksByRegion` (`make-it-happen/export-document.ts`) file each brick under the rep, area and region of the LATEST closed month it sold on that line, and each rep under the District Manager on his own latest row (`brickCover` / `repManager` / `areaRegion` in `workspace.ts`); no rep reads "Vacant seat", no manager "No District Manager", no place "No region" / "No area", a nameless area "Area not named". Every total is value; each tab adds up to the brick forecast exactly. A manager's name stands alone — a Regional Manager holding an area is never called a District Manager. Pinned by `tests/make-it-happen.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
