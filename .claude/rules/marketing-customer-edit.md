---
paths:
  - "src/lib/marketing-requests/customer-edit*"
  - "src/components/marketing-requests/customer-edit-panel*"
  - "app/api/marketing-requests/validated-customers/*/edit/**"
  - "app/api/marketing-requests/validated-customers/*/pharmacies/**"
  - "tests/marketing-customer-edit*"
---

# Module memory — Editing a marketing customer on file, and find-before-create on Save Validation

**Scope:** The Super Admin's Edit on Customer Check (name, speciality, phone, add a pharmacy by distributor code, remove one with a reason) and Save Validation attaching a pharmacy or CRM doctor already on file instead of copying it.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

- 🔴 **SAVE VALIDATION FINDS BEFORE IT CREATES, AND A CUSTOMER ON FILE IS CHANGED ON CUSTOMER CHECK, NEVER BY SAVING IT AGAIN** (owner, 25 Nov 2026: "make the super admin able to open the customer and edit", after a second save copied Dr Othman El Shewehy and four Damietta pharmacies). A typed pharmacy whose every distributor code is held by ONE live venue the actor may reuse is attached, not copied (codes match without leading zeros, `distributorCodeMatchKey`); a desk save for a CRM doctor the employee already holds joins that customer, and so does a desk save that names him (`existingCustomerId`) with no capture of him (`isDeskAttachEntry`, 26 Nov: no re-stamped validation, no new contact). The Super Admin edits name, speciality and phone, adds a pharmacy by distributor code (the one on file, else a new one with its map pin) and removes one with a reason (links switched off, never deleted) — `src/lib/marketing-requests/customer-edit.ts`, through the same `createMarketingValidationRecord` with the server-only `attachPharmaciesOnly`, never read from a request. Pinned by `tests/marketing-customer-edit.test.ts`.
- 🔒 **THE NEW-PHARMACY CARD ON CUSTOMER VALIDATION IS CODE-FIRST** (owner, 26 Nov 2026: "It must be easier"). Distributor and code open the card; a code held by ONE venue on file offers "Use this pharmacy" (attach, never a second capture), two holders offer nothing; tapping a distributor suggestion fills an EMPTY name box only; "What is this?" is still asked, never answered for him (`tests/venue-type-must-be-asked.test.ts`). One match key for the card and the save: `src/lib/marketing-requests/pharmacy-code-first.ts`. Pinned by `tests/marketing-customer-edit.test.ts`.
- 🔒 **THE DOCTOR PICKER MARKS A DOCTOR ALREADY ON FILE** (owner, 26 Nov 2026). Each CRM doctor carries `onFile` (live, unmerged `marketing_customers` with his `phoenix_crm_customer_id`, read in `loadCrmDoctorsForArea`); whose copy counts is the employee the save writes for (the on-behalf person at the desk, else the rep). The list reads "already validated" or "on file for <name>"; once picked, the desk is told only his pharmacies are written (the join above), a rep saving his own doctor is WARNED his save makes a second copy (only the desk joins), and someone else's copy is plain information. `doctorOnFileMark`/`doctorOnFileNotice` in `src/lib/marketing-requests/crm-doctor-pick.ts`. Pinned by `tests/marketing-customer-edit.test.ts`.

<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
