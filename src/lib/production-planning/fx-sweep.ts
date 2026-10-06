/**
 * Production Planner — the daily dollar rate.
 *
 * The owner types a price once, in dollars or in pounds, and the other figure is DERIVED (his
 * instruction, 2026-10-05). That only stays honest if the rate behind it moves on its own, so this
 * reads one rate a day and records it beside the date it belongs to.
 *
 * ── What this deliberately cannot do ────────────────────────────────────────────────────────────
 *
 * It cannot overwrite a good rate with nothing. A failed fetch writes `fetch_ok = false` and the
 * reason, leaving `fetched_usd_to_egp` as it was, because the table's own CHECK forbids claiming a
 * rate arrived with nothing to show — and a day with no rate falls back to the last good one and
 * then to the fallback in settings, never to zero.
 *
 * It cannot touch the rate HE typed. `manual_usd_to_egp` is a separate column and wins over the
 * fetched one at read time (`resolveEffectiveFxRate` in costing.ts), so a rate he set by hand
 * because the bank gave him a different one survives every sweep after it.
 *
 * And it is gated by its OWN pair of switches, independent of the reorder email's:
 * `fx_fetch_enabled` must be explicitly `true` and `fx_fetch_dry_run` explicitly `false`, both read
 * fail-safe. A dry run reports the rate it would have stored and stores nothing.
 */
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { readUsdToEgpRate } from "./fx-rate-reader";
import { PRODPLAN_TABLES, loadProductionPlanningDataForSystem } from "./service";

/**
 * Keyless on purpose: a daily rate is public information and a key is one more secret to rotate.
 * `PRODPLAN_FX_RATE_URL` overrides it without a deployment if the endpoint ever goes away — the
 * reader only requires a JSON body with `rates.EGP` on it.
 */
const DEFAULT_FX_URL = "https://open.er-api.com/v6/latest/USD";
const FX_SOURCE_NAME = "open.er-api.com";

export type FxSweepResult = {
  readonly rateDate: string;
  readonly skipped: "disabled" | null;
  readonly dryRun: boolean;
  readonly fetched: string | null;
  readonly stored: boolean;
  readonly error: string | null;
};

/** Cairo, so "today's rate" is the day the office is having, not UTC's. */
function todayCairo(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

export async function runProductionPlanningFxFetch(): Promise<FxSweepResult> {
  const rateDate = todayCairo();
  const data = await loadProductionPlanningDataForSystem();
  const base: FxSweepResult = {
    dryRun: data.settings.fxFetchDryRun,
    error: null,
    fetched: null,
    rateDate,
    skipped: null,
    stored: false,
  };

  if (!data.settings.fxFetchEnabled) return { ...base, skipped: "disabled" };

  const url = process.env.PRODPLAN_FX_RATE_URL?.trim() || DEFAULT_FX_URL;
  let rate: string | null = null;
  let failure: string | null = null;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      failure = `The rate source answered HTTP ${response.status}.`;
    } else {
      rate = readUsdToEgpRate(await response.json());
      if (rate === null) failure = "The rate source returned no usable USD to EGP rate.";
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : "The rate source could not be reached.";
  }

  if (data.settings.fxFetchDryRun) {
    return { ...base, dryRun: true, error: failure, fetched: rate };
  }

  const db = getSupabaseAdmin();
  if (rate === null) {
    // Records the FAILURE against today and nothing else. `fetched_usd_to_egp` is left untouched —
    // overwriting a good rate with null is the one thing a failed fetch must never do.
    const { error } = await db
      .from(PRODPLAN_TABLES.fx)
      .upsert(
        { fetch_error: failure, fetch_ok: false, fetch_source: FX_SOURCE_NAME, rate_date: rateDate },
        { onConflict: "rate_date" },
      );
    if (error) {
      logError("Production planner FX fetch could not record its failure", {
        labels: { event: "prodplan_fx_record_failed", job: "production-planning-fx" },
        error,
      });
    }
    return { ...base, error: failure };
  }

  const { error } = await db.from(PRODPLAN_TABLES.fx).upsert(
    {
      fetch_error: null,
      fetch_ok: true,
      fetch_source: FX_SOURCE_NAME,
      fetched_at: new Date().toISOString(),
      fetched_usd_to_egp: rate,
      rate_date: rateDate,
    },
    { onConflict: "rate_date" },
  );
  if (error) {
    logError("Production planner FX fetch could not store the rate", {
      labels: { event: "prodplan_fx_store_failed", job: "production-planning-fx" },
      error,
    });
    return { ...base, error: error.message, fetched: rate };
  }

  return { ...base, fetched: rate, stored: true };
}
