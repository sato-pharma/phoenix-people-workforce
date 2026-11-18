import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CROSS_ORIGIN_MASKED_DISPLAY } from "../src/lib/error-monitor/cross-origin-masked.ts";
import { isBrowserNoiseMessage } from "../src/lib/error-monitor/browser-noise.ts";
import { isModuleLockRefusal } from "../src/lib/error-monitor/expected-refusal.ts";
import {
  NEW_ERROR_ALERTS_PER_WINDOW,
  NEW_ERROR_ALERT_WINDOW_MS,
  createNewErrorAlertSlots,
  newErrorAlertRefusal,
  newErrorAlertText,
  newErrorSignature,
  normalizeErrorMessage,
  rememberNewErrorSignature,
  takeNewErrorAlertSlot,
} from "../src/lib/error-monitor/new-error-alert-rules.ts";
import { scrubPath, scrubText } from "../src/lib/observability/scrub.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE NEW-ERROR TELEGRAM (owner, 17 Nov 2026: "Rebuild the ping in Phoenix"). The outside error tracker is retired,
 * and Phoenix's own error log now sends the instant Telegram for a new error.
 *
 * What is held, and the break that proves each one:
 *   1. ONE ERROR IS ONE SIGNATURE: ids, numbers and HR ids are folded out, so a repeat never sends again, while a
 *      different source or different words are a different error. Drop a fold and the pair stops matching.
 *   2. PRODUCTION ONLY, BY APP_ENV — staging builds as NODE_ENV=production too. Browser noise and the browser's
 *      redacted copy of a server render error never send.
 *   3. NOTHING IDENTIFYING LEAVES: the message is scrubbed (HR ids, e-mail addresses, bot tokens, ids in paths).
 *   4. A BROKEN DEPLOY CANNOT FLOOD HIS TELEGRAM: ten messages per process per ten minutes, then a warning line.
 *   5. THE WIRING: the error table writes the row first and the alert rides behind it, fire-and-forget; Telegram
 *      only, on the technical-health audience, once per error and recipient by its idempotency key.
 * This suite imports the pure rules and reads the senders as text. It never reaches createSystemNotification.
 */

function code(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

function scrubTests() {
  // Paths: HR ids, uuids, numbers and long tokens go; words stay; the query and fragment go.
  assert.equal(scrubPath("/admin/employees/B-10"), "/admin/employees/:id");
  assert.equal(scrubPath("/admin/employees/b10/edit?tab=pay#x"), "/admin/employees/:id/edit");
  assert.equal(scrubPath("/api/leave/4821/approve"), "/api/leave/:id/approve");
  assert.equal(scrubPath("/x/3f2b8c1e-9d4a-4e6b-8a1f-0c2d3e4f5a6b"), "/x/:id");
  assert.equal(scrubPath("/admin/payroll/summary"), "/admin/payroll/summary");
  // A database call keeps its table (or function) name: schema, not data. Values ride in the query string, which
  // is dropped, and a path that merely resembles one is scrubbed as before.
  assert.equal(scrubPath("/rest/v1/employees?hr_id=eq.B-10&select=*"), "/rest/v1/employees");
  assert.equal(scrubPath("/rest/v1/source_of_sales_import_rows_staging_archive?limit=1"), "/rest/v1/source_of_sales_import_rows_staging_archive");
  assert.equal(scrubPath("/rest/v1/rpc/phx_monthly_achievement"), "/rest/v1/rpc/phx_monthly_achievement");
  assert.equal(scrubPath("/rest/v1/employees/B-10"), "/rest/v1/employees", "nothing after the table name is ever kept");
  assert.equal(scrubPath("/auth/v1/user"), "/auth/v1/user");
  assert.equal(scrubPath("/storage/v1/object/hiring/B-10"), "/storage/v1/object/hiring/:id");
  assert.equal(scrubPath("/rest/B-10/employees"), "/rest/:id/employees", "a PostgREST shape needs the real /rest/v1/ prefix");
  // Telegram's bot API carries the bot's credential as a path segment (`/bot<id>:<token>/sendMessage`). The token
  // below is made up.
  const fakeBotToken = "1234567890:AAFakeFakeFakeFakeFakeFakeFakeFake_abc";
  assert.equal(scrubPath(`/bot${fakeBotToken}/sendMessage`), "/:id/sendMessage", "the bot path segment is masked");
  assert.equal(
    scrubText(`POST https://api.telegram.org/bot${fakeBotToken}/sendMessage`),
    "POST https://api.telegram.org/:id/sendMessage",
    "a message carrying the Telegram URL loses the token",
  );
  assert.equal(scrubText(`fetch failed for ${fakeBotToken}`), "fetch failed for [token]", "the bare token is masked wherever it appears");
  assert.equal(
    scrubText("GET https://ozucdzovmcqvepbozvqf.supabase.co/rest/v1/employees?hr_id=eq.B-10"),
    "GET https://ozucdzovmcqvepbozvqf.supabase.co/rest/v1/employees",
  );
  assert.equal(scrubText("GET /admin/employees/B-10?month=2026-10"), "GET /admin/employees/:id");
  assert.equal(scrubText("failed for omar@satopharma.com on B-204"), "failed for [email] on :id");
  assert.equal(scrubText("fetch https://phoenix-hr.satopharma.com/api/leave/4821"), "fetch https://phoenix-hr.satopharma.com/api/leave/:id");
  assert.doesNotMatch(code("src/lib/observability/scrub.ts"), /^\s*import\s/m, "scrub.ts stays import-free: it runs on failing paths");
}

function signatureTests() {
  // 1. The parts that change between occurrences are folded out.
  assert.equal(
    normalizeErrorMessage("Payroll run 2026-10 failed for B-204 (row 3f2b8c1e-9d4a-4e6b-8a1f-0c2d3e4f5a6b)"),
    "payroll run #-# failed for # (row #)",
  );
  assert.equal(
    newErrorSignature({ message: "Leave 4821 not found for B-10", source: "server" }),
    newErrorSignature({ message: "Leave 977 not found for Z-9043", source: "server" }),
    "the same error about another record is a repeat, never a new Telegram",
  );
  assert.notEqual(
    newErrorSignature({ message: "Leave 4821 not found", source: "server" }),
    newErrorSignature({ message: "Leave 4821 not found", source: "client" }),
    "the server and the browser are two sources",
  );
  assert.notEqual(
    newErrorSignature({ message: "Leave not found", source: "server" }),
    newErrorSignature({ message: "Expense not found", source: "server" }),
    "different words are a different error",
  );
  assert.notEqual(
    newErrorSignature({ message: "Minified React error #418; visit https://react.dev/errors/418", source: "client" }),
    newErrorSignature({ message: "Minified React error #423; visit https://react.dev/errors/423", source: "client" }),
    "an error code names the error: two codes are two errors",
  );
  // A status or error code names the error in every spelling it arrives in — a colon, a quoted JSON key, the HTTP
  // version — so a harmless first one never silences a serious sibling.
  for (const [first, second] of [
    ["Request failed, status: 403", "Request failed, status: 500"],
    ["HTTP/1.1 502 Bad Gateway", "HTTP/1.1 504 Bad Gateway"],
    ['{"code":"42501","message":"denied"}', '{"code":"23505","message":"denied"}'],
    ["Upstream answered status 403", "Upstream answered status 500"],
  ] as const) {
    assert.notEqual(
      newErrorSignature({ message: first, source: "server" }),
      newErrorSignature({ message: second, source: "server" }),
      `two codes are two errors: ${first} / ${second}`,
    );
  }
  // And an id after `#` is a record, not an error number: only a React-sized number (up to three digits) is kept,
  // so a message that carries a long id is one error, not one Telegram per record.
  assert.equal(
    newErrorSignature({ message: "Request #48210 failed", source: "server" }),
    newErrorSignature({ message: "Request #48211 failed", source: "server" }),
    "a long id after # is folded like any other id",
  );
  assert.notEqual(
    newErrorSignature({ message: "permission denied for table some_very_long_table_name_alpha", source: "server" }),
    newErrorSignature({ message: "permission denied for table some_very_long_table_name_bravo", source: "server" }),
    "a long name without a digit is not an id",
  );
  assert.match(newErrorSignature({ message: "x", source: "server" }), /^[0-9a-f]{16}$/, "16 hex characters, for the idempotency key");
  // A caller that knows what makes two reports the same passes it: a freeze's seconds change every time.
  assert.equal(
    newErrorSignature({ message: "Server froze for 4.3 s", signature: "event-loop-stall|all|crm:contact-lists", source: "server" }),
    newErrorSignature({ message: "Server froze for 1.9 s", signature: "event-loop-stall|all|crm:contact-lists", source: "server" }),
  );
  assert.equal(normalizeErrorMessage("word ".repeat(300)).length, 240, "the grouping text is bounded");
}

function refusalTests() {
  // 2. Production only, by the deployment's name and never the build mode.
  assert.equal(newErrorAlertRefusal({ appEnv: "production", message: "boom" }), null);
  assert.equal(newErrorAlertRefusal({ appEnv: " Production ", message: "boom" }), null, "case and stray spaces do not matter");
  for (const appEnv of ["staging", "ci", "development", "", undefined]) {
    assert.ok(newErrorAlertRefusal({ appEnv, message: "boom" }), `APP_ENV=${String(appEnv)} sends nothing`);
  }
  assert.equal(newErrorAlertRefusal({ appEnv: "production", message: "   " }), "no message");
  for (const message of ["Load failed", "Failed to fetch", "Error in input stream", "network error", CROSS_ORIGIN_MASKED_DISPLAY]) {
    assert.equal(isBrowserNoiseMessage(message), true, `${message} is the browser talking, not Phoenix`);
    assert.equal(newErrorAlertRefusal({ appEnv: "production", message }), "browser noise");
  }
  assert.equal(isBrowserNoiseMessage("Connection closed."), false, "'Connection closed.' was once a REAL Supabase failure and must stay visible");
  assert.equal(isBrowserNoiseMessage("Failed to fetch the incentive table"), false, "the match is exact, never a substring");
  assert.equal(
    newErrorAlertRefusal({ appEnv: "production", message: "Minified React error #441; visit https://react.dev/errors/441" }),
    "the server already reported it",
    "the browser's redacted copy of a server render error never sends: the server's own row did",
  );
  assert.equal(newErrorAlertRefusal({ appEnv: "production", message: "Minified React error #418" }), null, "a hydration mismatch is a real browser error");

  // A locked module's refusal never reaches the error table at all, so it can never send.
  assert.equal(isModuleLockRefusal(new Error("Forbidden: sales is temporarily locked by the system administrator.")), true);
  assert.equal(isModuleLockRefusal(new Error("Forbidden: Employee cannot read payroll.")), false, "a real refusal still reaches the error table");
  assert.equal(isModuleLockRefusal("Forbidden: incentive is temporarily locked by the system administrator."), false, "only a thrown error object counts");
  assert.match(code("instrumentation.ts"), /if \(isModuleLockRefusal\(error\)\) return;\s*await forwardServerErrorToIngestion/, "the lock refusal is skipped before the error table is written");
}

function textTests() {
  // 3. Nothing identifying leaves.
  const text = newErrorAlertText({
    message: "Payslip PDF failed for B-204 (omar@satopharma.com)\n  at render /admin/employees/B-204/payslip?month=2026-10",
    moduleLabel: "Payroll",
    route: "/admin/employees/B-204/payslip?month=2026-10",
    source: "server",
  });
  assert.equal(text.title, "New error in Phoenix");
  assert.equal(
    text.message,
    [
      "Payroll · Server",
      "Payslip PDF failed for :id ([email]) at render /admin/employees/:id/payslip",
      "Page: /admin/employees/:id/payslip",
      "Sent once. Every repeat is on the System Audit.",
    ].join("\n"),
  );
  assert.ok(!/B-204|omar@|month=/.test(text.message), "no HR id, address or query leaves");
  const long = newErrorAlertText({ message: "y".repeat(2_000), source: "client" });
  assert.ok(long.message.split("\n")[1].length === 300, "a long message is cut to 300 characters");
  assert.equal(long.message.split("\n")[0], "Other · Browser", "no module label reads Other; a browser report reads Browser");
  assert.ok(!long.message.includes("Page:"), "no route, no Page line");
}

function memoryAndCapTests() {
  // A process remembers what it sent, bounded.
  const seen = new Set<string>();
  assert.equal(rememberNewErrorSignature(seen, "a"), true, "the first sight is new");
  assert.equal(rememberNewErrorSignature(seen, "a"), false, "a repeat is not");
  assert.equal(rememberNewErrorSignature(seen, "b", 2), true);
  assert.equal(rememberNewErrorSignature(seen, "c", 2), true, "a full memory starts over rather than growing");
  assert.equal(seen.size, 1);

  // 4. The flood cap.
  assert.equal(NEW_ERROR_ALERTS_PER_WINDOW, 10);
  assert.equal(NEW_ERROR_ALERT_WINDOW_MS, 10 * 60_000);
  const slots = createNewErrorAlertSlots();
  const start = 1_000_000;
  for (let index = 0; index < NEW_ERROR_ALERTS_PER_WINDOW; index += 1) {
    assert.equal(takeNewErrorAlertSlot(slots, start + index), true, `message ${index + 1} of the window sends`);
  }
  assert.equal(takeNewErrorAlertSlot(slots, start + 60_000), false, "the eleventh in ten minutes is held back");
  assert.equal(takeNewErrorAlertSlot(slots, start + NEW_ERROR_ALERT_WINDOW_MS), true, "a new window sends again");
}

function wiringTests() {
  // 5. The error table first, the alert behind it, never awaited by the request.
  const service = code("src/lib/error-monitor/service.ts");
  const insertAt = service.indexOf('logError("Failed to persist app_error_events row"');
  const alertAt = service.indexOf('void import("@/lib/error-monitor/new-error-alert")');
  assert.ok(insertAt > 0 && alertAt > insertAt, "RED the alert rides behind a written row, never before it");
  assert.match(
    service,
    /void import\("@\/lib\/error-monitor\/new-error-alert"\)\s*\.then\(\(\{ alertNewError \}\) => alertNewError\(report\)\)\s*\.catch\(\(\) => undefined\);/,
    "fire-and-forget, and a failed import can never become a second error",
  );
  assert.match(service, /route: redactSecretsFromRoute\(input\.route\)/, "the route it is handed is the redacted one");
  // The browser reaches service.ts (module-locks-manager.tsx -> permissions.ts -> log.ts), and the alert's import
  // pulls in the notification stack down to sharp, which needs `fs`: unfenced, the production build fails.
  assert.match(
    service,
    /if \(process\.env\.NEXT_RUNTIME !== ""\) \{\s*if \(id\) \{[\s\S]{0,900}?void import\("@\/lib\/error-monitor\/new-error-alert"\)/,
    'RED the alert\'s import sits inside `if (process.env.NEXT_RUNTIME !== "")`, which Next compiles out of a browser bundle',
  );

  const alert = code("src/lib/error-monitor/new-error-alert.ts");
  assert.match(alert, /channels: \["telegram"\]/, "RED Telegram only — the alert never becomes an email");
  assert.doesNotMatch(alert, /"email"/, "no email channel anywhere in the sender");
  assert.match(alert, /const AUDIENCE_KEY = "weekly_system_health_digest" as const;/, "the technical-health audience, retargeted on the recipients screen");
  assert.match(alert, /eventType: "new_app_error"/);
  assert.match(alert, /idempotencyKey: `new-app-error:\$\{signature\}:\$\{recipient\.hrId\}`/, "once per error and recipient, across processes and redeploys");
  assert.match(alert, /newErrorAlertRefusal\(\{ appEnv: process\.env\.APP_ENV, message: report\.message \}\)/, "the production gate reads APP_ENV");
  assert.doesNotMatch(alert, /logError\(/, "RED its own failure is a warning: an error line writes a row, and a row calls this");

  assert.match(code("src/lib/notifications/operator-watch-channel-guard.ts"), /"new_app_error"/, "a failed Telegram never falls back to email");
  assert.match(code("src/lib/notifications/notification-types.ts"), /eventType: "new_app_error".*sentFrom: \["src\/lib\/error-monitor\/new-error-alert\.ts"\]/);
}

export function runNewErrorAlertTests() {
  scrubTests();
  signatureTests();
  refusalTests();
  textTests();
  memoryAndCapTests();
  wiringTests();
}
