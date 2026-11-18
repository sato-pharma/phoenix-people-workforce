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
  usagePath,
  billingPage,
  includedMinutesFrom,
  allowanceIsEstimated,
  pickActionsBudget,
  budgetFromVariable,
  resolveBudget,
  publicRepositories,
} from "../scripts/check-actions-cost.mjs";

type Row = { date: string; product: string; sku: string; grossAmount: number; discountAmount: number; netAmount: number; pricePerUnit: number; repositoryName?: string };

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
  // The owner is an organization since 2026-11-06: its usage lives under organizations/, and users/ answers 404.
  assert.equal(usagePath("sato-pharma"), "organizations/sato-pharma", "an organization's billing is read under organizations/");
  assert.equal(usagePath("someone", false), "users/someone", "a personal account's billing stays under users/");
  // The billing PAGE is not the API path: a personal account's is github.com/settings/billing.
  assert.equal(billingPage("sato-pharma", true), "github.com/organizations/sato-pharma/settings/billing");
  assert.equal(billingPage("someone", false), "github.com/settings/billing", "🔴 github.com/users/<login>/settings/billing is a 404");
  // 🔴 An organization's included minutes depend on its plan, so the Pro 3,000 is never assumed for one —
  //    and an unset figure must NOT switch the alarm off (exit 2 is only a warning): it counts as 0 and says estimate.
  assert.equal(includedMinutesFrom({}, true), 0, "🔴 an organization with no stated allowance still projects, on the API's own discount");
  assert.equal(allowanceIsEstimated({}, true), true, "and the reading is labelled an estimate");
  assert.equal(allowanceIsEstimated({ ACTIONS_INCLUDED_MINUTES: "50000" }, true), false);
  assert.equal(allowanceIsEstimated({}, false), false, "a personal account's 3,000 is a stated default, not an estimate");
  assert.equal(includedMinutesFrom({}, false), 3000, "a personal Pro account keeps its 3,000");
  assert.equal(includedMinutesFrom({ ACTIONS_INCLUDED_MINUTES: "50000" }, true), 50000);
  assert.equal(includedMinutesFrom({ ACTIONS_INCLUDED_MINUTES: "lots" }, true), null);

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
  const lines = describeProjection(p, { owner: "sato-pharma", now }).join("\n");
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
    describeProjection(spent, { owner: "sato-pharma", now: new Date("2026-11-03T08:00:00Z") }).join("\n"),
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
  assert.match(describeProjection(early, { owner: "sato-pharma" }).join("\n"), /weak reading/, "a rate on two days must say it is weak");
  //    …but kept when it is the only complete day there is, so the first morning still has a reading.
  const firstMorning = projectActionsCost([row("2026-10-26", 4), row("2026-10-27", 2)], { now: new Date("2026-10-27T09:00:00Z"), budget: 300 });
  assert.equal(firstMorning.windowDays, 1);
  near(firstMorning.dailyGross, 4, "the first day is the only complete day, so it is the rate");
  //    No complete day at all: no rate, and the line says so instead of projecting $0.
  const none = projectActionsCost([row("2026-10-26", 4)], { now: new Date("2026-10-26T15:00:00Z"), budget: 300 });
  assert.equal(none.windowDays, 0);
  assert.equal(none.finding, false);
  assert.match(describeProjection(none, { owner: "sato-pharma" }).join("\n"), /no complete day of usage yet/);

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
    assert.match(describeReadFailure({ stderr }, { isOrg: false }), /Plan: Read-only/, `a refused billing read must name the permission it needs: ${stderr}`);
    const org = describeReadFailure({ stderr }, { owner: "sato-pharma", isOrg: true });
    assert.match(org, /resource owner is sato-pharma/, `🔴 an organization's refused read sent the reader to a personal token: ${stderr}`);
    assert.doesNotMatch(org, /Plan: Read-only/);
  }
  assert.match(describeReadFailure(new Error("socket hang up")), /the billing read failed \(socket hang up\)/);

  // 9. The scheduled drift check runs it, with the billing token and the fallback budget variable, and
  //    an exit 2 is a FINDING (clause 12), never a pass.
  const source = readFileSync(resolve(".github/workflows/secret-drift-check.yml"), "utf8");
  const start = source.indexOf("        id: actions_cost");
  assert.notEqual(start, -1, "🔴 secret-drift-check.yml no longer has the actions_cost step, so nothing reads the month's spend");
  const stepText = source.slice(source.lastIndexOf("      - name: ", start), source.indexOf("\n      - name: ", start));
  assert.match(stepText, /node scripts\/check-actions-cost\.mjs/);
  assert.match(stepText, /continue-on-error:\s*true/, "a cost finding must be reported, never withhold a deploy");
  assert.match(stepText, /timeout-minutes:\s*\d+/);
  assert.match(stepText, /ACTIONS_MONTHLY_BUDGET:\s*\$\{\{\s*vars\.ACTIONS_MONTHLY_BUDGET\s*\}\}/, "🔴 the step lost the budget variable, so every run says CANNOT TELL");
  assert.match(stepText, /GH_TOKEN:\s*\$\{\{\s*secrets\.ACTIONS_BILLING_READ_TOKEN/, "the step must read billing with the billing token first");
  assert.doesNotMatch(stepText, /GH_TOKEN:[^\n]*PHOENIX_ACTIONS_DISPATCH_TOKEN/, "🔴 the dispatch token is a personal-account token and can never read the organization's billing");
  assert.doesNotMatch(stepText, /secrets\.GITHUB_TOKEN/, "GITHUB_TOKEN cannot read an account's billing; falling back to it only hides why");
  assert.match(stepText, /set \+e/, "under bash -e an exit 2 aborts the step before it is turned into a warning");
  assert.match(stepText, /"\$rc" -eq 2/);

  // 10. 🔴 THE BUDGET IS GITHUB'S OWN, AND $0 IS A BUDGET (2026-11-19, owner: "Fix the cost alarm"). The
  //     budget came only from a variable nobody set, and `budget > 0` read the organization's real $0
  //     budget as "unset", so every daily run said CANNOT TELL on a green job. This is the endpoint's
  //     shape as read that night: four $0 budgets, all "Stop usage".
  const live = [
    { budget_product_sku: "actions", budget_scope: "organization", budget_amount: 0, prevent_further_usage: true, budget_entity_name: "sato-pharma" },
    { budget_product_sku: "packages", budget_scope: "organization", budget_amount: 0, prevent_further_usage: true, budget_entity_name: "sato-pharma" },
    { budget_product_sku: "codespaces", budget_scope: "organization", budget_amount: 0, prevent_further_usage: true, budget_entity_name: "sato-pharma" },
    { budget_product_sku: "git_lfs", budget_scope: "organization", budget_amount: 0, prevent_further_usage: true, budget_entity_name: "sato-pharma" },
  ];
  assert.deepEqual(pickActionsBudget(live, "sato-pharma"), { amount: 0, stopsUsage: true }, "🔴 the organization's $0 Actions budget was not found, or read as no budget");
  assert.equal(pickActionsBudget([], "sato-pharma"), null);
  assert.equal(pickActionsBudget(live.slice(1), "sato-pharma"), null, "another product's budget is not the Actions budget");
  assert.equal(pickActionsBudget([{ ...live[0], budget_scope: "repository", budget_amount: 5 }], "sato-pharma"), null, "a repository's budget is not the account's limit");
  assert.equal(pickActionsBudget([{ ...live[0], budget_entity_name: "someone-else" }], "sato-pharma"), null, "another account's budget is not this one's");
  assert.deepEqual(
    pickActionsBudget(
      [{ ...live[0], budget_amount: 50, prevent_further_usage: false }, { ...live[0], budget_amount: 300 }, { ...live[0], budget_amount: 100 }],
      "sato-pharma",
    ),
    { amount: 100, stopsUsage: true },
    "a Stop-usage budget binds before an alerting one, and the smallest of those binds first",
  );
  assert.equal(budgetFromVariable({}), null);
  assert.deepEqual(budgetFromVariable({ ACTIONS_MONTHLY_BUDGET: "0" }), { amount: 0, stopsUsage: true }, '🔴 "0" in the variable read as unset');
  assert.deepEqual(budgetFromVariable({ ACTIONS_MONTHLY_BUDGET: " 300 " }), { amount: 300, stopsUsage: true });
  assert.deepEqual(budgetFromVariable({ ACTIONS_MONTHLY_BUDGET: "lots" }), { invalid: true });
  const refused = () => {
    throw Object.assign(new Error("gh failed"), { stderr: "gh: Resource not accessible by personal access token (HTTP 403)" });
  };
  // `resolveBudget` answers a union (a budget, or `{ error }`); the clauses read it as one loose shape.
  type Resolved = { source?: string; amount?: number; why?: string; error?: string };
  const fromGithub: Resolved = resolveBudget({ readBudgets: () => ({ budgets: live }), env: { ACTIONS_MONTHLY_BUDGET: "300" }, owner: "sato-pharma", isOrg: true });
  assert.equal(fromGithub.source, "github", "🔴 GitHub's own budget must win over a hand-copied variable");
  assert.equal(fromGithub.amount, 0);
  const fromVar: Resolved = resolveBudget({ readBudgets: refused, env: { ACTIONS_MONTHLY_BUDGET: "0" }, owner: "sato-pharma", isOrg: true });
  assert.equal(fromVar.source, "variable");
  assert.equal(fromVar.amount, 0);
  assert.match(String(fromVar.why), /resource owner is sato-pharma/, "the run must say why it fell back to the variable");
  const blind: Resolved = resolveBudget({ readBudgets: refused, env: {}, owner: "sato-pharma", isOrg: true });
  assert.match(String(blind.error), /could not be read[\s\S]*ACTIONS_MONTHLY_BUDGET is unset/, "no budget anywhere must name both halves");
  assert.match(String(resolveBudget({ readBudgets: () => ({ budgets: [] }), env: {}, owner: "sato-pharma", isOrg: true }).error), /lists no Actions budget/);
  assert.match(String(resolveBudget({ readBudgets: refused, env: { ACTIONS_MONTHLY_BUDGET: "x" }, owner: "sato-pharma", isOrg: true }).error), /not a number/);

  // 11. 🔴 A PUBLIC REPOSITORY'S MINUTES ARE FREE. The repository has been public since 7 Nov 2026, and by
  //     18 Nov it had run 26,235 minutes with $0.00 billed. Counted as spend against the $0 budget, they
  //     read as a budget already reached, every day. The November shape: every day discounted in full.
  const repo = "phoenix-people-workforce";
  const publicDay = (date: string, gross: number): Row => ({ ...row(date, gross, gross), repositoryName: repo });
  const publicNovember = [8.2, 19.68, 11.95, 45.76, 5.87, 3.08, 3.77, 14, 13.64, 2.16, 3.13, 23.18, 4.92].map((gross, i) =>
    publicDay(`2026-11-${String(i + 6).padStart(2, "0")}`, gross),
  );
  const at19 = new Date("2026-11-19T00:00:00Z");
  const freeMonth = projectActionsCost(publicNovember, { now: at19, budget: 0, includedMinutes: 0, freeRepositories: [repo] });
  assert.equal(freeMonth.finding, false, "🔴 free public-repository minutes were counted against the $0 budget");
  near(freeMonth.gross, 0, "nothing billable this month");
  near(freeMonth.freeGross, 159.34, "the free usage is still reported");
  assert.equal(freeMonth.windowDays, 7, "🔴 an all-free account read as 'no complete day of usage yet' instead of a $0 rate");
  near(freeMonth.dailyGross, 0, "the billable rate is $0");
  const freeLines = describeProjection(freeMonth, { owner: "sato-pharma", now: at19 }).join("\n");
  assert.match(freeLines, /Left out: \$159\.34 of this month's Actions ran on public repositories \(phoenix-people-workforce\)/);
  assert.match(freeLines, /\$0 budget with "Stop usage" on means Actions stops the moment anything would be billed/);
  //     The same rows on a PRIVATE repository: the $0 budget really is at risk, and it must say so.
  const privateMonth = projectActionsCost(publicNovember, { now: at19, budget: 0, includedMinutes: 0 });
  assert.ok(privateMonth.finding, "🔴 without the public-repository exclusion this is a finding — the exclusion is what clears it");
  //     A $0 budget is met by the first cent billed, and is not met by $0.00.
  const at11 = new Date("2026-11-11T08:00:00Z");
  const firstCent = projectActionsCost([row("2026-11-10", 0.5)], { now: at11, budget: 0, includedMinutes: 0 });
  assert.ok(firstCent.finding, "🔴 a cent billed against a $0 budget was not a finding");
  assert.match(describeProjection(firstCent, { owner: "sato-pharma", now: at11 }).join("\n"), /ALREADY reached/);
  assert.equal(projectActionsCost([], { now: at19, budget: 0, includedMinutes: 0 }).finding, false, "🔴 $0.00 billed was read as meeting a $0 budget");
  //     With stated included minutes ($18 at the Linux price), a $0 budget stops Actions the day they run
  //     out: $6 a day from the 1st is $18 by the end of the 3rd.
  const included = projectActionsCost(days(1, 3, "2026-11", 6).map((r) => ({ ...r, discountAmount: 6, netAmount: 0 })), {
    now: new Date("2026-11-04T00:00:00Z"),
    budget: 0,
    includedMinutes: 3000,
  });
  assert.ok(included.finding, "a $0 budget with the included minutes used up is a finding");
  assert.equal(cairoDay(included.stopDate!), "Wed 4 Nov", "🔴 the stop day must be the day the included minutes run out");
  //     A budget that only alerts must not claim Actions stops.
  const alertOnly = describeProjection(projectActionsCost([row("2026-11-10", 0.5)], { now: at11, budget: 0, includedMinutes: 0, stopsUsage: false }), {
    owner: "sato-pharma",
    now: at11,
  }).join("\n");
  assert.match(alertOnly, /only alerts/);
  assert.doesNotMatch(alertOnly, /GitHub has stopped Actions/, "🔴 an alerting budget was described as stopping CI");
  //     Visibility is read, never guessed: an unreadable repository is neither free nor billed.
  const vis = publicRepositories(["a", "b", "c"], (name: string) => {
    if (name === "c") throw new Error("HTTP 404");
    return name === "a" ? "public" : "private";
  });
  assert.deepEqual(vis, { free: ["a"], unread: ["c"] });

  // 12. 🔴 AN EXIT 2 IS A FINDING, NOT A WARNING. It was `::warning::` and `exit 0`: green, nothing sent,
  //     for every day the budget variable was unset. It still cannot fail the job (continue-on-error), but
  //     `cost_unread` reaches the report and Telegram, worded apart from a budget about to be reached.
  const unreadAt = stepText.indexOf('"$rc" -eq 2');
  const unreadBranch = stepText.slice(unreadAt, stepText.indexOf("\n          fi", unreadAt));
  assert.match(unreadBranch, /::error::/, "🔴 a blind cost alarm went back to a warning");
  assert.match(unreadBranch, /cost_unread=true/);
  assert.match(unreadBranch, /exit 1/, "🔴 a blind cost alarm went back to exit 0, which nothing reports");
  assert.doesNotMatch(unreadBranch, /exit 0/);
  const reportStart = source.indexOf("- name: Report the Actions budget projection");
  assert.notEqual(reportStart, -1, "the cost report step is gone");
  const report = source.slice(reportStart, source.indexOf("\n      - name: ", reportStart + 10));
  assert.match(report, /steps\.actions_cost\.outputs\.cost_unread/, "the report must say when the cost alarm could not read");
  const notify = source.slice(source.indexOf("- name: Notify Telegram on failure"));
  assert.match(notify, /COST_UNREAD:\s*\$\{\{\s*steps\.actions_cost\.outputs\.cost_unread\s*\}\}/, "Telegram must be told the cost alarm could not read");
  assert.match(notify, /\[ "\$COST_UNREAD" = "true" \]/, "Telegram must word a blind cost alarm apart from a budget about to be reached");
  assert.match(notify, /ACTIONS COST ALARM IS BLIND/);
}
