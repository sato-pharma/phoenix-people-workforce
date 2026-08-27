-- The job-offer module: editable letter templates, a per-title cost-of-living catalogue, and the
-- offers themselves.
--
-- WHY A SEPARATE MODULE. The owner asked for one explicitly, and the reason is operational rather
-- than architectural: `src/lib/recruitment/offers.ts` models the offer STAGE of a hiring pipeline,
-- which only exists for somebody who entered the ATS as a candidate. He needs to issue an offer to
-- anybody — a referral, a direct approach, a rehire — without first manufacturing a fake
-- application to hang it on. Nothing here references a candidate, an application or a pipeline
-- stage, and the two must not be merged later.
--
-- WHAT IS ACTUALLY NEW HERE. The `offers` permission resource already exists in
-- src/lib/auth/permissions.ts and is already granted (HR authority roles plus Talent Acquisition),
-- with no table behind it. The Dockerfile already installs Chromium and puppeteer-core explicitly
-- "for server-side PDF generation of offer letters". `JOB_OFFER_EMAIL_FROM` already exists in
-- .env.example, docs/environment.md and the Railway secret sync. All of it was scaffolded and
-- none of it was ever used. This migration is the missing half.
--
-- NO RLS POLICIES, DELIBERATELY. Visibility in this app is application-scoped: every read path
-- goes through the service-role client, which bypasses RLS, and the actual gate is
-- `assertPermission(ctx, "offers", action)` in the route handler. RLS is enabled with no policy
-- so that a stray anon/authenticated client reaching these tables directly reads NOTHING — the
-- "RLS on, no grant" shape that is the norm in this schema, not an oversight. An offer row holds
-- somebody's salary before they have accepted a job; it must never be anon-readable.

begin;

-- ── 1. Templates ────────────────────────────────────────────────────────────────────────────────
-- A template is an ordered list of BLOCKS stored as JSON, not a blob of HTML. That is what lets a
-- non-engineer reorder, recolour, retitle or delete any part of the letter without a deploy, and
-- what lets the same stored design be re-rendered by two different renderers (print/PDF and the
-- table-based email body) instead of being frozen into one.
create table if not exists public.offer_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- Exactly one row may carry this; enforced by the partial unique index below. It is the design
  -- the owner uploaded, it is what a new offer opens on, and it can be restored after any amount
  -- of editing.
  is_default boolean not null default false,
  blocks jsonb not null default '[]'::jsonb,
  -- The twelve CSS custom properties that drive every colour in the document (fifteen is the
  -- number of BLOCK types, which is a different list — see OFFER_BLOCK_DEFS).
  theme jsonb not null default '{}'::jsonb,
  font_family text not null default '''Open Sans'',Arial,Helvetica,sans-serif',
  font_size_pt numeric(4, 2) not null default 9.9,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offer_templates_name_not_blank check (btrim(name) <> ''),
  constraint offer_templates_blocks_is_array check (jsonb_typeof(blocks) = 'array'),
  constraint offer_templates_theme_is_object check (jsonb_typeof(theme) = 'object'),
  -- A font size outside this range is a typo, and it would render an unreadable legal document.
  constraint offer_templates_font_size_sane check (font_size_pt between 5 and 24)
);

-- "Exactly one default" as a database fact rather than an application convention. Two defaults
-- would make "which template does a new offer open on" answer differently depending on row order.
create unique index if not exists offer_templates_one_default_idx
  on public.offer_templates (is_default)
  where is_default;

-- ── 2. The job-title catalogue ──────────────────────────────────────────────────────────────────
-- Cost of living is flat PER TITLE, never per person — that is the rule the three signed offers
-- establish, and it is the whole reason one typed number can produce the entire compensation
-- table. The three seed rows below are the owner's own figures, given directly on 2026-08-26.
create table if not exists public.offer_job_titles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  cost_of_living numeric(12, 2) not null default 0,
  reports_to text,
  contract_term text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offer_job_titles_title_not_blank check (btrim(title) <> ''),
  -- A negative cost of living would INFLATE basic and transport, silently, on a signed offer.
  constraint offer_job_titles_cost_of_living_non_negative check (cost_of_living >= 0)
);

-- Case-insensitive, because "Medical Representative" and "Medical representative" being two rows
-- is how one of them silently stops driving cost of living.
create unique index if not exists offer_job_titles_title_norm_idx
  on public.offer_job_titles (lower(btrim(title)));

-- ── 3. The offers ───────────────────────────────────────────────────────────────────────────────
create table if not exists public.offers (
  id uuid primary key default gen_random_uuid(),

  -- Who it is for. `candidate_email` is an EXTERNAL address by definition; the Recipient Assurance
  -- Guard blocks any address not in the employee directory unless the send declares it, which the
  -- service does.
  candidate_name text not null,
  salutation_name text not null default '',
  candidate_email text not null,

  -- What is being offered.
  title text not null,
  territory text not null default '',
  reports_to text not null default '',
  start_date text not null default '',
  contract_term text not null default '',
  reference text not null default '',
  date_of_issue text not null default '',
  valid_until text not null default '',

  -- The money. ONLY these two are stored: the total package as typed, and the cost of living that
  -- applied at the time. Basic, transport and every annual column are DERIVED on render by
  -- src/lib/offers/pay.ts. Storing them too would create a second source of truth that can drift
  -- from the formula, and the drift would show up as a letter whose table contradicts its header.
  total_monthly numeric(12, 2) not null default 0,
  cost_of_living numeric(12, 2) not null default 0,

  status text not null default 'draft',
  template_id uuid references public.offer_templates (id) on delete set null,

  -- The template AS RENDERED at send time. An offer that went out must never re-render differently
  -- later because somebody edited the template afterwards — the candidate holds a copy, and the
  -- copy is the contract. `template_id` alone cannot promise that; this snapshot can.
  template_snapshot jsonb,

  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_by text,
  sent_at timestamptz,

  constraint offers_status_known check (status in ('draft', 'sent', 'accepted', 'declined', 'withdrawn')),
  constraint offers_candidate_name_not_blank check (btrim(candidate_name) <> ''),
  constraint offers_total_monthly_non_negative check (total_monthly >= 0),
  constraint offers_cost_of_living_non_negative check (cost_of_living >= 0),
  -- Cost of living cannot exceed the package it is carved out of; that would derive a negative
  -- basic salary. The renderer clamps defensively too, but a nonsense row should not exist.
  constraint offers_cost_of_living_within_package check (cost_of_living <= total_monthly),
  -- A sent offer must know when it went. Without this, "has this been sent?" has two answers.
  constraint offers_sent_at_present_when_sent check (status = 'draft' or sent_at is not null)
);

create index if not exists offers_status_created_idx on public.offers (status, created_at desc);
create index if not exists offers_candidate_email_idx on public.offers (lower(btrim(candidate_email)));

-- ── 4. updated_at ───────────────────────────────────────────────────────────────────────────────
-- public.touch_updated_at() already exists in the baseline schema and is what expense_claims and
-- friends use. Reusing it rather than adding a fourth near-identical trigger function.
do $$
begin
  if to_regprocedure('public.touch_updated_at()') is not null then
    if not exists (select 1 from pg_trigger where tgname = 'offer_templates_touch_updated_at') then
      create trigger offer_templates_touch_updated_at
        before update on public.offer_templates
        for each row execute function public.touch_updated_at();
    end if;
    if not exists (select 1 from pg_trigger where tgname = 'offer_job_titles_touch_updated_at') then
      create trigger offer_job_titles_touch_updated_at
        before update on public.offer_job_titles
        for each row execute function public.touch_updated_at();
    end if;
    if not exists (select 1 from pg_trigger where tgname = 'offers_touch_updated_at') then
      create trigger offers_touch_updated_at
        before update on public.offers
        for each row execute function public.touch_updated_at();
    end if;
  end if;
end
$$;

-- ── 5. RLS on, no policy ────────────────────────────────────────────────────────────────────────
-- See the header. This is a deny-by-default wall behind the application's own permission check,
-- not a substitute for it.
alter table public.offer_templates enable row level security;
alter table public.offer_job_titles enable row level security;
alter table public.offers enable row level security;

-- ── 6. Seed the job titles ──────────────────────────────────────────────────────────────────────
-- The owner's three figures, given directly on 2026-08-26. Two are additionally corroborated by
-- signed offers: District Sales Manager by SP-HR-DSM-2026-019 (30,000 total → 18,550 / 7,950 /
-- 3,500) and Medical Representative by two more. `on conflict do nothing` so re-running this
-- migration never overwrites a figure HR has since changed in the UI.
insert into public.offer_job_titles (title, cost_of_living, reports_to, contract_term)
values
  ('National Sales Manager', 5500, 'Chief Executive Officer', 'One year, renewable'),
  ('District Sales Manager', 3500, 'National Sales Manager', 'One year, renewable'),
  ('Medical Representative', 2500, 'District Sales Manager', 'One year, renewable')
on conflict do nothing;

-- The default template itself is NOT seeded in SQL. Its block structure lives in
-- src/lib/offers/default-template.ts, and duplicating ~20 blocks of JSON here would create a
-- second copy that drifts from the renderer that reads it. The service seeds it on first read
-- (`ensureDefaultTemplate`), which also means "Restore SATO default" keeps working forever.

commit;
