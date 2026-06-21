# Playbook: Add a New DSM + New Region + Reporting Team

Use this whenever the org expands the line structure with a **new region** and a **new
District Sales Manager (DSM)** who has medical reps reporting to him (e.g. the
"Delta (3)" expansion of June 2026).

> **The one thing to understand first:** there are **two separate systems**, and a full
> expansion touches **both**. Creating one does **not** create the other.

| System | What it controls | Who changes it |
| --- | --- | --- |
| **A. Sales geography** (Source of Sales) | The regions sales roll up by — Delta (1)/(2)/(3), which governorates belong to each. Powers all sales dashboards. | **Engineering / a DB migration** (ask Claude). Not a UI task. |
| **B. Employee org structure** | Lines → Areas → Positions → **Seats (vacancies)** → Employees. Powers the employee master, org chart, approvals. | **You**, via **Employees → Import** (Excel). |

---

## Part A — Create the new SALES region (request a migration)

A new region + moving governorates into it is a **database migration**, not a screen.
Ask Claude/engineering with these inputs:

- **Region name** exactly as it should read, e.g. `Delta (3)`.
- **Which governorates** it contains, e.g. Sharkia, Suez, Ismailia, Qaluebya, Shoubra el Khema.
- **Carved from where**, e.g. Sharkia out of Delta (2), Qaluebya out of Delta (1), Suez out of "Others", Shoubra out of Cairo.
- **Effective date** — sales count under the new region from this date forward.

**Locked rules the migration must follow (don't break these):**
- **Forward-only** — past sales stay under their old region; only new uploads pick up the new region. History is never rewritten.
- **Brick = source of truth** — geography comes from the brick master; re-point the bricks, don't rename in reports.
- **Region name must match exactly** what employees will type in Part B (e.g. `Delta (3)`), or sales scope won't line up.
- Production runs an **older schema than staging** — the migration must be written against the **production** columns (prod has no `region_name` on areas/blocks/bricks). Apply **only that one migration** surgically; never `supabase db push` (production is many migrations behind and a push would apply unrelated changes).
- **Check where bricks currently live** — some territories (e.g. Shoubra el Khema) are mapped to a different region than expected (Shoubra was in Cairo / CA, not Qaluebya / D1). Always verify in the brick master before assuming.

*(References: D3 region in PR #447 / migration `20260621123000_delta3_region_carveout.sql`;
D33 Shoubra area in migration `20260622120000_d33_shoubra_carveout.sql`.)*

---

## Part B — Add the people (you do this, via Employee Import)

> ⚠️ The **manual add-employee form only fills an existing open seat**. For a brand-new
> team there is no seat yet, so the form shows nothing. **Use Import** — one upload
> creates the new Area *and* all the people with their reporting lines.

### Steps
1. **Employees → Export / Download template** to get the master Excel with the correct columns.
2. Add **one row per new person** and fill these columns:

   | Column | DSM row | Each Rep row |
   | --- | --- | --- |
   | **Employee ID** | the new HR_ID you assign | the new HR_ID you assign |
   | **Full Name** | DSM's name | rep's name |
   | **Department** | `Sales` | `Sales` |
   | **Line** | `Pedia` | `Pedia` |
   | **Area** | `Delta (3)` *(import creates it)* | `Delta (3)` |
   | **Position** | `District Sales Manager` | `Medical Representative` |
   | **Manager HR_ID** | the **RSM's** HR_ID | the **DSM's** HR_ID *(the one you assigned above)* |
   | **Region** | `Delta (3)` | `Delta (3)` |
   | **Hiring Date** | e.g. `2026-06-22` | same |
   | **Employment Status** | `active` | `active` |

   *(Email, salary, national ID, etc. are optional — blanks don't erase anything and can be added later.)*

3. **The reporting chain is built by the "Manager HR_ID" column:**
   - DSM's Manager HR_ID = the **RSM**.
   - Every rep's Manager HR_ID = the **DSM's** HR_ID.
4. **Upload** from **Employees → Import**. New HR_IDs create new **active** employees; the
   `Delta (3)` operating area is created automatically; valid rows apply and any blocked
   row is skipped (and reported).
5. **Verify** in the org chart / employee directory: the reps report to the DSM, the DSM
   reports to the RSM, all show Region `Delta (3)`.

### Copy-paste example (the actual Delta (3) team — June 2026)

The Pedia Delta (3) team has **1 DSM + 4 reps**:

| Employee ID | Full Name | Department | Line | Area | Position | Manager HR_ID | Region | Hiring Date | Employment Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `<DSM HR_ID>` | `<DSM name>` | Sales | Pedia | Delta (3) | District Sales Manager | `<RSM HR_ID>` | Delta (3) | 2026-06-22 | active |
| `<REP1 HR_ID>` | `<Rep 1 — Sharkia 1>` | Sales | Pedia | Delta (3) | Medical Representative | `<DSM HR_ID>` | Delta (3) | 2026-06-22 | active |
| `<REP2 HR_ID>` | `<Rep 2 — Sharkia 2>` | Sales | Pedia | Delta (3) | Medical Representative | `<DSM HR_ID>` | Delta (3) | 2026-06-22 | active |
| `<REP3 HR_ID>` | `<Rep 3 — Ismailia>` | Sales | Pedia | Delta (3) | Medical Representative | `<DSM HR_ID>` | Delta (3) | 2026-06-22 | active |
| `<REP4 HR_ID>` | `<Rep 4 — Shoubra el Khema + Shoubra Masr>` | Sales | Pedia | Delta (3) | Medical Representative | `<DSM HR_ID>` | Delta (3) | 2026-06-22 | active |

---

## Gotchas / checklist
- [ ] **Region text matches exactly** between Part A (sales) and Part B (employee Region column) — e.g. `Delta (3)`, including the parentheses.
- [ ] Position names match the system list exactly: `District Sales Manager`, `Medical Representative`.
- [ ] The DSM row comes with the **RSM's** real HR_ID; rep rows carry the **DSM's** HR_ID.
- [ ] Sales for the new region only appear **from the effective date forward** — if a file for that month was already imported before Part A, **re-import it**.
- [ ] No `sales_manager_region_scope` row is needed — sales scope auto-resolves from the employee's Region name.
- [ ] **Shoubra el Khema bricks are in Cairo (CA6), not Qaluebya (D11)** — always check the brick master; geography in the system doesn't always match Egypt's administrative governorate boundaries.

## Valid values reference (as of 2026-06)
- **Lines:** Anti infective, Pedia, CNS, Head Office
- **Key positions:** District Sales Manager, Regional Sales Manager, National Sales Manager, Medical Representative, Group Product Manager, Product Manager

## Delta (3) geography reference (as of 2026-06)
| Area code | Area name | Contains |
| --- | --- | --- |
| D11 | Qalubeya | Banha, Kafr Shokr, Tokh, Qanater, Sheben el Kanater, etc. |
| D24 | Sharkia 1 | 8 bricks — Rep 1 territory |
| D25 | Sharkia 2 | 8 bricks — Rep 2 territory |
| D31 | Suez | El Sewis (B122-12) only; South Sinai stays in Others |
| D32 | Ismailia | Placeholder — no bricks yet; populated as customers upload |
| D33 | Shoubra el Khema | 9 bricks carved from Cairo (CA6) — Rep 4 territory |
