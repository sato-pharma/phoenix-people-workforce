// WP-6: Contract Non-Renewal Terminal Lifecycle.
//
// When a contract renewal request resolves as "not_renew", the employee is
// terminated and a vacancy is opened via the canonical resignation helper
// (resignEmployeeAndOpenVacancy — the same call every other termination in
// the system uses). The underlying schema
// (supabase/_migrations_archive/pre-baseline-2026-07-11/20260531120000_contract_non_renewal_terminal_lifecycle.sql)
// is confirmed live on both staging (cifwmndunmlxjhyjugxa) and production
// (ozucdzovmcqvepbozvqf), and a disposable-fixture smoke test against staging
// on 2026-07-18 confirmed the WP-6 reason/notes shape writes correctly and the
// terminated employee is excluded from v_active_organogram and
// v_payroll_eligible_employees, as expected.
export const WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED = true;
