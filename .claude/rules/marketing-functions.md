---
paths:
  - "src/lib/marketing-functions/**"
  - "src/components/marketing-functions/**"
  - "app/**/{marketing-functions,marketing-feedback,marketing-field-feedback}/**"
  - "tests/marketing-functions*"
  - "supabase/migrations/*marketing_functions*"
---

# Module memory — Monthly Marketing Functions and the Marketing Field Visit Feedback

**Scope:** The Product Manager's Monthly Marketing Functions sheet (eight categories, Planned and Actual, mid-month and end-of-month status, submit and review) and the Marketing Field Visit Feedback form with its rep tracking, in the Group Product Manager's own wording and colours.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

- 🔒 **HER WORDING AND HER COLOURS ARE FINAL** (owner, 2026-11-10: "use her exact wording", "same colors same wording"). Every label, column head, category, remark and email sentence, and every category fill, comes from Dr. Rasha Sabry's own two files, kept in `src/lib/marketing-functions/vocabulary.ts`. The only change is the typo "Promotianal" → "Promotional". The screens, the Excel export and the tests all read that one file. Never restyle a band to the house palette or reword a label. The export keeps her layout and is exempt from the house document identity. Pinned by `tests/marketing-functions-vocabulary.test.ts`.
- 🔴 **PRODUCT MANAGERS ONLY FILL BOTH SHEETS** (owner, 2026-11-10). The Group Product Manager, the Marketing Manager, the CEO and the Super Admin read. The Group Product Manager, the Marketing Manager and the Super Admin stamp a submitted month Reviewed, which locks it, or reopen it. **The rep's own line National Sales Manager reads the signed FIELD FEEDBACK on his reps only, never the monthly sheet**, and the rep never sees either. A reader sees a form only once it is signed. Row narrowing lives in `scope.ts` and is applied in `service.ts`; the matrix grants only open the module. Pinned by `tests/marketing-functions-access.test.ts`.
- 🔴 **BELL ONLY, NEVER AN EMAIL.** A submitted month rings the author's direct manager, and a review or reopen rings the author (`notify.ts`, `marketing_functions.*` in `notifications/policy.ts`), inside `afterResponse`.
- **THE CLINIC COUNTS STAY AM · PM · PHARMACIES** — her "No. of visited clinics" is filled as separate AM and PM fields. A ride-along day prefills them through `visitCountBucket`, through `getDoubleVisitRows` with `doubleHrIds` (either partner slot or the companions) and `kpiOnly` — the figures are clinic counts, so only rows that count, a re-saved visit collapsed. Never add them into one number.
- **A RECURRING GAP IS AVERAGE OR POOR ON 2 OF THE LAST 3 SIGNED VISITS; A STRENGTH IS EXCELLENT OR GOOD ON THE LAST 2** (`tracking.ts`). Drafts never count. Pinned by `tests/marketing-functions-tracking.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
