-- Company device register — the asset half of the custody receipt.
--
-- WHY THIS EXISTS. `src/lib/hiring-pack/custody-text.ts` holds the owner's own Arabic
-- «إقرار استلام عهدة» in two numbered forms — نموذج رقم 1 for a laptop, with the Windows "About"
-- block, and نموذج رقم 2 for a phone or tablet, with IMEI, رقم الشريحة and رقم الخط. Fifteen
-- undertakings, three signatures, and a full محضر رد العهدة. The paper is complete.
--
-- Every technical field on it prints as a ruled blank. In `custody-text.ts` the Serial Number
-- (:172) and the IMEI (:219) both carry `token: null`, and `custody-template.ts` says plainly why:
-- "Phoenix holds no asset register". Somebody writes the number in with a pen, the paper is filed,
-- and the number never enters a database. A sweep of every migration in this repository before this
-- one finds exactly one device-shaped table — `attendance_device_user_map` — and that is the
-- fingerprint clocks.
--
-- So today Phoenix knows WHO signed for a device and not WHICH device. When a tablet walks, there
-- is a signed Arabic undertaking naming a person, and no IMEI to give the police, no serial to
-- blocklist, and no way to answer "how many do we own and where are they".
--
-- ---------------------------------------------------------------------------
-- WHY TWO TABLES AND NOT ONE.
-- ---------------------------------------------------------------------------
-- A device OUTLIVES any one holder. One row per handover would answer "who signed for this?" and
-- would not answer "how many tablets do we own", "which are unissued", or "what happened to the one
-- H-3003 returned in March" — and those are half the questions the register is being built for. So
-- `company_devices` is the thing the company OWNS, and `device_assignments` is one custody EVENT
-- against it. A laptop reissued to four people over its life is one device row and four assignment
-- rows, and both questions stay answerable.
--
-- ---------------------------------------------------------------------------
-- THE ESTIMATED VALUE IS SNAPSHOTTED ONTO THE ASSIGNMENT, DELIBERATELY.
-- ---------------------------------------------------------------------------
-- البند (9) of the receipt: «القيمة المدونة قرين كل صنف قيمة تقديرية متفق عليها لأغراض تسوية
-- العهدة، وقد اطلعت عليها وقبلتها عند التوقيع» — the value AS IT STOOD WHEN HE SIGNED is what was
-- agreed, and البند (10) caps any wage deduction at that figure. If the assignment read the value
-- live off the device, a later revaluation would silently change what somebody had already signed
-- for, and it would change it in the direction of owing more. It is copied at issue and frozen.
--
-- ---------------------------------------------------------------------------
-- A LOST DEVICE DOES NOT CLOSE ITS ASSIGNMENT.
-- ---------------------------------------------------------------------------
-- The instinct is that `lost` or `stolen` ends the custody. البند (10) says the opposite: where the
-- device is not returned, the holder owes its value, and البند (5) requires a police report before
-- البند (11) can excuse him. So marking a device lost leaves the assignment OUTSTANDING and the
-- person still owing it. Only a recorded return, or an explicit write-off carrying a reason, closes
-- one. Closing it on `lost` would erase the debt at exactly the moment it is incurred.
--
-- ---------------------------------------------------------------------------
-- NOTHING IS BACKFILLED, AND THAT IS THE OPPOSITE CALL TO 20260830001000.
-- ---------------------------------------------------------------------------
-- The mailbox register backfilled 52 leavers because those rows were a PRESENT EXPOSURE that
-- already existed and could be derived — a live credential per row, computable from
-- `employees.work_email`. There is no equivalent source here. No table, no column and no file in
-- this repository records which laptop or tablet any person holds; the data exists only on the
-- devices themselves and on paper in a filing cabinet. A backfill would therefore have to INVENT
-- serials, and an invented serial in an asset register is worse than an empty one: it reads as
-- evidence. The register starts empty and fills as devices are issued and as the existing fleet is
-- walked and entered by hand.

begin;

-- ---------------------------------------------------------------------------
-- 1. The devices the company owns
-- ---------------------------------------------------------------------------

create table if not exists public.company_devices (
  id uuid primary key default gen_random_uuid(),

  -- The human handle. Owner rule (AGENTS.md §4): show human-readable names, never raw codes — a
  -- uuid is unusable on a sticker, in a corridor conversation or on a police report, so every
  -- device carries a tag somebody can read off the case. Unique case-insensitively via the index
  -- below: tags get typed in both cases and PHX-LAP-0007 and phx-lap-0007 are one device.
  asset_tag text not null check (char_length(trim(asset_tag)) > 0),

  -- Which of the two custody forms this device prints on. `laptop` takes نموذج رقم 1 with the
  -- Windows block; `tablet` and `phone` take نموذج رقم 2 with IMEI and SIM. `other` exists for a
  -- monitor or a dongle that still needs signing for and has no technical block of its own.
  category text not null check (category in ('laptop', 'tablet', 'phone', 'other')),

  manufacturer text,
  model text,

  -- ---------------------------------------------------------------------------
  -- IDENTITY. The whole reason the register exists.
  -- ---------------------------------------------------------------------------
  -- A serial or an IMEI is what a police report, an insurance claim and an operator blocklist all
  -- ask for, and it is the one thing the paper form never captured. A row carrying neither is a
  -- note that the company owns "a laptop" — it cannot identify the machine to anybody, which is
  -- the exact failure this table is built to end. The CHECK below refuses such a row rather than
  -- letting it sit in the register looking like coverage.
  serial_number text,
  imei text,

  -- نموذج رقم 1's البيانات الفنية, field for field with the Windows Settings → System → About
  -- screen the form was written against. Named for what the screen calls them so the person typing
  -- them in is copying like-for-like.
  device_name text,
  processor text,
  installed_ram text,
  system_type text,
  windows_device_id text,
  windows_product_id text,

  -- نموذج رقم 2's block. The SIM travels with the device and is signed for on the same form
  -- (item 7, «شريحة اتصال»), so it belongs on the device rather than in a separate telecom table.
  sim_number text,
  line_number text,

  -- القيمة التقديرية — البند (9). EGP. The ceiling on any wage deduction under البند (10), so it
  -- is money and is refused negative.
  estimated_value_egp numeric(12, 2) check (estimated_value_egp is null or estimated_value_egp >= 0),

  purchased_on date,

  -- in_stock  — owned, held by the company, ready to issue.
  -- assigned  — somebody has signed for it. Set by phx_device_issue, never by hand.
  -- repair    — with IT or a vendor. Not issuable.
  -- lost      — gone, cause unknown or the holder's account accepted.
  -- stolen    — gone, and a محضر was filed under البند (5). Kept apart from `lost` because the two
  --             differ in what the company can then do: a police report supports an insurance
  --             claim and an operator blocklist, and البند (11) can excuse the holder entirely.
  -- retired   — end of life, disposed of or written off. Terminal.
  --
  -- Only the three functions below write this column.
  status text not null default 'in_stock'
    check (status in ('in_stock', 'assigned', 'repair', 'lost', 'stolen', 'retired')),

  -- Why it is lost, stolen, retired or in repair. Required for those four by the CHECK below: a
  -- device that has left the fleet with no recorded reason is indistinguishable from a typo.
  status_reason text,
  status_changed_at timestamptz,
  status_changed_by text,

  note text,

  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),

  -- A device nobody can identify is not an asset record. See the identity note above.
  constraint company_devices_identifiable check (
    (serial_number is not null and char_length(trim(serial_number)) > 0)
    or (imei is not null and char_length(trim(imei)) > 0)
  ),

  -- A status that names an event must carry the event's reason — the same rule
  -- mailbox_offboarding_tasks applies to `not_applicable`.
  constraint company_devices_status_reason_required check (
    status not in ('lost', 'stolen', 'retired', 'repair')
    or (status_reason is not null and char_length(trim(status_reason)) > 0)
  )
);

-- Case-insensitive, because all three of these get typed by hand off a sticker or a settings
-- screen. A duplicate serial in an asset register means two rows claiming one machine, and the
-- register then answers "where is it" two different ways.
create unique index if not exists uq_company_devices_asset_tag
  on public.company_devices (lower(asset_tag));

create unique index if not exists uq_company_devices_serial
  on public.company_devices (lower(serial_number))
  where serial_number is not null and char_length(trim(serial_number)) > 0;

create unique index if not exists uq_company_devices_imei
  on public.company_devices (lower(imei))
  where imei is not null and char_length(trim(imei)) > 0;

create index if not exists idx_company_devices_status
  on public.company_devices (status, category);

comment on table public.company_devices is
  'Every laptop, tablet and phone the company owns. The asset half of the custody receipt '
  '(إقرار استلام عهدة) — a row exists so that a serial or an IMEI can be produced for a police '
  'report, an operator blocklist or an insurance claim.';

comment on constraint company_devices_identifiable on public.company_devices is
  'A device row with neither a serial nor an IMEI identifies nothing to anybody, which is the '
  'failure the register exists to end. Refused rather than stored as false coverage.';

-- ---------------------------------------------------------------------------
-- 2. Custody — one row per handover
-- ---------------------------------------------------------------------------

create table if not exists public.device_assignments (
  id uuid primary key default gen_random_uuid(),

  -- ON DELETE RESTRICT, not CASCADE. An assignment is the record that a named person signed for a
  -- named machine; deleting the device must not silently delete the evidence. AGENTS.md §2.1
  -- carries the wider version of this: a CASCADE runs as the table owner and takes surfaces a
  -- dependency sweep never sees.
  device_id uuid not null references public.company_devices (id) on delete restrict,

  -- Not a foreign key to employees(hr_id), for the reason mailbox_offboarding_tasks gives at
  -- length: hr_id is MIXED CASE in this database and every comparison in the app runs through
  -- lower(). A FK would impose exact-case matching nothing else honours.
  employee_hr_id text not null check (char_length(trim(employee_hr_id)) > 0),

  -- Snapshotted at issue. The person's name and title AS THE RECEIPT WAS SIGNED are what the
  -- custody trail is about; a later directory correction must not rewrite a signed instrument.
  employee_name text not null,
  job_title text,

  -- رقم الإقرار and مكان التسليم — two of the header boxes the form asks for and Phoenix could
  -- never answer. تاريخ التسليم is `issued_on`.
  declaration_no text,
  handover_place text,

  issued_on date not null default (now() at time zone 'Africa/Cairo')::date,
  issued_by text,

  -- Frozen at issue — see the header. This, not the device's current value, is the ceiling
  -- البند (10) puts on any deduction from this person's wages.
  agreed_value_egp numeric(12, 2) check (agreed_value_egp is null or agreed_value_egp >= 0),

  -- outstanding — he holds it. The only state that owes anything.
  -- returned    — محضر رد العهدة completed. البند (8): a return is proven by nothing else.
  -- written_off — closed without the device coming back, carrying a reason and usually a
  --               settlement. The deliberate, recorded end to a debt البند (10) creates.
  status text not null default 'outstanding'
    check (status in ('outstanding', 'returned', 'written_off')),

  -- محضر رد العهدة, in columns.
  returned_on date,
  returned_by text,
  -- الحالة عند الرد — how it came back. `damaged` and `incomplete` are what البند (10) prices.
  return_condition text
    check (return_condition is null or return_condition in ('good', 'damaged', 'incomplete')),
  -- الناقص أو التالف — what was missing or broken.
  shortfall_note text,
  -- إجمالي ما يُحتسب — what is actually being charged. Capped at the agreed value by the CHECK
  -- below, which is البند (10) expressed as a constraint: «بما لا يجاوز القيمة التقديرية».
  settlement_egp numeric(12, 2) check (settlement_egp is null or settlement_egp >= 0),

  reason text,
  note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- البند (10), in the database. The receipt caps recovery at the estimated value the holder saw
  -- and accepted when he signed. A settlement above it is not a data-entry slip to be tidied later
  -- — it is a wage deduction larger than the instrument authorises.
  constraint device_assignments_settlement_within_agreed check (
    settlement_egp is null
    or agreed_value_egp is null
    or settlement_egp <= agreed_value_egp
  ),

  -- A closed row must say how it closed. A `returned` row with no date cannot evidence البند (8);
  -- a `written_off` row with no reason is a debt that vanished without anybody owning the decision.
  constraint device_assignments_return_recorded check (
    status <> 'returned'
    or (returned_on is not null and return_condition is not null)
  ),
  constraint device_assignments_write_off_reason check (
    status <> 'written_off'
    or (reason is not null and char_length(trim(reason)) > 0)
  )
);

-- One live holder per device. Without this, two people can each hold a signed receipt for the same
-- laptop and the register cannot say which of them has it — which is the state the paper filing
-- cabinet is already in.
create unique index if not exists uq_device_assignments_outstanding_device
  on public.device_assignments (device_id)
  where status = 'outstanding';

-- The clearance query: "what does this person still hold". Lowered, per the hr_id rule above.
create index if not exists idx_device_assignments_employee
  on public.device_assignments (lower(employee_hr_id), status);

create index if not exists idx_device_assignments_status
  on public.device_assignments (status, issued_on);

comment on table public.device_assignments is
  'One custody event: a named person signed for a named device on a date. Closed only by a '
  'recorded return (محضر رد العهدة, البند 8) or an explicit write-off carrying a reason.';

comment on constraint device_assignments_settlement_within_agreed on public.device_assignments is
  'البند (10) of the custody receipt caps recovery at the estimated value shown at signature. A '
  'settlement above it would be a wage deduction the signed instrument does not authorise.';

-- ---------------------------------------------------------------------------
-- 3. Issuing a device
-- ---------------------------------------------------------------------------

create or replace function public.phx_device_issue(
  p_device_id uuid,
  p_employee_hr_id text,
  p_actor text,
  p_declaration_no text default null,
  p_handover_place text default null,
  p_issued_on date default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.company_devices%rowtype;
  v_employee record;
  v_assignment_id uuid;
begin
  if p_actor is null or char_length(trim(p_actor)) = 0 then
    raise exception 'Issuing a device must record who handed it over.';
  end if;

  select * into v_device from public.company_devices where id = p_device_id;
  if not found then
    raise exception 'Device % was not found.', p_device_id;
  end if;

  -- A device that is lost, stolen, retired or in repair is not in the building. Issuing one
  -- produces a signed receipt for a machine nobody can hand over.
  if v_device.status <> 'in_stock' then
    raise exception 'Device % is %, not in stock. Only a device in stock can be issued.',
      v_device.asset_tag, v_device.status;
  end if;

  -- Belt and braces over uq_device_assignments_outstanding_device. The index is the real guard;
  -- this raises the readable error instead of a constraint-violation string.
  if exists (
    select 1 from public.device_assignments
    where device_id = p_device_id and status = 'outstanding'
  ) then
    raise exception 'Device % is already signed out to somebody.', v_device.asset_tag;
  end if;

  -- lower() on BOTH sides — hr_id is mixed case in this database and a plain `=` silently
  -- under-returns.
  select e.hr_id, e.full_name, e.nickname, e.job_title
  into v_employee
  from public.employees e
  where lower(e.hr_id) = lower(trim(p_employee_hr_id))
  limit 1;

  if not found then
    raise exception 'No employee matches HR ID %.', p_employee_hr_id;
  end if;

  insert into public.device_assignments (
    device_id, employee_hr_id, employee_name, job_title,
    declaration_no, handover_place, issued_on, issued_by, agreed_value_egp
  )
  values (
    p_device_id,
    v_employee.hr_id,
    coalesce(nullif(trim(v_employee.full_name), ''), v_employee.hr_id),
    v_employee.job_title,
    nullif(trim(p_declaration_no), ''),
    nullif(trim(p_handover_place), ''),
    coalesce(p_issued_on, (now() at time zone 'Africa/Cairo')::date),
    p_actor,
    -- Frozen here, on purpose. See the migration header: البند (9) makes the value shown at
    -- signature the agreed one, and البند (10) caps recovery at it.
    v_device.estimated_value_egp
  )
  returning id into v_assignment_id;

  update public.company_devices
  set status = 'assigned',
      status_reason = null,
      status_changed_at = now(),
      status_changed_by = p_actor,
      updated_at = now()
  where id = p_device_id;

  return v_assignment_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. محضر رد العهدة — recording a return
-- ---------------------------------------------------------------------------

create or replace function public.phx_device_return(
  p_assignment_id uuid,
  p_actor text,
  p_condition text,
  p_shortfall_note text default null,
  p_settlement_egp numeric default null,
  p_returned_on date default null,
  p_note text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.device_assignments%rowtype;
begin
  if p_actor is null or char_length(trim(p_actor)) = 0 then
    raise exception 'A return must record who received the device.';
  end if;

  select * into v_row from public.device_assignments where id = p_assignment_id;
  if not found then
    raise exception 'Device assignment % was not found.', p_assignment_id;
  end if;

  if v_row.status <> 'outstanding' then
    raise exception 'This custody record is already closed as %.', v_row.status;
  end if;

  if p_condition is null or p_condition not in ('good', 'damaged', 'incomplete') then
    raise exception 'A return must state the condition: good, damaged or incomplete.';
  end if;

  -- البند (10) in the database. The service checks it too, but a rule in a page is bypassed by the
  -- next page — and this one decides how much may come out of somebody's wages.
  if p_settlement_egp is not null
     and v_row.agreed_value_egp is not null
     and p_settlement_egp > v_row.agreed_value_egp then
    raise exception
      'A settlement of % exceeds the % agreed on the signed receipt. البند (10) caps recovery at the estimated value.',
      p_settlement_egp, v_row.agreed_value_egp;
  end if;

  -- Something missing or broken must say what. البند (10) prices «ما لم يُرد أو تكلفة إصلاح ما
  -- تلف» — an unexplained charge cannot be defended to the person paying it.
  if p_condition in ('damaged', 'incomplete')
     and (p_shortfall_note is null or char_length(trim(p_shortfall_note)) = 0) then
    raise exception 'A damaged or incomplete return must record what was missing or broken.';
  end if;

  update public.device_assignments
  set status = 'returned',
      returned_on = coalesce(p_returned_on, (now() at time zone 'Africa/Cairo')::date),
      returned_by = p_actor,
      return_condition = p_condition,
      shortfall_note = nullif(trim(p_shortfall_note), ''),
      settlement_egp = p_settlement_egp,
      note = coalesce(nullif(trim(p_note), ''), note),
      updated_at = now()
  where id = p_assignment_id;

  -- A device that came back broken goes to `repair`, not straight back into stock — issuing it to
  -- the next person is how a known fault becomes the next holder's liability under البند (1),
  -- which has him accepting it «بحالتها المدونة بهذا الإقرار».
  update public.company_devices
  set status = case when p_condition = 'good' then 'in_stock' else 'repair' end,
      status_reason = case
        when p_condition = 'good' then null
        else coalesce(nullif(trim(p_shortfall_note), ''), 'Returned ' || p_condition)
      end,
      status_changed_at = now(),
      status_changed_by = p_actor,
      updated_at = now()
  where id = v_row.device_id;

  return 'returned';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Marking a device lost, stolen, retired, in repair, or back in stock
-- ---------------------------------------------------------------------------

create or replace function public.phx_device_mark(
  p_device_id uuid,
  p_status text,
  p_actor text,
  p_reason text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.company_devices%rowtype;
begin
  if p_actor is null or char_length(trim(p_actor)) = 0 then
    raise exception 'A device status change must record who made it.';
  end if;

  select * into v_device from public.company_devices where id = p_device_id;
  if not found then
    raise exception 'Device % was not found.', p_device_id;
  end if;

  -- `assigned` is not settable by hand: it is what phx_device_issue means. Letting it be typed
  -- would produce a device marked as held by nobody in particular.
  if p_status not in ('in_stock', 'repair', 'lost', 'stolen', 'retired') then
    raise exception 'Unknown device status %. Issue a device to make it assigned.', p_status;
  end if;

  if p_status in ('lost', 'stolen', 'retired', 'repair')
     and (p_reason is null or char_length(trim(p_reason)) = 0) then
    raise exception 'Marking a device % needs a written reason.', p_status;
  end if;

  -- THE RULE THIS FUNCTION EXISTS FOR. A device that is lost or stolen while somebody holds it
  -- does NOT release him: البند (10) makes the holder owe its value where it is not returned, and
  -- البند (11) excuses him only once he has proved force majeure and filed the محضر البند (5)
  -- requires. So the assignment is left OUTSTANDING here, deliberately, and closing it is a
  -- separate, recorded decision — phx_device_write_off — that somebody has to own.
  --
  -- Returning a device to `in_stock` while it is signed out is the mirror image and is refused
  -- outright: it would say the company holds a machine that is in somebody's bag.
  if p_status = 'in_stock' and exists (
    select 1 from public.device_assignments
    where device_id = p_device_id and status = 'outstanding'
  ) then
    raise exception
      'Device % is signed out. Record the return (محضر رد العهدة) rather than putting it back in stock.',
      v_device.asset_tag;
  end if;

  update public.company_devices
  set status = p_status,
      status_reason = nullif(trim(p_reason), ''),
      status_changed_at = now(),
      status_changed_by = p_actor,
      updated_at = now()
  where id = p_device_id;

  return p_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Closing a custody record without the device coming back
-- ---------------------------------------------------------------------------

create or replace function public.phx_device_write_off(
  p_assignment_id uuid,
  p_actor text,
  p_reason text,
  p_settlement_egp numeric default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.device_assignments%rowtype;
begin
  if p_actor is null or char_length(trim(p_actor)) = 0 then
    raise exception 'A write-off must record who decided it.';
  end if;
  if p_reason is null or char_length(trim(p_reason)) = 0 then
    raise exception 'A write-off needs a written reason — it ends a debt البند (10) created.';
  end if;

  select * into v_row from public.device_assignments where id = p_assignment_id;
  if not found then
    raise exception 'Device assignment % was not found.', p_assignment_id;
  end if;
  if v_row.status <> 'outstanding' then
    raise exception 'This custody record is already closed as %.', v_row.status;
  end if;

  if p_settlement_egp is not null
     and v_row.agreed_value_egp is not null
     and p_settlement_egp > v_row.agreed_value_egp then
    raise exception
      'A settlement of % exceeds the % agreed on the signed receipt. البند (10) caps recovery at the estimated value.',
      p_settlement_egp, v_row.agreed_value_egp;
  end if;

  update public.device_assignments
  set status = 'written_off',
      reason = trim(p_reason),
      settlement_egp = p_settlement_egp,
      updated_at = now()
  where id = p_assignment_id;

  return 'written_off';
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. RLS and grants
-- ---------------------------------------------------------------------------

-- Visibility in this app is application-scoped (AGENTS.md §8): every read runs on the service-role
-- client behind an assertPermission call. RLS on with no `authenticated` grant is the norm in this
-- database and is the right posture for a register naming what each employee carries and what it
-- is worth — no browser session reaches these tables at all.
alter table public.company_devices enable row level security;
alter table public.device_assignments enable row level security;

-- A SECURITY DEFINER function runs as its owner and bypasses RLS by design, so the default ACL
-- granting EXECUTE to PUBLIC is a hole straight through the posture above. Revoking PUBLIC also
-- strips service_role, so each is re-granted explicitly.
revoke execute on function public.phx_device_issue(p_device_id uuid, p_employee_hr_id text, p_actor text, p_declaration_no text, p_handover_place text, p_issued_on date) from public, anon, authenticated;
grant execute on function public.phx_device_issue(p_device_id uuid, p_employee_hr_id text, p_actor text, p_declaration_no text, p_handover_place text, p_issued_on date) to service_role;

revoke execute on function public.phx_device_return(p_assignment_id uuid, p_actor text, p_condition text, p_shortfall_note text, p_settlement_egp numeric, p_returned_on date, p_note text) from public, anon, authenticated;
grant execute on function public.phx_device_return(p_assignment_id uuid, p_actor text, p_condition text, p_shortfall_note text, p_settlement_egp numeric, p_returned_on date, p_note text) to service_role;

revoke execute on function public.phx_device_mark(p_device_id uuid, p_status text, p_actor text, p_reason text) from public, anon, authenticated;
grant execute on function public.phx_device_mark(p_device_id uuid, p_status text, p_actor text, p_reason text) to service_role;

revoke execute on function public.phx_device_write_off(p_assignment_id uuid, p_actor text, p_reason text, p_settlement_egp numeric) from public, anon, authenticated;
grant execute on function public.phx_device_write_off(p_assignment_id uuid, p_actor text, p_reason text, p_settlement_egp numeric) to service_role;

commit;
