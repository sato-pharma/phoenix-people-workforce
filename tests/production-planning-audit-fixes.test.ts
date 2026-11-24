import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { cairoDate, isAfterToday, spellDate } from "@/lib/production-planning/dates.ts";
import { planProgress, type PlanProgressPlan, type PlanProgressRun } from "@/lib/production-planning/execution.ts";
import { stockReversal, type StockHistoryRow } from "@/lib/production-planning/stock.ts";

/**
 * The audit of the Production Planner for Dr. Sahar (owner, 2026-11-24: "deep audit the module, dr
 * sahar is having difficulty working with it — understand its concept, facilitate and recommend
 * enhancements"). He chose all four fixes:
 *
 *   1. THE PRODUCT ON EVERY TAB, REMEMBERED. The page opened on the first product and only the
 *      Planner tab could change it; on 3 November 576 kg of Saginkgo foil went in against another
 *      product's aluminium film.
 *   2. A WRONG ENTRY IS PUT RIGHT FROM THE SCREEN. There was no list of entries and no undo — the
 *      foil needed a database write. A reversal is a new row back to the balance before the entry.
 *   3. DATES AND SOURCES THAT CANNOT GO WRONG QUIETLY. Three deliveries typed on 12 October were
 *      stored as 10 November (the date box reads month/day); every Sato-warehouse count was saved as
 *      a "factory report"; a refused save showed its message two screens above the button.
 *   4. THE PLAN AND THE EXECUTION MEET. A committed plan never showed how much of it was produced.
 */

function row(partial: Partial<StockHistoryRow> & { id: string }): StockHistoryRow {
  return {
    materialId: "box",
    locationId: "medcare",
    expiryDate: null,
    qty: BigInt(0),
    asOfDate: "2026-11-24",
    source: "factory_report",
    createdAt: "2026-11-24T13:00:00.000000+00:00",
    ...partial,
  };
}

export function runProductionPlanningAuditFixesTests() {
  // ── 2. The reversal rule ────────────────────────────────────────────────────────────────────
  // The foil, as production holds it: the owner's 576,885 g at Sato's store, then today's zero.
  const foil = [
    row({ id: "moved", materialId: "foil", locationId: "sato", qty: BigInt(576_885), asOfDate: "2026-11-03", source: "own_count", createdAt: "2026-11-10T23:12:00.1+00:00" }),
    row({ id: "moved-out", materialId: "film", locationId: "sato", qty: BigInt(0), asOfDate: "2026-11-11", source: "own_count", createdAt: "2026-11-10T23:12:00.1+00:00" }),
    row({ id: "typo", materialId: "foil", locationId: "sato", qty: BigInt(999), asOfDate: "2026-11-24", source: "own_count", createdAt: "2026-11-24T15:00:00+00:00" }),
  ];
  const typo = stockReversal(foil, "typo");
  assert.ok(typo.ok, "the newest entry of a lot, typed on its own, can be reversed");
  assert.equal(typo.ok && typo.restoreQty, BigInt(576_885), "a reversal puts the lot back to the balance before the entry");
  assert.deepEqual(
    stockReversal(foil.filter((entry) => entry.id !== "moved-out"), "moved"),
    { ok: false, reason: "notNewest" },
    "an entry a later count has replaced cannot be reversed — the lot no longer holds what was before it",
  );
  assert.deepEqual(
    stockReversal(foil.slice(0, 2), "moved"),
    { ok: false, reason: "paired" },
    "half of a move (two rows, one insert, one timestamp) is never reversed on its own",
  );
  assert.deepEqual(stockReversal(foil, "nothing"), { ok: false, reason: "notFound" });
  const first = stockReversal([row({ id: "only", qty: BigInt(65_300) })], "only");
  assert.ok(first.ok && first.restoreQty === BigInt(0), "the first entry of a lot goes back to nothing");

  // The Saginkgo boxes: a count, the production's take, then a count typed after it.
  const boxes = [
    row({ id: "count", qty: BigInt(65_300), createdAt: "2026-11-24T14:00:00+00:00" }),
    row({ id: "run", qty: BigInt(43_170), source: "production", createdAt: "2026-11-24T14:16:00+00:00" }),
    row({ id: "after", qty: BigInt(54_470), createdAt: "2026-11-24T14:19:00+00:00" }),
  ];
  assert.deepEqual(
    stockReversal(boxes, "after"),
    { ok: false, reason: "afterProduction" },
    "a count right after a production is corrected by a new count, never reversed onto the production's row",
  );
  assert.deepEqual(stockReversal(boxes.slice(0, 2), "run"), { ok: false, reason: "production" });
  const delivered = stockReversal(
    [...boxes.slice(0, 2), row({ id: "delivery", qty: BigInt(53_170), source: "delivery", createdAt: "2026-11-24T15:00:00+00:00" })],
    "delivery",
  );
  assert.ok(delivered.ok && delivered.restoreQty === BigInt(43_170), "a delivery after a production only added, so it reverses");

  // ── 3. Dates ────────────────────────────────────────────────────────────────────────────────
  assert.equal(spellDate("2026-11-10", "en"), "10 November 2026", "the date she picked is spelled out under the box");
  assert.equal(spellDate("2026-11-10", "ar"), "10 نوفمبر 2026");
  assert.equal(spellDate("", "ar"), "");
  assert.equal(spellDate("11/10/2026", "en"), "", "only an ISO date is spelled; nothing else is guessed at");
  assert.equal(isAfterToday("2026-11-10", "2026-10-12"), true, "her 12 October delivery dated 10 November is refused");
  assert.equal(isAfterToday("2026-10-12", "2026-10-12"), false, "today is allowed");
  assert.equal(isAfterToday(null, "2026-10-12"), false, "no date means today, which is allowed");
  assert.equal(cairoDate(new Date("2026-11-24T22:30:00Z")), "2026-11-25", "Cairo's day, not UTC's");

  // ── 4. Plan progress — Saginkgo as production holds it ─────────────────────────────────────
  const plan: PlanProgressPlan = {
    id: "plan",
    title: "ساجنكو 120 مجم — 17 تشغيلة",
    status: "committed",
    requestMode: "total_boxes",
    requestedQty: "22130",
    sampleUnits: "6985",
    committedAt: "2026-11-24T12:24:00+00:00",
  };
  const nov26: PlanProgressRun = {
    planId: null,
    stage: "awaiting_balance",
    producedOn: "2026-11-24",
    saleableBoxes: "22130",
    actualSampleUnits: "6985",
    exactRuns: "23.294167",
  };
  const saginkgo = planProgress([plan], [nov26], cairoDate);
  assert.ok(saginkgo, "a committed plan is shown");
  assert.equal(saginkgo.target, "22130");
  assert.equal(saginkgo.done, "29115", "a total-boxes plan counts the samples inside the total, as the plan itself does");
  assert.equal(saginkgo.over, "6985", "what went past the plan is shown as over, never as a negative left");
  assert.equal(saginkgo.left, "0");
  assert.equal(saginkgo.productionsCounted, 1, "a production recorded before productions carried their plan is matched by date");
  assert.equal(
    planProgress([plan], [{ ...nov26, producedOn: "2026-11-23" }], cairoDate)?.productionsCounted,
    0,
    "an unlinked production made before the plan was committed is not counted against it",
  );
  assert.equal(planProgress([plan], [{ ...nov26, stage: "cancelled" }], cairoDate)?.done, "0", "a cancelled production counts for nothing");
  assert.equal(planProgress([plan], [{ ...nov26, planId: "other" }], cairoDate)?.done, "0", "another plan's production is not this one's");
  const saleable = planProgress([{ ...plan, requestMode: "good_units" }], [nov26], cairoDate);
  assert.equal(saleable?.done, "22130", "a saleable-boxes plan counts boxes only");
  assert.equal(saleable?.samplesDone, "6985");
  const byRuns = planProgress([{ ...plan, requestMode: "runs", requestedQty: "17" }], [nov26], cairoDate);
  assert.equal(byRuns?.done, "23.29", "a runs plan counts exact runs, to two decimals");
  assert.equal(byRuns?.over, "6.29");
  assert.equal(planProgress([{ ...plan, status: "draft" }], [nov26], cairoDate), null, "a draft is not a plan to report against");

  // ── The service obeys the rules ─────────────────────────────────────────────────────────────
  // Read as text because service.ts pulls in the Supabase admin client.
  const service = readFileSync("src/lib/production-planning/service.ts", "utf8");
  assert.equal(
    (service.match(/refuseFutureDate\(/g) ?? []).length,
    5,
    "the stock report, the move, the production and the factory balance all refuse a date after today (plus the helper itself)",
  );
  const reverse = service.slice(service.indexOf("export async function reverseStockEntry"), service.indexOf("export async function updateProductPackaging"));
  assert.ok(reverse.indexOf("await assertWrite(access)") < reverse.indexOf("body.entryId"), "write access is asserted before the body is read");
  assert.match(reverse, /stockReversal\(rows, entryId\)/, "the writer decides through the pure rule, never inline");
  assert.match(reverse, /source: "adjustment"/, "a reversal is a new row — nothing is deleted or updated");
  assert.doesNotMatch(reverse, /\.delete\(|\.update\(/, "a reversal never deletes or rewrites a stock row");
  assert.match(reverse, /writeRequiredAuditLog/, "every reversal is in the history log");
  const execute = service.slice(service.indexOf("export async function executeProduction"), service.indexOf("async function loadRunForExecution"));
  assert.match(execute, /plan_id: committedPlan\.data\?\.id/, "a production carries the newest committed plan it was made against");
  const route = readFileSync("app/api/production-planning/stock/route.ts", "utf8");
  assert.match(route, /body\.action === "reverse" \? await reverseStockEntry\(access, body\)/);

  // ── The screen ──────────────────────────────────────────────────────────────────────────────
  const workspace = readFileSync("src/components/production-planning/production-planning-workspace.tsx", "utf8");
  const shell = workspace.slice(workspace.indexOf("export function ProductionPlanningWorkspace("), workspace.indexOf("export function PlannerTab("));
  const planner = workspace.slice(workspace.indexOf("export function PlannerTab("), workspace.indexOf("function PlannerResult("));
  assert.match(shell, /onChange=\{\(event\) => chooseProduct\(event\.target\.value\)\}/, "the product is chosen above the tabs, for every tab");
  assert.doesNotMatch(planner, /onProductChange/, "the Planner tab no longer holds a picker of its own");
  assert.match(shell, /useState<string>\(rememberedProduct\)/, "the page opens on the product last chosen in this browser");
  assert.match(shell, /errorRef\.current\?\.scrollIntoView/, "a refused save is brought into view");
  assert.match(shell, /awaitingRuns\.length > 0 && tab !== "run"/, "a production waiting for its balance is announced on every other tab");
  const stockTab = workspace.slice(workspace.indexOf("export function StockTab("), workspace.indexOf("function StockHistory("));
  assert.ok(
    stockTab.indexOf("t.stockBalancesTitle") < stockTab.indexOf('openForm === "add"'),
    "the balances come first on the Stock tab and the forms after them",
  );
  assert.match(stockTab, /setSource\(store\.isFactory \? "factory_report" : "own_count"\)/, "the source follows the store");
  assert.match(stockTab, /max=\{cairoDate\(\)\}/, "the date box offers no day after today");
  assert.match(stockTab, /spellDate\(asOfDate, S\.lang\)/, "the date is spelled out under the box");
  const history = workspace.slice(workspace.indexOf("function StockHistory("), workspace.indexOf("function StoreHeld("));
  assert.match(history, /action: "reverse"/, "the entry list's button posts a reversal");
  assert.match(history, /entry\.reversible/, "the button is offered only where the service will accept it");
  const runTab = workspace.slice(workspace.indexOf("export function RunTab("), workspace.indexOf("function wastePctText("));
  assert.match(runTab, /planProgress\(data\.plans, data\.runs, cairoDate\)/, "the Execution tab shows how far the plan has got");
}
