/**
 * Doctor Coverage visit norms — admin-editable policy with a TS-const fallback.
 *
 * Mirrors probation/intelligence/config.ts exactly: the DB singleton (doctor_coverage_config) is
 * the source of truth once present, DEFAULT_DOCTOR_COVERAGE_NORMS is the compile-time fallback that
 * keeps the board working before the row is seeded or when the schema is not yet migrated, and the
 * result is cached briefly so a board render does not pay a config read per request.
 *
 * WHY THIS IS CONFIGURABLE. The norm used to be a constant — A = 2 visits a month, B and C = 1 —
 * applied to every contact. It was written for doctors, but the vendor's `speciality` column also
 * carries pharmacies, hospitals, contracts and insurance offices: 21% of the graded panel measured
 * on production 2026-08-08. Those were all being told to expect two visits a month like an A-grade
 * physician. Rather than guess a pharmacy's real call frequency, the owner asked for the number to
 * be editable (2026-08-09), so the business sets it and the code stops assuming.
 *
 * ZERO MEANS NOT SCORED. `visitsThisMonth >= 0` is always true, so a literal zero target would make
 * every contact of that kind green and quietly inflate coverage. A zero therefore removes that
 * population from the panel and the denominator — see buildDoctorCoverageBoard.
 */

import { writeAuditLog } from "@/lib/admin/audit";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { CrmContactKind } from "@/lib/crm/contact-taxonomy";

export type DoctorCoverageGradeTier = "A" | "B" | "C";
/** Scored kinds only — `unclassified` is never scored, by construction. */
export type ScoredContactKind = Extract<CrmContactKind, "sp" | "hcp">;

export type DoctorCoverageNorms = Record<ScoredContactKind, Record<DoctorCoverageGradeTier, number>>;

export type DoctorCoverageConfig = {
  norms: DoctorCoverageNorms;
  updatedAt: string | null;
  updatedBy: string | null;
};

/**
 * Today's live behaviour, unchanged: A needs 2 visits a month, B and C need 1 — for BOTH kinds.
 * Deliberately identical for sp and hcp so that shipping this feature moves no number on any
 * board; only an explicit admin edit does.
 */
export const DEFAULT_DOCTOR_COVERAGE_NORMS: DoctorCoverageNorms = {
  sp: { A: 2, B: 1, C: 1 },
  hcp: { A: 2, B: 1, C: 1 },
};

export const DEFAULT_DOCTOR_COVERAGE_CONFIG: DoctorCoverageConfig = {
  norms: DEFAULT_DOCTOR_COVERAGE_NORMS,
  updatedAt: null,
  updatedBy: null,
};

/** Largest accepted value. A norm above this is a typo, not a policy — 31 days in a month. */
export const MAX_VISITS_PER_MONTH = 31;

const GRADES: readonly DoctorCoverageGradeTier[] = ["A", "B", "C"];
const KINDS: readonly ScoredContactKind[] = ["sp", "hcp"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  // Norms are whole visits; clamp rather than reject so one bad stored value cannot break a board.
  const rounded = Math.round(parsed);
  if (rounded < 0) return fallback;
  if (rounded > MAX_VISITS_PER_MONTH) return fallback;
  return rounded;
}

function isConfigSchemaMissing(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? error ?? "").toLowerCase();
  return (
    message.includes("doctor_coverage_config") ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

function mapNorms(raw: unknown): DoctorCoverageNorms {
  const record = asRecord(raw);
  const out = {} as DoctorCoverageNorms;
  for (const kind of KINDS) {
    const kindRecord = asRecord(record[kind]);
    out[kind] = {} as Record<DoctorCoverageGradeTier, number>;
    for (const grade of GRADES) {
      out[kind][grade] = normOr(kindRecord[grade], DEFAULT_DOCTOR_COVERAGE_NORMS[kind][grade]);
    }
  }
  return out;
}

const CONFIG_CACHE_MS = 30_000;
let configCache: { config: DoctorCoverageConfig; fetchedAt: number } | null = null;

/**
 * Effective config: DB singleton merged over the TS-const default. Never throws — a board must
 * always be able to compute a norm, so a missing table or a transient read error degrades to the
 * last-known-good config, then to the defaults.
 */
export async function getDoctorCoverageConfig(): Promise<DoctorCoverageConfig> {
  if (configCache && configCache.fetchedAt + CONFIG_CACHE_MS > Date.now()) return configCache.config;
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("doctor_coverage_config")
      .select("norms,updated_by,updated_at")
      .eq("id", true)
      .maybeSingle();
    if (error) {
      if (isConfigSchemaMissing(error)) return DEFAULT_DOCTOR_COVERAGE_CONFIG;
      throw error;
    }
    const row = data as { norms: unknown; updated_by: string | null; updated_at: string | null } | null;
    const config: DoctorCoverageConfig = row
      ? { norms: mapNorms(row.norms), updatedAt: row.updated_at ?? null, updatedBy: row.updated_by ?? null }
      : DEFAULT_DOCTOR_COVERAGE_CONFIG;
    configCache = { config, fetchedAt: Date.now() };
    return config;
  } catch (error) {
    if (isConfigSchemaMissing(error)) return DEFAULT_DOCTOR_COVERAGE_CONFIG;
    return configCache?.config ?? DEFAULT_DOCTOR_COVERAGE_CONFIG;
  }
}

/** Clear the in-process cache — called after an admin update so the change shows immediately. */
export function clearDoctorCoverageConfigCache(): void {
  configCache = null;
}

export class DoctorCoverageConfigValidationError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "DoctorCoverageConfigValidationError";
    this.issues = issues;
  }
}

/**
 * Validate an incoming norms payload. Pure, so the editor and the route share one rule.
 * Rejects rather than clamps here: an admin typing 400 should be told, not silently given 31.
 */
export function validateDoctorCoverageNorms(input: unknown): DoctorCoverageNorms {
  const issues: string[] = [];
  const record = asRecord(input);
  const out = {} as DoctorCoverageNorms;
  for (const kind of KINDS) {
    const kindRecord = asRecord(record[kind]);
    out[kind] = {} as Record<DoctorCoverageGradeTier, number>;
    for (const grade of GRADES) {
      const raw = kindRecord[grade];
      const parsed = Number(raw);
      if (raw === undefined || raw === null || raw === "" || !Number.isFinite(parsed)) {
        issues.push(`${kind.toUpperCase()} grade ${grade}: enter a number of visits per month (0 means not scored).`);
        continue;
      }
      if (!Number.isInteger(parsed)) {
        issues.push(`${kind.toUpperCase()} grade ${grade}: visits per month must be a whole number.`);
        continue;
      }
      if (parsed < 0) {
        issues.push(`${kind.toUpperCase()} grade ${grade}: visits per month cannot be negative.`);
        continue;
      }
      if (parsed > MAX_VISITS_PER_MONTH) {
        issues.push(`${kind.toUpperCase()} grade ${grade}: ${parsed} is more than one visit a day — the maximum is ${MAX_VISITS_PER_MONTH}.`);
        continue;
      }
      out[kind][grade] = parsed;
    }
  }
  if (issues.length > 0) throw new DoctorCoverageConfigValidationError(issues);
  return out;
}

/**
 * Persist new norms. Writes an audit row (same posture as the probation config editor) because
 * this silently changes what every role's coverage % means, and a later "why did coverage jump"
 * needs to be answerable.
 */
export async function updateDoctorCoverageNorms(input: {
  norms: unknown;
  actorLoginId: string | null;
}): Promise<DoctorCoverageConfig> {
  const norms = validateDoctorCoverageNorms(input.norms);
  const previous = await getDoctorCoverageConfig();
  const updatedAt = new Date().toISOString();

  const { error } = await getSupabaseAdmin()
    .from("doctor_coverage_config")
    .upsert({ id: true, norms, updated_by: input.actorLoginId ?? null, updated_at: updatedAt }, { onConflict: "id" });
  if (error) throw new Error(error.message);

  clearDoctorCoverageConfigCache();

  await writeAuditLog({
    actorLoginId: input.actorLoginId ?? null,
    entityType: "doctor_coverage_config",
    entityId: "singleton",
    newValues: { norms },
    oldValues: { norms: previous.norms },
    summary: `Doctor Coverage visit norms updated (SP A/B/C = ${norms.sp.A}/${norms.sp.B}/${norms.sp.C}, HCP A/B/C = ${norms.hcp.A}/${norms.hcp.B}/${norms.hcp.C})`,
  });

  return { norms, updatedAt, updatedBy: input.actorLoginId ?? null };
}
