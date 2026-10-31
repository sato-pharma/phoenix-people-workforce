// The production smoke test pages the owner's Telegram when it fails (owner, 2026-10-31: "alert my
// Telegram when the production smoke test fails").
//
// WHY THIS EXISTS. synthetic-journeys.yml keeps its job GREEN on a failed journey so a real outage
// can never withhold the deploy carrying its own fix (tests/synthetic-journeys-never-withholds.test.ts).
// That left the failure on the admin Synthetic Journeys page and in an ::error:: annotation, which
// nobody opens unprompted: every run failed from 28 Oct 05:18 to 31 Oct 2026, 23 in a row, and nobody
// knew for three and a half days. scripts/synthetic-telegram-alert.mjs is the half that reaches a
// person, and this file pins both what it says and when the workflow calls it.
//
// Each invariant is asserted SEPARATELY with its own message, as in the sibling suite.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildSmokeTestAlert, cairoStamp, journeyVerdicts } from "../scripts/synthetic-telegram-alert.mjs";

const WORKFLOW = resolve(".github/workflows/synthetic-journeys.yml");
const SCRIPT = resolve("scripts/synthetic-telegram-alert.mjs");
const ALERT_STEP = "Tell the owner on Telegram that the production smoke test failed";
const PRODUCTION = "https://phoenix-hr.satopharma.com";

/** The block of YAML belonging to one named step, up to the next step at the same indent. */
function step(source: string, name: string): string {
  const start = source.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `synthetic-journeys.yml no longer has a step named "${name}".`);
  const rest = source.slice(start + 1);
  const nextAt = rest.indexOf("\n      - name: ");
  return nextAt === -1 ? rest : rest.slice(0, nextAt);
}

const journey = (journeyName: string, status: "passed" | "failed" | "skipped") => ({ journeyName, status });

export function runSyntheticTelegramAlertTests() {
  // ── What the message says ──────────────────────────────────────────────────────────────────────

  // 1. The suite retries once, so a journey that failed twice is in the report twice. It is ONE
  //    failed check, and the count must say so — the dashboard's "4 failed" for two journeys is
  //    exactly the double-count this must not repeat in his chat.
  const finishedAt = new Date("2026-12-01T10:05:00Z");
  const report = [
    journey("authenticate as synthetic admin", "passed"),
    journey("Employee 360 Medical Rep profile loads with expenses correctly hidden", "failed"),
    journey("Employee 360 Medical Rep profile loads with expenses correctly hidden", "failed"),
    journey("Employee 360 manager profile shows expenses without a schema error", "failed"),
    journey("Employee 360 manager profile shows expenses without a schema error", "failed"),
    // Failed, then passed on the retry: Playwright calls it flaky and the step passes. Not a failure.
    journey("Payroll Report loads", "failed"),
    journey("Payroll Report loads", "passed"),
    journey("Outstation Expenses export produces a workbook", "skipped"),
  ];
  const alert = buildSmokeTestAlert({ results: report, baseUrl: PRODUCTION, finishedAt, runUrl: "https://example.test/run/1" });

  assert.match(alert.text, /^Production smoke test FAILED/, "the alert must open by saying the production smoke test FAILED");
  assert.match(
    alert.text,
    /2 of 5 checks failed on phoenix-hr\.satopharma\.com\./,
    "a journey retried after failing must count ONCE, a flaky pass must not count, and the total must be journeys, not attempts",
  );
  assert.equal(
    alert.text.split("Employee 360 Medical Rep profile loads with expenses correctly hidden").length - 1,
    1,
    "a journey that failed on both attempts must be named once, not once per attempt",
  );
  assert.match(alert.text, /- Employee 360 manager profile shows expenses without a schema error/, "every failed journey must be named");
  assert.doesNotMatch(alert.text, /Payroll Report/, "a journey that passed on its retry is not a failure and must not be named");
  assert.doesNotMatch(alert.text, /Outstation Expenses export/, "a skipped journey is not a failure and must not be named");

  // 2. Times are Cairo local, never UTC (AGENTS.md §4). 10:05 UTC on 1 Dec is 12:05 in Cairo.
  assert.equal(cairoStamp(finishedAt), "1 Dec, 12:05", "the stamp must be Cairo local time, day and short month");
  assert.match(alert.text, /1 Dec, 12:05 Cairo:/, "the alert must carry the run's Cairo time");

  // 3. The button opens the page that holds the detail, on the site that was checked.
  assert.deepEqual(
    alert.button,
    { text: "Open Synthetic Journeys", url: `${PRODUCTION}/admin/synthetic-journeys` },
    "the alert's button must open the admin Synthetic Journeys page",
  );
  assert.equal(
    buildSmokeTestAlert({ results: report, baseUrl: `${PRODUCTION}/`, finishedAt }).button.url,
    `${PRODUCTION}/admin/synthetic-journeys`,
    "a trailing slash on the base URL must not double the slash in the button",
  );

  // 4. A run that left NO report died before checking anything. That is the case where production
  //    went unchecked, and the alert must say exactly that rather than "0 of 0 checks failed".
  for (const results of [null, []]) {
    const unchecked = buildSmokeTestAlert({ results, baseUrl: PRODUCTION, finishedAt, runUrl: "https://example.test/run/2" });
    assert.match(unchecked.text, /^Production smoke test could not run/, `no report (${JSON.stringify(results)}) must read as a run that could not run`);
    assert.match(unchecked.text, /production was NOT checked/, "a run that could not run must say production was NOT checked");
    assert.match(unchecked.text, /https:\/\/example\.test\/run\/2/, "a run that could not run must link the run log, the only place its reason is");
    assert.doesNotMatch(unchecked.text, /0 of 0/, "an empty report must never read as zero failed checks");
  }

  // 5. A long outage names the first eight and counts the rest, so the message stays readable.
  const many = Array.from({ length: 11 }, (_, i) => journey(`Journey ${String(i + 1).padStart(2, "0")}`, "failed"));
  const long = buildSmokeTestAlert({ results: many, baseUrl: PRODUCTION, finishedAt });
  assert.match(long.text, /11 of 11 checks failed/, "every failed journey must be counted even when not all are named");
  assert.match(long.text, /- Journey 08\n- and 3 more/, "past eight names the alert must say how many more failed");
  assert.doesNotMatch(long.text, /Journey 09/, "the ninth name onwards is folded into 'and N more'");

  // 6. journeyVerdicts is the one place a status is decided; pin its three outcomes directly.
  assert.deepEqual(
    journeyVerdicts([journey("A", "failed"), journey("A", "passed"), journey("B", "failed"), journey("C", "skipped"), journey("", "failed")]),
    [
      { name: "A", status: "passed" },
      { name: "B", status: "failed" },
      { name: "C", status: "skipped" },
    ],
    "a passed attempt wins, a failed-only journey fails, a skipped-only journey is skipped, and a nameless row is dropped",
  );

  // ── When the workflow sends it ─────────────────────────────────────────────────────────────────

  const source = readFileSync(WORKFLOW, "utf8");
  const alertStep = step(source, ALERT_STEP);
  const ifLine = alertStep.match(/^ {8}if:\s*(.*)$/m)?.[1] ?? "";
  assert.ok(ifLine, "the Telegram step must have an `if:` — without one it runs on every PASSING run and pages him six times a day");

  // 7. On a failed journey. `failure()` alone is permanently false here, because the journeys step
  //    is continue-on-error and the job concludes success — gating on it would mute the alert.
  assert.match(ifLine, /steps\.journeys\.outcome\s*==\s*'failure'/, "the Telegram step must fire on the journeys step's own outcome");
  // 8. And on a run that died before the journeys (a missing credential, a failed install).
  assert.match(ifLine, /\|\|\s*failure\(\)/, "the Telegram step must also fire when the run died before checking production");
  // 9. always(), or a run that died in setup skips the step and the unchecked case goes silent.
  assert.match(ifLine, /^\$\{\{\s*always\(\)\s*&&/, "the Telegram step must be gated with always() first, or a setup failure skips it");
  // 10. main only — a branch dispatch testing a journey change (as on 31 Oct) must never page him.
  assert.match(ifLine, /github\.ref\s*==\s*'refs\/heads\/main'/, "the Telegram step must fire only for runs of main");
  // 11. production only — a manual run against another environment must never read as production down.
  assert.match(
    ifLine,
    /\(inputs\.base_url \|\| 'https:\/\/phoenix-hr\.satopharma\.com'\)\s*==\s*'https:\/\/phoenix-hr\.satopharma\.com'/,
    "the Telegram step must fire only when the run checked production",
  );

  // 12. A Telegram outage must not turn the job red and withhold a deploy.
  assert.match(alertStep, /^ {8}continue-on-error:\s*true\s*$/m, "the Telegram step must be continue-on-error");
  assert.match(alertStep, /^ {8}timeout-minutes:\s*\d+\s*$/m, "the Telegram step must carry its own timeout, or a hang cancels the job");

  // 13. The secrets it reads, and the plain runner Node it runs on.
  assert.match(alertStep, /TELEGRAM_BOT_TOKEN:\s*\$\{\{\s*secrets\.TELEGRAM_BOT_TOKEN\s*\}\}/, "the Telegram step must read the bot token secret");
  assert.match(alertStep, /TELEGRAM_ALERT_CHAT_ID:\s*\$\{\{\s*secrets\.TELEGRAM_ALERT_CHAT_ID\s*\}\}/, "the Telegram step must read the owner's alert chat secret");
  assert.match(alertStep, /^ {8}run:\s*node scripts\/synthetic-telegram-alert\.mjs\s*$/m, "the Telegram step must run the script with plain node — no pnpm, no loader");

  // 14. Before the dashboard save, which writes to the production database — down exactly when
  //     production is, and allowed four minutes. The alert must not wait on it.
  assert.ok(
    source.indexOf(`      - name: ${ALERT_STEP}`) < source.indexOf("      - name: Save the run to the dashboard"),
    "the Telegram step must run BEFORE the dashboard save, so the alert never waits on the production database",
  );

  // 15. The script needs nothing installed: on a run that died in setup there is no node_modules.
  const imports = [...readFileSync(SCRIPT, "utf8").matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);
  assert.ok(imports.length >= 3, `expected the script's imports to parse, found ${imports.length} — the import reader has stopped matching`);
  for (const specifier of imports) {
    assert.ok(
      specifier.startsWith("node:") || specifier === "./lib/refuse-arguments.mjs",
      `scripts/synthetic-telegram-alert.mjs imports "${specifier}" — it must use Node built-ins only, because it runs when setup may have failed`,
    );
  }
}
