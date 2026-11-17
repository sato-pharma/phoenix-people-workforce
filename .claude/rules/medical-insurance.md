---
paths:
  - "src/lib/medical-insurance/**"
  - "src/components/medical-insurance/**"
  - "app/**/medical-insurance/**"
  - "tests/medical-insurance*"
  - "supabase/migrations/*medical_insurance*"
---

# Module memory — Medical Insurance (Libano-Suisse group policy, who is in and out, bill against plan)

**Scope:** The Libano-Suisse group medical policy: who should be on it, the insurer's member file for additions and deletions, what the year costs at the signed rate card, each bill against that plan, and the communication tools, forms, policy and emails behind it.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

- 🔒 **THE POLICY IS LIBANO-SUISSE TAKAFUL EGYPT, 15 NOVEMBER 2026 TO 14 NOVEMBER 2027** (owner, 2026-11-17: "build the Libano-Suisse medical insurance module", start "15 Nov 2026"). MetLife was cancelled and its module retired on 2026-11-11 (`docs/medical-insurance-retired.md`); this one was rebuilt on the same tables from the signed table of benefits and renewal offer Rev 1.3. Until Libano-Suisse issues a policy number the proposal code stands in, and the Cost tab sets the number.
- 🔒 **MEDICAL INSURANCE IS OPTIONAL: EVERYONE IS ASKED FOR FROM DAY ONE, AND SOMEONE WHO DOES NOT WANT IT IS EXCLUDED** (owner, 2026-11-04: "everyone from day one … and ofcourse i can make exceptions and full control"; 2026-11-17: "medical insurance is optional not required … make an option of exclude"). An employee belongs from the later of their joining date and the policy's start until `employeeExitDay`. Exclude is one press on the add list (a `keep_out` exception, reason "Does not want medical insurance") or, for someone on the register, an end on their first day with `keepOut`; the exceptions list reverses it. The list decides nothing: a person acts on it.
- 🔴 **THE CONTRACT'S AGE LIMITS ARE A REVIEW, NEVER A REMOVAL.** Over 64 (employee or spouse) needs a health statement and loses cover for conditions from before the policy; a child is covered to 18. The age is read on the day cover starts, and a missing date of birth is also listed, because nobody can be priced without one.
- 🔴 **NO AMOUNT EVER REACHES AN HR SEAT** (owner, 2026-11-04: "The HR Operations seat can see and maintain members. Invoices stay with you."). `medical_insurance` is members, papers and the member file, held by both HR seats through `medical_insurance_members`; every amount, the rate card, the policy number, the bills and the emails are `medical_insurance_invoices`, Super Admin only. `MedicalInsuranceView` carries no amount and `MedicalInsuranceMoneyView` is built only after the check.
- 🔴 **THE RATE CARD IS PINNED TO THE SIGNED OFFER: EGP 712,300 FOR 104 PEOPLE** (Plan A 234,645, B 172,339, C 305,316). The premium is annual, per person, by plan and five-year age band; each seeded rate is the band's printed total divided by its head count, and a band's total is rounded to the pound, so Plan A 55 to 59 prints 123,458, not 4 × 30,865. On top: 1.55% tax, EGP 30 a card per member, EGP 90 issue fee once. A band the offer did not quote is null and never priced at zero. `tests/medical-insurance.test.ts` reads the card from the migration itself.
- 🔴 **A JOINER PAYS BY THE DAY; FROM THE LAST QUARTER, 25% OF THE YEAR; A LEAVER IS REFUNDED BY THE DAY.** That much is the contract. What it does not say and the code assumes is listed on the Cost tab (`MEDICAL_INSURANCE_OPEN_POINTS`): the age is taken on the day cover starts, the 1.55% follows a joiner's charge and a leaver's refund, and the card fee is never refunded. They stay assumptions until Libano-Suisse confirms in writing.
- 🔒 **IT SENDS NOTHING AND PAYS NOTHING.** The member file is built for the people ticked on the add/remove screen and goes to the insurer by a person's hand; a bill's difference is reported and never written to payroll or a deduction. Never wire mail to it without asking who receives it.
- 🔴 **THE MEMBER FILE IS LIBANO-SUISSE'S OWN SHEET** — `LIBANO_MEMBER_FILE_HEADERS` are the 39 headings of their "Output draft" exactly, spacing and spelling included, one row per person (an employee's spouse and children each get a row), every cell text so '34-1' and '08042019' never become a number or a date. Dates are ddmmyyyy; Relation P, S or C; a 40th column carries the start day, or the last covered day for deletions.
- 🔴 **A BILL IS RECORDED BY HAND, NOT READ FROM ITS FILE.** Libano-Suisse's bill layout is not known yet, so its number, kind, dates and total are typed and the file is kept beside it. `compareInvoiceToPlan` holds an opening bill against the opening statement and an additions or deletions bill against the movements inside its dates; a day-one joiner belongs on the opening bill, never an endorsement.
- 🔴 **A JOINER'S PLAN IS DECIDED ON THE ADD/REMOVE SCREEN AND KEPT** (owner, 2026-11-04: "make me decide in the system"). `medical_insurance_category_choices` holds one decision per person per policy; `additionCategory()` is the one order (picked for the file, then the register, then the decision, then the job's suggestion). Never pick a plan for him: it sets what the person is entitled to and what it costs.
- 🔴 **A PERSON WITH NO EMPLOYEE RECORD CAN BE PUT UNDER AN EMPLOYEE AS THEIR SPOUSE OR CHILD, AND THEIR OWN FAMILY MOVE WITH THEM** (owner, 2026-11-17: "saeed and his family are family to dr anwar"). `planFamilyMove` is the one rule: only spouse or child (the insurer's sheet has no other letter), only under an open employee row, and an employee with their own record keeps their own certificate. The row is updated in place and the audit log keeps who they sat under before. An adult "child" stays on the age review: the contract covers children to 18.
- 🔒 **A ROW IS NEVER DELETED.** Cover is ended with its reason and can be put back; an exception is revoked and stays; a document is taken off the page and its row and file stay. Ending an employee ends the family under them on the same day.
- 🔴 **NAMES AND NATIONAL IDS NEVER GO IN THE REPO.** The register was seeded once from the insurer's Initial Draft by a local run, announced first as a bulk production write; the tests use invented names.
- 🔴 **THE BUCKET STAYS PRIVATE.** A bill names every employee with their date of birth. Every read goes through a route that resolves the path from a row id; no caller names an object and no signed link reaches a browser.

<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
