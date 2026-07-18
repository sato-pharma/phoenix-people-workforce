// Probation configuration — admin-editable policy with a TS-const fallback.
//
// Mirrors the payroll_statutory_config / v2_vacation_sla_settings pattern: the DB singleton
// (probation_config) is the source of truth once present; DEFAULT_PROBATION_CONFIG is the
// compile-time fallback that keeps the module working before the row is seeded or when the
// schema is not yet migrated (schema-missing guard). Cached briefly to avoid per-request reads.

import { writeAuditLog } from "@/lib/admin/audit";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { ProbationEvaluatorRole } from "./types";

export type ProbationRoleRequirements = Record<ProbationEvaluatorRole, number>;

export type ProbationRoleWeights = Record<ProbationEvaluatorRole | "sfe" | "hr", number>;

export type ProbationScoringScale = { min: number; max: number };

export type ProbationSlaPolicy = {
  /** Feedback becomes due this many hours after a validated DV-Day is imported. */
  dueHours: number;
  /** Escalate to the manager chain after this many hours if still pending. */
  escalateHours: number;
  /** Mark overdue after this many hours. */
  overdueHours: number;
};

export type ProbationConfig = {
  requirements: ProbationRoleRequirements;
  roleWeights: ProbationRoleWeights;
  scoringScale: ProbationScoringScale;
  sla: ProbationSlaPolicy;
  /** Ordered scorecard dimension keys the structured feedback form scores (config-driven). */
  scorecardDimensions: string[];
  /**
   * Admin enable/disable switch for the HR probation assessment. ON by default: this module
   * covers the field force (Medical Reps + District Managers), for whom fingerprint attendance is
   * not an input, so the HR assessment is available (leave/deductions auto signals + HR judgment).
   * When false, the HR component reports "unavailable" and HR submission is blocked.
   */
  hrAssessmentEnabled: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
};

// The default structured scorecard dimensions (spec §Structured Feedback Form).
export const DEFAULT_SCORECARD_DIMENSIONS: string[] = [
  "medical_knowledge",
  "product_knowledge",
  "communication",
  "selling_skills",
  "customer_engagement",
  "call_planning",
  "objection_handling",
  "closing_skills",
  "professional_behavior",
  "crm_compliance",
  "coachability",
  "overall_field_readiness",
];

// Owner-locked defaults: DM 3 / TM 1 / PM|GPM 1 / NSM 1 = 6 DV-Days; 1..10 scale; SLA 24/48/72h.
export const DEFAULT_PROBATION_CONFIG: ProbationConfig = {
  // Training Manager feedback is OPTIONAL (owner directive 2026-07-18): tm requirement = 0, so a
  // missing TM component never blocks decision-readiness and never appears as a required-but-missing
  // item. The tm weight is kept — if a TM DOES submit feedback it still counts (the score normalizes
  // over PRESENT components). TM DV-days are also excluded from SLA reminders/escalation (see
  // feedback-sla-reminders.ts).
  requirements: { dm: 3, tm: 0, pm_gpm: 1, nsm: 1 },
  roleWeights: { dm: 0.3, tm: 0.15, pm_gpm: 0.15, nsm: 0.15, sfe: 0.15, hr: 0.1 },
  scoringScale: { min: 1, max: 10 },
  sla: { dueHours: 24, escalateHours: 48, overdueHours: 72 },
  scorecardDimensions: DEFAULT_SCORECARD_DIMENSIONS,
  hrAssessmentEnabled: true,
  updatedBy: null,
  updatedAt: null,
};

/** Total required DV-Days across all roles (derived, never hard-coded elsewhere). */
export function totalRequiredDvDays(config: ProbationConfig = DEFAULT_PROBATION_CONFIG): number {
  return Object.values(config.requirements).reduce((sum, n) => sum + (Number(n) || 0), 0);
}

type ProbationConfigRow = {
  requirements: unknown;
  role_weights: unknown;
  scoring_scale: unknown;
  sla: unknown;
  scorecard_dimensions: unknown;
  hr_assessment_enabled: unknown;
  updated_by: string | null;
  updated_at: string | null;
};

function stringArrayOr(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value.map((v) => String(v ?? "").trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isProbationConfigSchemaMissing(error: unknown): boolean {
  const message = String(
    (error as { message?: unknown })?.message ?? error ?? "",
  ).toLowerCase();
  return (
    message.includes("probation_config") ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

function mapConfigRow(row: ProbationConfigRow): ProbationConfig {
  const req = asRecord(row.requirements);
  const weights = asRecord(row.role_weights);
  const scale = asRecord(row.scoring_scale);
  const sla = asRecord(row.sla);
  const d = DEFAULT_PROBATION_CONFIG;
  return {
    requirements: {
      dm: numberOr(req.dm, d.requirements.dm),
      tm: numberOr(req.tm, d.requirements.tm),
      pm_gpm: numberOr(req.pm_gpm, d.requirements.pm_gpm),
      nsm: numberOr(req.nsm, d.requirements.nsm),
    },
    roleWeights: {
      dm: numberOr(weights.dm, d.roleWeights.dm),
      tm: numberOr(weights.tm, d.roleWeights.tm),
      pm_gpm: numberOr(weights.pm_gpm, d.roleWeights.pm_gpm),
      nsm: numberOr(weights.nsm, d.roleWeights.nsm),
      sfe: numberOr(weights.sfe, d.roleWeights.sfe),
      hr: numberOr(weights.hr, d.roleWeights.hr),
    },
    scoringScale: {
      min: numberOr(scale.min, d.scoringScale.min),
      max: numberOr(scale.max, d.scoringScale.max),
    },
    sla: {
      dueHours: numberOr(sla.dueHours, d.sla.dueHours),
      escalateHours: numberOr(sla.escalateHours, d.sla.escalateHours),
      overdueHours: numberOr(sla.overdueHours, d.sla.overdueHours),
    },
    scorecardDimensions: stringArrayOr(row.scorecard_dimensions, d.scorecardDimensions),
    hrAssessmentEnabled: typeof row.hr_assessment_enabled === "boolean" ? row.hr_assessment_enabled : d.hrAssessmentEnabled,
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

const CONFIG_CACHE_MS = 30_000;
let configCache: { fetchedAt: number; config: ProbationConfig } | null = null;

/**
 * Resolve the effective probation config: DB singleton merged over the TS-const default.
 * Falls back to DEFAULT_PROBATION_CONFIG (never throws) when the table is missing/empty or
 * on a transient read error, so callers always get a usable, complete config.
 */
export async function getProbationConfig(): Promise<ProbationConfig> {
  if (configCache && configCache.fetchedAt + CONFIG_CACHE_MS > Date.now()) {
    return configCache.config;
  }
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("probation_config")
      .select("requirements,role_weights,scoring_scale,sla,scorecard_dimensions,hr_assessment_enabled,updated_by,updated_at")
      .eq("id", true)
      .maybeSingle();
    if (error) {
      if (isProbationConfigSchemaMissing(error)) return DEFAULT_PROBATION_CONFIG;
      throw error;
    }
    const config = data ? mapConfigRow(data as ProbationConfigRow) : DEFAULT_PROBATION_CONFIG;
    configCache = { fetchedAt: Date.now(), config };
    return config;
  } catch (error) {
    if (isProbationConfigSchemaMissing(error)) return DEFAULT_PROBATION_CONFIG;
    // Non-schema transient error: prefer last-known-good, else defaults. Never throw upward —
    // config must always resolve so scoring/SLA can compute.
    return configCache?.config ?? DEFAULT_PROBATION_CONFIG;
  }
}

/** Clear the in-process cache (call after an admin config update). */
export function clearProbationConfigCache() {
  configCache = null;
}

// ── Admin editor (Enhancement E5) ─────────────────────────────────────────────

export class ProbationConfigValidationError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(`Validation failed: ${issues.join(" ")}`);
    this.name = "ProbationConfigValidationError";
    this.issues = issues;
  }
}

export type ProbationConfigInput = {
  requirements: ProbationRoleRequirements;
  roleWeights: ProbationRoleWeights;
  scoringScale: ProbationScoringScale;
  sla: ProbationSlaPolicy;
  scorecardDimensions: string[];
  hrAssessmentEnabled: boolean;
};

const ROLE_KEYS: (keyof ProbationRoleRequirements)[] = ["dm", "tm", "pm_gpm", "nsm"];
const WEIGHT_KEYS: (keyof ProbationRoleWeights)[] = ["dm", "tm", "pm_gpm", "nsm", "sfe", "hr"];

function validateProbationConfigInput(input: ProbationConfigInput): string[] {
  const issues: string[] = [];
  for (const k of ROLE_KEYS) {
    const v = Number(input.requirements?.[k]);
    if (!Number.isInteger(v) || v < 0) issues.push(`Requirement "${k}" must be a whole number ≥ 0.`);
  }
  for (const k of WEIGHT_KEYS) {
    const v = Number(input.roleWeights?.[k]);
    if (!Number.isFinite(v) || v < 0) issues.push(`Weight "${k}" must be a number ≥ 0.`);
  }
  if (WEIGHT_KEYS.every((k) => Number(input.roleWeights?.[k]) === 0)) issues.push("At least one role weight must be > 0.");
  const { min, max } = input.scoringScale ?? {};
  if (!Number.isInteger(min) || !Number.isInteger(max) || Number(min) >= Number(max)) {
    issues.push("Scoring scale must have integer min < max.");
  }
  const { dueHours, escalateHours, overdueHours } = input.sla ?? {};
  if (![dueHours, escalateHours, overdueHours].every((h) => Number.isFinite(h) && Number(h) > 0)) {
    issues.push("SLA hours must be positive numbers.");
  } else if (!(Number(dueHours) <= Number(escalateHours) && Number(escalateHours) <= Number(overdueHours))) {
    issues.push("SLA hours must be non-decreasing: due ≤ escalate ≤ overdue.");
  }
  const dims = input.scorecardDimensions;
  if (!Array.isArray(dims) || dims.filter((d) => String(d ?? "").trim()).length === 0) {
    issues.push("At least one scorecard dimension is required.");
  }
  if (typeof input.hrAssessmentEnabled !== "boolean") issues.push("hrAssessmentEnabled must be a boolean.");
  return issues;
}

/**
 * Persist the admin-edited probation config to the singleton, audit it, and clear the cache.
 * Throws ProbationConfigValidationError on invalid input. Caller must have already checked authz.
 */
export async function saveProbationConfig(
  input: ProbationConfigInput,
  actor: { loginId?: string | null; hrId?: string | null },
): Promise<ProbationConfig> {
  const issues = validateProbationConfigInput(input);
  if (issues.length > 0) throw new ProbationConfigValidationError(issues);

  const previous = await getProbationConfig();
  const now = new Date().toISOString();
  const actorId = actor.loginId ?? actor.hrId ?? "system";

  const { data, error } = await getSupabaseAdmin()
    .from("probation_config")
    .upsert(
      {
        id: true,
        requirements: {
          dm: Number(input.requirements.dm), tm: Number(input.requirements.tm),
          pm_gpm: Number(input.requirements.pm_gpm), nsm: Number(input.requirements.nsm),
        },
        role_weights: Object.fromEntries(WEIGHT_KEYS.map((k) => [k, Number(input.roleWeights[k])])),
        scoring_scale: { min: Number(input.scoringScale.min), max: Number(input.scoringScale.max) },
        sla: {
          dueHours: Number(input.sla.dueHours), escalateHours: Number(input.sla.escalateHours),
          overdueHours: Number(input.sla.overdueHours),
        },
        scorecard_dimensions: input.scorecardDimensions.map((d) => String(d).trim()).filter(Boolean),
        hr_assessment_enabled: input.hrAssessmentEnabled,
        updated_by: actorId,
        updated_at: now,
      },
      { onConflict: "id" },
    )
    .select("requirements,role_weights,scoring_scale,sla,scorecard_dimensions,hr_assessment_enabled,updated_by,updated_at")
    .single();
  if (error) throw error;

  clearProbationConfigCache();

  await writeAuditLog({
    actorLoginId: actorId,
    entityType: "probation_config",
    entityId: "probation_config",
    oldValues: previous as unknown as Record<string, unknown>,
    newValues: input as unknown as Record<string, unknown>,
    summary: `Probation config updated by ${actorId}`,
  });

  return mapConfigRow(data as ProbationConfigRow);
}
