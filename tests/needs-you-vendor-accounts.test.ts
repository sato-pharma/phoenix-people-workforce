import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { buildNeedsYouBoard, NEEDS_YOU_ALL_CLEAR_SENTENCE } from "../src/lib/needs-you/classify.ts";
import { buildNeedsYouDailyMessage } from "../src/lib/needs-you/deliver/daily.ts";
import { buildNeedsYouWeeklyEmail } from "../src/lib/needs-you/deliver/weekly.ts";
import { buildNeedsYouSections, needsYouSectionLines } from "../src/lib/needs-you/render/sections.ts";
import { TELEGRAM_BUDGET } from "../src/lib/needs-you/render/telegram.ts";
import { needsYouDestinations, needsYouSourceIds, type NeedsYouSourceId, type NeedsYouSourceResult, type NeedsYouSourceState } from "../src/lib/needs-you/types.ts";
import {
  judgeGithubAccount,
  judgeTelegramAccount,
  judgeWhatsAppAccount,
  NEEDS_YOU_VENDORS_NOT_READ_LINE,
  VENDOR_GITHUB_KEY_MISSING_LABEL,
  VENDOR_GITHUB_REFUSED_LABEL,
  VENDOR_GITHUB_SILENCE_HOURS,
  VENDOR_TELEGRAM_KEY_MISSING_LABEL,
  VENDOR_TELEGRAM_REFUSED_LABEL,
  VENDOR_WHATSAPP_NOT_CONNECTED_LABEL,
  vendorWhatsAppRefusedLabel,
} from "../src/lib/needs-you/vendor-accounts-rules.ts";
import {
  classifySyntheticDispatchFailure,
  SYNTHETIC_DISPATCH_FAILURE_PREFIX,
  SYNTHETIC_DISPATCH_TOKEN_UNSET,
  SYNTHETIC_DISPATCH_UNREACHABLE,
  syntheticDispatchOtherStatus,
  syntheticDispatchRefused,
} from "../src/lib/observability/synthetic-dispatch-reasons.ts";

/**
 * The vendor accounts on Needs You (owner, 3 Nov 2026).
 *
 * On 2 Nov 2026 GitHub suspended the account and no board said so. Three things are pinned here. A refusal reaches
 * his own lane. A vendor's outage is never worded as a refused account, and is never a calm zero. And what the
 * board cannot see is printed rather than implied.
 */

const NOW = new Date("2026-11-03T08:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
/** The sentence the hourly route files when GitHub answers 403, which is what the suspended account answered. */
const GITHUB_403 = `${SYNTHETIC_DISPATCH_FAILURE_PREFIX}${syntheticDispatchRefused(403)}`;

function rowOf(state: NeedsYouSourceState): { label: string; note: string | null } | null {
  assert.equal(state.status, "ok", `expected a row or nothing, got ${JSON.stringify(state)}`);
  if (state.status !== "ok") return null;
  assert.ok(state.items.length <= 1, "a vendor source says one thing");
  const item = state.items[0];
  if (!item) return null;
  assert.equal(item.lane, "yours", "an account is settled by him alone");
  assert.equal(item.href, needsYouDestinations[item.sourceId].href);
  assert.equal(item.overdue, false);
  return { label: item.label, note: item.note };
}

function assertUnread(state: NeedsYouSourceState, why: string): void {
  assert.equal(state.status, "unavailable", why);
}

function failed(detail: string | null, hours = 1) {
  return { lastOutcome: "fail" as const, lastSuccessAt: hoursAgo(5), lastFailAt: hoursAgo(hours), lastDetail: detail };
}

const SUCCEEDED = { lastOutcome: "success" as const, lastSuccessAt: hoursAgo(1), lastFailAt: hoursAgo(9), lastDetail: null };

export function runNeedsYouVendorAccountsTests(): void {
  checkTheSentencesReadBack();
  checkGithub();
  checkWhatsApp();
  checkTelegram();
  checkOnTheBoard();
  checkTheWiring();
}

function checkTheSentencesReadBack(): void {
  assert.equal(classifySyntheticDispatchFailure(GITHUB_403), "refused", "a suspended account's 403 is a refusal");
  assert.equal(classifySyntheticDispatchFailure(syntheticDispatchRefused(401)), "refused");
  assert.equal(classifySyntheticDispatchFailure(syntheticDispatchRefused(404)), "refused", "a token outside the owner is answered 404, and the board reads it as refused");
  assert.equal(classifySyntheticDispatchFailure(syntheticDispatchOtherStatus(404)), "refused", "a repository that can no longer be seen needs a person");
  assert.equal(classifySyntheticDispatchFailure(syntheticDispatchOtherStatus(503)), "not-answered", "🔴 GitHub's own trouble is not a refused account");
  assert.equal(classifySyntheticDispatchFailure(syntheticDispatchOtherStatus(429)), "not-answered", "nor is a rate limit");
  assert.equal(classifySyntheticDispatchFailure(SYNTHETIC_DISPATCH_UNREACHABLE), "not-answered");
  assert.equal(classifySyntheticDispatchFailure(`${SYNTHETIC_DISPATCH_FAILURE_PREFIX}${SYNTHETIC_DISPATCH_TOKEN_UNSET}`), "token-unset");
  assert.equal(classifySyntheticDispatchFailure("TypeError: boom"), "unknown", "a crash names nothing about the account");
  assert.equal(classifySyntheticDispatchFailure(null), "unknown");
}

function checkGithub(): void {
  assert.equal(rowOf(judgeGithubAccount(SUCCEEDED, NOW, true)), null, "the last run dispatched: nothing on the board");

  // 🔴 The suspension.
  assert.equal(rowOf(judgeGithubAccount(failed(GITHUB_403), NOW, true))?.label, VENDOR_GITHUB_REFUSED_LABEL, "the 2 Nov suspension reaches his lane");

  assert.equal(rowOf(judgeGithubAccount(failed(SYNTHETIC_DISPATCH_TOKEN_UNSET), NOW, true))?.label, VENDOR_GITHUB_KEY_MISSING_LABEL, "a missing key on production is a finding");
  assert.equal(judgeGithubAccount(failed(SYNTHETIC_DISPATCH_TOKEN_UNSET), NOW, false).status, "not-applicable", "on staging it is normal");

  assertUnread(judgeGithubAccount(failed(SYNTHETIC_DISPATCH_UNREACHABLE), NOW, true), "unreachable says nothing about the account");
  assertUnread(judgeGithubAccount(failed(syntheticDispatchOtherStatus(502)), NOW, true), "a 5xx says nothing about the account");
  assertUnread(judgeGithubAccount(failed("TypeError: boom"), NOW, true), "a crash says nothing about the account");

  // The job itself can stop, and silence must not read as fine.
  const silent = { ...SUCCEEDED, lastSuccessAt: hoursAgo(VENDOR_GITHUB_SILENCE_HOURS + 1), lastFailAt: null };
  assertUnread(judgeGithubAccount(silent, NOW, true), "🔴 a green row twelve hours old proves nothing");
  assert.equal(judgeGithubAccount({ ...SUCCEEDED, lastSuccessAt: hoursAgo(VENDOR_GITHUB_SILENCE_HOURS - 1), lastFailAt: null }, NOW, true).status, "ok", "inside the window it stands");
  assertUnread(judgeGithubAccount({ ...failed(GITHUB_403, VENDOR_GITHUB_SILENCE_HOURS + 6), lastSuccessAt: null }, NOW, true), "an old refusal with nothing since is silence");
  assertUnread(judgeGithubAccount(null, NOW, true), "no row at all is not fine");
  assertUnread(judgeGithubAccount({ lastOutcome: null, lastSuccessAt: null, lastFailAt: null, lastDetail: null }, NOW, true), "nor is a row that never reported");
  assert.equal(judgeGithubAccount(null, NOW, false).status, "not-applicable", "staging does not run the job");
}

function checkWhatsApp(): void {
  const fine = { ok: true, failureKind: null };
  const blocked = { ok: false, failureKind: "meta" as const, httpStatus: 400 };
  const flagged = { ok: false, failureKind: "meta" as const, httpStatus: 200 };
  const outage = { ok: false, failureKind: "meta" as const, httpStatus: 503 };
  const limited = { ok: false, failureKind: "meta" as const, httpStatus: 429 };
  const dropped = { ok: false, failureKind: "transport" as const };

  assert.equal(rowOf(judgeWhatsAppAccount([fine, fine], true)), null, "every line answers");
  assert.equal(rowOf(judgeWhatsAppAccount([fine, blocked], true))?.label, vendorWhatsAppRefusedLabel(1));
  assert.equal(rowOf(judgeWhatsAppAccount([blocked, flagged], true))?.label, vendorWhatsAppRefusedLabel(2), "a line Meta reports as not connected counts");
  assert.equal(rowOf(judgeWhatsAppAccount([{ ok: false, failureKind: "meta" }], true))?.label, vendorWhatsAppRefusedLabel(1), "an older probe with no status still reads as Meta's answer");

  assertUnread(judgeWhatsAppAccount([fine, outage], true), "🔴 Meta's own 5xx is not a refused account");
  assertUnread(judgeWhatsAppAccount([limited], true), "a rate limit is not a refused account");
  assertUnread(judgeWhatsAppAccount([dropped], true), "a dropped connection is not a refused account");

  // The news is not hidden by the part that could not be read, and that part is still said.
  const mixed = rowOf(judgeWhatsAppAccount([blocked, dropped], true));
  assert.equal(mixed?.label, vendorWhatsAppRefusedLabel(1));
  assert.equal(mixed?.note, "1 more could not be read.");

  assert.equal(rowOf(judgeWhatsAppAccount([], true))?.label, VENDOR_WHATSAPP_NOT_CONNECTED_LABEL, "no key or no line on production is a finding");
  assert.equal(judgeWhatsAppAccount([], false).status, "not-applicable", "on staging it is normal");
}

function checkTelegram(): void {
  const asked = { hasToken: true, checked: true, error: null };
  assert.equal(rowOf(judgeTelegramAccount(asked, true)), null, "Telegram answered");
  assert.equal(rowOf(judgeTelegramAccount({ ...asked, error: "Unauthorized", httpStatus: 401 }, true))?.label, VENDOR_TELEGRAM_REFUSED_LABEL);
  assert.equal(rowOf(judgeTelegramAccount({ ...asked, error: "Not Found", httpStatus: 404 }, true))?.label, VENDOR_TELEGRAM_REFUSED_LABEL);
  assertUnread(judgeTelegramAccount({ ...asked, error: "Bad Gateway", httpStatus: 502 }, true), "🔴 Telegram's own fault is not a dead key");
  assertUnread(judgeTelegramAccount({ ...asked, error: "Too Many Requests", httpStatus: 429 }, true), "nor is a rate limit");
  assertUnread(judgeTelegramAccount({ hasToken: true, checked: false, error: "timed out" }, true), "a read that never landed is not fine");
  assert.equal(rowOf(judgeTelegramAccount({ hasToken: false, checked: false, error: null }, true))?.label, VENDOR_TELEGRAM_KEY_MISSING_LABEL);
  assert.equal(judgeTelegramAccount({ hasToken: false, checked: false, error: null }, false).status, "not-applicable");
}

function boardWith(overrides: Partial<Record<NeedsYouSourceId, NeedsYouSourceState>>) {
  const results: NeedsYouSourceResult[] = needsYouSourceIds.map((id) => ({ id, state: overrides[id] ?? { status: "ok", items: [] } }));
  return buildNeedsYouBoard(results, NOW);
}

function checkOnTheBoard(): void {
  // A read that failed blocks the all-clear.
  const unread = boardWith({ "vendor-whatsapp": judgeWhatsAppAccount([{ ok: false, failureKind: "transport" }], true) });
  assert.equal(unread.allClearProvable, false, "🔴 a vendor that could not be read blocks the all-clear");
  assert.equal(unread.notProven[0]?.id, "vendor-whatsapp");

  // A refusal is his.
  const refused = boardWith({ "vendor-github": judgeGithubAccount(failed(GITHUB_403), NOW, true) });
  assert.equal(refused.yours[0]?.sourceId, "vendor-github");
  assert.equal(refused.yours[0]?.label, VENDOR_GITHUB_REFUSED_LABEL);

  // And all three fine leaves the board able to say so, with the fixed line beside it rather than blocking it.
  const calm = boardWith({
    "vendor-github": judgeGithubAccount(SUCCEEDED, NOW, true),
    "vendor-whatsapp": judgeWhatsAppAccount([{ ok: true, failureKind: null }], true),
    "vendor-telegram": judgeTelegramAccount({ hasToken: true, checked: true, error: null }, true),
  });
  assert.equal(calm.allClearProvable, true, "the line about what is not read can never block the all-clear");
  assert.ok(needsYouSectionLines(buildNeedsYouSections(calm)).join("\n").includes(NEEDS_YOU_ALL_CLEAR_SENTENCE));

  // 🔴 The vendor's own words never reach him: a long error with a request echoed in it.
  const noisy = "(#200) Application does not have permission Authorization: Bearer EAAG-secret ".repeat(20);
  const words = JSON.stringify([
    judgeGithubAccount(failed(`${GITHUB_403} ${noisy}`), NOW, true),
    judgeWhatsAppAccount([{ ok: false, failureKind: "meta", httpStatus: 400 }], true),
    judgeTelegramAccount({ hasToken: true, checked: true, error: noisy, httpStatus: 401 }, true),
    judgeTelegramAccount({ hasToken: true, checked: true, error: noisy, httpStatus: 500 }, true),
  ]);
  assert.equal(words.includes("Bearer"), false, "every sentence is fixed");
  assert.equal(words.includes("#200"), false);

  // The worst day: all three refused, on a phone's 900 characters.
  const worst = boardWith({
    "vendor-github": judgeGithubAccount(failed(GITHUB_403), NOW, true),
    "vendor-whatsapp": judgeWhatsAppAccount([{ ok: false, failureKind: "meta", httpStatus: 400 }, { ok: false, failureKind: "meta", httpStatus: 400 }, { ok: false, failureKind: "transport" }], true),
    "vendor-telegram": judgeTelegramAccount({ hasToken: true, checked: true, error: "Unauthorized", httpStatus: 401 }, true),
  });
  const digest = buildNeedsYouDailyMessage({ board: worst, boardUrl: "/admin/needs-you" });
  assert.ok(digest.length < TELEGRAM_BUDGET, `the digest stays inside Telegram's budget: ${digest.length}`);
  assert.ok(digest.includes(VENDOR_GITHUB_REFUSED_LABEL), "and the refusal is in it");

  // The Sunday email says what the board does not see, whatever else it says.
  const email = buildNeedsYouWeeklyEmail({ board: calm, boardUrl: "https://example.test/admin/needs-you" });
  assert.ok(email.includes(NEEDS_YOU_VENDORS_NOT_READ_LINE), "🔴 what it cannot see is printed, not implied");
  for (const blind of ["Supabase invoices", "Railway", "GitHub billing", "OneSignal", "Maps", "Sentry", "cron-job.org"]) {
    assert.ok(NEEDS_YOU_VENDORS_NOT_READ_LINE.includes(blind), `the fixed line names ${blind}`);
  }
}

function checkTheWiring(): void {
  const board = stripComments(readFileSync("src/components/admin/needs-you-board.tsx", "utf8"));
  assert.ok(board.includes("{NEEDS_YOU_VENDORS_NOT_READ_LINE}"), "the screen prints the fixed line");

  const sources = stripComments(readFileSync("src/lib/needs-you/sources.ts", "utf8"));
  for (const load of ["loadGithubAccountState(now)", "loadWhatsAppAccountState()", "loadTelegramAccountState()"]) {
    assert.ok(sources.includes(`ownerOnlyQueue(access, VENDOR_NOT_YOURS) ?? ${load}`), `${load} is the Super Admin's alone`);
  }

  const dispatch = stripComments(readFileSync("src/lib/observability/dispatch-synthetic-journeys.ts", "utf8"));
  assert.ok(dispatch.includes("reason: syntheticDispatchRefused(response.status)"), "the dispatch files the sentence the board reads");
  assert.ok(dispatch.includes("reason: syntheticDispatchOtherStatus(response.status)"));
  // 🔴 A fine-grained token made on another account is answered 404 by the organization's repository, so 404 is a refusal
  //    here — and the log names the other thing a 404 means (a renamed workflow file or a missing ref).
  const refusedBranch = /if \(response\.status === 401 \|\| response\.status === 403 \|\| response\.status === 404\) \{([\s\S]*?)\r?\n  \}/.exec(dispatch)?.[1] ?? "";
  assert.ok(refusedBranch.includes("reason: syntheticDispatchRefused(response.status)"), "a 404 is filed as a refusal, not an unexpected status");
  assert.ok(refusedBranch.includes("resource owner"), "the log names the token's owner");
  assert.ok(refusedBranch.includes("${WORKFLOW_FILE}") && refusedBranch.includes("no longer exists"), "and the other cause of a 404, so the cause is not misattributed");
  const route = stripComments(readFileSync("app/api/cron/run-synthetic-journeys/route.ts", "utf8"));
  assert.ok(route.includes("`${SYNTHETIC_DISPATCH_FAILURE_PREFIX}${result.reason}`"));

  const reads = stripComments(readFileSync("src/lib/needs-you/vendor-accounts.ts", "utf8"));
  assert.ok(reads.includes('"phoenix-run-synthetic-journeys"'), "the row whose every run uses this account's key");
  assert.equal(/\bfetch\(/.test(reads), false, "this file makes no call of its own");
}
