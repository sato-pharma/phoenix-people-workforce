// ─────────────────────────────────────────────────────────────────────────────
// Make It Happen — a plan's units per brick, checked (engine.ts rule 9).
//
// PURE: no database, no server import, so the save and export routes (plans.ts) and the tests call
// the same check. A refusal is a PlanBricksError carrying the sentence the user reads; plans.ts turns
// it into a 400.
// ─────────────────────────────────────────────────────────────────────────────

import { brickUnitsFor, parseForecastUnits, type MakeItHappenWorkspace } from "@/lib/sales/make-it-happen/engine";

export class PlanBricksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanBricksError";
  }
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * Each product's units per brick, checked against the caller's own workspace: a brick must be one the
 * product sold on in scope, units whole, and a product's bricks must add up to its units. A product
 * sent with no bricks is split by its bricks' pace. Only bricks holding units are kept; a brick left
 * out reads 0. `units` are the product units already checked.
 */
export function checkPlanBricks(
  workspace: MakeItHappenWorkspace,
  units: Record<string, number>,
  raw: unknown,
): Record<string, Record<string, number>> {
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new PlanBricksError("The bricks of the plan could not be read.");
  }
  const sent = (raw ?? {}) as Record<string, unknown>;
  const open = new Map<string, MakeItHappenWorkspace["lines"][number]["rows"][number]>();
  for (const group of workspace.lines) {
    if (group.remainingMonths <= 0) continue;
    for (const row of group.rows) open.set(row.productCode, row);
  }
  for (const code of Object.keys(sent)) {
    if (!open.has(code)) throw new PlanBricksError("One of the products is not open in your plan for this period.");
  }

  const out: Record<string, Record<string, number>> = {};
  for (const [code, productUnits] of Object.entries(units)) {
    const row = open.get(code);
    if (!row || row.bricks.length === 0) continue;
    let given: Record<string, number> | null = null;
    const rawBricks = sent[code];
    if (rawBricks != null) {
      if (typeof rawBricks !== "object" || Array.isArray(rawBricks)) {
        throw new PlanBricksError(`The bricks of ${row.name} could not be read.`);
      }
      const known = new Set(row.bricks.map((brick) => brick.brickId));
      given = {};
      for (const [brickId, value] of Object.entries(rawBricks as Record<string, unknown>)) {
        const parsed = parseForecastUnits(value);
        if (parsed == null) throw new PlanBricksError("Units must be whole numbers of zero or more.");
        if (!known.has(brickId)) throw new PlanBricksError(`One of the bricks is not one ${row.name} sells on in your plan.`);
        given[brickId] = parsed;
      }
      const sum = Object.values(given).reduce((total, value) => total + value, 0);
      if (sum !== productUnits) {
        throw new PlanBricksError(
          `The bricks of ${row.name} add up to ${numberFormat.format(sum)} units, not ${numberFormat.format(productUnits)}.`,
        );
      }
    }
    const kept: Record<string, number> = {};
    for (const [brickId, value] of Object.entries(brickUnitsFor(row.bricks, productUnits, given))) {
      if (value > 0) kept[brickId] = value;
    }
    if (Object.keys(kept).length > 0) out[code] = kept;
  }
  return out;
}
