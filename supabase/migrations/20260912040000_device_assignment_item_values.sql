-- Per-item values on a custody assignment — the breakdown البند (9) already describes.
--
-- WHY THIS EXISTS. The receipt's item table (`بيان العهدة المسلَّمة`) has a
-- «القيمة التقديرية (ج.م)» column and a total row, and both have printed empty on every custody
-- receipt this system has produced. The value column is not decoration: البند (9) reads
-- «القيمة المدونة قرين كل صنف قيمة تقديرية متفق عليها لأغراض تسوية العهدة» — the value written
-- BESIDE EACH ITEM — and البند (10) caps any wage deduction at those figures. So the paper has
-- always been per-item, and the register has only ever held one number for the whole handover.
--
-- That gap is not academic. A laptop form lists four items (laptop, charger, bag, box) and the
-- phone form seven. When one of them comes back damaged or missing, البند (10) prices THAT item,
-- and a single total cannot answer it. Today somebody writes the figures in by hand, which is
-- exactly the transcription the register was built to remove.
--
-- ---------------------------------------------------------------------------
-- WHY A JSONB MAP AND NOT A CHILD TABLE.
-- ---------------------------------------------------------------------------
-- The rows are not data. They are FIXED positions on a printed template — `custody-text.ts` names
-- them, four on نموذج رقم 1 and seven on نموذج رقم 2 — so there is nothing to insert, delete,
-- reorder or reference. A child table would add a second table, a foreign key, its own grants and
-- its own RLS story, to hold at most seven numbers that are written once and then frozen, and it
-- would still have to name the row by the same template number this map uses as its key.
--
-- The map is keyed by that item number as text ("1".."7") and holds a non-negative EGP amount.
--
-- ---------------------------------------------------------------------------
-- AN ABSENT KEY MEANS "NOT HANDED OVER", AND THAT IS THE FORM'S OWN RULE.
-- ---------------------------------------------------------------------------
-- `itemNoteAr` on both templates: «ويُشطب سطر أي صنف لم يُسلَّم فعليًا ولا تُحتسب قيمته ضمن
-- الإجمالي» — a row for an item not actually handed over is struck through and its value is not
-- counted in the total. So a missing key prints a blank cell and is excluded from the sum, rather
-- than printing a zero. A zero on a signed instrument asserts the item was handed over and is
-- worth nothing, which is a different statement and the wrong one.
--
-- ---------------------------------------------------------------------------
-- FROZEN AT ISSUE, LIKE `agreed_value_egp`, FOR THE SAME REASON.
-- ---------------------------------------------------------------------------
-- The original migration's reasoning applies unchanged: the value AS IT STOOD WHEN HE SIGNED is
-- what was agreed, and a later revaluation must not silently change what somebody already signed
-- for, in the direction of owing more. `agreed_value_egp` stays the single figure البند (10) caps
-- recovery at; this column is the breakdown behind it, not a replacement for it. Nothing here
-- recomputes the total from the parts, because the signed total is the signed total.
--
-- SAFETY. Adds one nullable column and one CHECK. No existing row changes, no default is written,
-- no rewrite is taken. Every assignment already recorded keeps a null map, which prints exactly
-- what it prints today.

-- The shape guard. A CHECK cannot hold a subquery, so the per-key rules live in an IMMUTABLE
-- function called from the constraint — the same pattern the register already relies on for
-- `company_devices_identifiable`: the database is the real guard, and the domain layer's version of
-- this rule exists to give a person a sentence instead of a constraint-violation string.
create or replace function public.phx_custody_item_values_valid(v jsonb)
returns boolean
language sql
immutable
as $$
  select
    v is null
    or (
      jsonb_typeof(v) = 'object'
      and coalesce(
        (
          select bool_and(
            -- The key is a template item number, not free text: "1".."99".
            key ~ '^[1-9][0-9]?$'
            and jsonb_typeof(value) = 'number'
            and (value)::numeric >= 0
          )
          from jsonb_each(v)
        ),
        -- An empty object is valid and means the same as null: nothing priced yet.
        true
      )
    );
$$;

comment on function public.phx_custody_item_values_valid(jsonb) is
  'True when a custody item-value map is an object keyed by template item number with non-negative numeric amounts. Used by device_assignments_item_values_shape.';

alter table public.device_assignments
  add column if not exists item_values_egp jsonb;

comment on column public.device_assignments.item_values_egp is
  'Per-item estimated values in EGP, keyed by the custody template item number ("1".."7"). An absent key means the item was not handed over: it prints blank and is excluded from the total, per itemNoteAr. Frozen at issue like agreed_value_egp.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'device_assignments_item_values_shape'
      and conrelid = 'public.device_assignments'::regclass
  ) then
    alter table public.device_assignments
      add constraint device_assignments_item_values_shape
      check (public.phx_custody_item_values_valid(item_values_egp));
  end if;
end
$$;
