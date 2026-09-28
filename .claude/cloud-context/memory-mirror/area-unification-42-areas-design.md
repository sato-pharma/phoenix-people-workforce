---
name: area-unification-42-areas-design
description: "The owner's 2026-07-12 design unifying organogram / employee-master / lifecycle / Source-of-Sales / sales calc onto ONE canonical geography. IT IS BUILT AND LIVE — au.canonical_areas + au.line_area_map drive production ozucdzovmcqvepbozvqf — so this is the design rationale, not a proposal. WARNING: the count moved. The spec started from 42 fixed areas; production now holds 50. Never quote 42 as the current number. The region is PER-LINE (the area's manager's region), never a global area→region map — that was the reverted attempt."
metadata: 
  node_type: memory
  type: project
  originSessionId: 785df647-44c8-4011-856b-d15dd74cd4d8
  modified: 2026-09-26T02:12:01.687Z
---

## It shipped, and the number is now 50 — read this first

The old description said "DESIGN PHASE, no code yet." Both halves are wrong now:

1. **It shipped.** `au.canonical_areas` exists in production `ozucdzovmcqvepbozvqf`, `au.line_area_map`
   covers every one of its codes, and there is an admin surface —
   `app/(admin)/admin/master-data/area-consolidation/page.tsx`, backed by `public.area_consolidations`
   + `public.area_consolidation_moves`.
2. **42 is now 50.** Production holds **50 canonical areas, 50 distinct codes in the line map.** "42
   fixed areas" is the number the design *started from*, not the live count — quoting 42 as current
   understates the geography by eight areas. The Delta (3) move and the Fayoum/Beni Suef split are the
   kind of change that moved it.

The design reasoning below is why this file stays — it explains WHY the system is shaped this way.

## The point of the whole thing

The owner used to do the monthly closing **manually** in the Sales Queue module (hand-calculate → upload
→ the `sales_records` pipeline). This mapping exists to make the **Source-of-Sales module the AUTOMATIC
engine**: once SoS knows per-line `area→rep→manager→region`, it auto-attributes raw brick/area sales to
reps/DMs/regions/lines, auto-runs the monthly closing, and auto-computes achievement. The canonical area
list **is the join key** between SoS (actuals, geography, no targets) and the manager/target world. The
pivot is the AREA: SoS sales per area → line sheet maps area→one rep→manager→region; target attaches per
area; achievement rolls up per area. Distinct from the reverted [[area-unification-revert-settled]]
(#726/#921), which tried a single *global* area→region map — this is **region per-line, manager-driven.**

## The canonical model (the durable rules)

- **Area codes are region-prefixed** (AB/CA/D1/D2/GZ/OT/UE…) but **the prefix is only the area's fixed
  identity — it NEVER decides the operational region.**
- **Operational region = the area's MANAGER's region, per line, always.** The SAME area can sit in
  different regions in different lines (Helwan-Maadi = Giza in CNS but Cairo in Pedia; Kafr El-Sheikh 1
  code=Delta1 but manager=Alex-BHR in both lines).
- **Team = all reps sharing one Manager HR-ID = one region under a District Manager.** DM sales+target =
  Σ his areas (occupied AND vacant).
- **Regions are PER-LINE, and region count = DM count in that line.** "6 regions + Other" was
  CNS-specific. A geography can SPLIT into numbered regions when it has >1 DM (Upper Egypt is one region
  in CNS/Pedia but UE-1/UE-2 in Anti-infective; Delta is always D1/D2). The OT prefix IS the "Other" —
  6 regions + 1 Other, not 7.
- **Org tiers vary by line:** Pedia = 4 tiers NSM→RSM→DM→rep (ONLY line with an RSM); CNS + Anti-infective
  = 3 tiers NSM→DM→rep. DM owns a region in ALL lines. **Pedia RSM is PARTIAL** — only Alex-BHR + Delta 1
  + Delta 2 DMs report to the RSM; Cairo + Giza + Upper Egypt DMs + Others report straight to the NSM.
  Tree builds via the manager chain (variable depth, no special flag).
- **Lines = exactly {CNS, Pedia, Anti-infective}; Head Office EXCLUDED. One rep per (line, area).**
- **Line/NSM total sales = Σ(region DMs) + Other. Line/NSM total target = Σ(region DMs) ONLY** (Other has
  no target).

## The 4 (+1) situations per area row in a line sheet

1. **Occupied** — real rep + manager. Sales + target.
2. **Vacant (will hire)** — rep="vacant", no HR-ID, HAS a manager. Counts as a vacant box; still carries
   sales + target; rolls to its DM. Temporary.
3. **Other, line-specific** — token `<AREA>-<LINE>-OT`. No manager. This line chose not to staff it but
   another line does (Imbaba=Other in CNS, real Giza seat in Pedia). Sales, NO target. 🔴 **Any
   `<AREA>-<LINE>-OT` token = Other REGARDLESS of any manager value on the row** (a stray manager there is
   a data-entry mistake).
4. **Other, permanent** — rep="Other" (North Sinai, Suez/S.Sinai, Aswan). Other in EVERY line, never
   staffed. Sales, NO target.
5. **Vacant DM** — Manager HR-ID is a free-text label ("Cairo DM vacant", bare "VACANT"). Treat the seat
   as a normal DM (its region + areas carry sales + target, roll up) until a DM is hired; all rows sharing
   that label = the vacant DM's team.

**"Other" is a first-class pseudo-DM** — its areas listed like reps with per-area detail + an Other
subtotal, then added into the line/NSM total. Never a silent rollup.

**Acting DM** = a rep who ALSO manages areas (B-1 Nosiba: rep under one DM, manages other areas). Modeled
as an ACTING_DM seat under their own manager; supported via the acting-DSM heuristic
(`organogram-view-model.ts`). **RULE: never assume a rep has zero reports.**

## FIRM RULES (owner 2026-07-12)

1. **SEAT CONTINUITY** — if a rep OR a manager resigns, NOTHING in the structure changes: keep the box,
   replace the HR-ID with a generated VACANT seat ID, preserve ALL historical data, until a new hire lands
   in that seat. Applies at BOTH rep and manager level.
2. **HISTORY IS SEAT-BASED, not person-based** — sales attribute to the SEAT/region/area, so a new hire
   inheriting a seat automatically sees ALL that seat's historical sales. `employee_history` is dead;
   `occupancy_history` (append-only, effective-dated spans, one open span per seat) replaces it.
3. **Targets are a SEPARATE page + sidebar tab** — the unification must NOT bake in target columns.
4. This module is TRUST-CRITICAL — build clean, no historical cruft carried forward.

## The architecture that shipped (schema `au`)

- **Reference data:** `regions` / `canonical_areas` / `lines` / `sos_official_line_map` /
  `sos_area_crosswalk` (map-or-reject import; never auto-create an area).
- **`seats`** — a seat_id is NEVER an HR-ID (scheme keyed by line/tier/region/area). Vacant-DM, vacant-rep
  and Other are all the SAME shape: a seat with an empty occupant that still carries sales/target. CEO
  root seat = AA (Anwar Gawish).
- **`line_area_map`** — per (line, area) → operational region + DM seat + rep seat + state + other_type.
  **ALL per-line variance lives here**, not in the crosswalk.
- **`occupancy_history`** — the seat-continuity ledger (rule 2). Lifecycle RPCs `au.resign_occupant` /
  `hire_into_seat` / `transfer_occupant` (SECURITY DEFINER, service-role only) keep one open span per seat
  and chain `prev_occupancy_id` so a new hire inherits the seat's area history.
- 🔴 **FKs are RESTRICT, never SET NULL.** The root cause of the July-7 ~70-rep wipe was `area_id` FKs set
  `ON DELETE SET NULL` — deleting a duplicate area silently nulled every dependent. All `area_id` FKs were
  flipped to RESTRICT; `public.areas.line_id` is nullable (areas are line-independent).
- **Org tree** climbs `seats.parent_seat_id`; the live organogram was rebuilt to read the seat model as its
  DATA SOURCE (kept the existing chart/KPIs/access-control), not a parallel "/organogram-v2".
- **RLS/grants:** au tables + `au_v_*` wrapper views are service-role-only; `public.au_v_*` wrappers exist
  only because PostgREST exposes the public schema. The app reads via `getSupabaseAdmin`, so it is
  unaffected. (A Phase-3/5 hole where those wrapper views had anon/authenticated WRITE grants was closed.)

## SoS crosswalk is IDENTITY — no mapping work

Staging `source_of_sales_areas` already uses the exact canonical codes + region codes, and **SoS geography
is line-INDEPENDENT (one region per area, globally).** So the SoS→canonical-area join is IDENTITY (zero
unmatched) — the crosswalk needs no work. `official_line` values map cns=CNS, pedia=Pedia,
anti_infective='Anti infective'; Head Office is excluded.

## 🔴 The CUTOVER DECISION (owner 2026-07-13) — where each period is calculated

- **H1 2026 (Jan–Jun, Semester One) STAYS on the legacy manual Sales Queue** (`sales_records`),
  UNCHANGED — incentives AND sales calc.
- **From JULY 2026 onward, FOREVER, everything (sales calc + incentives/achievement) comes from the NEW
  Source-of-Sales automatic engine.** The au auto-closing is AUTHORITATIVE only for periods **>= 2026-07**;
  scope the read path/UI accordingly.
- **The manual Sales Queue is therefore NOT retired** — it is the record for H1 2026 + transition.
- This also moots historical per-person accuracy: the occupancy spans all start at go-live, so pre-system
  months would resolve to the *current* occupant — irrelevant, because those months stay on the queue, and
  as-of becomes exact going forward as real hire/resign events accrue.

## Targets (the separate module)

- **Grain = ONE TARGET PER PRODUCT PER AREA PER MONTH** (area-keyed, NOT person-keyed — the old
  person-keyed `public.sales_targets` was abandoned). Achievement measured PER MONTH; targets attach on
  the same canonical (line, area) as actuals so a target with zero sales still surfaces under its rep/region.
- **EDIT/upload = Super Admin + SFE Manager only**, gated `assertPermission(sales,'import')`; input is
  BOTH an Excel template and on-screen grid edits. All other roles get read/export, no import — the gate
  is correct by construction (the permission matrix, not a nav hide, is the boundary).
- A source drill-down (Product→Distributor→Brick→customer, units+value, MoM trend, source files, Excel
  export) exists on the Targets page so the owner can SEE how every area number is built up. Direct sales
  are region-level (no area) — shown in the export, not as expandable area rows.

## Traps that outlived the build

- **Connector routing:** staging `cifwmndunmlxjhyjugxa` "Phoenix-HR-Staging" is reached via the
  **supabase-PRODUCTION** connector; the supabase-staging connector points at the PAUSED
  `izhmxvgiktiafqusolot`. Production = `ozucdzovmcqvepbozvqf`. (Staging state itself has since changed — it
  is now a full clone; this is only the connector wiring.)
- **NEVER full-regenerate the owner's live template** (it wipes his edits) — surgical patches only.
- The attribution engine reconciled EXACTLY against the existing closing RPCs at build time (every
  line×period diff = 0), because value basis MIRRORS them: indirect = effective_units×factory_price,
  direct = direct_value, units = total_qty, validated batches only, confidential (LA003/LA004/SS001)
  stripped. A future change to attribution must preserve that basis or it will silently stop reconciling.

See [[area-unification-42-areas-audit-findings]] for the deep read-only audit of the pre-unification
system and why it resisted this model. Show-names-not-codes was enforced across these surfaces per
[[feedback-show-names-not-codes]].
