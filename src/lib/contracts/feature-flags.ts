// WP-6 kill switch for the Contract Non-Renewal Terminal Lifecycle.
// Default is OFF so the runtime behavior remains exactly as it is today.
// Only flip to true AFTER the WP-6 migration
// (supabase/_migrations_archive/pre-baseline-2026-07-11/20260531120000_contract_non_renewal_terminal_lifecycle.sql)
// has been applied and staging smoke tests are green.

export const WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED = false;

export const WP6_CONTRACT_NON_RENEWAL_TERMINAL_DISABLED_MESSAGE =
  "Contract non-renewal terminal lifecycle is disabled until WP-6 migration is applied.";
