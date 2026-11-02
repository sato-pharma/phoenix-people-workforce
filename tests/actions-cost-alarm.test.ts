// The daily Actions cost alarm must name the day the budget stops CI, before it happens (2026-10-27).
//
// WHY IT NEEDS A TEST. GitHub stopped Actions over billing or the spending limit on 5 Aug, 23 Aug,
// 27 Sep and 12 Oct, and every time the first sign was CI not starting — which also held every deploy
// at the release gate. Nothing compared the month's spend with the budget. scripts/check-actions-cost.mjs
// does, and these clauses pin the arithmetic that decides whether it says so in time: the rate over
// complete days only, the account's part-empty first day left out, the allowance never larger than the
// spend it discounts, and the stop day in Cairo, not UTC.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  cairoDay,
  describeProjection,
  describeReadFailure,
  projectActionsCost,
} from "../scripts/check-actions-cost.mjs";

type Row = { date: string; product: string; sku: string; grossAmount: number; discountAmount: number; netAmount: number; pricePerUnit: number };

function row(date: string, gross: number, discount = 0, product = "actions"): Row {
  return { date: `${date}T00:00:00Z`, product, sku: "actions_linux", grossAmount: gross, discountAmount: discount, netAmount: gross - Math.min(discount, gross), pricePerUnit: 0.006 };
}

function near(actual: number, expected: number, what: string) {
  assert.ok(Math.abs(actual - expected) < 0.01, `${what}: expected about ${expected}, got ${actual}`);
}

function days(fromDay: number, toDay: number, month: string, gross: number): Row[] {
  const out: Row[] = [];
  for (let d = fromDay; d <= toDay; d += 1) out.push(row(`${month}-${String(d).padStart(2, "0")}`, gross));
  return out;
}

export function runActionsCostAlarmTests() {
  // 1. The projection. Ten days into November at today's CI shape ($13.80 a day), with the 3,000
  //    included minutes ($18) used up on the 1st and 2nd, a partial row for today and a Copilot row
  //    that is not Actions.
  const now = new Date("2026-11-10T12:00:00Z");
  const november = [
    row("2026-11-01", 13.8, 13.8),
    row("2026-11-02", 13.8, 4.2),
    ...days(3, 9, "2026-11", 13.8),
    row("2026-11-10", 6.9),
    row("2026-11-05", 10, 0, "copilot"),
  ];
  const october = days(26, 31, "2026-10", 13.8);
  const p = projectActionsCost([...october, ...november], { now, budget: 300 });
  near(p.gross, 9 * 13.8 + 6.9, "this month's gross must hold Actions rows only, today's partial row included");
  near(p.allowance, 18, "the allowance is 3,000 minutes at the API's Linux price");
  assert.equal(p.windowDays, 7, "the rate covers the last 7 complete days");
  near(p.dailyGross, 13.8, "🔴 today's partial row pulled the rate down — the rate must cover complete days only");
  near(p.projectedNet, 131.1 + 13.8 * 20.5 - 18, "the month's end is today's spend plus the rate over the days left, less the allowance");
  assert.ok(p.finding, "🔴 a month that ends near $396 against a $300 budget must be a finding");
  assert.equal(cairoDay(p.stopDate!), "Tue 24 Nov", "the day the $300 is reached at this rate");
  const lines = describeProjection(p, { owner: "gawishtheit", now }).join("\n");
  assert.match(lines, /reached on Tue 24 Nov \(Cairo\)/);
  assert.match(lines, /release gate holds every deploy/, "the line must say what a stop does, not only that it happens");
  assert.doesNotMatch(lines, /weak reading/, "seven days is not a weak reading");

  // 2. The stop day is Cairo's. 23:00 UTC on the 23rd is already the 24th in Cairo, and summer time
  //    (UTC+3) moves a 21:30 UTC stop to the next day too.
  assert.equal(cairoDay(new Date("2026-11-23T23:00:00Z")), "Tue 24 Nov", "🔴 the stop day was printed in UTC, a day early for the owner");
  assert.equal(cairoDay(new Date("2026-07-15T21:30:00Z")), "Thu 16 Jul", "🔴 Cairo summer time (UTC+3) was ignored");

  // 3. Under budget: no finding, no stop date, the OK path.
  const quiet = projectActionsCost([...october, ...days(1, 9, "2026-11", 2)], { now, budget: 300 });
  assert.equal(quiet.finding, false, "a month that ends far under the budget raised a finding");
  assert.equal(quiet.stopDate, null);

  // 4. Already reached: what is billed meets the budget, so the stop is now, whatever the rate.
  const spent = projectActionsCost([row("2026-11-01", 200), row("2026-11-02", 130)], { now: new Date("2026-11-03T08:00:00Z"), budget: 300 });
  assert.ok(spent.finding);
  assert.ok(spent.net >= 300);
  assert.match(
    describeProjection(spent, { owner: "gawishtheit", now: new Date("2026-11-03T08:00:00Z") }).join("\n"),
    /ALREADY reached/,
    "🔴 a budget already reached must say Actions has stopped, not name a future day",
  );

  // 5. The account's first day is part-empty and left out while a later complete day exists. It moved
  //    at 11:03 Cairo on 26 Oct, so 26 Oct's $1 would have cut the rate by a third.
  const early = projectActionsCost(
    [row("2026-10-26", 1), row("2026-10-27", 13.8), row("2026-10-28", 13.8), row("2026-10-29", 3)],
    { now: new Date("2026-10-29T12:00:00Z"), budget: 300 },
  );
  assert.equal(early.windowDays, 2, "🔴 the account's part-empty first day was counted as a full day");
  near(early.dailyGross, 13.8, "🔴 the first day pulled the rate down");
  assert.match(describeProjection(early, { owner: "gawishtheit" }).join("\n"), /weak reading/, "a rate on two days must say it is weak");
  //    …but kept when it is the only complete day there is, so the first morning still has a reading.
  const firstMorning = projectActionsCost([row("2026-10-26", 4), row("2026-10-27", 2)], { now: new Date("2026-10-27T09:00:00Z"), budget: 300 });
  assert.equal(firstMorning.windowDays, 1);
  near(firstMorning.dailyGross, 4, "the first day is the only complete day, so it is the rate");
  //    No complete day at all: no rate, and the line says so instead of projecting $0.
  const none = projectActionsCost([row("2026-10-26", 4)], { now: new Date("2026-10-26T15:00:00Z"), budget: 300 });
  assert.equal(none.windowDays, 0);
  assert.equal(none.finding, false);
  assert.match(describeProjection(none, { owner: "gawishtheit" }).join("\n"), /no complete day of usage yet/);

  // 6. On the 1st, the rate still has last month's complete days behind it, and none of them is
  //    counted as this month's spend.
  const first = projectActionsCost(days(20, 31, "2026-10", 13.8), { now: new Date("2026-11-01T10:00:00Z"), budget: 300 });
  assert.equal(first.gross, 0, "last month's rows were added to this month's spend");
  assert.equal(first.windowDays, 7);
  near(first.dailyGross, 13.8, "🔴 on the 1st the rate must come from last month's complete days");
  assert.ok(first.finding, "$13.80 a day for a whole month is over $300");

  // 7. The API sometimes reports a discount larger than the row's gross; the allowance never counts more.
  const capped = projectActionsCost([row("2026-11-01", 13.8, 30)], { now: new Date("2026-11-02T10:00:00Z"), budget: 300, includedMinutes: 0 });
  near(capped.allowance, 13.8, "🔴 a discount larger than its row's gross inflated the allowance");

  // 8. Every way the read can fail says what to do, and none is a pass.
  assert.match(describeReadFailure({ code: "ENOENT" }), /not on PATH/);
  assert.match(
    describeReadFailure({ stderr: "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token." }),
    /no GitHub token reached the step/,
  );
  assert.match(describeReadFailure({ stderr: "gh: Bad credentials (HTTP 401)" }), /expired or was revoked/, "🔴 a dead token was described as a missing permission");
  for (const stderr of ["gh: Resource not accessible by personal access token (HTTP 403)", "gh: Not Found (HTTP 404)"]) {
    assert.match(describeReadFailure({ stderr }), /Plan: Read-only/, `a refused billing read must name the permission it needs: ${stderr}`);
  }
  assert.match(describeReadFailure(new Error("socket hang up")), /the billing read failed \(socket hang up\)/);

  // 9. The scheduled drift check runs it, with the budget variable and a token, and an exit 2 is a
  //    warning, never a pass and never red.
  const source = readFileSync(resolve(".github/workflows/secret-drift-check.yml"), "utf8");
  const start = source.indexOf("        id: actions_cost");
  assert.notEqual(start, -1, "🔴 secret-drift-check.yml no longer has the actions_cost step, so nothing reads the month's spend");
  const stepText = source.slice(source.lastIndexOf("      - name: ", start), source.indexOf("\n      - name: ", start));
  assert.match(stepText, /node scripts\/check-actions-cost\.mjs/);
  assert.match(stepText, /continue-on-error:\s*true/, "a cost finding must be reported, never withhold a deploy");
  assert.match(stepText, /timeout-minutes:\s*\d+/);
  assert.match(stepText, /ACTIONS_MONTHLY_BUDGET:\s*\$\{\{\s*vars\.ACTIONS_MONTHLY_BUDGET\s*\}\}/, "🔴 the step lost the budget variable, so every run says CANNOT TELL");
  assert.match(stepText, /GH_TOKEN:\s*\$\{\{\s*secrets\.ACTIONS_BILLING_READ_TOKEN/, "the step must read billing with the billing token first");
  assert.doesNotMatch(stepText, /secrets\.GITHUB_TOKEN/, "GITHUB_TOKEN cannot read an account's billing; falling back to it only hides why");
  assert.match(stepText, /set \+e/, "under bash -e an exit 2 aborts the step before it is turned into a warning");
  assert.match(stepText, /"\$rc" -eq 2/);
}
