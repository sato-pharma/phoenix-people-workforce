// scripts/synthetic-telegram-alert.mjs
// ---------------------------------------------------------------------------
// TELL THE OWNER ON TELEGRAM THAT THE PRODUCTION SMOKE TEST FAILED (owner, 2026-10-31: "alert my
// Telegram when the production smoke test fails").
//
// WHY. synthetic-journeys.yml keeps its job GREEN on a failed journey, on purpose: a red suite on
// `main` HEAD withholds the deploy carrying the fix (tests/synthetic-journeys-never-withholds.test.ts).
// So a failure reached only the admin Synthetic Journeys page and an ::error:: annotation, and nobody
// opens either unprompted. From 28 Oct 05:18 to 31 Oct 2026 every run failed, 23 in a row, and nobody
// knew for three and a half days. This step is what makes the failure reach a person.
//
// 🔴 NODE BUILT-INS ONLY, NO `@/` IMPORT AND NO TYPESCRIPT. The workflow also calls this when the run
// died BEFORE the journeys (a missing credential, a failed install), and then `setup-node` and
// `pnpm install` may never have run — only the runner's own Node is there. That is exactly the case
// where production went unchecked, so it is the last place a send may depend on the app's modules.
// It is the same plain sendMessage call fallback-image.yml and emergency-host.yml already make.
//
// It reads the report the journeys wrote (tests/synthetic/report/latest.json, the file
// synthetic:save-report saves to the dashboard) and never writes anything.
//
// TEST MODE. With SYNTHETIC_ALERT_TEST=true it sends one message headed TEST that says nothing failed
// and reads no report — the workflow's `test_alert` switch, the same "send a test alert and stop"
// every other Telegram alarm here has, so the alarm can be proved without breaking production.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { refuseArguments } from "./lib/refuse-arguments.mjs";

const PRODUCTION_URL = "https://phoenix-hr.satopharma.com";
const DASHBOARD_PATH = "/admin/synthetic-journeys";
const REPORT_PATH = "tests/synthetic/report/latest.json";
/** Names listed in the message before "and N more" — the dashboard holds the whole list. */
const MAX_LISTED = 8;

/** "31 Oct, 18:20" in Cairo — the time is always Cairo local (AGENTS.md §4). */
export function cairoStamp(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Cairo",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

/**
 * One verdict per journey. The suite retries once, so a journey that failed twice appears twice in
 * the report — and one that failed and then passed on the retry is NOT a failure (Playwright calls
 * it flaky and the step passes). A journey failed only when it has a failed attempt and no passed one.
 */
export function journeyVerdicts(results) {
  const byName = new Map();
  for (const result of results) {
    const name = String(result?.journeyName ?? "").trim();
    if (!name) continue;
    const seen = byName.get(name) ?? new Set();
    seen.add(result.status);
    byName.set(name, seen);
  }
  return [...byName].map(([name, statuses]) => ({
    name,
    status: statuses.has("passed") ? "passed" : statuses.has("failed") ? "failed" : "skipped",
  }));
}

/**
 * The message. `results` is null when the run left no readable report — it died before the journeys,
 * or the step timed out before the reporter wrote — and then production was NOT checked at all.
 * `test` is the workflow's test switch: a message headed TEST that reads no results.
 *
 * @param {{
 *   results?: Array<{ journeyName?: string; status?: string }> | null;
 *   baseUrl?: string;
 *   finishedAt: Date;
 *   runUrl?: string;
 *   test?: boolean;
 * }} input
 */
export function buildSmokeTestAlert({ results, baseUrl, finishedAt, runUrl, test = false }) {
  const site = String(baseUrl || PRODUCTION_URL).replace(/\/+$/, "");
  const host = site.replace(/^https?:\/\//, "");
  const when = cairoStamp(finishedAt);
  const dashboardUrl = `${site}${DASHBOARD_PATH}`;
  const button = { text: "Open Synthetic Journeys", url: dashboardUrl };

  if (test) {
    return {
      button,
      text: [
        "TEST — production smoke test alert",
        `${when} Cairo: this is a test, sent on purpose. Nothing failed, and this run did not check ${host}.`,
        "When a real smoke test of production fails, this chat gets a message from this bot naming each failed check, with the button below.",
      ].join("\n\n"),
    };
  }

  if (!Array.isArray(results) || results.length === 0) {
    return {
      button,
      text: [
        "Production smoke test could not run",
        `${when} Cairo: the smoke test of ${host} stopped before it checked any screen, so production was NOT checked this time.`,
        runUrl ? `What stopped it is in the run log: ${runUrl}` : "What stopped it is in the GitHub run log.",
      ].join("\n\n"),
    };
  }

  const verdicts = journeyVerdicts(results);
  const failed = verdicts.filter((verdict) => verdict.status === "failed").map((verdict) => verdict.name);
  const listed = failed.slice(0, MAX_LISTED).map((name) => `- ${name}`);
  if (failed.length > MAX_LISTED) listed.push(`- and ${failed.length - MAX_LISTED} more`);

  return {
    button,
    text: [
      "Production smoke test FAILED",
      failed.length > 0
        ? `${when} Cairo: ${failed.length} of ${verdicts.length} checks failed on ${host}.`
        : `${when} Cairo: the smoke test of ${host} failed outside the screen checks.`,
      ...(listed.length > 0 ? [listed.join("\n")] : []),
      "Either a screen is broken for employees, or a check is out of date. The details are on the Synthetic Journeys page.",
    ].join("\n\n"),
  };
}

/** The report, or null when it is missing, unreadable or empty. */
export function readReport(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function main() {
  refuseArguments({
    name: "synthetic-telegram-alert",
    usage:
      "node scripts/synthetic-telegram-alert.mjs\n\n" +
      "Sends the owner's Telegram one message saying the production smoke test failed, built from\n" +
      `${REPORT_PATH}. Run by synthetic-journeys.yml only, on a failed run of main against production,\n` +
      "or with SYNTHETIC_ALERT_TEST=true by its test_alert switch, as one message headed TEST.\n" +
      "Reads TELEGRAM_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID, SYNTHETIC_BASE_URL, RUN_URL and SYNTHETIC_ALERT_TEST.\n" +
      "Writes nothing.",
  });

  const test = process.env.SYNTHETIC_ALERT_TEST?.trim() === "true";
  const what = test ? "The TEST smoke-test alert was requested" : "The smoke test FAILED";
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID?.trim();
  if (!token || !chatId) {
    console.log(
      `::warning::${what} but no Telegram alert was sent — TELEGRAM_BOT_TOKEN or TELEGRAM_ALERT_CHAT_ID is not set in this repository's Actions secrets.`,
    );
    process.exit(1);
  }

  const alert = buildSmokeTestAlert({
    results: test ? null : readReport(path.resolve(process.cwd(), REPORT_PATH)),
    baseUrl: process.env.SYNTHETIC_BASE_URL,
    finishedAt: new Date(),
    runUrl: process.env.RUN_URL,
    test,
  });

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: alert.text,
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[alert.button]] },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) {
      // Never echo the request: its URL carries the bot token.
      throw new Error(`Telegram answered ${response.status}${payload?.description ? ` — ${payload.description}` : ""}`);
    }
  } catch (error) {
    const reason = String(error instanceof Error ? error.message : error).replaceAll(token, "[token]");
    console.log(`::warning::${what} and the Telegram alert could not be sent: ${reason}`);
    process.exit(1);
  }

  console.log(test ? "TEST Telegram alert sent to the owner." : "Telegram alert sent to the owner.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
