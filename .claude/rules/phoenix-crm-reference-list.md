---
paths:
  - "src/lib/phoenix-crm/server/{list,visits,missed-records}.ts"
  - "app/api/phoenix-crm/list/route.ts"
  - "app/api/phoenix-crm/visits/form/**"
  - "supabase/migrations/*{seat_reference,add_path,name_row}*"
  - "tests/phoenix-crm-{add-path-name-row,board-reads,doctor-once,reference-mint-throttle}*"
---

# Module memory — Phoenix CRM — the reference list: the seat's customers and the mint that keeps them current

**Scope:** Which customers a rep's seat carries by right (phoenix_crm_seat_reference), how a doctor he added himself is matched and named, and when the reference mint runs — the List, Add Visit and the planners through the five-minute throttle, missed records every time.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

Moved out of `phoenix-crm` on 2 Nov 2026 so its injected pointer stays under the 4,000-byte margin
`tests/module-memory.test.ts` enforces (it stood at 3,964 bytes with 33 rules). **`phoenix-crm` keeps every
glob it had**, so a session working on these files loads BOTH files — nothing that used to arrive stopped arriving.

- 🔴 **A DOCTOR A REP ADDED HIMSELF IS FOUND BY HIS OWN ID — `phoenix_crm_seat_reference` MATCHES A CUSTOMER ON `reference_contact_crm_id` OR, WHEN THAT IS NULL, `own_contact_crm_id`** (owner, 2026-10-12: "stop a rep adding a doctor who is already on his list"). The refresh lists such a doctor under his OWN id, the old lookup used the vendor id alone and returned NULL, and `phoenix_crm_ensure_reference_customers` — which runs on every read — minted a pending copy for every NULL. The REP never made the second row. 🔴 **A new reader of the reference list matches on `coalesce(reference_contact_crm_id, own_contact_crm_id)`, never on the vendor id alone**; `phoenix_crm_customers_no_double_add` (insert trigger) refuses the copy as `doctor_already_on_list`. Existing pairs are untouched. Account: `docs/phoenix-crm-switchover-2026-10.md`, "A doctor the system added twice". 🔴 **The function joins its customers on ONE key (`seat_customer.seat_key` = `seat_id || '|' || contact id`), never on two columns** (23 Oct 2026): written as `seat_id = … and contact_crm_id = …` the planner merge-joined on `seat_id` alone and discarded 1.78 million pairs by join filter (803 ms for 111 seats, 504 ms after). Pinned by `tests/phoenix-crm-doctor-once.test.ts`.
- 🔴 **THE ADD PATH WRITES THE DOCTOR'S `crm_contacts` NAME ROW ITSELF, BYTE-IDENTICALLY TO THE HOURLY REFRESH'S NAME-ROW PASS** (production, 2026-10-15; before it a doctor a rep added waited a mean of 312 s for it). Six functions insert into `phoenix_crm_customers`, so the rule is a TRIGGER — `phoenix_crm_customers_write_contact_name_row`, `after insert or update of status, name, speciality, phone`, carrying the refresh pass's own filter (`not is_test`, status active/pending/dropped, so `outside` writes nothing) plus `reference_contact_crm_id is null`: a reference customer's name row already exists, and upserting onto it would make a list read wait on a row lock the refresh holds. 🔴 **The trigger and that pass MOVE TOGETHER** — same key `coalesce(reference_contact_crm_id, own_contact_crm_id)`, same `'phoenix'`, same `least(created_at in Cairo, today)`, same conflict arm — Phoenix's value wins, a blank never erases one (`20261022163200`) — so the next refresh changes nothing about him. `20261015135844`, pinned by `tests/phoenix-crm-add-path-name-row.test.ts`; account `docs/phoenix-crm-switchover-2026-10.md`.
- 🔴 **THE LIST AND ADD VISIT MINT THROUGH THE PLANNERS' FIVE-MINUTE THROTTLE (`ensureReferenceCustomersRecently`), NEVER ON EVERY READ — ONLY MISSED RECORDS STILL MINTS EVERY TIME** (1 Nov 2026, the speed root cause: a production read costs ~450 ms at Supabase's edge for 2–7 ms of SQL, and the two screens a rep opens most each paid the `phoenix_crm_ensure_reference_customers` RPC before their first read). A seat minted inside `REFERENCE_MINT_FRESH_MS` answers a settled promise so the customer read starts at once; the first open still mints first; a running mint is joined, a failed one is never remembered; an app write that changes what a mint finds calls `forgetReferenceMints`. Missed records looks for exactly what a mint would add, so it stays unthrottled. Pinned by `tests/phoenix-crm-reference-mint-throttle.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
