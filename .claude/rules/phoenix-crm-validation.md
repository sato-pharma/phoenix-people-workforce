---
paths:
  - "src/lib/phoenix-crm/{signboard-rules,validation-feedback,duplicate-merge-rules,validation-review-filters}.ts"
  - "src/lib/phoenix-crm/server/{signboard-check,signboard-sweep,validation-reviews}.ts"
  - "src/components/phoenix-crm/{refusal-reason-field,reopened-customer-list,validated-place-list,validation-review-queue,validation-reviews-board}.tsx"
  - "app/**/field-crm/validation-reviews/**"
  - "scripts/phoenix-crm-merge-same-seat-duplicates.ts"
  - "tests/phoenix-crm-{signboard-check,capture-trust-place,validation-feedback,place-brick-lookup,duplicate-merge,refuse-validation,validation-review-filters,place-checks-in-overflow}*"
---

# Module memory — Phoenix CRM — validating a place: the signboard, the refusal, the merge

**Scope:** What turns a captured place into a validated one — the signboard read, capture trust, the Place checks page, the closed refusal reasons the rep is told, the customers waiting to be captured again, the validate-first order, the brick lookup and the same-seat duplicate merge.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

_No module rules yet. Add one here, in the PR that teaches it._
- 🔒 **A VALIDATED PLACE NEEDS THE CUSTOMER'S NAME ON ITS SIGNBOARD, AND A PERSON'S NAME IS NEVER READ ON AN AM PHOTO** (owner, 2026-10-08: "require the customer's name always" and "NEVER A PERSON AM SIGN / PM SIGN"). The old check validated a LOCATION; he grades an IDENTIFICATION. `judgeSignboard` (`signboard-rules.ts`): a confident "no signboard" holds on either list; AM reads place names only; PM must name the person. 🔴 **`unjudged` NEVER holds** (no key, a failed call, an unreadable sign) — the key has run dry silently twice. Pharmacies are never read. Pinned by `tests/phoenix-crm-signboard-check.test.ts`. Account: `docs/phoenix-crm-validation-feedback.md`.
- 🔒 **A REFUSAL TELLS THE REP WHAT IS WRONG WITH HIS PHOTO, FROM SIX FIXED REASONS, AND NEVER WHO REFUSED** (owner, 2026-10-08). `VALIDATION_REFUSAL_REASONS` (`validation-feedback.ts`) is closed; the free note stays the record's. The notice `phoenix_crm.validation_not_confirmed` is in-app and Telegram only, push-blocked, never email; the system's sentence says "this place". Pinned by `tests/phoenix-crm-validation-feedback.test.ts`, `tests/phoenix-crm-refuse-validation.test.ts`, `tests/phoenix-crm-email-block.test.ts`.
- 🔴 **A ROW SHOWS "Validate again" OR "Not validated yet", NEVER BOTH** — the pill and title come from `google-place-rules.ts`; `list-customer.tsx` once hard-coded the first and showed the pair one under the other.
- 🔴 **THE LIVE "TO VALIDATE" ORDER IS `validateFirstIn`, NOT `rankValidateNext`** — capture-again customers first (oldest reopening first, rose), then visits-waiting-first. `rankValidateNext` has no caller in `src/` or `app/`; changing it changes nothing a rep sees. Pinned by `tests/phoenix-crm-validate-next.test.ts`.
- 🔴 **THE PLACE CHECKS PAGE READS EVERY ROW, PAGED** — 598 of 643 validated places had never been looked at when it showed a capped slice (2026-10-08). Every read goes through `readEveryPage` / `selectByIds`; `capped` tells the board when a read hit its ceiling. Pinned by `tests/phoenix-crm-place-checks-in-overflow.test.ts`.
- 🔒 **THE SAME-SEAT DUPLICATE MERGE ARCHIVES THE LOSER, NEVER DELETES IT, AND RUNS DRY BY DEFAULT** — a deleted reference row is re-minted. `scripts/phoenix-crm-merge-same-seat-duplicates.ts` writes a report, a plan and a pre-image; `--apply` needs all three and an actor, and `phoenix_crm_merge_duplicate_customer` re-checks every guard under the seat's lock. The keeper keeps every place. A bulk production change: announce it first. Pinned by `tests/phoenix-crm-duplicate-merge.test.ts`.
- 🔴 **THE SIGNBOARD READ CROPS THE EVIDENCE STAMP OFF FIRST, FROM `drawStamp`'s OWN ARITHMETIC** (`stampBandFraction`), or the model reads the stamp's customer name and calls it a match. `brick_lookup` records whether a place found a brick, found none nearby, or could not look. Pinned by `tests/phoenix-crm-place-brick-lookup.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
