---
paths:
  - "src/lib/double-visit-analytics/service.ts"
  - "tests/private-calendar-double-visit-days*"
---

# Module memory — Field CRM — the double-visit focus panel on a manager's home

**Scope:** The double-visit panel on a District Manager's and a National Sales Manager's home: whose days it reads, the field set it leaves out, and the settled weeks it counts from a copy up to an hour old.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

Moved out of `crm` on 3 Nov 2026 so its injected pointer stays under the 4,000-byte margin
`tests/module-memory.test.ts` enforces (4,078 bytes with the settled-weeks rule). **`crm` keeps every glob it had**, so a
session working on these files loads BOTH files — nothing that used to arrive stopped arriving.

- 🔴 **THE PORTAL DOUBLE-VISIT FOCUS PANEL READS ONLY THE DAYS ITS OWN PEOPLE VISITED — NEVER EVERY DOUBLE VISIT SINCE JANUARY** (28 Oct 2026, "now fix the double-visit read"). Its people are the viewer plus the probationers it shows (the first 8 by days remaining, sliced BEFORE the read; 9 people at most, `DOUBLE_VISIT_FOCUS_MAX_PEOPLE`); `findDoubleVisitFocusDays` finds their days with no day cap, and `readListedDayRuns` reads those whole days in runs of 7, four at a time, sorted back to id order. Never cap it at 31 days, never send all days in one request (the URL limit answers an empty set silently), never drop the sort. 163,189 buffers became 58,331 for a manager alone, about 159,000 at worst. Pinned by `tests/private-calendar-double-visit-days.test.ts`. Account: `docs/crm-double-visit-focus-read.md`.
- 🔴 **THE FOCUS PANEL ALONE LEAVES THE PHOENIX FIELD SET OUT OF ITS READ (`withoutVisitDetail`) — THE REPORT PRINTS THOSE COLUMNS THROUGH THE SAME LOADER** (2 Nov 2026, "fix the portal home slow opens"). The panel only counts, and the field set was more than half of each request's bytes on every manager's landing (494 KB against 219 KB for one week; the whole open fell from 11.3 MB to 6.1 MB). `tests/portal-home-card-reads.test.ts` pins that exactly one caller passes it and that the tallies never read `phoenix_detail`. Account: `docs/crm-double-visit-focus-read.md`.
- 🔴 **THE FOCUS PANEL ALONE COUNTS WEEKS MORE THAN 7 DAYS OLD FROM A COPY UP TO AN HOUR OLD; THE LAST 7 DAYS ARE ALWAYS LIVE** (owner, 3 Nov 2026, "fix the manager's double-visit panel on the home", then "Yes, one hour is fine"). The hour is his word: never widen it, and never pass `shareSettledWeeks` from another reader, because the report, the private calendar and the scoring engine read this loader live. Credit is still decided on every open from that open's identity overrides and directory, so only the visits can be an hour old. An empty or failed week is never kept. A first open after a deploy or an expired hour still pays the read. Pinned by `tests/private-calendar-double-visit-days.test.ts` and `tests/shared-read-cache.test.ts`. Account: `docs/crm-double-visit-focus-read.md`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
