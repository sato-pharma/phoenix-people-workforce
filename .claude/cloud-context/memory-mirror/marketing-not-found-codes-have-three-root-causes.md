---
name: marketing-not-found-codes-have-three-root-causes
description: "A not_found marketing pharmacy code is usually a WRONG DISTRIBUTOR or a PADDING mistake, not a bad code — chimipharm (and any thin-list distributor) can NEVER match, and a stale reference list is the third cause. Holds the diagnostic order and the reusable traps for placing a pharmacy: GPS>name>code but check for a reused coordinate, town≠markaz, a dead code is safe to retire, and moving a pharmacy's area does not hide it from the capturing rep."
metadata: 
  node_type: memory
  type: project
  originSessionId: 9f9d1d5e-92b5-4eaa-a238-ad2fc773fd35
  modified: 2026-09-26T03:11:40.222Z
---

Every `not_found` row in `marketing_pharmacy_distributor_codes` on prod was audited (2026-08-19..23). Almost
none were "the rep invented a code". **Three recurring causes, in order of frequency:**

1. **Wrong distributor picked, and some distributors can NEVER match.** `marketing_distributors` `chimipharm`
   has **ZERO rows in `marketing_pharmacy_code_references`**, so *every* code entered under it is
   automatically `not_found` regardless of correctness — re-activates only when a Chimipharm sale appears in
   a monthly upload. Same trap waits on any thin-list distributor (`egd 1002` 19 rows, `epda` 56, `mec` 141).
2. **POS zero-padding applied to a code that is NOT a POS code.** POS codes are 10-digit zero-padded
   ([[pos-pharmacy-codes-are-zero-padded]]); Ibn sina codes are exactly 6. Users pad an Ibn sina code to 10
   and file it under POS. **When a code is not_found, also try `ltrim(code,'0')` against the OTHER
   distributors, not only `lpad(code,10,'0')` against the same one.**
3. **The reference list is stale — the code is real, we just don't have it.** Confirmed by
   `master_match_kind = 'exact'` while `reference_status = 'not_found'` (the master resolver found it in
   `source_of_sales_customer_map` but the reference import lacks it). Repair = **`reference_status =
   'manual_approved'`**, which clears the block WITHOUT asserting a different shop — never invent a reference
   row. [[marketing-reference-list-is-a-point-in-time-import]]

**The capture gate is scoped to `not_found` ONLY** — `matched` and `manual_approved` both pass, so there is
never a need to invent a match to unblock someone. Retiring a dead code (`active = false`) also removes it
from the picker entirely, so a valid `manual_approved`/`matched` sibling code passes with no override reason.

## Placing a pharmacy — evidence in order of strength, with the traps

- **Captured GPS > name > code.** `marketing_pharmacies.captured_latitude/longitude/captured_address`
  (typically ±25 m) beats the name, which beats the code. 🔴 **`area_id` on that table is the SUBMITTER's
  coarse area, NOT the shop's** (286 of 309 NULL) — never read geography from it. The master resolver
  (`phx_resolve_marketing_pharmacy_codes`) does not run automatically —
  [[marketing-master-resolver-never-runs-automatically]].
- 🔴 **Uniqueness inside the GPS TOWN is the test, not how distinctive the name looks — and the town is the
  TOWN, not the markaz.** Read the reverse-geocoded locality literally: rival same-named rows usually sit in
  named VILLAGES of the same markaz, which the town label excludes. Markaz and town share a name in Egypt,
  and collapsing them is exactly what makes a shop look ambiguous.
- 🔴 **The GPS-beats-name rule has an exception: check whether the submitter reused ONE coordinate across
  several rows before trusting it.** A byte-identical point on two different shops means the GPS carries no
  per-shop information — "±25 m" describes the DEVICE, not the discipline. **Group a submitter's rows by
  rounded lat/lon before using GPS as the strongest evidence**; when a coordinate repeats, the name or code
  has to decide.
- **A code in NEITHER the master NOR the reference list, in any padding form, is a DEAD code — overwriting it
  destroys nothing, and the repair is to RETIRE it, not replace it.** A code sitting on TWO different
  pharmacies marks a copy-paste default rather than a real code.
- **A seed row's `marketing_customer_pharmacies` link can supply the geography the row itself lacks** — the
  linked customer often resolves to exactly one master row. Check that link before writing a seed row off.
- **Odd-looking round codes can be REAL master rows** (`PS 0001000000`, `PS 0001511111` are genuine) — verify
  against the master before assuming a placeholder matched spuriously. A true placeholder like `0000` is
  handled by the capture gate (it forces a written override reason), and **an active pharmacy needs at least
  one active code** — retiring its only code, even a placeholder, is a regression (it can no longer be put on
  a request).

## Duplicate pharmacies, area moves, and who to ask

- 🔴 **Before deactivating any duplicate pharmacy, compare the distributor codes on BOTH rows** — the record
  you delete may hold the better code, and the two are often under DIFFERENT distributors, so neither is
  wrong. **Repoint the good code** (`pharmacy_id` update, audit the old id) rather than stranding it on a dead
  record.
- 🔴 **Moving a pharmacy's `area_id` does NOT hide it from the rep who captured it** — `canReuseMarketingPharmacy`
  branch 1 keeps it visible via `owner_hr_id` (even a DSM who owns rows outside her own seat area). The area
  move only changes which OTHER territory's reps additionally see it. Check `owner_hr_id` before fearing an
  area change hides a shop.
- **Two neighbouring shops legitimately end up in different areas** — a town can straddle two bricks in the
  master (the code-wins rule then puts them in different areas, ~80 m apart). That split is pre-existing; do
  NOT "tidy" it.
- **The route to who calls on a doctor is `ireports360_visits`** (`agent_hr_id` against `contact_name`) — the
  CRM knows even when marketing owns nothing (155 of 175 active `marketing_customers` have no owner, and seed
  rows carry `owner/manager/line/area` all NULL). 🔴 **Owner ruled: do NOT contact these reps.** The lookup
  is a diagnostic, not a licence to act.
- **Size the class before treating a fix as a bulk change** — these "problems" repeatedly turned out to be
  1–3 rows, not a bulk operation needing an §8 announcement. And **check `code.updated_at` against a
  pharmacy's deactivation time before blaming your own write** — a live-code-on-dead-pharmacy leak is often
  another session's, provable by the timestamp.

## The unprovable seed cohort

A residual set of `not_found` rows are **seed rows from the 2026-06-20 import** — `created_by_hr_id` NULL,
`evidence_status = 'missing'`, no GPS, no area, `pharmacy_code` set to the distributor code itself. Their
codes are absent from BOTH the master and the reference list under every distributor and every padding form
(the resolver's `fam` CTE maps POS→`PS,PS-T`, EGD→`EG,EG-BR,EG-HOS`, Ibn sina→`IS,IS-S,IS-T`, chimipharm→`CP`,
so it had a valid search space and genuinely found nothing — root causes 1–3 all ruled out). Each carries 0
requests, so it blocks nobody. `master_match_kind = 'unresolved'` and `reference_status = 'not_found'` are
DIFFERENT questions — an app-captured row with real GPS can be `unresolved` yet `matched` (in the reference
list, merely no sales history); do not lump it with the seeds. **Only new field evidence — a rep revisiting
with GPS — can ever close these; they are unprovable, not unexamined, so do not re-audit them from scratch.**
Areas were inferred from the linked customers so reps can at last see them, but the codes are unchanged — do
not read the areas as progress on the codes. A transfer to Direct Orders with an unresolved code reproduces
the حضانه النيل fault ([[marketing-transfer-writes-no-distributor-link-when-the-code-is-unresolved]]).
[[seeded-marketing-pharmacies-have-no-area-and-are-invisible]]
