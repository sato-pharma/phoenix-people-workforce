/**
 * Phoenix CRM — the settings row, the line opening dates and the Ramadan dates.
 *
 * Read on every request, uncached: three primary-key reads of a handful of rows, and a changed cap or
 * opening date must take effect on the very next save (a cached value would let one more plan through
 * on the old cap).
 */

import { ApiError, validationError } from "@/lib/http/api-errors";
import type { RamadanRange } from "@/lib/phoenix-crm/calendar";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { PHOENIX_CRM_DEFAULT_SETTINGS, type PhoenixCrmGrade, type PhoenixCrmListType, type PhoenixCrmSettings } from "@/lib/phoenix-crm/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type LineRollout = { lineCode: string; opensOn: string | null };

export type PhoenixCrmConfig = {
  settings: PhoenixCrmSettings;
  lineRollout: LineRollout[];
  ramadanOverrides: RamadanRange[];
};

const GRADES: PhoenixCrmGrade[] = ["A", "B", "C"];
const LIST_TYPES: PhoenixCrmListType[] = ["PM", "AM"];

function readTargets(raw: unknown): PhoenixCrmSettings["gradeTargets"] {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, Record<string, unknown> | undefined>;
  const targets = { PM: { A: null, B: null, C: null }, AM: { A: null, B: null, C: null } } as PhoenixCrmSettings["gradeTargets"];
  for (const listType of LIST_TYPES) {
    for (const grade of GRADES) {
      const value = source[listType]?.[grade];
      const parsed = value === null || value === undefined || value === "" ? null : Number(value);
      targets[listType][grade] = parsed !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
    }
  }
  return targets;
}

export async function loadPhoenixCrmConfig(): Promise<PhoenixCrmConfig> {
  const supabase = getSupabaseAdmin();
  const [settingsResult, rolloutResult, ramadanResult] = await Promise.all([
    supabase.from("phoenix_crm_settings").select("pm_daily_cap, am_daily_cap, far_apart_km, visit_far_meters, weak_gps_meters, grade_targets").eq("id", 1).maybeSingle(),
    supabase.from("phoenix_crm_line_rollout").select("line_code, opens_on").order("line_code"),
    supabase.from("phoenix_crm_ramadan_overrides").select("hijri_year, starts_on, ends_on").order("hijri_year"),
  ]);
  throwIfError(settingsResult.error);
  throwIfError(rolloutResult.error);
  throwIfError(ramadanResult.error);

  const row = settingsResult.data as Record<string, unknown> | null;
  const settings: PhoenixCrmSettings = row
    ? {
        pmDailyCap: Number(row.pm_daily_cap),
        amDailyCap: Number(row.am_daily_cap),
        farApartKm: Number(row.far_apart_km),
        visitFarMeters: Number(row.visit_far_meters),
        weakGpsMeters: Number(row.weak_gps_meters),
        gradeTargets: readTargets(row.grade_targets),
        // The call rate is the company-wide locked standard (the call-rate golden rule: AM against 2,
        // PM against 10), never a per-territory setting — it has no column and is not editable, so it
        // always comes from the constant, and cannot drift from the rule the KPI board is pinned to.
        callRateAmTarget: PHOENIX_CRM_DEFAULT_SETTINGS.callRateAmTarget,
        callRatePmTarget: PHOENIX_CRM_DEFAULT_SETTINGS.callRatePmTarget,
      }
    : PHOENIX_CRM_DEFAULT_SETTINGS;

  return {
    settings,
    lineRollout: ((rolloutResult.data ?? []) as Array<Record<string, unknown>>).map((entry) => ({
      lineCode: String(entry.line_code),
      opensOn: typeof entry.opens_on === "string" ? entry.opens_on : null,
    })),
    ramadanOverrides: ((ramadanResult.data ?? []) as Array<Record<string, unknown>>).map((entry) => ({
      hijriYear: Number(entry.hijri_year),
      startsOn: String(entry.starts_on),
      endsOn: String(entry.ends_on),
    })),
  };
}

/** Line codes open on this Cairo day. */
export function openLineCodes(rollout: ReadonlyArray<LineRollout>, cairoToday: string): Set<string> {
  return new Set(rollout.filter((entry) => entry.opensOn !== null && entry.opensOn <= cairoToday).map((entry) => entry.lineCode));
}

// ── Super Admin changes ─────────────────────────────────────────────────────────────────────────

function integerIn(value: unknown, min: number, max: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw validationError(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return parsed;
}

export async function saveSettings(actorHrId: string, raw: unknown): Promise<void> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const farApart = Number(body.farApartKm);
  if (!Number.isFinite(farApart) || farApart <= 0 || farApart > 500) {
    throw validationError("The far-apart distance must be more than 0 and at most 500 km.");
  }
  const targetsRaw = (body.gradeTargets && typeof body.gradeTargets === "object" ? body.gradeTargets : {}) as Record<string, Record<string, unknown>>;
  const gradeTargets: Record<string, Record<string, number | null>> = {};
  for (const listType of LIST_TYPES) {
    gradeTargets[listType] = {};
    for (const grade of GRADES) {
      const value = targetsRaw[listType]?.[grade];
      gradeTargets[listType][grade] =
        value === null || value === undefined || value === "" ? null : integerIn(value, 0, 31, `The ${listType} grade ${grade} visits`);
    }
  }
  const { error } = await getSupabaseAdmin()
    .from("phoenix_crm_settings")
    .update({
      pm_daily_cap: integerIn(body.pmDailyCap, 1, 60, "The PM a day"),
      am_daily_cap: integerIn(body.amDailyCap, 1, 60, "The AM a day"),
      far_apart_km: Math.round(farApart * 10) / 10,
      visit_far_meters: integerIn(body.visitFarMeters, 50, 20000, "The far visit distance"),
      weak_gps_meters: integerIn(body.weakGpsMeters, 10, 5000, "The weak location accuracy"),
      grade_targets: gradeTargets,
      updated_at: new Date().toISOString(),
      updated_by_hr_id: actorHrId,
    })
    .eq("id", 1);
  throwIfError(error);
}

export async function saveLineRollout(actorHrId: string, lineCode: string, opensOn: string | null, knownLines: ReadonlySet<string>): Promise<void> {
  if (!knownLines.has(lineCode)) throw new ApiError(404, "not_found", "This line is not in the organogram.");
  if (opensOn !== null && !isIsoDay(opensOn)) throw validationError("Choose the day the line opens.");
  const { error } = await getSupabaseAdmin()
    .from("phoenix_crm_line_rollout")
    .upsert({ line_code: lineCode, opens_on: opensOn, updated_at: new Date().toISOString(), updated_by_hr_id: actorHrId }, { onConflict: "line_code" });
  throwIfError(error);
}

export async function saveRamadanOverride(actorHrId: string, raw: unknown): Promise<void> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const hijriYear = integerIn(body.hijriYear, 1440, 1500, "The Hijri year");
  const supabase = getSupabaseAdmin();
  if (body.reset === true) {
    const { error } = await supabase.from("phoenix_crm_ramadan_overrides").delete().eq("hijri_year", hijriYear);
    throwIfError(error);
    return;
  }
  const startsOn = String(body.startsOn ?? "");
  const endsOn = String(body.endsOn ?? "");
  if (!isIsoDay(startsOn) || !isIsoDay(endsOn)) throw validationError("Choose Ramadan's first and last day.");
  const span = Math.round((Date.parse(`${endsOn}T12:00:00Z`) - Date.parse(`${startsOn}T12:00:00Z`)) / 86400000);
  if (span < 27 || span > 30) throw validationError("Ramadan lasts 28 to 31 days, first and last day included.");
  const { error } = await supabase
    .from("phoenix_crm_ramadan_overrides")
    .upsert(
      { hijri_year: hijriYear, starts_on: startsOn, ends_on: endsOn, updated_at: new Date().toISOString(), updated_by_hr_id: actorHrId },
      { onConflict: "hijri_year" },
    );
  throwIfError(error);
}
