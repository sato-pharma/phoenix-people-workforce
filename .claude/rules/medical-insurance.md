---
paths:
  - "src/lib/medical-insurance/**"
  - "src/components/medical-insurance/**"
  - "app/**/medical-insurance/**"
  - "tests/medical-insurance*"
  - "supabase/migrations/*medical_insurance*"
---

# Module memory — Medical Insurance (group policy, who is in and out, invoice against plan)

**Scope:** The group medical policy: who should be on it, the additions and deletions form, what a period should cost at the rate card, each uploaded invoice against that plan, and the communication tools, forms, policy and emails behind it.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

- 🔒 **EVERYONE BELONGS FROM DAY ONE, AND AN EXCEPTION BEATS THE RULE EITHER WAY** (owner, 2026-11-04: "everyone from day one but note that the policy started 1 nov and ofcourse i can make exceptions and full control"). An employee belongs from the later of their joining date and the policy's start until `employeeExitDay`, so someone serving notice stays covered until they go. The list decides nothing: a person acts on it.
- 🔴 **NO AMOUNT EVER REACHES AN HR SEAT** (owner, 2026-11-04: "The HR Operations seat can see and maintain members. Invoices stay with you."). `medical_insurance` is members, papers and the form, and both held seats have it through `medical_insurance_members`; every amount, the policy and the emails are `medical_insurance_invoices`, Super Admin only. `MedicalInsuranceView` carries no amount and `MedicalInsuranceMoneyView` is built only after the check. The HR Operations Specialist seat is salary-blind, so never add a figure to the first shape.
- 🔴 **THE CERTIFICATE IS THE GRAIN OF A COMPARISON.** The insurer bills a spouse and children inside the employee's certificate, so a family compares as one row. The report reprints a member's heading across a page break, so the parser merges by certificate; reading them apart gave 114 members and 16 problems on the first real bill instead of 106 and 0.
- 🔴 **THE RATE CARD IS PINNED TO THE FIRST BILL: EGP 306,122.04.** Fees and stamp are rounded per product, never on the grand total, and the issue fee and its nominal stamp land on the first statement only. `tests/medical-insurance.test.ts` holds every product line; a red pin there means the arithmetic moved, never that the pin is stale.
- 🔴 **PART OF A PERIOD IS CHARGED BY THE DAY, AND THAT IS AN ASSUMPTION.** The contract has no clause for a leaver's refund or a joiner's charge part-way through a period. The page says so beside the cost, and it stays an assumption until the insurer confirms in writing.
- 🔒 **IT SENDS NOTHING AND PAYS NOTHING.** The additions and deletions form is built and goes to the insurer by a person's hand; an invoice's difference is reported and never written to payroll or a deduction. Never wire mail to it without asking who receives it.
- 🔒 **A ROW IS NEVER DELETED.** Cover is ended with its reason and can be put back; an exception is revoked and stays; a document is taken off the page and its row and file stay. Ending an employee ends the family under them on the same day.
- 🔴 **NAMES AND NATIONAL IDS NEVER GO IN THE REPO.** The register is seeded once from the insurer's file by a local run, announced first as a bulk production write. The tests use invented names.
- 🔴 **THE BUCKET STAYS PRIVATE.** An invoice names every employee with their date of birth. Every read goes through a route that resolves the path from a row id; no caller names an object and no signed link reaches a browser.

<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
