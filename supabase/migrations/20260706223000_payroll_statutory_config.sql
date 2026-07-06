-- Payroll Copilot — Phase 2: statutory (tax + social insurance) configuration.
--
-- Holds the effective-dated Egyptian statutory parameters the Payroll Copilot
-- uses to COMPUTE social insurance and income tax (previously these amounts were
-- carried/uploaded). Editable when the law changes — no code deploy needed.
--
-- Also adds employees.social_insurance_wage: the per-employee "insurance/subject
-- wage" (Law 148/2019). Employee SI = si_employee_rate x clamp(wage, min, max).
--
-- Seeded with the 2026 figures confirmed by the owner (Law 7 of 2024 brackets +
-- EGP 20,000 exemption; SI 11%/18.75%, monthly caps 2,700 / 16,700). The
-- high-earner tax phase-out (>EGP 600k/yr) is intentionally NOT modelled yet
-- (Phase 2 = standard brackets; phase-out is a later, separately-verified step).

create table if not exists public.payroll_statutory_config (
  id uuid primary key default gen_random_uuid(),
  effective_from date not null,
  label text null,
  -- Income tax
  personal_exemption_annual numeric(20, 2) not null,
  disabled_exemption_annual numeric(20, 2) not null,
  -- Ordered marginal brackets: [{ "up_to": <EGP annual, null = top>, "rate": <fraction> }]
  tax_brackets jsonb not null,
  taxable_rounding_step integer not null default 10,
  -- Social insurance (Law 148/2019)
  si_employee_rate numeric(6, 5) not null,
  si_employer_rate numeric(6, 5) not null,
  si_min_monthly_wage numeric(20, 2) not null,
  si_max_monthly_wage numeric(20, 2) not null,
  created_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_statutory_config_effective_from_unique unique (effective_from)
);

create index if not exists payroll_statutory_config_effective_from_idx
  on public.payroll_statutory_config (effective_from desc);

alter table public.payroll_statutory_config enable row level security;

do $$
begin
  execute 'drop policy if exists payroll_statutory_config_admin_select on public.payroll_statutory_config';
  execute 'create policy payroll_statutory_config_admin_select on public.payroll_statutory_config for select to authenticated using (public.current_access_can_manage_employees())';
  execute 'drop policy if exists payroll_statutory_config_admin_insert on public.payroll_statutory_config';
  execute 'create policy payroll_statutory_config_admin_insert on public.payroll_statutory_config for insert to authenticated with check (public.current_access_can_manage_employees())';
  execute 'drop policy if exists payroll_statutory_config_admin_update on public.payroll_statutory_config';
  execute 'create policy payroll_statutory_config_admin_update on public.payroll_statutory_config for update to authenticated using (public.current_access_can_manage_employees()) with check (public.current_access_can_manage_employees())';
  execute 'drop policy if exists payroll_statutory_config_admin_delete on public.payroll_statutory_config';
  execute 'create policy payroll_statutory_config_admin_delete on public.payroll_statutory_config for delete to authenticated using (public.current_access_can_manage_employees())';
end $$;

-- Per-employee social-insurance (subject) wage.
alter table public.employees
  add column if not exists social_insurance_wage numeric(20, 2) null;

-- Seed the confirmed 2026 statutory parameters (idempotent on effective_from).
insert into public.payroll_statutory_config (
  effective_from, label,
  personal_exemption_annual, disabled_exemption_annual,
  tax_brackets, taxable_rounding_step,
  si_employee_rate, si_employer_rate, si_min_monthly_wage, si_max_monthly_wage,
  created_by
)
values (
  date '2026-01-01',
  'Egypt 2026 (Law 7/2024 brackets + EGP 20k exemption; SI Law 148/2019, 2026 caps)',
  20000.00, 30000.00,
  '[
    {"up_to": 40000, "rate": 0.0},
    {"up_to": 55000, "rate": 0.10},
    {"up_to": 70000, "rate": 0.15},
    {"up_to": 200000, "rate": 0.20},
    {"up_to": 400000, "rate": 0.225},
    {"up_to": 1200000, "rate": 0.25},
    {"up_to": null, "rate": 0.275}
  ]'::jsonb,
  10,
  0.11000, 0.18750, 2700.00, 16700.00,
  'system'
)
on conflict (effective_from) do nothing;
