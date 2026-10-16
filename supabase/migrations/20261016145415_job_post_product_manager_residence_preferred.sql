-- job_post_product_manager_residence_preferred
--
-- WHAT THIS CHANGES: on the Product Manager row of public.ats_job_post_titles, the residence requirement
-- becomes a preference — "Greater Cairo resident" → "Greater Cairo resident preferred". One row; `needs`
-- and `updated_at`. The other six requirements, the duties and the headline are untouched.
-- WHY: the owner said (2026-10-16, in chat) "cairo resident is prefferable". It still reads "Greater
-- Cairo", never plain Cairo (his earlier word the same day).
-- GUARDED: it changes the row ONLY while `needs` still holds exactly what 20261016143954 wrote, so a list
-- edited on the Job Posts page is never overwritten.
-- ROLLBACK: update public.ats_job_post_titles set needs = <the list in 20261016143954> where
-- lower(btrim(title)) = 'product manager'; — or edit the line on the Job Posts page.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one line of one row's wording, and only while the row still holds the earlier list.

begin;

update public.ats_job_post_titles
set
  needs = '[
    {"lead": "Minimum 2 years as a Product Manager", "rest": "in pharmaceutical companies — ideally with new launch experience"},
    {"lead": "Pharmacist or vet graduate", "rest": ""},
    {"lead": "Excellent communication and analytical skills", "rest": ""},
    {"lead": "Very good with Microsoft Office", "rest": "(PowerPoint, Excel, Word)"},
    {"lead": "Excellent command of written and spoken English", "rest": "is a must"},
    {"lead": "Greater Cairo resident", "rest": "preferred"},
    {"lead": "Chest, ENT or Urology experience", "rest": "preferred"}
  ]'::jsonb,
  updated_at = now()
where lower(btrim(title)) = 'product manager'
  and needs = '[
    {"lead": "Minimum 2 years as a Product Manager", "rest": "in pharmaceutical companies — ideally with new launch experience"},
    {"lead": "Pharmacist or vet graduate", "rest": ""},
    {"lead": "Excellent communication and analytical skills", "rest": ""},
    {"lead": "Very good with Microsoft Office", "rest": "(PowerPoint, Excel, Word)"},
    {"lead": "Excellent command of written and spoken English", "rest": "is a must"},
    {"lead": "Greater Cairo resident", "rest": ""},
    {"lead": "Chest, ENT or Urology experience", "rest": "preferred"}
  ]'::jsonb;

commit;
