-- job_post_product_manager_marketer_copy
--
-- WHAT THIS CHANGES: the Product Manager row of public.ats_job_post_titles gets copy written for
-- marketers — a two-line headline, six "What you will do" lines in place of the five-line draft, and the
-- owner's seven requirements tightened for a detail-minded reader. One row; `headline`, `duties`,
-- `needs` and `updated_at`.
-- WHY: the owner asked (2026-10-16, in chat) for a Product Manager post tailored to product managers —
-- "marketers ... detail oriented" — that catches their eye. The requirements keep his meaning:
-- "Very good in" → "Very good with"; "preferably with new launch experience" → "ideally with new launch
-- experience"; "Preferably experience in Chest, ENT or Urology specialities — or in more than one of
-- them" → "Chest, ENT or Urology experience preferred". "Greater Cairo resident" stays word for word.
-- GUARDED: it changes the row ONLY while the headline is still empty and both lists still hold what
-- 20261016005009 (duties) and 20261016142455 (needs) wrote, so wording edited on the Job Posts page is
-- never overwritten.
-- ROLLBACK: update public.ats_job_post_titles set headline = null, duties = <the draft list in
-- 20261016005009>, needs = <the list in 20261016142455> where lower(btrim(title)) = 'product manager';
-- — or edit the lines on the Job Posts page.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: at most one row's wording changes, and only while it still holds the earlier text.

begin;

update public.ats_job_post_titles
set
  headline = 'Own the brand.' || chr(10) || 'Lead the launch.',
  duties = '[
    {"lead": "Own the brand strategy", "rest": "— positioning, targeting and the annual brand plan"},
    {"lead": "Lead new product launches", "rest": "from market insight to the first prescription"},
    {"lead": "Craft the message", "rest": "— key messages, visual aids and campaigns doctors remember"},
    {"lead": "Turn data into decisions", "rest": "— market share, competitor moves and the return on every pound you spend"},
    {"lead": "Build KOL partnerships", "rest": "and run round tables, conferences and medical events"},
    {"lead": "Equip the field force", "rest": "with product training and the tools to win every call"}
  ]'::jsonb,
  needs = '[
    {"lead": "Minimum 2 years as a Product Manager", "rest": "in pharmaceutical companies — ideally with new launch experience"},
    {"lead": "Pharmacist or vet graduate", "rest": ""},
    {"lead": "Excellent communication and analytical skills", "rest": ""},
    {"lead": "Very good with Microsoft Office", "rest": "(PowerPoint, Excel, Word)"},
    {"lead": "Excellent command of written and spoken English", "rest": "is a must"},
    {"lead": "Greater Cairo resident", "rest": ""},
    {"lead": "Chest, ENT or Urology experience", "rest": "preferred"}
  ]'::jsonb,
  updated_at = now()
where lower(btrim(title)) = 'product manager'
  and headline is null
  and duties = '[
    {"lead": "Own your line''s marketing plan", "rest": "from positioning to launch and campaigns"},
    {"lead": "Equip the sales force", "rest": "with product training, visual aids and clear key messages"},
    {"lead": "Track line performance", "rest": "— sales, targets and market feedback — and act on it"},
    {"lead": "Plan and run medical events", "rest": "such as round tables, with the field teams"},
    {"lead": "Manage the line''s marketing budget", "rest": "and report what it delivered"}
  ]'::jsonb
  and needs = '[
    {"lead": "Minimum 2 years of experience", "rest": "as a Product Manager in pharmaceutical companies, preferably with new launch experience"},
    {"lead": "Pharmacist or vet graduate", "rest": ""},
    {"lead": "Excellent communication and analytical skills", "rest": ""},
    {"lead": "Very good in Microsoft Office", "rest": "(PowerPoint, Excel, Word)"},
    {"lead": "Excellent command of written and spoken English", "rest": "is a must"},
    {"lead": "Greater Cairo resident", "rest": ""},
    {"lead": "Preferably experience in Chest, ENT or Urology specialities", "rest": "— or in more than one of them"}
  ]'::jsonb;

commit;
