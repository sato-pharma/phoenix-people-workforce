-- job_post_product_manager_needs
--
-- WHAT THIS CHANGES: replaces the DRAFT "What you need" list on the Product Manager row of
-- public.ats_job_post_titles with the owner's own seven requirements. One row, one column
-- (`needs`, plus `updated_at`). The "What you will do" list stays the draft — he has not given duties yet.
-- WHY: the owner asked (2026-10-16, in chat) for these qualifications on the new Product Manager job post:
-- 2+ years as a Product Manager in pharmaceutical companies (new launches preferred), pharmacist or vet
-- graduate, communication and analytical skills, Microsoft Office, English, Greater Cairo resident, and
-- a preference for Chest, ENT or Urology experience. His spelling is tidied only where it was a slip
-- ("2 year" → "2 years", "Great Cairo" → "Greater Cairo", "uro" → "Urology").
-- GUARDED: it changes the row ONLY while `needs` still equals the draft the seed migration
-- (20261016005009) wrote, so a requirement list the owner already edited on the Job Posts page is never overwritten.
-- ROLLBACK: update public.ats_job_post_titles set needs = <the draft list in 20261016005009> where
-- lower(btrim(title)) = 'product manager'; — or edit the lines on the Job Posts page.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: at most one row's wording changes, and only while it still holds the draft.

begin;

update public.ats_job_post_titles
set
  needs = '[
    {"lead": "Minimum 2 years of experience", "rest": "as a Product Manager in pharmaceutical companies, preferably with new launch experience"},
    {"lead": "Pharmacist or vet graduate", "rest": ""},
    {"lead": "Excellent communication and analytical skills", "rest": ""},
    {"lead": "Very good in Microsoft Office", "rest": "(PowerPoint, Excel, Word)"},
    {"lead": "Excellent command of written and spoken English", "rest": "is a must"},
    {"lead": "Greater Cairo resident", "rest": ""},
    {"lead": "Preferably experience in Chest, ENT or Urology specialities", "rest": "— or in more than one of them"}
  ]'::jsonb,
  updated_at = now()
where lower(btrim(title)) = 'product manager'
  and needs = '[
    {"lead": "Pharmacy, medicine, veterinary or science degree", "rest": ""},
    {"lead": "Pharmaceutical marketing experience", "rest": ", ideally managing a product line"},
    {"lead": "Strong analytical skills", "rest": "— turning sales data into decisions"},
    {"lead": "Excellent English", "rest": "and presentation skills"},
    {"lead": "Cairo-based", "rest": "/ able to commute to Sheraton"}
  ]'::jsonb;

commit;
