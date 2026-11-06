// ─────────────────────────────────────────────────────────────────────────────
// Make It Happen — saving a plan and asking Phoenix for one.
//
// Both actions rebuild the workspace from the database for the caller before doing anything, so
// a plan is always valued at today's price against today's target in the caller's OWN scope — a
// forged product code or a period nobody offered is refused, never stored.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { isUuid } from "@/lib/http/uuid";
import {
  achievementOf,
  isPeriodKind,
  parseForecastUnits,
  type MakeItHappenWorkspace,
  type SavedPlanSummary,
} from "@/lib/sales/make-it-happen/engine";
import { phoenixCoachMessage } from "@/lib/sales/make-it-happen/coach";
import { PlanBricksError, checkPlanBricks } from "@/lib/sales/make-it-happen/plan-bricks";
import { insertPlan, updateOwnPlan } from "@/lib/sales/make-it-happen/plan-store";
import {
  DEFAULT_GOAL_PCT,
  buildPlanScenarios,
  parseGoalPct,
  suggestedScenario,
  type PlanScenario,
} from "@/lib/sales/make-it-happen/scenarios";
import { canUseMakeItHappen } from "@/lib/sales/make-it-happen/scope";
import { buildMakeItHappenWorkspace } from "@/lib/sales/make-it-happen/workspace";

export class MakeItHappenError extends Error {
  status: 400 | 403 | 404;

  constructor(status: 400 | 403 | 404, message: string) {
    super(message);
    this.name = "MakeItHappenError";
    this.status = status;
  }
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new MakeItHappenError(400, "The request could not be read.");
  }
  return body as Record<string, unknown>;
}

export function requestBody(body: unknown): Record<string, unknown> {
  return bodyObject(body);
}

export function requestedRep(body: Record<string, unknown>): string | null {
  return typeof body.rep === "string" && body.rep.trim() ? body.rep.trim() : null;
}

/** The chosen goal, or a 400 in words when the box holds something that is not a goal. */
export function requestedGoalPct(body: Record<string, unknown>): number {
  const goal = parseGoalPct(body.goalPct);
  if (goal == null) throw new MakeItHappenError(400, "Choose an achievement goal between 1% and 300%.");
  return goal;
}

/**
 * Typed units checked against what is really open in the caller's own workspace — the same refusal
 * the save path gives, so an export can never carry a product the screen could not have planned.
 */
export function validatedUnits(workspace: MakeItHappenWorkspace, raw: unknown): Record<string, number> {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new MakeItHappenError(400, "The plan has no units.");
  const open = openConcentrations(workspace);
  const units: Record<string, number> = {};
  for (const [code, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = parseForecastUnits(value);
    if (parsed == null) throw new MakeItHappenError(400, "Units must be whole numbers of zero or more.");
    if (parsed === 0) continue;
    if (!open.has(code)) throw new MakeItHappenError(400, "One of the products is not open in your plan for this period.");
    units[code] = parsed;
  }
  return units;
}

/** A plan's units per brick (engine.ts rule 9), checked in plan-bricks.ts; a refusal is a 400 in words. */
export function validatedBricks(
  workspace: MakeItHappenWorkspace,
  units: Record<string, number>,
  raw: unknown,
): Record<string, Record<string, number>> {
  try {
    return checkPlanBricks(workspace, units, raw);
  } catch (error) {
    if (error instanceof PlanBricksError) throw new MakeItHappenError(400, error.message);
    throw error;
  }
}

export async function workspaceFor(ctx: AccessContext, body: Record<string, unknown>, rep: string | null) {
  if (!canUseMakeItHappen(ctx.role)) {
    throw new MakeItHappenError(403, "Make It Happen is not available for your role.");
  }
  const periodKind = body.periodKind;
  const periodKey = typeof body.periodKey === "string" ? body.periodKey : "";
  if (!isPeriodKind(periodKind) || !periodKey) {
    throw new MakeItHappenError(400, "Choose a month, quarter or semester first.");
  }
  const workspace = await buildMakeItHappenWorkspace(ctx, { kind: periodKind, period: periodKey, rep });
  if (workspace.periodKind !== periodKind || workspace.periodKey !== periodKey) {
    throw new MakeItHappenError(400, "That period cannot be planned.");
  }
  return workspace;
}

/** Concentrations still open for forecasting, keyed by product code. */
function openConcentrations(workspace: MakeItHappenWorkspace) {
  const open = new Map<string, { price: number; name: string; row: MakeItHappenWorkspace["lines"][number]["rows"][number] }>();
  for (const group of workspace.lines) {
    if (group.remainingMonths <= 0) continue;
    for (const row of group.rows) open.set(row.productCode, { price: row.price, name: row.name, row });
  }
  return open;
}

export async function saveForecastPlan(ctx: AccessContext, rawBody: unknown): Promise<SavedPlanSummary> {
  // The role decides first: a refused role must hear 403, never a form-validation answer that
  // tells it the endpoint would have accepted a better-shaped body.
  if (!canUseMakeItHappen(ctx.role)) {
    throw new MakeItHappenError(403, "Make It Happen is not available for your role.");
  }
  const body = bodyObject(rawBody);
  const ownerKey = canonicalHrIdForDisplay(ctx.hrId);
  if (!ownerKey) {
    throw new MakeItHappenError(403, "Your account is not linked to an employee record, so a plan cannot be saved.");
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 80) {
    throw new MakeItHappenError(400, "Give the plan a name of up to 80 characters.");
  }
  const planId = body.planId == null || body.planId === "" ? null : String(body.planId);
  if (planId && !isUuid(planId)) throw new MakeItHappenError(404, "That plan was not found.");
  if (!body.units || typeof body.units !== "object" || Array.isArray(body.units)) {
    throw new MakeItHappenError(400, "The plan has no units.");
  }

  const workspace = await workspaceFor(ctx, body, null);
  const open = openConcentrations(workspace);
  if (open.size === 0) {
    throw new MakeItHappenError(400, "This period is already closed, so there is nothing left to plan.");
  }

  const units: Record<string, number> = {};
  let forecastValue = 0;
  for (const [code, raw] of Object.entries(body.units as Record<string, unknown>)) {
    const parsed = parseForecastUnits(raw);
    if (parsed == null) throw new MakeItHappenError(400, "Units must be whole numbers of zero or more.");
    if (parsed === 0) continue;
    const concentration = open.get(code);
    if (!concentration) throw new MakeItHappenError(400, "One of the products is not open in your plan for this period.");
    units[code] = parsed;
    forecastValue += parsed * concentration.price;
  }

  const bricks = validatedBricks(workspace, units, body.bricks);

  const values = {
    ownerKey,
    periodKind: workspace.periodKind,
    periodKey: workspace.periodKey,
    name,
    units,
    bricks,
    forecastValue,
    forecastAchievement: achievementOf(workspace.totals.gradedValue, forecastValue, workspace.totals.targetValue),
    targetValue: workspace.totals.targetValue,
  };

  const stored = planId ? await updateOwnPlan(planId, values) : await insertPlan(values);
  if (!stored) throw new MakeItHappenError(404, "That plan was not found.");
  const { ownerKey: _ownerKey, ...summary } = stored;
  return summary;
}

export type MakeItHappenSuggestion = {
  units: Record<string, number>;
  reachable: boolean | null;
  projectedAchievement: number | null;
  shortValue: number;
  message: string;
  /** The goal the plan was built for, as a whole percentage of target. */
  goalPct: number;
  /** Scenario 1 steady pace, 2 realistic plan, 3 your goal — the units above are 3 when realistic, else 2. */
  scenarios: PlanScenario[];
};

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export async function suggestRealisticPlan(ctx: AccessContext, rawBody: unknown): Promise<MakeItHappenSuggestion> {
  const body = bodyObject(rawBody);
  const rep = requestedRep(body);
  const goalPct = requestedGoalPct(body);
  const workspace = await workspaceFor(ctx, body, rep);
  const open = openConcentrations(workspace);
  if (open.size === 0) {
    throw new MakeItHappenError(400, "This period is already closed, so there is nothing left to plan.");
  }

  // The suggestion IS one of the cards (suggestedScenario): Scenario 3 when your goal sits inside what
  // the products realistically support, Scenario 2 otherwise — one builder, so the plan Phoenix
  // fills in and the card beside it can never disagree, and a Pedia plan meets its Sato half first.
  const scenarios = buildPlanScenarios(workspace, goalPct);
  const pace = scenarios[0];
  const suggestion = suggestedScenario(scenarios);
  const shortValue = suggestion.shortOfGoal ?? 0;
  const pct = (value: number | null) => (value == null ? null : `${(value * 100).toFixed(1)}%`);
  const egp = (value: number) => `EGP ${numberFormat.format(Math.round(value))}`;

  const picks = Object.entries(suggestion.units)
    .filter(([, units]) => units > 0)
    .map(([code, units]) => ({ code, units, value: units * (open.get(code)?.price ?? 0) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((pick) => ({ name: open.get(pick.code)?.name ?? "this product", unitsLabel: numberFormat.format(pick.units) }));

  const message = await phoenixCoachMessage({
    periodLabel: workspace.periodLabel,
    goalLabel: goalPct === DEFAULT_GOAL_PCT ? null : `${goalPct}%`,
    projectedAchievementLabel: pct(suggestion.achievement),
    shortValueLabel: shortValue > 0 ? egp(shortValue) : null,
    reachable: suggestion.planReachesGoal,
    onTrack: pace.reachesGoal === true,
    earlyHistory: [...open.values()].some(({ row }) => row.trend.kind === "early"),
    picks,
    halves: suggestion.checks
      .filter((check) => check.targetValue != null)
      .map((check) => ({
        label: check.label,
        achievementLabel: pct(check.achievement) ?? "",
        shortValueLabel: check.reachesGoal === false ? egp(check.shortOfGoal ?? 0) : null,
      })),
  });

  return {
    units: suggestion.units,
    reachable: suggestion.reachesGoal,
    projectedAchievement: suggestion.achievement,
    shortValue,
    message,
    goalPct,
    scenarios,
  };
}
