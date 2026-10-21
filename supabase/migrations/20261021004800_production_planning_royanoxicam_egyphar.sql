-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Production Planner — Royanoxicam's toll manufacturer moves from Medizen to Egyphar.
--
-- Owner, 2026-10-21: *"look the fctory changed from medizen to egyphar and the almunumnblister
-- leave empty for now"* — answering the question about the foil weight, and correcting the factory
-- in the same sentence. Both halves are honoured here: the factory is renamed, and the aluminium
-- blister foil keeps its deliberate absence (no composition row, so no requirement and no buy-list
-- line) rather than being given a guessed weight per box.
--
-- ── Why this RENAMES the location instead of adding one ────────────────────────────────────────
--
-- `MEDIZEN` was created hours earlier by `20261020200000_production_planning_royanoxicam.sql` and
-- nothing has accumulated against it: measured on production before this migration, it had ONE
-- product (Royanoxicam, which is moving) and ZERO stock entries, so there is no history to keep at
-- the old name. Adding `EGYPHAR` beside it would leave a factory in every picker that nothing is
-- ever made at, which is the clutter the module's own rules warn about. The three live factories
-- stay EGPI (Ivyronc), DBK (Guamusin) and — from here — EGYPHAR (Royanoxicam).
--
-- ── What deliberately does NOT change ──────────────────────────────────────────────────────────
--
-- **The formula, the geometry and the supplier split are untouched.** A batch is still a fixed
-- 31 kg = 200,000 tablets of 155 mg, 20 to a box. The eleven excipients are seeded
-- `supplier = 'factory'` rather than against a named company precisely so a change of factory
-- carries them with it — the owner's split (*"loranoxiam and pamphlet and box and almunium are me
-- others medizen"*) still reads correctly: Sato brings the active, the leaflet, the box and the
-- aluminium, and the factory — now Egyphar — brings the rest.
--
-- **The bill of materials keeps its provenance.** The papers that produced this formula were
-- Medizen's, and the internal codes on them (STR1121001 and the rest) are real. They are relabelled
-- `BOM code` rather than deleted or reattributed to Egyphar, which has supplied no paperwork of its
-- own yet.
--
-- Reverting: additive and reversible — rename `EGYPHAR` back to `MEDIZEN` and restore the two
-- `manufacturer_name`/`notes` strings.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. The factory ──────────────────────────────────────────────────────────────────────────────
-- Guarded both ways: it does nothing on a database where the rename already happened, and it
-- refuses to collide with an EGYPHAR row somebody else created.
update public.prodplan_locations
set code = 'EGYPHAR',
    name_en = 'At the factory (Egyphar)',
    name_ar = 'مخزن المصنع — إيجيفار'
where code = 'MEDIZEN'
  and not exists (select 1 from public.prodplan_locations l2 where l2.code = 'EGYPHAR');

-- ── 2. The product ──────────────────────────────────────────────────────────────────────────────
update public.prodplan_products
set manufacturer_name = 'Egyphar',
    notes = 'Film-coated tablet, toll-manufactured by Egyphar for Sato Pharma. One batch is a FIXED 31 kg = 200,000 tablets of 155 mg; 20 tablets to a box, so one run is exactly 10,000 boxes. Shelf life 3 years. A tablet IS the dose and IS the saleable unit; no free samples, so sample_unit_ml is the tablet itself and is never used. Seeded 2026-10-20 from the bill of materials and the proposed declaration of composition. The toll manufacturer moved from Medizen to Egyphar on 2026-10-21 at the owner''s word; the formula, the geometry and the supplier split are unchanged by that move.'
where code = 'ROYANOXICAM';

-- ── 3. The factory's own codes on the bill of materials ────────────────────────────────────────
-- Six materials carry "Medizen code STR…". The codes are real and worth keeping; the attribution is
-- not, now that a different factory makes the product.
update public.prodplan_materials
set notes = replace(notes, 'Medizen code', 'BOM code')
where notes like '%Medizen code%';
