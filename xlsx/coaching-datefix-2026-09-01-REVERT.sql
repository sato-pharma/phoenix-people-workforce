-- Revert script for the coaching date corrections applied to PRODUCTION on 2026-09-01.
-- Project: ozucdzovmcqvepbozvqf  (Phoenix HR, production)
--
-- Captured 2026-09-01 immediately before dropping schema coaching_datefix_20260901,
-- at the owner's instruction. That schema held the only pre-images; this file replaces it.
-- Production has NO PITR, so this file is the entire undo path for these 12 rows.
--
-- coaching_month / coaching_quarter / coaching_year are GENERATED ALWAYS from coaching_date,
-- so restoring coaching_date restores all three automatically.
--
-- Each row was a day/month swap introduced by the importer (fixed in PR #2850).
--   report          rep                                       corrected  ->  original(restore)
--   CR-2026-000213  Ahmed Helal Eliwa Hussenin                2024-08-10 ->  2024-10-08
--   CR-2026-000217  Ahmed Helal Eliwa Hussenin                2024-12-10 ->  2024-10-12
--   CR-2026-000219  Ahmed Helal Eliwa Hussenin                2025-01-11 ->  2025-11-01
--   CR-2026-000236  Fiby Wagdy Luka                           2025-11-12 ->  2025-12-11
--   CR-2026-000237  Fiby Wagdy Luka                           2025-12-10 ->  2025-10-12
--   CR-2026-000244  Hayam Mohamed Eladl FaragAllah Hefnawy    2024-09-11 ->  2024-11-09
--   CR-2026-000252  Mostafa Galal Marghany Abdelwahed         2025-08-11 ->  2025-11-08
--   CR-2026-000253  Mostafa Galal Marghany Abdelwahed         2025-11-05 ->  2025-05-11
--   CR-2026-000254  Mostafa Galal Marghany Abdelwahed         2025-11-08 ->  2025-08-11
--   CR-2026-000265  Nosiba Salah Hussenin Moussa              2025-07-06 ->  2025-06-07
--   CR-2026-000268  Nosiba Salah Hussenin Moussa              2025-09-06 ->  2025-06-09
--   CR-2026-000272  Omnia Nader Ismael Hamed Elsherbiny       2024-09-03 ->  2024-03-09
--
-- To undo ALL twelve, run the block below inside a transaction and check the row count is 12.

begin;

update public.coaching_reports set coaching_date = '2024-10-08', updated_at = '2026-07-18 00:47:51.301124+00' where id = '983e646b-6085-41cf-93d8-b71d0bc97f75';
update public.coaching_reports set coaching_date = '2024-10-12', updated_at = '2026-07-18 00:47:51.301124+00' where id = '64043bd3-13b7-442e-b796-a707b6f895e6';
update public.coaching_reports set coaching_date = '2025-11-01', updated_at = '2026-07-18 00:47:51.301124+00' where id = '85afa51f-ae01-480f-98ac-6b8513a044ba';
update public.coaching_reports set coaching_date = '2025-12-11', updated_at = '2026-07-18 00:47:51.301124+00' where id = 'a274370d-f42d-4317-93dd-be55f0c7ad85';
update public.coaching_reports set coaching_date = '2025-10-12', updated_at = '2026-07-18 00:47:51.301124+00' where id = '3f674f74-0ba1-4482-a6af-d05198e14d02';
update public.coaching_reports set coaching_date = '2024-11-09', updated_at = '2026-07-18 00:47:51.301124+00' where id = 'f1b3bcd4-1b87-46df-bfd5-c57b0f360ee8';
update public.coaching_reports set coaching_date = '2025-11-08', updated_at = '2026-07-18 00:47:51.301124+00' where id = '83c89827-6074-4a35-9c3f-43b7d2087f56';
update public.coaching_reports set coaching_date = '2025-05-11', updated_at = '2026-07-18 00:47:51.301124+00' where id = 'e75fc1b7-6fda-4959-a22c-2e00f8e42dd6';
update public.coaching_reports set coaching_date = '2025-08-11', updated_at = '2026-07-18 00:47:51.301124+00' where id = '70d4a0af-21ac-4d80-aa89-beed837d121e';
update public.coaching_reports set coaching_date = '2025-06-07', updated_at = '2026-07-18 00:47:51.301124+00' where id = '504f7d80-b326-404d-a9ce-0c647abd09ae';
update public.coaching_reports set coaching_date = '2025-06-09', updated_at = '2026-07-18 00:47:51.301124+00' where id = 'b78f6dfb-ba1f-4881-9015-e065869c0499';
update public.coaching_reports set coaching_date = '2024-03-09', updated_at = '2026-07-18 00:47:51.301124+00' where id = 'ba6f246c-348b-496b-9b4f-c3a300cd7e99';

-- expect: 12
select count(*) from public.coaching_reports
where id in (
  '983e646b-6085-41cf-93d8-b71d0bc97f75','64043bd3-13b7-442e-b796-a707b6f895e6',
  '85afa51f-ae01-480f-98ac-6b8513a044ba','a274370d-f42d-4317-93dd-be55f0c7ad85',
  '3f674f74-0ba1-4482-a6af-d05198e14d02','f1b3bcd4-1b87-46df-bfd5-c57b0f360ee8',
  '83c89827-6074-4a35-9c3f-43b7d2087f56','e75fc1b7-6fda-4959-a22c-2e00f8e42dd6',
  '70d4a0af-21ac-4d80-aa89-beed837d121e','504f7d80-b326-404d-a9ce-0c647abd09ae',
  'b78f6dfb-ba1f-4881-9015-e065869c0499','ba6f246c-348b-496b-9b4f-c3a300cd7e99'
);

commit;


-- ---------------------------------------------------------------------------
-- SECTION 2 - added 2026-09-01 04:19 Cairo. SEPARATE from the twelve above.
-- ---------------------------------------------------------------------------
--
-- One further correction, applied after reconciling every report against the
-- import source F:\coaching\Q1 Coaching Report 2026.xlsx (sheet Jan-Feb-March-April).
--
--   report          rep                              corrected  ->  original(restore)
--   CR-2026-000240  Hadeer Abdelnaser Osman Hassan   2025-12-07 ->  2025-07-12
--
-- Why: 2025-07-12 was 112 days BEFORE her hire date of 2025-11-01. The source
-- workbook records 2025-12-07, which sits 16 days before her next session
-- (2025-12-23). Owner approved the change on 2026-09-01.
--
-- NOTE - this row was NOT last written by the batch above. Another session
-- rewrote it by direct SQL at 2026-09-01 00:10:15.948695+00 (03:10 Cairo),
-- twelve minutes after that batch, with no audit row. The updated_at restored
-- below is THAT session's stamp, not the 2026-07-18 import stamp used above.
--
-- The UPDATE that was applied carried a guard (coaching_date = '2025-07-12'),
-- and returned exactly one row: month 12, quarter 4, year 2025.
--
-- To undo, run this block and check the count is 1.

begin;

update public.coaching_reports set coaching_date = '2025-07-12', updated_at = '2026-09-01 00:10:15.948695+00' where id = 'f6724577-16b1-4cf2-8f53-a3291001ea98' and coaching_date = '2025-12-07';

-- expect: 1
select count(*) from public.coaching_reports
where id = 'f6724577-16b1-4cf2-8f53-a3291001ea98' and coaching_date = '2025-07-12';

commit;

-- =====================================================================
-- SECTION 3 - Eman Ahmed Fathy Mohamed, CR-2026-000199
-- Applied 2026-09-01 01:36:29.631745+00 (04:36 Cairo), owner-approved.
-- =====================================================================
--
-- The report held 2026-04-05. It was corrected to 2026-05-04 because three
-- independent sources put that session on 4 May:
--   1. F:\coaching\Double Visits Full Coaching 2026.xlsx, May sheet -
--      "Eman Fathy | Maadi & Helwan Line Anti-I | 04/05/2026" (TEXT cell,
--      day > 12 so Excel never reparsed it - the reliable kind).
--   2. F:\coaching\Q1 Coaching Report 2026.xlsx row 19 - Eman.Ahmed,
--      2026-05-04, score 80, matching this report's score of 80 exactly.
--   3. F:\coaching\x\May Cocahing Report 2026.xlsx - an Eman session on
--      2026-05-04.
-- Root cause: Excel parsed "04/05/2026" as m/d on the authoring machine and
-- stored the day and month reversed. Same mechanism as SECTION 1.
--
-- Pre-image read immediately before the write:
--   coaching_date 2026-04-05, month 4, quarter 2, year 2026,
--   updated_at 2026-07-18 00:47:51.301124+00  (the original import stamp -
--   unlike SECTION 2, no other session had touched this row).
--
-- The UPDATE carried a guard (coaching_date = '2026-04-05') and returned
-- exactly one row: month 5, quarter 2, year 2026.
--
-- Verified after the write: total reports 116 (unchanged), Jan-Jun 2026
-- reports 25 (unchanged), rows with updated_at > 01:30 = 1, and Eman's
-- sessions read 2026-02-16, 2026-05-04.
--
-- To undo, run this block and check the count is 1.

begin;

update public.coaching_reports set coaching_date = '2026-04-05', updated_at = '2026-07-18 00:47:51.301124+00' where id = '8ce6098d-3d11-4f45-a096-47b65c67dfcc' and coaching_date = '2026-05-04';

-- expect: 1
select count(*) from public.coaching_reports
where id = '8ce6098d-3d11-4f45-a096-47b65c67dfcc' and coaching_date = '2026-04-05';

commit;
