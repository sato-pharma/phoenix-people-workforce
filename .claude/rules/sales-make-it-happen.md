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
- 🔴 **MAKE IT HAPPEN'S EXCEL HAS ONE TAB PER LEVEL — "District Managers", "Medical Reps", "Bricks" — NEVER ONE TAB PER MANAGER, NEVER ONE PRODUCT × BRICK LIST** (owner, 2026-11-14: "a tab called district managers … Same for medical reps. Then for bricks … start from the big region … area brick"). Bricks runs region → area → brick. A level tab appears only when the file holds MORE THAN ONE of that level (a DM's own file has no District Managers tab; a rep's has Bricks only). `groupBricksByDistrict` / `groupBricksByRegion` (`export-document.ts`) file each brick under the rep, area and region of its LATEST closed month (`brickCover` / `repManager` / `areaRegion`, `workspace.ts`); empty buckets read "Vacant seat", "No District Manager", "No region", "No area". Every total is value and each tab adds up to the brick forecast. A manager's name stands alone, never "District Manager" after it. Pinned by `tests/make-it-happen.test.ts`.
- 🔴 **A REGIONAL MANAGER USES MAKE IT HAPPEN IN THE PORTAL, FOR HIS OWN REGION ONLY** (owner, 2026-11-14: "Yes, own region"). Nine roles now: the eight earlier ones plus Regional Manager, in MAKE_IT_HAPPEN_PORTAL_ROLES (scope.ts), showMakeItHappenTab (employee-portal/navigation.ts) and the portal row in system-navigation.ts. His bound is the sales scope's seat areas (vsTargetBoundFromSalesScope), so he sees his region's reps and bricks, never the whole line; a Regional Manager whose seat gives no areas reads nothing (fails closed). The CEO is still not a Make It Happen role. Pinned by tests/make-it-happen.test.ts.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
