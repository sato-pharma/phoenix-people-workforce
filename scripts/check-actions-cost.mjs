#!/usr/bin/env node
// Will this month's GitHub Actions spend reach the budget, and on what day? Read-only.
//
// 🔴 WHY THIS EXISTS (2026-10-27). GitHub stopped Actions over billing or the spending limit on
// 5 Aug, 23 Aug, 27 Sep (120 runs failed to start) and 12 Oct. Each stop froze CI, and because
// production deploys only after `validate` and `checks` pass (the release gate), each stop also held
// every deploy, silently. Nothing anywhere compared the month's spend with the budget, so the first
// sign every time was CI not starting. Then the 19 Oct CI split took each run from 4 billed jobs to 8
// and the day from 1,189 to 2,397 minutes, with nothing to say so. At that rate the new account's
// $300 budget, with "Stop usage" on, is reached around day 23 of every month.
//
// WHAT IT DOES. Reads the billing usage API's own amounts for the account that owns this repository
// (never minutes times a rate for the spend), works out the daily rate over the last complete days,
// projects the month's end against `ACTIONS_MONTHLY_BUDGET`, and names the day the budget would be
// reached. The included minutes are the one figure it multiplies: the plan's allowance
// (`ACTIONS_INCLUDED_MINUTES`; a personal Pro account defaults to 3,000, an organization that does not
// state its plan's figure counts as 0 and the run says the reading is an estimate) times the API's own
// Linux price.
//
// Exit 0 = the month ends under the budget · 1 = at this rate the budget is reached this month (the
// line says which day, Cairo time) · 2 = cannot tell (no budget set, no token, or the API refused).
// A 2 is NEVER a pass. The read goes through `gh api`, so CI passes the token as GH_TOKEN.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GITHUB_OWNER, GITHUB_OWNER_IS_ORG } from "./required-check-names.mjs";

const DAY_MS = 86_400_000;

function utcDay(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** A day as the owner reads it: "Mon 23 Nov", Cairo time. */
export function cairoDay(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    weekday: "short",
    day: "numeric",
    month: "short",
  })
    .format(date)
    .replace(",", "");
}

const money = (n) => `$${n.toFixed(2)}`;

/**
 * The month's projection from the usage API's rows. `items` are `/settings/billing/usage` rows
 * (`{ date, product, sku, grossAmount, discountAmount, netAmount, pricePerUnit }`), this month's and
 * last month's together, so the rate on the 1st still has complete days behind it.
 *
 * The rate is the gross spend of the last `rateDays` complete UTC days, divided by how many there
 * were. The first day with any usage is left out while a later complete day exists: it is the day the
 * account started (26 Oct 2026), part-empty, and would pull the rate down.
 */
export function projectActionsCost(items, { now = new Date(), budget = 0, includedMinutes = 3000, rateDays = 7 } = {}) {
  const actions = (items || []).filter((row) => /^actions$/i.test(String(row.product || "")));
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const today = utcDay(now);
  const at = (row) => Date.parse(row.date);

  const thisMonth = actions.filter((row) => at(row) >= monthStart && at(row) < monthEnd);
  const gross = thisMonth.reduce((sum, row) => sum + (Number(row.grossAmount) || 0), 0);
  const net = thisMonth.reduce((sum, row) => sum + (Number(row.netAmount) || 0), 0);
  // The API applies the allowance as a discount, sometimes larger than a row's gross; never more.
  const discount = thisMonth.reduce(
    (sum, row) => sum + Math.min(Number(row.discountAmount) || 0, Number(row.grossAmount) || 0),
    0,
  );

  const firstDay = actions.length ? Math.min(...actions.map((row) => utcDay(new Date(at(row))))) : today;
  let windowStart = Math.max(today - rateDays * DAY_MS, firstDay);
  if (windowStart === firstDay && firstDay + DAY_MS < today) windowStart = firstDay + DAY_MS;
  const windowDays = Math.max(0, (today - windowStart) / DAY_MS);
  const windowGross = actions
    .filter((row) => at(row) >= windowStart && at(row) < today)
    .reduce((sum, row) => sum + (Number(row.grossAmount) || 0), 0);
  const dailyGross = windowDays > 0 ? windowGross / windowDays : 0;

  const linuxPrice = actions.find((row) => /linux/i.test(String(row.sku || "")))?.pricePerUnit;
  const allowance = Math.max(includedMinutes * (Number(linuxPrice) || 0.006), discount);
  const daysLeft = Math.max(0, (monthEnd - now.getTime()) / DAY_MS);
  const projectedGross = gross + dailyGross * daysLeft;
  const projectedNet = Math.max(net, projectedGross - allowance);

  let stopDate = null;
  if (budget > 0 && net >= budget) {
    stopDate = now;
  } else if (budget > 0 && dailyGross > 0 && projectedNet >= budget) {
    const daysToStop = Math.max(0, (budget + allowance - gross) / dailyGross);
    stopDate = new Date(now.getTime() + daysToStop * DAY_MS);
  }

  return {
    gross,
    net,
    dailyGross,
    windowDays,
    allowance,
    projectedNet,
    budget,
    stopDate,
    finding: Boolean(stopDate),
  };
}

/** The lines the run prints and the alarm quotes, in plain words. */
export function describeProjection(p, { owner = GITHUB_OWNER, now = new Date() } = {}) {
  const lines = [
    `${owner}: Actions so far this month ${money(p.gross)} gross, ${money(p.net)} billed after the included minutes (${money(p.allowance)}).`,
    p.windowDays > 0
      ? `Rate: ${money(p.dailyGross)} a day over the last ${p.windowDays} complete day(s).`
      : "Rate: no complete day of usage yet, so no projection.",
    `Month's end at this rate: about ${money(p.projectedNet)} billed against the ${money(p.budget)} budget.`,
  ];
  if (p.windowDays > 0 && p.windowDays < 3) {
    lines.push(`The rate rests on ${p.windowDays} day(s) only, so this is a weak reading; it firms up after three complete days.`);
  }
  if (p.stopDate && p.stopDate.getTime() <= now.getTime()) {
    lines.push(`🔴 The ${money(p.budget)} budget is ALREADY reached. With "Stop usage" on, GitHub has stopped Actions: no CI, and the release gate holds every deploy.`);
  } else if (p.stopDate) {
    lines.push(
      `🔴 At this rate the ${money(p.budget)} budget is reached on ${cairoDay(p.stopDate)} (Cairo). With "Stop usage" on, GitHub then stops Actions: no CI, and the release gate holds every deploy until the month turns.`,
    );
  }
  return lines;
}

/** An organization's usage is under `organizations/<org>`, a personal account's under `users/<login>`. */
export function usagePath(owner, isOrg = GITHUB_OWNER_IS_ORG) {
  return `${isOrg ? "organizations" : "users"}/${owner}`;
}

/** The billing PAGE, which is not the API path: a personal account's is github.com/settings/billing. */
export function billingPage(owner, isOrg = GITHUB_OWNER_IS_ORG) {
  return isOrg ? `github.com/organizations/${owner}/settings/billing` : "github.com/settings/billing";
}

/**
 * The plan's included minutes, or null when the variable holds something that is not a number. A personal
 * Pro account has 3,000; an organization's depends on its plan (Free, Team, an Enterprise trial), so
 * unset there counts as 0 and the billing API's own discount is the allowance (`projectActionsCost` takes
 * the larger of the two). The alarm stays live; `allowanceIsEstimated` says the reading is rougher.
 */
export function includedMinutesFrom(env, isOrg = GITHUB_OWNER_IS_ORG) {
  const raw = String(env.ACTIONS_INCLUDED_MINUTES ?? "").trim();
  if (raw === "") return isOrg ? 0 : 3000;
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}

/** True when an organization's allowance is not stated, so only the API's own discount stands for it. */
export function allowanceIsEstimated(env, isOrg = GITHUB_OWNER_IS_ORG) {
  return isOrg && String(env.ACTIONS_INCLUDED_MINUTES ?? "").trim() === "";
}

function readUsage(owner, year, month) {
  const raw = execFileSync("gh", ["api", `${usagePath(owner)}/settings/billing/usage?year=${year}&month=${month}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  const items = JSON.parse(raw).usageItems;
  if (!Array.isArray(items)) throw new Error("the usage API returned no usageItems array");
  return items;
}

/** Why a read failed, in words that say what to do. Never a token. */
export function describeReadFailure(error, { owner = GITHUB_OWNER, isOrg = GITHUB_OWNER_IS_ORG } = {}) {
  const text = `${error?.stderr || ""} ${error?.message || ""}`;
  if (error?.code === "ENOENT") return "the `gh` CLI is not on PATH here";
  // A 401 is the token itself (expired or revoked); a 403/404 is a live token without the permission.
  if (/\bHTTP 401\b|Bad credentials/i.test(text)) {
    return "GitHub refused the token itself (HTTP 401: it expired or was revoked). Regenerate it on github.com/settings/personal-access-tokens, with the organization as its resource owner, and store it under the same secret name";
  }
  if (/gh auth login|not logged|authentication token/i.test(text)) return "no GitHub token reached the step (ACTIONS_BILLING_READ_TOKEN is unset)";
  if (/\b(403|404)\b|Resource not accessible|Not Found/i.test(text)) {
    // An organization's billing is read only by a token whose RESOURCE OWNER is that organization, made by
    // one of its owners or billing managers; no permission added to a personal-account token reaches it.
    if (isOrg) {
      return `GitHub refused the billing read of the organization ${owner}. It needs a fine-grained token whose resource owner is ${owner}, with the organization permission "Administration: Read-only", made by an owner or billing manager of ${owner} (github.com/settings/personal-access-tokens); a token on the personal account can never read it. Store it as ACTIONS_BILLING_READ_TOKEN`;
    }
    return 'GitHub refused the billing read. The token needs the account permission "Plan: Read-only" (github.com/settings/personal-access-tokens): add it to the phoenix-synthetic-dispatch token, or store a token that has it as ACTIONS_BILLING_READ_TOKEN';
  }
  return `the billing read failed (${String(error?.message || error).split("\n")[0].slice(0, 200)})`;
}

async function main() {
  const budget = Number(process.env.ACTIONS_MONTHLY_BUDGET);
  if (!(budget > 0)) {
    console.log(
      `[actions-cost] CANNOT TELL — the repository variable ACTIONS_MONTHLY_BUDGET is unset. Set it to the Actions budget on ${billingPage(GITHUB_OWNER)}. This is not a pass.`,
    );
    process.exitCode = 2;
    return;
  }
  const includedMinutes = includedMinutesFrom(process.env);
  if (includedMinutes === null) {
    console.log(
      `[actions-cost] CANNOT TELL — the repository variable ACTIONS_INCLUDED_MINUTES is not a number. Set it to the plan's included minutes on ${billingPage(GITHUB_OWNER)}, or delete it. This is not a pass.`,
    );
    process.exitCode = 2;
    return;
  }
  const now = new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  let items;
  try {
    items = [
      ...readUsage(GITHUB_OWNER, last.getUTCFullYear(), last.getUTCMonth() + 1),
      ...readUsage(GITHUB_OWNER, now.getUTCFullYear(), now.getUTCMonth() + 1),
    ];
  } catch (error) {
    console.log(`[actions-cost] CANNOT TELL — ${describeReadFailure(error)}. This is not a pass.`);
    process.exitCode = 2;
    return;
  }
  const projection = projectActionsCost(items, { now, budget, includedMinutes });
  for (const line of describeProjection(projection, { now })) console.log(`  ${line}`);
  if (allowanceIsEstimated(process.env)) {
    console.log(
      `  ESTIMATE: ACTIONS_INCLUDED_MINUTES is unset, so ${GITHUB_OWNER}'s included minutes count only as far as the billing API has discounted them. Set it to the plan's figure on ${billingPage(GITHUB_OWNER)} for an exact reading.`,
    );
  }
  if (projection.finding) {
    console.log(
      `[actions-cost] OVER BUDGET THIS MONTH — the amount is the owner's decision on ${billingPage(GITHUB_OWNER)}; CI's own minutes are in docs/ci-self-hosted-runner.md.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("[actions-cost] OK — at this rate the month ends under the budget.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
