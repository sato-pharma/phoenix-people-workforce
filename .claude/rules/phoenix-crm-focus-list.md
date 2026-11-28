---
paths:
  - "src/lib/phoenix-crm/focus-list-rules.ts"
  - "src/lib/phoenix-crm/server/focus-list.ts"
  - "src/components/phoenix-crm/focus-list-tab.tsx"
  - "app/api/phoenix-crm/focus/**"
  - "tests/phoenix-crm-focus-list*"
  - "supabase/migrations/*phoenix_crm_focus_list*"
---

# Module memory — Phoenix CRM — the Focus list

**Scope:** The PM customers a rep or his manager put in focus with a written reason, grouped by grade then brick; the manager's keep or return, and his tracking of how often, when and where each was visited in a From–To period.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

Every ruling below is the owner's of 2026-11-28 unless it says otherwise. Pinned by `tests/phoenix-crm-focus-list.test.ts`.

- **Focus is a MARK, never a move: the customer stays on the rep's normal list.** Only a PM customer (active or pending) can be pushed; one open row per customer (a unique index on `returned_at is null`), so a second push answers "already on the Focus list".
- **The reason is WRITTEN AND REQUIRED (3–500 letters); the pick beside it is OPTIONAL** — High potential · Writes a competitor · Key opinion leader · Growing prescriber · New prescriber · Other. An unknown pick is no pick, never a refusal. His words: "WRITTEN REQUIREED AND OPTIOANAL PICK".
- **A rep's push WAITS for his district manager, who keeps or returns it; a manager's own push is kept at once.** On a vacant chain the waiting notice goes to SFE, never to nobody. Either the rep or the district manager may return a customer ("Rep or District Manager").
- **The rep's tab shows NO visit counts, no tracking and no sign he is checked** (Golden rule #1, `.claude/rules/phoenix-crm.md`) — the service builds no period and no tracking in rep mode, and his notices name no visit or count.
- **The manager's tracking is COUNTS over a From–To period he picks, with NO target** ("HE HAVE FILTER AND CAN EASILY CHOOSE THE FROM TO PERIOD"): visits in the period, a per-field-week strip, the weekly average, and the last visit — day, when it was saved, kind, by whom, place, address and brick. Never a future day, never over a year; default the last four field weeks.
- **Who is told, never by email:** in-app, Telegram and push only (`phoenix-crm-email-block.test.ts` lists the four `focus_list_*` events); the actor is never told of his own step; a keep or return withdraws the waiting notice.
- **The table and the tracking read are the service role's alone** — RLS on, nothing granted to anon or authenticated, `phoenix_crm_focus_visits` revoked from PUBLIC; the route enforces the territory through `territoryForFocusPush` / `canDecideFocus` / `canReturnOwnFocus`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
