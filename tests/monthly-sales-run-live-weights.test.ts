import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  weightsFromTrailingValues,
  withLiveWeights,
  type MonthlySalesStep,
  type StepStatus,
} from "../src/lib/sales/monthly-sales-run.ts";

/**
 * "Monthly closing complete" on the Monthly Sales wizard weighs each step by the distributor's share
 * of sales. It read that weight from the step row, where it was frozen when the run opened. On
 * production the 2026-05 run, opened on 2026-06-17, still weighted Pharma Overseas at 59%, EGD at 33%
 * and Office at 0.66%, while the closing's own months put Office near a quarter of the money and EGD
 * near 1%. So 5 confirmed steps out of 17 read "95% complete", and because the stored weights summed
 * to 98% the month could never reach 100%.
 *
 * Owner, 2026-09-18: keep the figure a share of money, but work it out fresh every time. It reads
 * 100% exactly when every step is confirmed or skipped, the moment the month can be locked.
 */

const RUN_SRC = readFileSync(new URL("../src/lib/sales/monthly-sales-run.ts", import.meta.url), "utf8");
const WIZARD_SRC = readFileSync(new URL("../src/components/sales/monthly-sales-wizard.tsx", import.meta.url), "utf8");

// The 2026-05 run's 17 steps as stored on production: code, status, frozen weight.
const MAY_STEPS: Array<[string, StepStatus, number]> = [
  ["PS", "confirmed", 0.590533],
  ["EG", "confirmed", 0.331865],
  ["RM", "pending", 0.015914],
  ["IS", "confirmed", 0.010989],
  ["DIRECT", "confirmed", 0.009223],
  ["Office", "pending", 0.006628],
  ["IS-S", "confirmed", 0.004248],
  ["IS-T", "pending", 0.0024],
  ["SF-T", "pending", 0.001],
  ["RM-T", "pending", 0.001],
  ["EG-BR", "pending", 0.001],
  ["EG-HOS", "pending", 0.001],
  ["EP", "pending", 0.001],
  ["MC", "pending", 0.001],
  ["PS-T", "pending", 0.001],
  ["CP", "pending", 0.001],
  ["SF", "pending", 0.001],
];

// Each distributor's percentage of the closing's value in the three months before May, as the
// closing reported them on 2026-09-18. EP-PHS and EP-BK sold in those months but have no May step.
const TRAILING: Array<Record<string, number>> = [
  { OFFICE: 37.02, PS: 24.1, IS: 18.45, DIRECT: 9.83, "IS-T": 0.01, RM: 3.01, "IS-S": 3.05, "EG-HOS": 0.01, EG: 1.62, "EG-BR": 0.95, "PS-T": 0.04, MC: 0.04, EP: 0, CP: 0.03, "EP-PHS": 1.31, "EP-BK": 0.53 },
  { OFFICE: 22.37, PS: 36.22, IS: 16.41, DIRECT: 10.11, "IS-T": 0.01, RM: 1.66, "IS-S": 3.34, EG: 1.69, SF: 3.43, "EG-BR": 1.54, "PS-T": 1.94, MC: 0.03, EP: 0, CP: 0.06, "EP-PHS": 0.46, "EP-BK": 0.74 },
  { OFFICE: 9.19, PS: 35.27, IS: 15.15, DIRECT: 6.22, "IS-T": 3.34, RM: 23.73, "IS-S": 2.52, "EG-HOS": 0, EG: 1.06, SF: 1.01, "EG-BR": 0.85, "SF-T": 0.1, "RM-T": 1.09, "PS-T": 0.02, MC: 0.01, EP: 0.02, CP: 0, "EP-PHS": 0.19, "EP-BK": 0.23 },
];

function step(code: string, status: StepStatus, weight: number): MonthlySalesStep {
  return { distributorCode: code, distributorName: code, stepStatus: status, skipReason: null, batchId: null, weight, ordering: 0, batch: null };
}

function mayWeights(): Map<string, number> {
  return weightsFromTrailingValues(
    MAY_STEPS.map(([code]) => code),
    TRAILING.map((month) => new Map(Object.entries(month))),
  );
}

export function runMonthlySalesRunLiveWeightsTests() {
  // HEADLINE — May's run, with the frozen weights still on its rows, reads today's share of money.
  const mayRun = withLiveWeights(MAY_STEPS.map(([code, status, weight]) => step(code, status, weight)), mayWeights());
  assert.equal(
    mayRun.completionPct,
    62,
    `May 2026 has 5 of 17 steps confirmed, holding 62% of the usual sales value — it read 95% off the weights frozen on 17 June (got ${mayRun.completionPct}%)`,
  );

  // Every step now carries its current weight, matched whatever the stored code's case.
  const weightOf = (code: string) => mayRun.steps.find((s) => s.distributorCode === code)?.weight ?? -1;
  assert.ok(Math.abs(weightOf("Office") - 0.2303) < 0.0001, `Office's weight is its current share, about 23% (got ${weightOf("Office")})`);
  assert.ok(Math.abs(weightOf("EG") - 0.0147) < 0.0001, `EGD's weight is its current share, about 1.5%, not the frozen 33% (got ${weightOf("EG")})`);

  // The weights cover the run's steps and nothing else, and add up to exactly 1.
  const weights = mayWeights();
  const sum = [...weights.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `the run's weights sum to 1 (got ${sum})`);
  assert.equal(weights.size, MAY_STEPS.length, "only the run's own distributors are weighted");
  assert.ok(
    [...weights.values()].every((w) => w > 0),
    "every step weighs something, so no step can be ignored by the figure",
  );

  // 100% only when the month can be locked: one tiny feed still open holds it at 99.
  const allButCp = withLiveWeights(
    MAY_STEPS.map(([code, , weight]) => step(code, code === "CP" ? "pending" : "confirmed", weight)),
    weights,
  );
  assert.equal(allButCp.completionPct, 99, `one open step (CP, 0.1% of sales) reads 99%, never 100% (got ${allButCp.completionPct}%)`);

  const allDone = withLiveWeights(
    MAY_STEPS.map(([code, , weight], index) => step(code, index % 2 === 0 ? "confirmed" : "skipped", weight)),
    weights,
  );
  assert.equal(allDone.completionPct, 100, "every step confirmed or skipped reads 100%, even though the stored weights summed to 98%");

  const noneDone = withLiveWeights(MAY_STEPS.map(([code, , weight]) => step(code, "pending", weight)), weights);
  assert.equal(noneDone.completionPct, 0, "no step done reads 0%");

  // A first close ever, with no earlier month to weigh by, falls back to equal weights.
  const firstEver = weightsFromTrailingValues(["A", "B", "C", "D"], [new Map(), new Map([["A", 0]])]);
  assert.deepEqual([...firstEver.values()], [0.25, 0.25, 0.25, 0.25], "with no sales history every step weighs the same");

  // The run is weighed live on every load, and never from the stored column.
  assert.ok(
    RUN_SRC.includes("withLiveWeights(steps, liveWeights)"),
    "loadRun must weigh the steps with the shares it has just worked out",
  );
  assert.ok(
    !RUN_SRC.includes("Math.min(1, Math.max(0, doneWeight))"),
    "loadRun must not sum the frozen step weights into the figure",
  );

  // When the shares cannot be read, the figure is withheld and the wizard says so.
  assert.ok(RUN_SRC.includes("let completionPct: number | null = null;"), "a failed read leaves the figure empty, not guessed");
  assert.ok(
    WIZARD_SRC.includes('run.completionPct === null ? "—"') && WIZARD_SRC.includes("Sales shares could not be read"),
    "the wizard shows the figure as unavailable when the shares could not be read",
  );
  assert.ok(WIZARD_SRC.includes("by sales value"), "the wizard says what the percentage is a share of");
}
