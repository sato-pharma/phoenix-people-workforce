-- deductions_self_read_active_lines_only
--
-- WHAT THIS CHANGES: replaces the deductions_publication_lines_self_read RLS
--   policy so an employee's own self-read is restricted to line_status = 'active'.
--   The per-line push migration (20260922021403) added line_status but never
--   updated this policy, so an employee querying the table directly could still
--   read their OWN withdrawn snapshot lines. The portal already reads via the
--   service-role client with an active filter, so no screen ever showed them —
--   this closes the direct-query gap at the RLS layer.
-- WHY: a withdrawn line is a pulled-back deduction; an employee should never read
--   one, even by hand. This is an access-control TIGHTENING only — it can only
--   remove rows an employee sees, never add any. Own-data only; there is no
--   cross-employee exposure either before or after. The admin/HR read policy
--   (deductions_publication_lines_admin_select) is UNCHANGED and still sees
--   withdrawn lines for audit.
-- ROLLBACK: re-create the policy WITHOUT the line_status clause — the prior
--   definition lives in 20260725130500_deductions_module_publish.sql. Non-
--   destructive; this migration changes no rows, only one SELECT policy.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Not destructive or bulk: it replaces one SELECT policy and touches no data rows.

begin;

drop policy if exists deductions_publication_lines_self_read on public.deductions_publication_lines;
create policy deductions_publication_lines_self_read
  on public.deductions_publication_lines for select to authenticated
  using (
    private.phx_can_access_employee(employee_hr_id)
    and deductions_publication_lines.line_status = 'active'
    and exists (
      select 1 from public.deductions_publications p
      where p.id = deductions_publication_lines.publication_id
        and p.status = 'published'
    )
  );

commit;
