update public.workflow_registry_modules
set
  statuses = '[
    {"key":"draft","label":"Draft","terminal":false},
    {"key":"pending","label":"Pending Approval","terminal":false},
    {"key":"approved","label":"Approved","terminal":false},
    {"key":"rejected","label":"Rejected","terminal":true},
    {"key":"added_to_payroll","label":"Added to Payroll","terminal":true}
  ]'::jsonb,
  actions = '[
    {
      "key":"submit",
      "label":"Submit expense",
      "from":["draft"],
      "to":"pending",
      "allowedRoles":["Employee","Medical Rep","District Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Manager","Super Admin","HR Specialist","Finance Manager","CEO"],
      "sideEffects":["capture employee, trip, GPS, and calculated amount"],
      "notifications":["notify approvers when request is pending"],
      "auditLog":"Expense submitted",
      "tests":["employee can submit live expense","submitted expense remains outside payroll until approval"]
    },
    {
      "key":"approve",
      "label":"Approve expense",
      "from":["pending"],
      "to":"approved",
      "allowedRoles":["Super Admin","HR Specialist","Finance Manager","CEO"],
      "sideEffects":["set approved_by and approved_at","make expense eligible for manual payroll import"],
      "notifications":["notify employee that expense was approved"],
      "auditLog":"Expense approved",
      "tests":["only authorized roles can approve","approval does not automatically add to payroll"]
    },
    {
      "key":"reject",
      "label":"Reject expense",
      "from":["pending"],
      "to":"rejected",
      "allowedRoles":["Super Admin","HR Specialist","Finance Manager","CEO"],
      "sideEffects":["store rejection reason"],
      "notifications":["notify employee that expense was rejected"],
      "auditLog":"Expense rejected",
      "tests":["rejected expense is excluded from payroll import"]
    },
    {
      "key":"add_to_payroll",
      "label":"Add to payroll",
      "from":["approved"],
      "to":"added_to_payroll",
      "allowedRoles":["Super Admin","HR Specialist","Finance Manager"],
      "sideEffects":["lock edit/delete","link expense to payroll run"],
      "notifications":["optional payroll completion notification"],
      "auditLog":"Expense added to payroll",
      "tests":["expense cannot be deleted after payroll import"]
    },
    {
      "key":"delete_before_payroll",
      "label":"Delete before payroll",
      "from":["draft","pending","approved","rejected"],
      "to":"deleted",
      "allowedRoles":["Super Admin","HR Specialist","Finance Manager"],
      "sideEffects":["remove or soft-delete expense before payroll lock"],
      "notifications":["optional employee/admin notification"],
      "auditLog":"Expense deleted before payroll",
      "tests":["approved expense can be deleted before payroll","payroll locked expense cannot be deleted"]
    }
  ]'::jsonb,
  updated_by = 'system'
where module_key = 'outstation_expenses';

update public.workflow_registry_modules
set
  statuses = '[
    {"key":"uploaded","label":"Uploaded","terminal":false},
    {"key":"part1_ready","label":"Part 1 Ready","terminal":false},
    {"key":"part1_paid","label":"Part 1 Paid","terminal":false},
    {"key":"adjustments_open","label":"Adjustments Open","terminal":false},
    {"key":"part2_ready","label":"Part 2 Ready","terminal":false},
    {"key":"under_review","label":"Under Review","terminal":false},
    {"key":"approved","label":"Approved","terminal":false},
    {"key":"locked","label":"Locked","terminal":true},
    {"key":"rejected","label":"Rejected","terminal":true}
  ]'::jsonb,
  actions = '[
    {"key":"mark_part1_ready","label":"Mark Part 1 ready","from":["uploaded"],"to":"part1_ready","allowedRoles":["Super Admin","HR Specialist","Finance Manager"],"sideEffects":["freeze initial upload for Part 1 review"],"notifications":["notify payroll admins"],"auditLog":"Payroll Part 1 marked ready","tests":["uploaded payroll can move to Part 1 ready"]},
    {"key":"mark_part1_paid","label":"Mark Part 1 paid","from":["part1_ready"],"to":"part1_paid","allowedRoles":["Super Admin","Finance Manager"],"sideEffects":["record part1_paid_by and part1_paid_at"],"notifications":["notify payroll admins"],"auditLog":"Payroll Part 1 marked paid","tests":["Part 1 ready payroll can be marked paid"]},
    {"key":"open_adjustments","label":"Open adjustments","from":["part1_paid"],"to":"adjustments_open","allowedRoles":["Super Admin","Finance Manager"],"sideEffects":["open Part 2 adjustment window"],"notifications":["notify payroll admins"],"auditLog":"Payroll adjustments opened","tests":["Part 1 paid payroll can open adjustments"]},
    {"key":"mark_part2_ready","label":"Mark Part 2 ready","from":["adjustments_open"],"to":"part2_ready","allowedRoles":["Super Admin","HR Specialist","Finance Manager"],"sideEffects":["record part2_ready_by and part2_ready_at"],"notifications":["notify payroll reviewers"],"auditLog":"Payroll Part 2 marked ready","tests":["adjustments can move to Part 2 ready"]},
    {"key":"mark_review","label":"Send to review","from":["part2_ready"],"to":"under_review","allowedRoles":["Super Admin","HR Specialist","Finance Manager"],"sideEffects":["move payroll to final review"],"notifications":["notify approvers"],"auditLog":"Payroll sent to review","tests":["Part 2 ready payroll can move under review"]},
    {"key":"approve","label":"Approve batch","from":["under_review"],"to":"approved","allowedRoles":["Super Admin","Finance Manager"],"sideEffects":["set approved_by and approved_at"],"notifications":["notify payroll owner"],"auditLog":"Payroll batch approved","tests":["approval requires authorized role"]},
    {"key":"lock","label":"Lock batch","from":["approved"],"to":"locked","allowedRoles":["Super Admin","Finance Manager"],"sideEffects":["set locked_at and lock payroll edits"],"notifications":["notify employees when payslips are ready"],"auditLog":"Payroll batch locked","tests":["locked payroll cannot be replaced silently"]},
    {"key":"reject","label":"Reject batch","from":["under_review"],"to":"rejected","allowedRoles":["Super Admin","Finance Manager"],"sideEffects":["store rejected_reason"],"notifications":["notify payroll owner"],"auditLog":"Payroll batch rejected","tests":["reject requires a reason"]},
    {"key":"reopen","label":"Reopen rejected batch","from":["rejected"],"to":"adjustments_open","allowedRoles":["Super Admin","Finance Manager"],"sideEffects":["clear rejected_reason and Part 2 ready markers"],"notifications":["notify payroll admins"],"auditLog":"Payroll batch reopened","tests":["rejected payroll can reopen to adjustments"]}
  ]'::jsonb,
  updated_by = 'system'
where module_key = 'payroll_batches';
;
