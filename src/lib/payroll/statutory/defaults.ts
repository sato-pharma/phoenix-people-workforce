import type { StatutoryConfig } from "./types.ts";

/**
 * The confirmed 2026 Egyptian parameters (Law 7/2024 brackets + EGP 20,000
 * exemption; Social Insurance Law 148/2019, 2026 caps 2,700 / 16,700). Used as a
 * fallback when the payroll_statutory_config table has no matching row, so the
 * calculator is never left without parameters. The DB row (same values) is the
 * editable source of truth once present.
 *
 * This lives in its own module — separate from config.ts — because config.ts
 * reaches for the Supabase admin client at import time, which cannot be pulled
 * into a client component. The Employee Master's salary auto-fill runs in the
 * browser and needs these numbers synchronously, so it imports from here.
 * config.ts re-exports the same constant; there is exactly one definition.
 */
export const DEFAULT_STATUTORY_CONFIG: StatutoryConfig = {
  effectiveFrom: "2026-01-01",
  personalExemptionAnnual: 20000,
  disabledExemptionAnnual: 30000,
  taxBrackets: [
    { upTo: 40000, rate: 0.0 },
    { upTo: 55000, rate: 0.1 },
    { upTo: 70000, rate: 0.15 },
    { upTo: 200000, rate: 0.2 },
    { upTo: 400000, rate: 0.225 },
    { upTo: 1200000, rate: 0.25 },
    { upTo: null, rate: 0.275 },
  ],
  taxableRoundingStep: 10,
  siEmployeeRate: 0.11,
  siEmployerRate: 0.1875,
  siMinMonthlyWage: 2700,
  siMaxMonthlyWage: 16700,
};
