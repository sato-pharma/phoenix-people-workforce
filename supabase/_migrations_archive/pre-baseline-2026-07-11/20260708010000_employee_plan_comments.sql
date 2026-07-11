-- Weekly / Monthly Plan two-way conversation.
-- A plan-level comment thread so the submitter can reply to a return/edit-request
-- and any participant in the approval chain (manager, CEO, HR/Super Admin) can
-- comment — not just post a one-shot decision comment. Additive only; does not
-- change employee_plan_decisions or employee_plan_item_return_notes, which stay
-- as the append-only audit trail and per-row return notes respectively.

create table if not exists public.employee_plan_comments (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.employee_plan_headers(id) on delete cascade,
  -- Optional anchor to a specific day's activity, so a comment can point at "Tuesday" without
  -- being limited to it — the thread itself is always plan-level.
  item_id uuid references public.employee_plan_items(id) on delete set null,
  -- Optional reply-to, for a threaded (not just flat) conversation.
  parent_id uuid references public.employee_plan_comments(id) on delete set null,
  author_hr_id text not null,
  author_login_id text,
  author_role text,
  body text not null check (btrim(body) <> ''),
  created_at timestamptz not null default now()
);

create index if not exists employee_plan_comments_plan_idx
  on public.employee_plan_comments(plan_id, created_at asc);

create index if not exists employee_plan_comments_item_idx
  on public.employee_plan_comments(item_id, created_at asc);

create index if not exists employee_plan_comments_parent_idx
  on public.employee_plan_comments(parent_id);

alter table public.employee_plan_comments enable row level security;

-- Same boundary as employee_plan_item_return_notes / employee_plan_decisions: the app never
-- talks to Supabase as anon/authenticated for this domain, only via the server-side service-role
-- client (src/lib/supabase/server.ts getSupabaseAdmin()), which already enforces the real
-- application-level authorization (canViewPlan) before reading or writing a row here.
revoke all on table public.employee_plan_comments from anon, authenticated;
grant select, insert, update, delete on public.employee_plan_comments to service_role;

drop policy if exists employee_plan_comments_service_role on public.employee_plan_comments;
create policy employee_plan_comments_service_role
  on public.employee_plan_comments
  for all
  to service_role
  using (true)
  with check (true);
