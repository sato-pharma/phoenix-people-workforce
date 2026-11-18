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
// 🔴 THE BUDGET IS READ FROM GITHUB, A $0 BUDGET IS A REAL ONE, AND A PUBLIC REPOSITORY'S MINUTES ARE
// FREE (2026-11-19, owner: "Fix the cost alarm"). Until then the budget came only from a hand-copied
// variable that was never set, so every daily run said CANNOT TELL, on a green job. Reading GitHub's
// own budgets showed why copying it would not have helped: the organization's Actions budget is $0 with
// "Stop usage" on, and `budget > 0` read $0 as "unset". And the repository has been public since
// 7 Nov 2026, so its standard-runner minutes are not billed (26,235 of them by 18 Nov, $0.00 billed):
// counted as spend, they would have reported a $0 budget reached every day. Now:
//   - the budget comes from `<account>/settings/billing/budgets` (the Actions one, at the account's own
//     scope), and `ACTIONS_MONTHLY_BUDGET` is only the fallback when that read is refused;
//   - $0 is a budget: with "Stop usage" on, Actions stops the moment anything is billed;
//   - usage rows of a PUBLIC repository are left out of the spend and the rate, and named in a line.
//
// Exit 0 = the month ends under the budget · 1 = at this rate the budget is reached this month (the
// line says which day, Cairo time) · 2 = cannot tell (no budget readable, no token, or the API refused).
// A 2 is NEVER a pass: the workflow turns it into a finding and a Telegram ("COST ALARM IS BLIND").
// The read goes through `gh api`, so CI passes the token as GH_TOKEN.

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
 *
 * `freeRepositories` are the names of the account's PUBLIC repositories: GitHub does not bill their
 * standard-runner minutes or storage, so their rows are left out of the spend, the allowance and the
 * rate, and only reported (`freeGross`). `budget` 0 is a real budget, met by the first cent billed;
 * `stopsUsage` says whether reaching it stops Actions or only alerts.
 */
export function projectActionsCost(
  items,
  { now = new Date(), budget = 0, includedMinutes = 3000, rateDays = 7, freeRepositories = /** @type {string[]} */ ([]), stopsUsage = true } = {},
) {
  const free = new Set(freeRepositories.map((name) => String(name).toLowerCase()));
  const isFree = (row) => free.has(String(row.repositoryName || "").toLowerCase());
  const allActions = (items || []).filter((row) => /^actions$/i.test(String(row.product || "")));
  const actions = allActions.filter((row) => !isFree(row));
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const today = utcDay(now);
  const at = (row) => Date.parse(row.date);

  const freeThisMonth = allActions.filter((row) => isFree(row) && at(row) >= monthStart && at(row) < monthEnd);
  const freeGross = freeThisMonth.reduce((sum, row) => sum + (Number(row.grossAmount) || 0), 0);
  const freeNames = [...new Set(freeThisMonth.map((row) => String(row.repositoryName)))].sort();

  const thisMonth = actions.filter((row) => at(row) >= monthStart && at(row) < monthEnd);
  const gross = thisMonth.reduce((sum, row) => sum + (Number(row.grossAmount) || 0), 0);
  const net = thisMonth.reduce((sum, row) => sum + (Number(row.netAmount) || 0), 0);
  // The API applies the allowance as a discount, sometimes larger than a row's gross; never more.
  const discount = thisMonth.reduce(
    (sum, row) => sum + Math.min(Number(row.discountAmount) || 0, Number(row.grossAmount) || 0),
    0,
  );

  // The account's first day comes from ALL its usage: an account whose usage is entirely free still has
  // complete days behind it, and its billable rate over them is $0, not "no reading yet".
  const firstDay = allActions.length ? Math.min(...allActions.map((row) => utcDay(new Date(at(row))))) : today;
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

  // 🔴 $0 IS A BUDGET. It was `budget > 0`, which read the organization's real $0 budget as "unset".
  // A $0 budget is met by the first cent billed; anything above it, by reaching it.
  const known = Number.isFinite(budget) && budget >= 0;
  const meets = (amount) => (budget > 0 ? amount >= budget : amount >= 0.01);
  let stopDate = null;
  if (known && meets(net)) {
    stopDate = now;
  } else if (known && dailyGross > 0 && meets(projectedNet)) {
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
    stopsUsage,
    freeGross,
    freeNames,
    stopDate,
    finding: Boolean(stopDate),
  };
}

/**
 * The Actions budget GitHub holds for `owner`, from the `budgets` array of
 * `<account>/settings/billing/budgets`, as `{ amount, stopsUsage }`, or null when there is none.
 * Only a budget on the Actions product at the account's own scope counts (a repository's or a cost
 * centre's budget is not the account's limit). With several, a "Stop usage" one wins over an alerting
 * one, and the smallest wins among those: it is the one Actions stops at first.
 */
export function pickActionsBudget(budgets, owner) {
  const candidates = (Array.isArray(budgets) ? budgets : [])
    .filter(
      (b) =>
        /^actions$/i.test(String(b?.budget_product_sku ?? "")) &&
        /^(organization|user)$/i.test(String(b?.budget_scope ?? "")) &&
        (!b?.budget_entity_name || String(b.budget_entity_name).toLowerCase() === String(owner).toLowerCase()),
    )
    .map((b) => ({ amount: Number(b.budget_amount), stopsUsage: b.prevent_further_usage === true }))
    .filter((b) => Number.isFinite(b.amount) && b.amount >= 0)
    .sort((a, b) => Number(b.stopsUsage) - Number(a.stopsUsage) || a.amount - b.amount);
  return candidates[0] ?? null;
}

/**
 * `ACTIONS_MONTHLY_BUDGET`, the fallback when GitHub's budgets cannot be read: `{ amount, stopsUsage }`,
 * null when unset, or `{ invalid: true }` when it is not a number. "0" is a budget, never "unset".
 * It is assumed to stop usage, because the budget it copies was set that way.
 */
export function budgetFromVariable(env) {
  const raw = String(env.ACTIONS_MONTHLY_BUDGET ?? "").trim();
  if (raw === "") return null;
  const amount = Number(raw);
  return Number.isFinite(amount) && amount >= 0 ? { amount, stopsUsage: true } : { invalid: true };
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
  if (p.freeGross > 0) {
    lines.splice(
      1,
      0,
      `Left out: ${money(p.freeGross)} of this month's Actions ran on public repositories (${p.freeNames.join(", ")}), which GitHub does not bill.`,
    );
  }
  if (p.budget === 0 && p.stopsUsage !== false) {
    lines.push('A $0 budget with "Stop usage" on means Actions stops the moment anything would be billed: only free usage can run.');
  }
  if (p.windowDays > 0 && p.windowDays < 3) {
    lines.push(`The rate rests on ${p.windowDays} day(s) only, so this is a weak reading; it firms up after three complete days.`);
  }
  const alertOnly = p.stopsUsage === false;
  if (p.stopDate && p.stopDate.getTime() <= now.getTime()) {
    lines.push(
      alertOnly
        ? `🔴 The ${money(p.budget)} budget is ALREADY reached. It only alerts ("Stop usage" is off), so GitHub keeps running Actions and bills the excess.`
        : `🔴 The ${money(p.budget)} budget is ALREADY reached. With "Stop usage" on, GitHub has stopped Actions: no CI, and the release gate holds every deploy.`,
    );
  } else if (p.stopDate) {
    lines.push(
      alertOnly
        ? `🔴 At this rate the ${money(p.budget)} budget is reached on ${cairoDay(p.stopDate)} (Cairo). It only alerts ("Stop usage" is off), so GitHub keeps running Actions and bills the excess.`
        : `🔴 At this rate the ${money(p.budget)} budget is reached on ${cairoDay(p.stopDate)} (Cairo). With "Stop usage" on, GitHub then stops Actions: no CI, and the release gate holds every deploy until the month turns.`,
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

function ghJson(path) {
  const raw = execFileSync("gh", ["api", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  return JSON.parse(raw);
}

function readUsage(owner, year, month) {
  const items = ghJson(`${usagePath(owner)}/settings/billing/usage?year=${year}&month=${month}`).usageItems;
  if (!Array.isArray(items)) throw new Error("the usage API returned no usageItems array");
  return items;
}

/**
 * The account's Actions budget: GitHub's own first, `ACTIONS_MONTHLY_BUDGET` only when GitHub gives none.
 * Returns `{ amount, stopsUsage, source, why? }`, or `{ error }` saying both what GitHub answered and why
 * the variable could not stand in. `readBudgets` returns the endpoint's JSON and throws as `gh` does.
 */
export function resolveBudget({ readBudgets, env, owner = GITHUB_OWNER, isOrg = GITHUB_OWNER_IS_ORG }) {
  let why;
  try {
    const picked = pickActionsBudget(readBudgets()?.budgets, owner);
    if (picked) return { ...picked, source: "github" };
    why = `GitHub lists no Actions budget for ${owner}`;
  } catch (error) {
    why = `GitHub's budgets could not be read: ${describeReadFailure(error, { owner, isOrg })}`;
  }
  const fromVariable = budgetFromVariable(env);
  if (fromVariable?.invalid) return { error: `${why}, and the repository variable ACTIONS_MONTHLY_BUDGET is not a number` };
  if (fromVariable) return { ...fromVariable, source: "variable", why };
  return { error: `${why}, and the repository variable ACTIONS_MONTHLY_BUDGET is unset` };
}

/**
 * Which of `names` (repositories of the account) are public. `readVisibility(name)` returns the
 * repository's `visibility` and throws when it cannot be read; an unread one is returned in `unread`,
 * never guessed either way — guessed free hides spend, guessed billed raises a false alarm.
 */
export function publicRepositories(names, readVisibility) {
  const free = [];
  const unread = [];
  for (const name of names) {
    try {
      if (String(readVisibility(name) ?? "").trim().toLowerCase() === "public") free.push(name);
    } catch {
      unread.push(name);
    }
  }
  return { free, unread };
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
  const budget = resolveBudget({
    readBudgets: () => ghJson(`${usagePath(GITHUB_OWNER)}/settings/billing/budgets`),
    env: process.env,
  });
  if (budget.error) {
    console.log(`[actions-cost] CANNOT TELL — ${budget.error}. The budget lives on ${billingPage(GITHUB_OWNER)}/budgets. This is not a pass.`);
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
  const names = [
    ...new Set(
      items
        .filter((row) => /^actions$/i.test(String(row.product || "")) && row.repositoryName)
        .map((row) => String(row.repositoryName)),
    ),
  ].sort();
  const visibility = publicRepositories(names, (name) => ghJson(`repos/${GITHUB_OWNER}/${name}`).visibility);
  if (visibility.unread.length) {
    console.log(
      `[actions-cost] CANNOT TELL — could not read whether ${visibility.unread.join(", ")} ${visibility.unread.length === 1 ? "is" : "are"} public, so free usage cannot be told from billed usage. This is not a pass.`,
    );
    process.exitCode = 2;
    return;
  }
  const projection = projectActionsCost(items, {
    now,
    budget: budget.amount,
    includedMinutes,
    freeRepositories: visibility.free,
    stopsUsage: budget.stopsUsage,
  });
  console.log(
    `  Budget: ${money(budget.amount)} for Actions, "Stop usage" ${budget.stopsUsage ? "on" : "off"} — ${
      budget.source === "github" ? "read from GitHub's own budgets" : `from ACTIONS_MONTHLY_BUDGET, because ${budget.why}`
    }.`,
  );
  for (const line of describeProjection(projection, { now })) console.log(`  ${line}`);
  if (allowanceIsEstimated(process.env) && projection.gross > 0) {
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
