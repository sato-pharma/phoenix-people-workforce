# Phase 5 — Automatic Monthly Closing (SoS → seat attribution)

Staging-only design. Project `cifwmndunmlxjhyjugxa` (Phoenix-HR-Staging). No production, no app cutover in this phase.

## Goal

Replace the **manual Sales Queue** (`sales_records`, uploaded from Excel) with an
**automatic** monthly attribution computed from the already-loaded Source-of-Sales
facts, driven by the new 42-area seat model (`au` schema). For each closed month,
attribute sales to **rep → DM → operational region → line**, including vacant
areas and the sales-only **"Other"** pseudo-DM, with an explicit **unmapped**
bucket (nothing silently dropped). Achievement % is **out of scope** here — it
needs targets, which are Phase 6.

## Source data (staging, verified 2026-07-13)

- `source_of_sales_fact_rollup` — 185,798 rows, periods **2026-01 … 2026-06**
  (4 `official_line` spellings → 3 lines; 43 `area_code` values = 42 canonical +
  one blank `''`). Columns used: `period, official_line, region_code, area_code,
  product_code, is_direct, effective_units, total_qty, direct_value, batch_id`.
- Only rows whose `batch_id` is a **validated** `source_of_sales_import_batches`
  count (mirrors the existing `phx_monthly_closing_*` RPCs).

## Mapping path (one SoS fact row → org)

1. `official_line` → `au.sos_official_line_map.line_code`
   (`CNS→cns`, `Pedia→pedia`, `Anti infective`/`Anti Inf→anti_infective`;
   **`Head Office` has no mapping → unmapped**).
2. `area_code` → `au.sos_area_crosswalk.canonical_area_code`
   (identity for all 42 today; **blank `''` → unmapped**).
3. `(line_code, canonical_area_code)` → `au.line_area_map` →
   `operational_region_code`, `area_state`, `other_type`, `rep_seat_id`,
   `dm_seat_id`, `carries_target`. **A (line,area) with no map row → unmapped.**
4. `rep_seat_id` / `dm_seat_id` → occupant via `au.occupancy_history`
   (see "as-of" rule). Vacant seat → occupant `null` (sales still attach to the
   seat/area/DM).

## Attribution rules (defaults — all mirror current system behaviour)

1. **Value basis (unchanged, so it reconciles):**
   - Indirect (`not is_direct`): `sales_value = effective_units × factory_price`,
     `sales_units = total_qty` — same as `phx_monthly_closing_matrix`.
   - Direct (`is_direct`): `sales_value = direct_value`, `sales_units = total_qty`
     — same as `phx_monthly_closing_direct`.
2. **Confidential products** `LA003, LA004, SS001` are excluded from the
   line/rep/region attribution (same as today). They remain visible only in the
   CEO/Super-Admin company view (unchanged elsewhere).
3. **Direct channel** has a region but no area/rep → attributed to
   **line + region only** (`rep_seat_id = dm_seat_id = null`, `channel='direct'`).
   It counts in region/line/company totals, never in a rep's number. National
   direct (`region_code='NATIONAL'` / blank) → company-level only.
4. **"Other" areas** (21 line-area rows, `other_type` in `line_specific`,
   `permanent`; `rep_seat_id null`) → attributed to the line's **"Other" pseudo-DM
   seat** (`au.seats.is_other_pseudo_dm`), rep `null`.
5. **Vacant areas** (`area_state='vacant_will_hire'`) → sales attach to the area +
   its rep seat + DM; `rep_hr_id null`. Never dropped.
6. **Occupant as-of rule:** the occupancy span **covering the period's last day**
   (`effective_from <= period_end AND (effective_to IS NULL OR effective_to >
   period_end)`); if the period predates the seat model (all spans currently start
   2026-07-13), fall back to the seat's **earliest** span. Today this resolves to
   the current occupant for every month; it becomes true as-of history once real
   dated resign/hire events accrue.
7. **Unmapped bucket:** any fact row failing step 1–3 (Head Office line, blank
   area, or an unmapped (line,area)) is emitted with `mapped=false` and a
   `unmapped_reason`, so `sum(attributed) + sum(unmapped) = sum(raw)` exactly.

## Deliverables (au schema, staging)

- `au.f_monthly_attribution(p_period text)` — SECURITY DEFINER, service-role only.
  Returns one row per `(period, channel, line_code, region_code, area_code,
  area_state, is_other, rep_seat_id, rep_hr_id, dm_seat_id, dm_hr_id, product_code,
  sales_units, sales_value, mapped, unmapped_reason)`.
- Rollup helper views over the function's shape for **per-rep**, **per-DM**,
  **per-region**, **per-line** (leaving product detail available).
- `au.f_monthly_attribution_reconcile(p_period)` — attributed + unmapped vs raw
  fact totals per line, to prove no leakage / no double-count.
- Public wrapper (service-role-only) for the read path, since PostgREST only
  exposes `public`.

## Not in this phase

- Achievement % (needs Phase 6 targets).
- Ripping out the manual `sales_records` upload and repointing portal / employee-360
  / incentives to the auto feed — that is the **cutover**, done after the owner
  signs off the numbers (Phase 8), never silently.
- Any production change (Phase 9).
