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
  buildRealisticMix,
  isPeriodKind,
  parseForecastUnits,
  type MakeItHappenWorkspace,
  type MixItem,
  type SavedPlanSummary,
} from "@/lib/sales/make-it-happen/engine";
import { phoenixCoachMessage } from "@/lib/sales/make-it-happen/coach";
import { insertPlan, updateOwnPlan } from "@/lib/sales/make-it-happen/plan-store";
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

async function workspaceFor(ctx: AccessContext, body: Record<string, unknown>, rep: string | null) {
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

  const values = {
    ownerKey,
    periodKind: workspace.periodKind,
    periodKey: workspace.periodKey,
    name,
    units,
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
};

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export async function suggestRealisticPlan(ctx: AccessContext, rawBody: unknown): Promise<MakeItHappenSuggestion> {
  const body = bodyObject(rawBody);
  const rep = typeof body.rep === "string" && body.rep.trim() ? body.rep.trim() : null;
  const workspace = await workspaceFor(ctx, body, rep);
  const open = openConcentrations(workspace);
  if (open.size === 0) {
    throw new MakeItHappenError(400, "This period is already closed, so there is nothing left to plan.");
  }

  const items: MixItem[] = [...open.values()].map(({ row }) => ({
    key: row.productCode,
    price: row.price,
    expectedUnits: row.trend.expectedUnits,
    realisticMaxUnits: row.trend.realisticMaxUnits,
    unitsStillToTarget: row.targetUnits != null ? row.targetUnits - row.gradedUnits : null,
  }));

  const target = workspace.totals.targetValue;
  const gap = target != null ? Math.max(0, target - workspace.totals.gradedValue) : null;
  const expectedValue = items.reduce((sum, item) => sum + item.expectedUnits * item.price, 0);
  const mix = buildRealisticMix(items, gap);
  const projectedAchievement = achievementOf(workspace.totals.gradedValue, mix.plannedValue, target);

  const picks = Object.entries(mix.units)
    .filter(([, units]) => units > 0)
    .map(([code, units]) => ({ code, units, value: units * (open.get(code)?.price ?? 0) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((pick) => ({ name: open.get(pick.code)?.name ?? "this product", unitsLabel: numberFormat.format(pick.units) }));

  const message = await phoenixCoachMessage({
    periodLabel: workspace.periodLabel,
    projectedAchievementLabel: projectedAchievement == null ? null : `${(projectedAchievement * 100).toFixed(1)}%`,
    shortValueLabel: mix.shortValue > 0 ? `EGP ${numberFormat.format(Math.round(mix.shortValue))}` : null,
    reachable: mix.reachable,
    onTrack: gap != null && expectedValue >= gap,
    earlyHistory: [...open.values()].some(({ row }) => row.trend.kind === "early"),
    picks,
  });

  return {
    units: mix.units,
    reachable: mix.reachable,
    projectedAchievement,
    shortValue: mix.shortValue,
    message,
  };
}
