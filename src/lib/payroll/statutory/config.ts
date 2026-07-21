import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { StatutoryConfig, TaxBracket } from "./types.ts";

/**
 * The confirmed 2026 Egyptian parameters (Law 7/2024 brackets + EGP 20,000
 * exemption; Social Insurance Law 148/2019, 2026 caps 2,700 / 16,700). Used as a
 * fallback when the payroll_statutory_config table has no matching row, so the
 * calculator is never left without parameters. The DB row (same values) is the
 * editable source of truth once present.
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

function parseBrackets(value: unknown): TaxBracket[] {
  if (!Array.isArray(value)) return DEFAULT_STATUTORY_CONFIG.taxBrackets;
  const brackets: TaxBracket[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const rate = Number(entry.rate);
    const upToRaw = entry.up_to;
    const upTo = upToRaw === null || upToRaw === undefined ? null : Number(upToRaw);
    if (!Number.isFinite(rate)) continue;
    if (upTo !== null && !Number.isFinite(upTo)) continue;
    brackets.push({ upTo, rate });
  }
  return brackets.length > 0 ? brackets : DEFAULT_STATUTORY_CONFIG.taxBrackets;
}

function mapConfigRow(row: Record<string, unknown>): StatutoryConfig {
  return {
    effectiveFrom: String(row.effective_from ?? DEFAULT_STATUTORY_CONFIG.effectiveFrom).slice(0, 10),
    personalExemptionAnnual: Number(row.personal_exemption_annual ?? DEFAULT_STATUTORY_CONFIG.personalExemptionAnnual),
    disabledExemptionAnnual: Number(row.disabled_exemption_annual ?? DEFAULT_STATUTORY_CONFIG.disabledExemptionAnnual),
    taxBrackets: parseBrackets(row.tax_brackets),
    taxableRoundingStep: Number(row.taxable_rounding_step ?? DEFAULT_STATUTORY_CONFIG.taxableRoundingStep),
    siEmployeeRate: Number(row.si_employee_rate ?? DEFAULT_STATUTORY_CONFIG.siEmployeeRate),
    siEmployerRate: Number(row.si_employer_rate ?? DEFAULT_STATUTORY_CONFIG.siEmployerRate),
    siMinMonthlyWage: Number(row.si_min_monthly_wage ?? DEFAULT_STATUTORY_CONFIG.siMinMonthlyWage),
    siMaxMonthlyWage: Number(row.si_max_monthly_wage ?? DEFAULT_STATUTORY_CONFIG.siMaxMonthlyWage),
  };
}

type CacheEntry = { at: number; config: StatutoryConfig };
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/**
 * Resolve the statutory config in force for a payroll period: the row with the
 * latest effective_from on or before the first day of the period. Falls back to
 * DEFAULT_STATUTORY_CONFIG when the table is empty/unavailable.
 */
export async function getStatutoryConfigForPeriod(period: {
  month: number;
  year: number;
}): Promise<StatutoryConfig> {
  const periodStart = `${period.year}-${String(period.month).padStart(2, "0")}-01`;
  const cached = cache.get(periodStart);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.config;

  let config = DEFAULT_STATUTORY_CONFIG;
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("payroll_statutory_config")
      .select("*")
      .lte("effective_from", periodStart)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      logError("Statutory config load failed, using default configuration", {
        labels: { event: "statutory_config_load_failed", periodStart },
        error,
      });
    } else if (data) {
      config = mapConfigRow(data as Record<string, unknown>);
    }
  } catch (error) {
    logError("Statutory config load threw an exception, using default configuration", {
      labels: { event: "statutory_config_load_threw", periodStart },
      error,
    });
  }

  cache.set(periodStart, { at: Date.now(), config });
  return config;
}
