import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripComments } from "./support/comment-strip.ts";
import { closingPublishBlocksTelegramFallback } from "../src/lib/notifications/closing-publish-channel-guard.ts";

/**
 * PUBLISHING A CLOSING TELLS EVERYONE ON THE LINE — BY EMAIL, TELEGRAM AND IN THE APP.
 *
 * Owner, 2026-10-10: "when I publish the closing the email and telegram and in app goes to all in the
 * published line." Until then the email went to the line's District Managers only (about 8 a line) and
 * nothing went to Telegram or the bell. A line seats about 34 people, so the audience is now ~4x wider
 * and three separate pieces have to agree or it silently reverts:
 *
 *  1. THE RECIPIENTS take every seat on the line except the NSM (Cc'd), with NO whitelist of seat tiers —
 *     a whitelist is exactly how reps were left out, and how the next new tier would be.
 *  2. THE NOTICE asks the unified pipeline for in-app and Telegram ONLY. The email stays the one shared
 *     message; asking the pipeline for email as well mails every person a second copy.
 *  3. THE TELEGRAM-FAILURE FALLBACK is skipped for this notice, because for a rep who never linked
 *     Telegram it re-sends as email on every publish.
 *
 * Telegram has two gates (policy.ts asks for it, telegram-governance.ts allows it) and a missing row in
 * either drops it with nothing failed and nothing logged, so both rows are pinned too.
 */

const read = (relative: string) => stripComments(readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8"));

export function runClosingPublishLineWideTests() {
  // ── 1. recipients: the whole line, no tier whitelist ─────────────────────────────────────────
  const recipients = read("src/lib/sales/closing-publish-recipients.ts");
  assert.doesNotMatch(recipients, /DM_SEAT_TIERS/, "a seat-tier whitelist is what left every rep off the closing email");
  assert.match(
    recipients,
    /seat_tier[^)]*\)\s*\.trim\(\)\.toUpperCase\(\)\s*!==\s*"NSM"/,
    "the To list is every seat on the line EXCEPT the NSM, who is Cc'd",
  );
  assert.match(recipients, /return \{ to, team, cc, bcc, warnings \}/, "the resolver must hand the team (HR_IDs) back for in-app and Telegram");

  // ── 2. the notice: in-app and Telegram only, to the team ─────────────────────────────────────
  const notifier = read("src/lib/sales/closing-publish-notification.ts");
  assert.match(notifier, /createSystemNotificationForRecipients\(/, "the whole line is told through the unified pipeline");
  assert.match(
    notifier,
    /channels:\s*\["in_app",\s*"telegram"\]/,
    "the per-person notice is in-app and Telegram ONLY — the email is the one shared message",
  );
  assert.match(notifier, /team\.map\(\(member\) => member\.hrId\)/, "the notice is addressed to the team by HR_ID");
  assert.equal(
    notifier.split("sendTemplatedEmail(").length - 1,
    1,
    "exactly one email send — a second one is the duplicate this design exists to avoid",
  );
  // A figure in the body would reach every rep on the line, wider than any one person's scope.
  assert.doesNotMatch(
    notifier.slice(notifier.indexOf("message:"), notifier.indexOf("message:") + 260),
    /\bvalue\b|\bEGP\b|\bachievement\b/i,
    "the notice carries no sales figure",
  );

  // ── 3. the fallback guard ────────────────────────────────────────────────────────────────────
  assert.equal(closingPublishBlocksTelegramFallback("sales", "closing_published"), true);
  assert.equal(closingPublishBlocksTelegramFallback(" Sales ", "CLOSING_PUBLISHED"), true, "matched case-insensitively");
  assert.equal(closingPublishBlocksTelegramFallback("sales", "weekly_upload"), false, "another sales notice keeps its fallback");
  assert.equal(closingPublishBlocksTelegramFallback("phoenix_crm", "closing_published"), false, "another module's notice is never touched");
  const system = read("src/lib/notifications/system.ts");
  assert.equal(
    system.split("closingPublishBlocksTelegramFallback(").length - 1,
    3,
    "all three Telegram-fallback sites (retry exhaustion, permanent failure, transient failure) must ask the guard",
  );

  // ── 4. both Telegram gates ───────────────────────────────────────────────────────────────────
  assert.match(
    read("src/lib/notifications/policy.ts"),
    /"sales\.closing_published":\s*\{[^}]*channels:\s*\["in_app",\s*"telegram"\][^}]*telegramAllowed:\s*true/,
    "policy.ts must ask for Telegram on this event, or it is discarded silently",
  );
  assert.match(
    read("src/lib/notifications/telegram-governance.ts"),
    /enabled:\s*true,\s*genericOnly:\s*false,\s*module:\s*"sales"/,
    "telegram-governance.ts must allow the sales module, or the unknown-module fail-safe drops the message silently",
  );

  // ── 5. the confidence gate does not hold the first whole-line publish ────────────────────────
  assert.match(
    read("src/lib/notifications/confidence-gate.ts"),
    /"sales\/closing_published":\s*\{\s*appliesTo:\s*"always",\s*ceiling:\s*60\s*\}/,
    "a whole line plus the Cc roster must clear the gate on every publish, not only the first",
  );
}
