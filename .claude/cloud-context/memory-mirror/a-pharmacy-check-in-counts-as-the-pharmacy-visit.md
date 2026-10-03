---
name: a-pharmacy-check-in-counts-as-the-pharmacy-visit
description: "Owner 2026-10-03 - a pharmacy needs NO validation and its visit is logged normally (no plan, reason or approval); the pharmacy a doctor's visit names counts as a visit to it, filed as a SINGLE linked visit with no stock answers. 11 pharmacy visits were backfilled; migrations 20261003174346 and 20261003175653 are on staging AND production (applied at his word, 3 Oct)."
metadata:
  node_type: memory
  type: project
  originSessionId: fbbdd50a-d200-4237-9d36-d3cb6c146f50
  modified: 2026-10-03T16:24:49.965Z
---

On 2026-10-03 the owner reported Hassan Elsherbiny (Pedia, El Mahalla) "visited pharmacies and submitted them but they appear as not visited". Measured: **no rep had ever saved a `list_type = 'Pharmacy'` visit**. Reps typed the pharmacy's name as "pharmacy you took feedback from" on their doctor visits, and the pharmacy customers read "Not visited this month".

His three rulings that day:
1. *"consider this as a pharmacy visit and make it count everywhere … for him and for anyone who has his same situation."*
2. *"Pharmacies doesn't need a validation. Pharmacy don't need a validation. It is visit is logged normally."*
3. *"Make all their … pharmacies … appear in their accounts and the manager account. Then start fixing."*

**Data:** 11 pharmacy visits filed with `phoenix_crm_admin_enter_visit` (planned, by B-10, so no approval) — Hassan 3 (Afaf Samak, Nasser, Al Farouk), Khaled Saeid 1 (Makka), Radwa 3 (Mohamed Khaled, Al Barbary, Pyramids), Sara 4 (Tawheed Ashmoun, Mohamed El Attar, El Attar second branch, El Fayoumi). Four pharmacies were new and joined the reps' lists. `phoenix_crm_admin_remove_visit` undoes any one. Sara's two rows carry her typed spellings ('الفرع التاني ص العطار', 'ص.التوحيد') so her day reads 7 pharmacies, not 9. Pre-image of the name backfill: `phoenix_crm_backup_20261003.pharmacy_visits_before_name_backfill` (11 rows).

**Database:** `20261003174346` (the countable view treats every pharmacy as validated) and `20261003175653` (save_visit, `linked_from_visit_id`, the naming trigger) are on staging AND production. The owner first declined the staging apply of the second, then said "apply the pharmacy visit migration to staging and production" the same evening; it went in after a staging rehearsal.

**The code (PR #5257, branch `codex/pharmacy-visits`, worktree `_wt-pharmacy-visits`):** Add visit → Pharmacy visit; a pending pharmacy sits on his list; the named pharmacy on a doctor's visit becomes its own visit — a `single` visit with NO stock answers, so neither the manager's double visits nor Missing stock count twice; What the field heard reads doctors only. The five SQL report functions keep `validated_at is not null` deliberately (they draw AM/PM only). Rule: `.claude/rules/phoenix-crm.md`; account: `docs/agents-owner-rules.md`, "A pharmacy visit is logged normally". Related: [[a-phoenix-crm-validation-is-checked-against-google-maps-never-ireports360]].
