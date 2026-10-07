-- The offer letter's role paragraph moves from the DESIGN to the JOB TITLE.
--
-- THE DEFECT. Three of the four shipped designs — including the HR-forms one production sends by
-- default — carried this sentence typed into the letter itself, for every position in the company:
--
--   "…the commercial judgement and the people leadership this district needs … you will be fully
--    accountable for the territory's sales performance — translating commercial strategy into an
--    executable district plan, leading and developing your field team…"
--
-- It was transcribed from one signed letter (Dr Samaa Shalaby, DSM Delta 3, SP-HR-DSM-2026-019) and
-- became the words EVERY offer says. So a letter to a Talent Acquisition Specialist promised them a
-- district's field team and its sales number, and the only way to change it was to rewrite the
-- design — which would have reworded the letter every medical representative receives as well. The
-- Letter Designer has no filter by position, correctly: it designs LOOKS. Nothing owned the WORDS.
--
-- AFTER THIS. The paragraph belongs to the position, beside the figures that already behave that
-- way, and reaches the letter as `{{roleSummary}}`. One design serves every position; a new position
-- is a row on the Job Titles screen, not a duplicated twenty-block letter.
--
-- NOTHING ALREADY SENT MOVES. All 36 offers on production carry a frozen `template_snapshot` and
-- none is a draft (read 2026-10-07), so every letter that exists renders from the blocks it was sent
-- with. And the three sales titles are seeded below with the EXACT paragraph they print today, so the
-- next field-force letter is byte-identical too.

-- ── 1. Where the words live ──────────────────────────────────────────────────────────────────────
-- NULL is a real answer and the default: "nobody has worded this position yet", which prints the
-- role-neutral standard sentence rather than leaving a hole in a legal document.
alter table public.offer_job_titles
  add column if not exists role_summary text;

comment on column public.offer_job_titles.role_summary is
  'What the offer letter says this job IS - the paragraph after the greeting, reaching the letter as {{roleSummary}}. NULL means nobody has worded this position yet and the role-neutral standard sentence prints instead (src/lib/offers/role-summary.ts). Plain text, not HTML: it is escaped on the way into the letter, so write a real em dash, never &mdash;. {{territory}} and the other offer tokens DO work inside it.';

-- ── 2. What one letter says ──────────────────────────────────────────────────────────────────────
-- Copied onto the offer when the title is chosen, and editable for that one letter. A COPY, not a
-- live lookup: an offer must say tomorrow what the candidate signed today, so rewording a position
-- must never restate a letter already in somebody's inbox. '' prints the standard sentence, which is
-- what every offer written before this column carries.
alter table public.offers
  add column if not exists role_summary text not null default '';

comment on column public.offers.role_summary is
  'This letter''s own role paragraph, copied from the job title when it was chosen and overridable here. Empty prints the standard sentence. Never resolved from the live job title at render time - that would silently restate a letter already sent.';

-- ── 3. The three sales titles keep exactly the paragraph they print today ────────────────────────
-- Guarded on NULL so re-running this never overwrites wording somebody has since typed, and matched
-- case-insensitively on the trimmed title because that is how the catalogue's own unique index reads.
update public.offer_job_titles
set role_summary =
  'Throughout our selection process you demonstrated the commercial judgement and the people '
  || 'leadership this district needs, and we would like you to bring both to {{territory}}. In this '
  || 'role you will be fully accountable for the territory' || chr(8217) || 's sales performance '
  || chr(8212) || ' translating commercial strategy into an executable district plan, leading and '
  || 'developing your field team, and driving sustainable growth and market expansion.'
where role_summary is null
  and lower(btrim(title)) in ('national sales manager', 'district sales manager', 'medical representative');

-- ── 4. Talent Acquisition — the position this whole change exists for ────────────────────────────
-- The title is already in the catalogue on production and had nothing to say about itself, so its
-- letter would have opened by telling a recruiter they were accountable for a territory's sales
-- number. A STARTING POINT like every other: it is a textarea on the Job Titles screen, and the same
-- NULL guard means a reword is never undone by re-running this.
update public.offer_job_titles
set role_summary =
  'Throughout our selection process you demonstrated the judgement and the people skills this role '
  || 'calls for, and we would like you to bring both to our Human Resources team. In this role you '
  || 'will own hiring end to end ' || chr(8212) || ' building the pipeline for the seats the business '
  || 'is opening, screening and interviewing with care, keeping every candidate properly informed, '
  || 'and giving the hiring managers you support a shortlist they can decide on.'
where role_summary is null
  and lower(btrim(title)) in ('talent acquisition', 'talent acquisition specialist');
