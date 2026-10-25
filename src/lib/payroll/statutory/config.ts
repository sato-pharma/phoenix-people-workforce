import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { DEFAULT_STATUTORY_CONFIG } from "./defaults.ts";
import type { StatutoryConfig, TaxBracket } from "./types.ts";

/** Re-exported so existing importers keep working; defined in defaults.ts. */
export { DEFAULT_STATUTORY_CONFIG };


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
 *
 * Only an answer the table actually gave is remembered (2026-10-26 cache audit, P3). A failed read
 * still falls back to the default for THIS call, but is not cached — otherwise a one-second blip
 * pinned the default for the next minute, and a payroll recalculated in that minute used it even
 * though the configured row was there.
 */
export async function getStatutoryConfigForPeriod(period: {
  month: number;
  year: number;
}): Promise<StatutoryConfig> {
  const periodStart = `${period.year}-${String(period.month).padStart(2, "0")}-01`;
  const cached = cache.get(periodStart);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.config;

  let config = DEFAULT_STATUTORY_CONFIG;
  let answered = false;
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
    } else {
      answered = true;
      if (data) config = mapConfigRow(data as Record<string, unknown>);
    }
  } catch (error) {
    logError("Statutory config load threw an exception, using default configuration", {
      labels: { event: "statutory_config_load_threw", periodStart },
      error,
    });
  }

  if (answered) cache.set(periodStart, { at: Date.now(), config });
  return config;
}
