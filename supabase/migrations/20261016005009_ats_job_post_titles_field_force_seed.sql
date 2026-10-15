-- ats_job_post_titles_field_force_seed
--
-- WHAT THIS CHANGES: adds three rows to public.ats_job_post_titles — Medical Representative,
-- District Sales Manager and Product Manager — each with its own "What you will do" and "What you
-- need" lists, so picking the title on the Job Posts page fills both lists at once. No schema change.
-- WHY: the owner asked (2026-10-16) for these three titles on the Job Posts page, with their wording
-- ready. WHAT A JOB IS belongs to the title row, never to a design.
--   * Medical Representative — the wording is the owner's OWN, pasted in chat 2026-10-16 (five duties,
--     five requirements), replacing the draft this file first carried; production and staging were
--     corrected by a guarded update (only while the row still held the draft) before merge.
--   * District Sales Manager — the wording is the owner's OWN, pasted in chat 2026-10-16 (six duties, six
--     requirements), replacing the adapted 2026-10-02 listing this file first carried; corrected on both
--     projects by a guarded update (only while the row still held that wording) before merge. The title is
--     the one the offer catalogue and the Employee Master use; WhatsApp choice stays "District Manager", the menu's label.
--   * Product Manager — DRAFT wording, reports to the Marketing Manager (as the Employee Master has it).
-- Idempotent: on conflict do nothing, so a title the owner already edited by hand is never overwritten.
-- ROLLBACK: delete from public.ats_job_post_titles where lower(btrim(title)) in
--   ('medical representative', 'district sales manager', 'product manager');  -- nothing references it.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This migration is neither: three new rows in a table that holds three.

begin;

insert into public.ats_job_post_titles (title, department, headline, reports_to, location, duties, needs, menu_name)
values (
  'Medical Representative',
  'Sales',
  null,
  'District Sales Manager',
  'Field-based, Egypt',
  '[
    {"lead": "Area Management:", "rest": "Plan and complete weekly visits to doctors and pharmacies in your assigned area."},
    {"lead": "Product Promotion:", "rest": "Present Sato Pharma''s products clearly and professionally."},
    {"lead": "Sales Achievement:", "rest": "Achieve monthly sales targets for each assigned product."},
    {"lead": "Customer Relationships:", "rest": "Build and maintain strong relationships with doctors and pharmacists."},
    {"lead": "Reporting:", "rest": "Record all field visits accurately using the company''s CRM system."}
  ]'::jsonb,
  '[
    {"lead": "Education:", "rest": "Bachelor''s degree in Pharmacy, Vet, or Science."},
    {"lead": "Experience:", "rest": "6 months to 2 years of experience in pharmaceutical sales."},
    {"lead": "Communication:", "rest": "Good presentation, communication, and negotiation skills."},
    {"lead": "Digital Skills:", "rest": "Ability to use CRM systems, mobile applications, and sales reports."},
    {"lead": "Accountability:", "rest": "Responsible, self-motivated, and committed to achieving targets."}
  ]'::jsonb,
  'Medical Representative'
)
on conflict do nothing;

insert into public.ats_job_post_titles (title, department, headline, reports_to, location, duties, needs, menu_name)
values (
  'District Sales Manager',
  'Sales',
  null,
  'National Sales Manager',
  'Field-based, Egypt',
  '[
    {"lead": "Team Leadership:", "rest": "Lead, motivate, and manage medical representatives across your region."},
    {"lead": "Sales Achievement:", "rest": "Achieve monthly sales targets for each area and product."},
    {"lead": "Team Development:", "rest": "Improve team performance through regular field coaching and joint visits."},
    {"lead": "Territory Management:", "rest": "Plan and monitor customer coverage, visit frequency, and field activities."},
    {"lead": "Performance Management:", "rest": "Track individual results, identify gaps, and take corrective actions."},
    {"lead": "Reporting:", "rest": "Monitor team activities and sales performance using the company''s CRM system."}
  ]'::jsonb,
  '[
    {"lead": "Education:", "rest": "Bachelor''s degree in Pharmacy, Vet, or Science."},
    {"lead": "Sales Experience:", "rest": "Strong background in pharmaceutical sales and territory management."},
    {"lead": "Location:", "rest": "Must be a resident of the district you will manage."},
    {"lead": "Transportation:", "rest": "Must own a car."},
    {"lead": "Digital Skills:", "rest": "Good knowledge of CRM systems, sales reporting, and performance analysis."},
    {"lead": "Accountability:", "rest": "Strong leadership, decision-making, and commitment to achieving targets."}
  ]'::jsonb,
  'District Manager'
)
on conflict do nothing;

insert into public.ats_job_post_titles (title, department, headline, reports_to, location, duties, needs, menu_name)
values (
  'Product Manager',
  'Marketing',
  null,
  'Marketing Manager',
  'Sheraton, Cairo',
  '[
    {"lead": "Own your line''s marketing plan", "rest": "from positioning to launch and campaigns"},
    {"lead": "Equip the sales force", "rest": "with product training, visual aids and clear key messages"},
    {"lead": "Track line performance", "rest": "— sales, targets and market feedback — and act on it"},
    {"lead": "Plan and run medical events", "rest": "such as round tables, with the field teams"},
    {"lead": "Manage the line''s marketing budget", "rest": "and report what it delivered"}
  ]'::jsonb,
  '[
    {"lead": "Pharmacy, medicine, veterinary or science degree", "rest": ""},
    {"lead": "Pharmaceutical marketing experience", "rest": ", ideally managing a product line"},
    {"lead": "Strong analytical skills", "rest": "— turning sales data into decisions"},
    {"lead": "Excellent English", "rest": "and presentation skills"},
    {"lead": "Cairo-based", "rest": "/ able to commute to Sheraton"}
  ]'::jsonb,
  'Product Manager'
)
on conflict do nothing;

commit;
