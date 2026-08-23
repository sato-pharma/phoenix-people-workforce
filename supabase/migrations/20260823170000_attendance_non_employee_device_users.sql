-- Not everyone who touches the fingerprint reader is an employee.
--
-- `attendance_device_user_map` has always assumed the opposite. `employee_hr_id` is a FK to
-- `employees(hr_id)`, and `attendance_device_user_map_active_requires_employee` forbids an active
-- row without one. Together they mean a driver, guard, cleaner or any outsourced person who is
-- enrolled on the device has no legal value to be recorded under. The row can only sit at
-- `employee_hr_id IS NULL, is_active = false`, which is the same shape as a device id nobody has
-- identified yet.
--
-- That conflation is the whole defect. `resolveDeviceMappingStatus` reads a null HR_ID as
-- `unmapped`, so a person we have positively identified is counted as an unknown forever: it drags
-- `mappingReadinessRate`, keeps a permanent row in the "recent unmapped" panel, and invites the
-- next reader to investigate it again. Production proof, 2026-08-23: device user 18 punches
-- regularly (last 2026-08-17 09:17 Cairo) and was investigated twice, ending with the owner saying
-- plainly that 18 is a driver. There was nowhere to write that down.
--
-- So: give a device user a non-employee identity, kept deliberately separate from the employee FK.
-- The punches of a labelled user are still skipped by `app/api/attendance/raw-punches/route.ts` -
-- that is the point. A driver is not on payroll and must never generate attendance days, late
-- minutes or deductions. This changes only how the row is COUNTED and DESCRIBED, never whether it
-- is ingested.

alter table public.attendance_device_user_map
  add column if not exists non_employee_label text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'attendance_device_user_map_non_employee_exclusive'
  ) then
    alter table public.attendance_device_user_map
      add constraint attendance_device_user_map_non_employee_exclusive
      check (
        non_employee_label is null
        or (
          employee_hr_id is null
          and is_active = false
          and btrim(non_employee_label) <> ''
        )
      );
  end if;
end $$;

comment on column public.attendance_device_user_map.non_employee_label is
  'Set ONLY for a device user who is deliberately not an employee - a driver, guard, cleaner or outsourced worker enrolled on the reader. Mutually exclusive with employee_hr_id and forces is_active = false, so the punches stay skipped: such a person is not on payroll and must never produce attendance days or deductions. Its purpose is to separate "identified, and not an employee" from "nobody knows who this is" in resolveDeviceMappingStatus - without it both read as unmapped. A blank string is rejected so the label cannot silently mean nothing.';

-- The row this was built for. Guarded on employee_hr_id IS NULL so that if anyone maps 18 to a real
-- employee between this file being written and applied, the migration leaves their work alone
-- rather than overwriting it - and the constraint above would reject the write anyway.
update public.attendance_device_user_map
   set non_employee_label = 'Driver',
       updated_at = now()
 where device_id = 'zkteco-main'
   and device_user_id = '18'
   and employee_hr_id is null
   and non_employee_label is null;
