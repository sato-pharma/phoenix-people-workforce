---
name: sales-consolidation-desktop-data
description: "The SATO Pharma sales-consolidation task on the user's Desktop (separate from the phoenix-workforce repo): consolidate monthly distributor sales into ONE database. Holds the monthly workflow the user actually uses (drop folder → hand back a filled file), the file locations, the territory source of truth, the LOCKED value rule, the hard-won brick-fill lessons (area-text is the key; customer-code is a proven dead-end fallback; the Customer→Brick master + internal-code propagation are Plan B), and the Phoenix integration end-state (customer_map is loaded in production; monthly path is /sales/import)."
metadata: 
  node_type: memory
  type: project
  originSessionId: 615a4b50-ecc3-4ee4-b548-8fe82e4b0b40
  modified: 2026-09-26T02:24:16.299Z
---

## The task and how to work it

A recurring, emotionally heavy multi-session task: consolidate SATO Pharma monthly distributor sales into
ONE database. It lives on the Desktop, **separate from the phoenix-workforce repo.** The user is
non-technical and overwhelmed — **LEAD and AUTOMATE, hand back a finished file, never hand them Excel tools
or VLOOKUP steps** ([[user-overwhelmed-needs-lead-and-automate]]). Keep explanations to plain short numbered
steps; offer Arabic. When showing a file on screen, jump to a well-filled tab (Overseas/EGD), not
Chimipharm (opens first, looks empty). `SendUserFile` is not always available — files land in the Desktop
working folder; point the user to the path.

**The monthly workflow the user actually uses:** they drop sales files (current OR historical, any month)
into **`C:\Users\satoh\OneDrive\Desktop\SALES - DROP HERE`** and message "do this month" / "add these"; the
pipeline runs and hands back the finished file (one tab per distributor, an orange Brick-ID column filled).

## Locations

- **Working folder:** `C:\Users\satoh\OneDrive\Desktop\Phoenix Sales DB\`, reorganized into `1 - RESULTS`
  (+`\filled`), `2 - DISTRIBUTOR WORKOUTS`, `3 - LOOKUPS`, `4 - ENGINE`. The engine `10_build_database.py`
  stays at ROOT (numbered scripts in `4 - ENGINE` importlib it); `area_alias_supplement.py` in ENGINE.
- **Territory source of truth = `C:\Users\satoh\Downloads\phoenix-bricks-master (8).xlsx`** (user-designated
  2026-06-05): sheets Brick Master (~589 bricks, IDs `B{block}-{n}`, Arabic names), `_ref_blocks` (148),
  `_ref_areas` (42), `_ref_regions` (7: AB/CA/D1/D2/GZ/OT/UE). Use THIS for all brick/area/region codes; the
  old `Source of sales area database.xlsx` area tables are retired — **but products + factory price still
  come from it** (22 products with Factory Price, 8 distributors).
- Source data: raw monthly exports (heavily duplicated) under `...\Desktop\Sales\`; reference/target data
  under `...\Desktop\Areas Database\`.

## The data

- **Distributors:** chimipharm, egd (+ egd 1002 branch), epda, ibnsina, mec, office, overseas, ramco,
  sofico; plus `customer sales` (FMCG aggregate ~32k rows), `tender <dist>` files, and Arabic files ساتو
  فارما صيدليات (pharmacies), ساتو فارما جملة (wholesale), مركز تموين مستشفيات (hospital supply).
- 🔴 **The hard part: each distributor uses different column names / order / language.** Per-distributor
  customer-code / area-text columns learned: **IbnSina G/S, EGD F/AJ, Overseas G/P, Ramco G/A, Sofico T/A,
  MEC G/A, EPDA G/A, FMCG D/H, SATO Pharmacies E/M.** EGD gotcha: look up by **CUSTOMER CODE (col F), never
  MRKZ_N** (which is "0" on data rows); the customer code is an int → match as the same type.
- **Product master decisions (resolved 2026-06-05):** added SS001 Satoslim, LA003 Lacto1-retail, LA004
  Lacto2-retail (with prices). EXCLUDED as out-of-scope: Trencedia, Vonopep, Fortrostep, Anoxicam, Lacto LF.

## 🔒 LOCKED VALUE RULE (user, 2026-06-06)

**Value = distributor-sheet QUANTITY × reference X-factory price × (1 − discount if present); Bonus is
EXCLUDED from qty.** EXCEPTION: **the Direct sales sheet — take the value AS-IS from the sheet** (no
recompute). Maps to Phoenix `source_of_sales_distributor_profile.value_source`: real distributors =
"recompute", Direct = "sheet". **The Phoenix code already implements this exactly**
(`src/lib/sales/monthly-distributor-import.ts`). Discount is read from a "Discount%" column — of the user's
manual columns, only Discount% is a real input; Brick/Area/Region/Distributor are auto. See
[[source-of-sales-rebuild-rules]].

## The hard-won brick-fill lessons (don't relearn these)

- 🔴 **The area-text column is the winning brick key for every distributor. Customer-code adds 0% as a
  fallback** — proven twice, including with cleaned codes; the cause is structural, not formatting: a
  customer only has a brick if one of their rows already resolved via area, so a broad-area distributor (EGD
  etc.) never lends a brick. **Do NOT pursue customer-code or address as a brick fallback.**
- **The only way to convert "area-only → brick" is a one-time Customer→Brick MASTER** (reps assign each
  customer code its exact brick once) → then a customer-code VLOOKUP fills permanently. This is the durable
  Plan B that closes the area-only gap. It was built with ~90%+ pre-filled from resolved rows, blanks left
  for reps.
- **The internal-code → master propagation trick is the general lever that pushes a distributor to ~98%:**
  learn the distributor's OWN internal markaz/brick code (Ibn Sina old-brick col A/R, EGD markaz AI, Sofico
  AC, etc.) → master location from its already-resolved rows (majority vote), then fill every customer
  sharing that code.
- 🔴 **NEVER impose outside/administrative geography, and mark every inference.** The user pushed back hard
  ("you're writing Monofia… mark the uncertain, you'll lose my confidence"). The reference's "region" is a
  SALES region that deliberately CROSSES governorates (area "Helwan-Maadi" sits in the **Giza** sales-region
  though Helwan is Cairo governorate), and distributor "gov" columns often hold CITY names, not
  governorates — so validating areas against administrative governorates produced hundreds of FALSE
  conflicts. Confidence must come from the `resolve_territory` derivation TIER (brick-id/crosswalk/brick-name
  = confirmed; area_alias supplement = SUGGESTED-review; internal-code propagation = auto-by-code;
  locality-only/none = review). Show a "file shows (locality)" column of the exact matched text; don't assert.
- **Location-less channels have no brick and never will** (100% blank is correct): EGD 1002 branch transfers,
  SATO Wholesale, Office, Hospital supply, Chimipharm, tenders, and the Direct / IS-S / EP-S SATO channels.

## Duplicate handling

The Sales tree is heavily duplicated (a scan found ~201 files, only ~121 unique). Consolidation uses
**transaction-level fingerprint dedup** — (distributor, period/date, customer_code, product_code, qty,
value) → keep first, route repeats to a "Duplicates" tab, **never double-counted.** Deleting duplicate
copies is permission-required; MOVE them to a `_DUPLICATES` folder rather than delete.

## The Phoenix integration — this Excel work is SEED DATA, and it is loaded

Phoenix already has a full brick-level Source-of-Sales feature in the main codebase, and the Excel outputs
map 1:1 to its tables: brick master → `source_of_sales_bricks`; alias dictionary →
`source_of_sales_{product,region,area,territory}_aliases`; **Customer-to-Brick MASTER →
`source_of_sales_customer_map`** (the key piece, unique on distributor_code+customer_code); distributor
column maps → `source_of_sales_distributor_profile`; the monthly fill script → the upload→auto-tag pipeline
(`src/lib/sales/monthly-distributor-import.ts` + `normalizer/*`). UI: `/sales/import`, `/sales/normalizer`,
`/sales/database-mapping`, `/sales/customer-directory`.

- **PRODUCTION customer_map is LOADED (2026-06-06, prod `ozucdzovmcqvepbozvqf`).** The 6 distributors our
  Excel covers were empty; loaded **IS/EG/RM/SF/MC/EP ≈ 3,778 brick-validated rows** tagged
  `excel-confirmed`, idempotent `ON CONFLICT (distributor_code,customer_code)`. Untouched: PS/CP (already
  seeded), the masters, the schema. Still empty (out of scope): Direct, IS-S, EP-S.
  **Rollback:** `DELETE FROM source_of_sales_customer_map WHERE distributor_code IN
  ('EG','IS','SF','RM','MC','EP') AND source LIKE 'excel-%';` (those targets were empty pre-load).
- **The in-app customer-map import (download→fix→import) shipped** (PR #28, merged) — `/sales/database-mapping`
  can upsert the customer map, validating brick vs master and deriving area/region from the brick.
- **So the monthly path out of Excel = upload the distributor file in `/sales/import` → it auto-tags brick
  via the map and learns aliases → dashboards.** ⚠️ Any data import into live `source_of_sales` is a prod
  change: stage on **`cifwmndunmlxjhyjugxa`** first (the old `izhmxvgiktiafqusolot` is dead), then prod with
  approval; see [[pr24-supabase-bridge-prod-lockout]] for app-side caution and [[ireports360-crm-integration]].
- ⚠️ **The deploy mechanics recorded during this task (Vercel git-target=production, the phoenix-workspace
  team, github.com/Phoenix-HR) are SUPERSEDED** — production is now Railway and the repo is
  `it-gawish-hr/phoenix-people-workforce`. Only the DB facts above (customer_map loaded in prod, the rollback)
  are current.

## Still open

Historical (2025) files use different per-distributor/month column layouts, so each needs a header-name-aware
loader, not the 2026 positional configs; chimipharm/office/"sato may" odd formats still unread; older-month
totals are DRAFT and unverified (the April-2026 output ≈ EGP 46.27M is the trusted one, within 0.1% of the
reported figure). The FMCG/Lacto aggregate dominates the headline — filter `line=Pharma` for pharma-only.
