---
name: a-pharmacy-check-in-counts-as-the-pharmacy-visit
description: "Owner 2026-10-03 - a pharmacy needs NO validation and its visit is logged normally (no plan, reason or approval); the pharmacy a doctor's visit names counts as a visit to it, filed as a SINGLE linked visit with no stock answers; a rep ADDS a pharmacy by its name alone (List and Pharmacy visit, no photo, no approval, 20261003211501). Migrations 174346, 175653, 202903 and 211501 are on staging AND production."
metadata:
  node_type: memory
  type: project
  originSessionId: fbbdd50a-d200-4237-9d36-d3cb6c146f50
  modified: 2026-10-03T18:11:55.877Z
---

On 2026-10-03 the owner reported Hassan Elsherbiny (Pedia, El Mahalla) "visited pharmacies and submitted them but they appear as not visited". Measured: **no rep had ever saved a `list_type = 'Pharmacy'` visit**. Reps typed the pharmacy's name as "pharmacy you took feedback from" on their doctor visits, and the pharmacy customers read "Not visited this month".

His three rulings that day:
1. *"consider this as a pharmacy visit and make it count everywhere … for him and for anyone who has his same situation."*
2. *"Pharmacies doesn't need a validation. Pharmacy don't need a validation. It is visit is logged normally."*
3. *"Make all their … pharmacies … appear in their accounts and the manager account. Then start fixing."*

**Data:** 11 pharmacy visits filed with `phoenix_crm_admin_enter_visit` (planned, by B-10, so no approval) — Hassan 3 (Afaf Samak, Nasser, Al Farouk), Khaled Saeid 1 (Makka), Radwa 3 (Mohamed Khaled, Al Barbary, Pyramids), Sara 4 (Tawheed Ashmoun, Mohamed El Attar, El Attar second branch, El Fayoumi). Four pharmacies were new and joined the reps' lists. `phoenix_crm_admin_remove_visit` undoes any one. Sara's two rows carry her typed spellings ('الفرع التاني ص العطار', 'ص.التوحيد') so her day reads 7 pharmacies, not 9. Pre-image of the name backfill: `phoenix_crm_backup_20261003.pharmacy_visits_before_name_backfill` (11 rows).

**The deploy gap (filed the same evening, at his word):** the fix went live on production at 19:35 Cairo; five pharmacies named on doctor visits saved earlier in the afternoon got no pharmacy visit, and were filed the same way (`phoenix_crm_admin_enter_visit`, then `pharmacy_name` set to the rep's own spelling): Sara → وجدي سلام اشمون and أمانه اشمون; Mohamed Salem (D11) → التهامي and a new pending الرحمه; Hassan → محمد الحماقى. He chose Amana Ashmoun and Mohamed El Hamaky where the matcher said "new" (typed "ص.الامانه" and "محمود الحماقى").

**One box, two pharmacies (same evening, his ask "fix a doctor visit that names two pharmacies in one box"):** Mohamed Salem typed three boxes with the Arabic comma. `20261003202903` (on staging AND production, prosrc md5 `c0be4488…`) files one visit per name the caller sends in `linked_pharmacies`; the split is `splitNamedPharmacies` — never on "/" (the reps' "ص/") or "-" (a branch). Filed by hand that night: الكوانيني (from his 20:19 box), and the الوكيل visit renamed from "كوانيني ،الوكيل" to "الوكيل". His day still reads 6 for 5 because "كوانيني" and "الكوانيني" keep different keys (`pharmacyNameKey` keeps the article) — left alone on purpose.

**He adds a pharmacy himself (same night):** *"he can also add a pharmacy without any validation or without any approval"*. Pharmacy visit already listed every non-dropped pharmacy (576 of 579 on production are `pending`); what was missing was a way to add one. "Add a pharmacy" on the List and on Pharmacy visit takes the NAME only; `matchAddedPharmacy` matches the key exactly (on list → opened, Archive → refused, else added) and `phoenix_crm_add_pharmacy` (`20261003211501`, prosrc md5 `e3675bd9…`, staging AND production) adds it `pending` under a per-territory lock. Shipped in PR #5263 with the two-names fix.

**Database:** `20261003174346` (the countable view treats every pharmacy as validated) and `20261003175653` (save_visit, `linked_from_visit_id`, the naming trigger) are on staging AND production. The owner first declined the staging apply of the second, then said "apply the pharmacy visit migration to staging and production" the same evening; it went in after a staging rehearsal.

**The code (PR #5257, merged 3 Oct and live on production at 19:35 Cairo; its worktree and branch are retired):** Add visit → Pharmacy visit; a pending pharmacy sits on his list; the named pharmacy on a doctor's visit becomes its own visit — a `single` visit with NO stock answers, so neither the manager's double visits nor Missing stock count twice; What the field heard reads doctors only. The five SQL report functions keep `validated_at is not null` deliberately (they draw AM/PM only). Rule: `.claude/rules/phoenix-crm.md`; account: `docs/agents-owner-rules.md`, "A pharmacy visit is logged normally". Related: [[a-phoenix-crm-validation-is-checked-against-google-maps-never-ireports360]].
