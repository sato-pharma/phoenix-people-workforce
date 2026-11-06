// Make It Happen — saved forecast plans, the table half.
//
// public.sales_forecast_plans is service-role only (RLS on, anon/authenticated revoked), so every
// read and write goes through here, after the caller's access was decided in plans.ts / workspace.ts.
// Owners are stored in the canonical display form of their HR id, and read back with the same form.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { PeriodKind, SavedPlanSummary } from "@/lib/sales/make-it-happen/engine";

const TABLE = "sales_forecast_plans";
const COLUMNS = "id,owner_hr_id,name,units,brick_units,forecast_value,forecast_achievement,updated_at";

export type StoredPlan = SavedPlanSummary & { ownerKey: string };

const CAIRO_STAMP = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Cairo",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function cleanUnits(raw: unknown): Record<string, number> {
  const units: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return units;
  for (const [code, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = Number(value);
    if (code && Number.isSafeInteger(parsed) && parsed > 0) units[code] = parsed;
  }
  return units;
}

/** product_code → brick_id → whole units; anything else in the stored object is dropped. */
function cleanBrickUnits(raw: unknown): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [code, bricks] of Object.entries(raw as Record<string, unknown>)) {
    if (!code || !bricks || typeof bricks !== "object" || Array.isArray(bricks)) continue;
    const units: Record<string, number> = {};
    for (const [brickId, value] of Object.entries(bricks as Record<string, unknown>)) {
      const parsed = Number(value);
      if (brickId && Number.isSafeInteger(parsed) && parsed >= 0) units[brickId] = parsed;
    }
    if (Object.keys(units).length > 0) out[code] = units;
  }
  return out;
}

function toPlan(record: Record<string, unknown>): StoredPlan {
  const updatedAt = new Date(String(record.updated_at ?? ""));
  const achievement = record.forecast_achievement == null ? null : Number(record.forecast_achievement);
  return {
    id: String(record.id ?? ""),
    ownerKey: String(record.owner_hr_id ?? ""),
    name: String(record.name ?? ""),
    units: cleanUnits(record.units),
    bricks: cleanBrickUnits(record.brick_units),
    forecastValue: Number(record.forecast_value ?? 0) || 0,
    forecastAchievement: achievement != null && Number.isFinite(achievement) ? achievement : null,
    updatedAtLabel: Number.isNaN(updatedAt.getTime()) ? "" : CAIRO_STAMP.format(updatedAt),
  };
}

/**
 * null — never [] — when the table is not there yet: it ships in a migration applied separately
 * from the deploy, and "no plans saved" would be a confident lie about plans that cannot exist.
 */
export async function listPlansForOwners(
  ownerKeys: readonly string[],
  periodKind: PeriodKind,
  periodKey: string,
): Promise<StoredPlan[] | null> {
  const keys = [...new Set(ownerKeys.filter(Boolean))];
  if (keys.length === 0) return [];
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select(COLUMNS)
    .in("owner_hr_id", keys)
    .eq("period_kind", periodKind)
    .eq("period_key", periodKey)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) {
    // A missing table answers PGRST205, not 42P01.
    if (error.code === "PGRST205") return null;
    throw error;
  }
  return ((data ?? []) as Record<string, unknown>[]).map(toPlan);
}

export type PlanValues = {
  ownerKey: string;
  periodKind: PeriodKind;
  periodKey: string;
  name: string;
  units: Record<string, number>;
  /** product_code → brick_id → units (engine.ts rule 9). */
  bricks: Record<string, Record<string, number>>;
  forecastValue: number;
  forecastAchievement: number | null;
  targetValue: number | null;
};

function toRecord(values: PlanValues) {
  return {
    owner_hr_id: values.ownerKey,
    period_kind: values.periodKind,
    period_key: values.periodKey,
    name: values.name,
    units: values.units,
    brick_units: values.bricks,
    forecast_value: Math.round(values.forecastValue * 100) / 100,
    forecast_achievement: values.forecastAchievement,
    target_value: values.targetValue,
  };
}

export async function insertPlan(values: PlanValues): Promise<StoredPlan> {
  const { data, error } = await getSupabaseAdmin().from(TABLE).insert(toRecord(values)).select(COLUMNS).single();
  if (error) throw error;
  return toPlan(data as Record<string, unknown>);
}

/** Update one plan the owner holds. null when no such plan belongs to them. */
export async function updateOwnPlan(planId: string, values: PlanValues): Promise<StoredPlan | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .update({ ...toRecord(values), updated_at: new Date().toISOString() })
    .eq("id", planId)
    .eq("owner_hr_id", values.ownerKey)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return data ? toPlan(data as Record<string, unknown>) : null;
}
