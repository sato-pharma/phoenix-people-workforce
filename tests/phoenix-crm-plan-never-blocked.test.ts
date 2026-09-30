import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { weekTimingsText } from "../src/lib/phoenix-crm/timings.ts";
import type { PhoenixCrmTiming } from "../src/lib/phoenix-crm/types.ts";

/**
 * Phoenix CRM plan — a day his saved hours do not cover NEVER blocks a customer (owner, 2026-09-30,
 * reviewing the plan as TEST-AYA: "does not receive on Wednesday — never block, because the rep didn't
 * add his time; add a column for timings but never block"), and the day's rows lose the "Day full"
 * word, carry a small inline "Not validated yet", and show brick and address where the blank was.
 * The server half (plan-rules.ts) and the draft/copy half (plan-week-draft.ts) are pinned in
 * phoenix-crm-rules and phoenix-crm-plan-board.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

function timing(weekday: number, startMinute: number, endMinute: number | null, season: "normal" | "ramadan" = "normal"): PhoenixCrmTiming {
  return { weekday, startMinute, endMinute, season };
}

export function runPhoenixCrmPlanNeverBlockedTests(): void {
  // ── The hours column: every day he receives, Saturday first ────────────────────────────────────
  const week = [timing(1, 18 * 60, 21 * 60), timing(6, 17 * 60, null), timing(1, 10 * 60, 12 * 60)];
  assert.equal(weekTimingsText(week, false), "Sat from 5:00 PM · Mon 10:00 AM – 12:00 PM, 6:00 PM – 9:00 PM", "Saturday first, each day's windows in order");
  assert.equal(weekTimingsText([], false), "", "nothing saved reads as nothing — the row then says so in words");
  assert.equal(
    weekTimingsText([timing(6, 17 * 60, null), timing(6, 21 * 60, null, "ramadan")], true),
    "Sat from 9:00 PM",
    "a Ramadan day shows the Ramadan hours where the place has them",
  );

  // ── The day panel: a tick always places, and nothing is asked ──────────────────────────────────
  const day = source("src/components/phoenix-crm/plan-day-panel.tsx");
  const toggle = /function toggle\(row: TickRow, next: boolean\) \{[\s\S]*?\n {2}\}/.exec(day)?.[0] ?? "";
  assert.ok(toggle, "the tick has one handler");
  assert.match(toggle, /onPlace\(\{ planDate: day\.date, customerId: row\.customerId, placeId: row\.placeId, exceptionType: null, exceptionNote: null \}\)/);
  assert.doesNotMatch(toggle, /receives|reason/i, "whether his hours cover the day never decides the tick");
  assert.doesNotMatch(day, /ReasonEditor|Give a reason|No reason given|Why does the visit go on|Does not receive on/, "no reason prompt and no 'does not receive' refusal anywhere on the day");
  assert.doesNotMatch(day, /Day full/, "the 'Day full' word is gone — the list heading already says how many are placed");

  // The hours are a COLUMN of the whole week, not a condition.
  assert.match(day, /Days and hours/, "the desktop table's hours column");
  assert.match(day, /const timings = fit\.place \? weekTimingsText\(fit\.place\.timings, day\.ramadan\) : "";/);
  assert.match(day, /timings: timings \|\| NO_HOURS,/, "a customer with nothing saved reads 'No days and hours yet'");

  // Not validated: small and inline, and his iReports360 brick and address fill the blank.
  assert.match(day, /\{pending \? <span className="font-bold text-orange-700">/, "the not-validated word rides inline on the meta line");
  assert.doesNotMatch(day, /<CrmPill tone="orange">\{PENDING_PILL\}<\/CrmPill>/, "never a pill on its own row");
  assert.match(day, /const reference = fit\.place \? null : \(customer\.reference \?\? null\);/);
  assert.match(day, /const address = fit\.place \? fit\.place\.address : reference\?\.address \?\? null;/);
  assert.match(day, /where: \[brick \? `Brick \$\{brick\}` : null, area, address\]\.filter\(Boolean\)\.join\(" · "\) \|\| null,/);

  // 🔴 THE NAMES ARE THE ORGANOGRAM'S (owner, 2026-09-30: "a big mismatch between area and region
  // names — audit and follow the organogram"). iReports360 keeps its own vocabulary in crm_contacts
  // zone/city, and on production only 3.8% of customers on a mapped brick carried an area name the
  // organogram agreed with. Neither field may reach a screen.
  const suggestions = source("src/lib/phoenix-crm/suggestions.ts");
  assert.match(suggestions, /export type PlannerReference = \{ brick: string \| null; area: string \| null; address: string \| null \};/);
  const listServer = source("src/lib/phoenix-crm/server/list.ts");
  const loader = /export async function loadPlannerReferences[\s\S]*?\n\}/.exec(listServer)?.[0] ?? "";
  assert.ok(loader, "the loader is one function");
  assert.match(loader, /brick: meta\?\.brickName \?\? null, area: meta\?\.areaName \?\? null, address: entry\.address/, "brick and area from the sales master, which matches the organogram");
  assert.doesNotMatch(loader, /entry\.zone|entry\.city/, "never iReports360's own zone or city");
  assert.equal((day.match(/<WhereLine where=\{row\.where\} \/>/g) ?? []).length, 2, "on the phone card and the desktop row");

  // The server hands the plan board iReports360's reference for a customer not validated yet.
  for (const builder of ["src/lib/phoenix-crm/server/plans.ts", "src/lib/phoenix-crm/server/monthly-plans.ts"]) {
    const text = source(builder);
    assert.match(text, /loadPlannerReferences\(seat\.seatId, isTest, customers\)/, `${builder} loads the references`);
    assert.match(text, /reference: references\.get\(customerId\) \?\? null,/, `${builder} attaches them`);
  }

  console.log("phoenix-crm plan never blocked: OK");
}
