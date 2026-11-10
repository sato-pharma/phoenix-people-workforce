---
paths:
  - "src/lib/marketing-requests/{crm-list-check,crm-doctor-pick,finance-ageing}*"
  - "src/components/marketing-requests/{list-check,marketing-list-check,not-on-crm-list,marketing-finance-ageing}*"
  - "app/**/{list-check,finance-ageing,marketing-list-check}/**"
  - "scripts/marketing-list-check*"
  - "tests/*{marketing-list-check,marketing-finance-ageing,marketing-crm-doctor-pick}*"
  - "supabase/migrations/*marketing_customer_list_checks*"
---

# Module memory — Marketing doctor-list check and Finance Ageing

**Scope:** Whether each validated marketing customer is on the rep's own Phoenix CRM list: the verdict, the approval flag and two photos, the hourly pass, the board and its answers. Also the Finance Ageing page of requests waiting at Finance Execution.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

- 🔒 **THE DOCTOR-LIST CHECK FLAGS AND NEVER BLOCKS, AND IT NEVER OVERWRITES A PERSON** (owner, 2026-10-27 and 2026-11-03). `crm-list-check-rules.ts` judges every validated customer against the rep's list of his area and line: same name within one letter, the right list, within 500 m. A person's answer beats a pick, a pick beats a re-check; a typed name changes only on a person's "same doctor". Nothing here writes to Phoenix CRM or refuses a save. Full wording: `docs/agents-owner-rules.md`, "The doctor-list check".
- 🔴 **ONE LETTER IS FOR A TYPING SLIP, NOT TWO NAMES** — `NEAR_TWIN_NAMES` refuses أحمد/محمد and its kin. A different name counts only within 100 m (`DIFFERENT_NAME_SAME_PLACE_METRES`), because at 500 m almost every city customer has another doctor nearby. A brick speaks only when no distance can be read: 7.5 km apart in one brick read as proven before that.
- 🔴 **`crmListFlag` SAYS "TYPED BY HAND" ONLY ABOUT A NAME SOMEONE TYPED** — `crm_list_source = checked` has its own sentence, and `NotOnCrmListFlag`'s chip reads the flag through `crmListFlagChip`. A read of the check that fails falls back to the stored status: an approval window always opens.
- 🔴 **THE FIRST `scripts/marketing-list-check.ts --apply` WAITS FOR THE DEPLOY, AND THE HOURLY CRON FOR THE APPLY** — the old code prints "typed by hand" on any `not_on_list` row, and a pass before the apply skips his seeded answers. A nursery name (`حضان`) stays a person's question; his 2026-10-27 "leave for now" on those rows stands. The guard reads the pre-image through Postgres (`SUPABASE_DB_URL`), because the API exposes no dated schema, and refuses if any customer is missing from it; a re-run never overwrites an answer given since (`decided_state` null only).
- 🔴 **ONE ANSWER PER CUSTOMER, AND ONLY HIS NEWEST PASS SPEAKS** — `listCheckSpokesmanIndex` picks the one line that writes his own three columns, or two lines would flip him every hour and undo a person's "same doctor". `currentListCheckRows` keeps a row left behind by an older pass off the flag and the board; a pass deletes such a row only when nobody answered on it. A marketing read takes a line's name by join (`line:lines(name)`): it may not read the shared reference list, and `tests/performance-phase-3.test.ts` refuses a new read of `lines`.
- 🔴 **THE MARKETING MANAGER IS A PORTAL ROLE** — `app/(admin)/layout.tsx` sends him away before an admin page runs, so the board has its own `/employee-portals/marketing-requests/list-check` and a rule in `portal-twins.ts`. A predicate that admits him proves nothing about the door.
- 🔴 **THE DOCTOR-LIST BOARD IS ESTIMATED COST ON APPROVED REQUESTS, NEVER SALES, AND A DOCTOR'S OBJECTION STOPS AT THE MANAGERS** — readers `canReadListCheckBoard`, answers `canDecideListCheck` (SFE Manager, Super Admin). `readsDoctorObjections` withholds the objection from the Marketing Manager on the server, in the sheet too.
- 🔴 **FINANCE AGEING HAS NO EXECUTE CONTROL AND THREE READERS** (`canViewMarketingFinanceAgeing`: Super Admin, CEO, Finance Manager), never through `canAccessMarketingAdminPage`, which admits the workflow roles. A held request never appears there. A row with no recorded opening reads "about".
- 🔴 **THE REPS LIST READS THIS CHECK'S LINK** — `phoenix_crm_customer_id`, set by a pick or by this check, is what puts a request on its doctor's Reps List row (`src/lib/crm/contact-trade.ts`, 2026-11-10). A customer left at `check` waits for a person's answer on the board and shows on the Reps List only by a name match until then.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
