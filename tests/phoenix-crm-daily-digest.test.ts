import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  DIGEST_CRON,
  DIGEST_JOB_SLUG,
  DIGEST_MAX_LINES,
  planPhoenixCrmDigest,
  type DigestRecipient,
} from "../src/lib/phoenix-crm/digest-rules.ts";
import type { TerritoryException } from "../src/lib/phoenix-crm/exceptions.ts";
import { JOB_SCHEDULES } from "../src/lib/observability/job-schedule.ts";
import { enforcePhoenixCrmEmailBlock } from "../src/lib/notifications/phoenix-crm-channel-guard.ts";

/**
 * Phoenix CRM — B1: the 06:55 digest.
 *
 * Owner, 2026-09-26, choosing between four shapes: the District Manager, at 06:55 Cairo, about the
 * previous field day. He is in the car or at breakfast, he has a phone, and the one thing worth his
 * attention before the day starts is which of his reps needs a call this morning.
 *
 * ## 🔴 The rule this file exists to pin: A CLEAN MANAGER IS TOLD NOTHING
 *
 * Not "all good", not a daily tick, not an empty digest. A message that arrives every morning
 * whatever happened is muted within a week, and a muted digest is WORSE than none, because everybody
 * then believes it is working. It is silent when broken: a "nothing to report" line would send
 * perfectly, look fine in staging, and only fail as a manager who stopped reading.
 */

const DAY = "2026-09-24";
const DAY_LABEL = "Thursday 24 September 2026";

function row(overrides: Partial<TerritoryException> = {}): TerritoryException {
  return {
    seatId: "SEAT-1",
    territoryName: "Cairo 1",
    lineName: "Pedia",
    repName: "Ahmed Samir",
    kind: "no_visit",
    label: "No visit on the last field day",
    why: "The last full field day has no visit on it.",
    detail: null,
    ...overrides,
  };
}

function manager(seatIds: string[], hrId = "B-200"): DigestRecipient {
  return { hrId, name: "Amgad Ibrahim", seatIds };
}

export function runPhoenixCrmDailyDigestTests(): void {
  // ── 🔴 A clean manager is told NOTHING ────────────────────────────────────────────────────────
  {
    assert.deepEqual(planPhoenixCrmDigest([], [manager(["SEAT-1", "SEAT-2"])], DAY, DAY_LABEL), [], "no rows, no message");

    // And a manager whose own seats are clean hears nothing even when the company has problems.
    const elsewhere = planPhoenixCrmDigest([row({ seatId: "SEAT-99" })], [manager(["SEAT-1"])], DAY, DAY_LABEL);
    assert.deepEqual(elsewhere, [], "another district's trouble is not his morning message");

    // There is no "all good" wording anywhere in the module's digest.
    const rules = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/digest-rules.ts", import.meta.url), "utf8"));
    for (const banned of [/all good/i, /nothing to report/i, /no issues/i, /well done/i]) {
      assert.doesNotMatch(rules, banned, "a digest that arrives whatever happened is one people mute");
    }
  }

  // ── One message per manager, worst first, names never codes ───────────────────────────────────
  {
    const digests = planPhoenixCrmDigest(
      [
        row({ seatId: "S-rate", territoryName: "Zzz", kind: "below_pm_rate", label: "Below the PM call rate", detail: "9.0 a day against 10" }),
        row({ seatId: "S-vacant", territoryName: "Aaa", kind: "vacant", label: "No rep in this seat", repName: null }),
      ],
      [manager(["S-rate", "S-vacant"])],
      DAY,
      DAY_LABEL,
    );
    assert.equal(digests.length, 1, "one message, not one per problem");
    const [digest] = digests;
    assert.equal(digest.title, "2 territories need you · Thursday 24 September 2026");
    assert.ok(digest.message.indexOf("Aaa") < digest.message.indexOf("Zzz"), "worst first inside the message too");
    assert.ok(digest.message.includes("Aaa · No rep: No rep in this seat"), "a vacant seat says so where the name would be");
    assert.ok(digest.message.includes("Zzz · Ahmed Samir: Below the PM call rate — 9.0 a day against 10"));
    // Names, never HR codes or seat ids (owner rule). The seat id is the key, never the message.
    assert.equal(digest.message.includes("S-rate"), false);
    assert.equal(/\bB-\d+\b/.test(digest.message), false, "no HR code reaches a message a person reads");

    // One territory reads as one, not "1 territories".
    const single = planPhoenixCrmDigest([row()], [manager(["SEAT-1"])], DAY, DAY_LABEL);
    assert.equal(single[0].title, "1 territory needs you · Thursday 24 September 2026");
  }

  // ── 🔴 Idempotent per manager per DAY, not per fire ───────────────────────────────────────────
  //
  // The cron can be retried by the platform, replayed by hand, or fired twice. None of those may
  // reach him a second time — and a key that carried a timestamp would let all three through.
  {
    const first = planPhoenixCrmDigest([row()], [manager(["SEAT-1"])], DAY, DAY_LABEL);
    const again = planPhoenixCrmDigest([row()], [manager(["SEAT-1"])], DAY, DAY_LABEL);
    assert.equal(first[0].idempotencyKey, again[0].idempotencyKey, "the same day twice is the same key");
    assert.equal(first[0].idempotencyKey, "phoenix_crm:digest:2026-09-24:B-200");
    const tomorrow = planPhoenixCrmDigest([row()], [manager(["SEAT-1"])], "2026-09-26", DAY_LABEL);
    assert.notEqual(first[0].idempotencyKey, tomorrow[0].idempotencyKey, "a new day is a new message");
    // Two managers on the same day are two keys, or the second one never hears.
    const two = planPhoenixCrmDigest(
      [row(), row({ seatId: "SEAT-2" })],
      [manager(["SEAT-1"], "B-200"), manager(["SEAT-2"], "B-201")],
      DAY,
      DAY_LABEL,
    );
    assert.equal(new Set(two.map((entry) => entry.idempotencyKey)).size, 2);
  }

  // ── A long list is cut, never sent as a wall ──────────────────────────────────────────────────
  {
    const many = Array.from({ length: DIGEST_MAX_LINES + 5 }, (_, index) => row({ seatId: `S-${index}`, territoryName: `T${String(index).padStart(2, "0")}` }));
    const [digest] = planPhoenixCrmDigest(many, [manager(many.map((entry) => entry.seatId))], DAY, DAY_LABEL);
    assert.equal(digest.message.split("\n").filter((text) => text.startsWith("• ")).length, DIGEST_MAX_LINES + 1, "the cut line is itself a bullet");
    assert.ok(digest.message.includes("and 5 more on the board."), "and it says how many were left out");
    assert.ok(digest.title.startsWith(`${DIGEST_MAX_LINES + 5} territories need you`), "while the count stays honest");
  }

  // ── 🔴 Email cannot escape, whatever this feature asks for ────────────────────────────────────
  {
    assert.deepEqual(
      enforcePhoenixCrmEmailBlock(["in_app", "telegram", "email"], "phoenix_crm"),
      ["in_app", "telegram"],
      "the module guard strips email on the MODULE key, so no call site can opt back in",
    );
    const runner = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/server/daily-digest.ts", import.meta.url), "utf8"));
    assert.ok(runner.includes('channels: ["in_app", "telegram"]'), "and the runner asks for neither");
    assert.equal(/"email"/.test(runner), false);
    assert.ok(runner.includes("module: PHOENIX_CRM_NOTIFICATION_MODULE"), "under the module key the guard filters on");
  }

  // ── It judges nothing of its own, and reads ONE day where the board reads six ──────────────────
  {
    const runner = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/server/daily-digest.ts", import.meta.url), "utf8"));
    // 🔴 One gathering, shared with the board. Two would let the digest and the screen disagree about
    // the same territory on the same morning, which nobody would notice for a month.
    assert.ok(runner.includes("gatherExceptions({"), "the digest calls the board's own gathering");
    assert.equal(/judgeTerritory|buildExceptions/.test(runner), false, "and judges nothing itself");
    assert.ok(runner.includes("const DIGEST_WINDOW_FIELD_DAYS = 1;"), "one field day — at 06:55 he wants yesterday");
    assert.ok(runner.includes("windowFieldDays: DIGEST_WINDOW_FIELD_DAYS"));

    // A territory whose line has not opened has no app to have been used, and putting it on a
    // manager's message would accuse him of a decision that is the owner's.
    assert.ok(runner.includes("openLines.has(seat.lineCode)"), "closed lines are left out");

    // One failed delivery must not cost the other managers their morning.
    assert.ok(runner.includes("failed += 1"), "a failure is counted");
    assert.ok(runner.includes("logError("), "and logged");
  }

  // ── 🔴 SCHEDULED, AND IN-APP OR TELEGRAM ONLY — the owner's decision, 2026-09-28 ─────────────
  //
  // He stood this digest down on 2026-09-27 ("donot create this digest i donot want it") and asked
  // for it back the next day with one condition: "i want it in app or telegram only". Nothing had
  // ever been sent in between, so there was nothing in the field to undo either way.
  //
  // His condition was already how it was built, and it is already pinned ABOVE — "Email cannot
  // escape, whatever this feature asks for" calls `enforcePhoenixCrmEmailBlock` itself, so it
  // proves the guard behaviourally rather than by reading the source. Do not add a second copy of
  // that check here; this section is only about the SCHEDULE. The
  // three schedule halves are pinned TOGETHER, because the failure mode of restoring them apart is
  // worse than not restoring them at all:
  //
  //   JOB_SCHEDULES            a declaration with no cron job behind it reads to the heartbeat
  //                            sweep as a job that has STOPPED. Once one 06:55 passes it goes
  //                            STRANDED and alarms every Super Admin, in-app, Telegram and push,
  //                            every sweep, for ever — about a job nobody created.
  //   scripts/cronjob-sync.mjs the list of jobs someone is about to create, which is what closes
  //                            that gap on `--apply`.
  //   docs/observability.md    the register test pins the table against JOB_SCHEDULES, so the two
  //                            move together or CI goes red.
  //
  // 🔴 So this file cannot prove the cron job EXISTS — only cron-job.org knows that. What it can
  // prove is that the three halves never drift apart, which is the part a session gets wrong.
  {
    const declared = JOB_SCHEDULES.find((entry) => entry.slug === DIGEST_JOB_SLUG);
    assert.ok(declared, "the digest is scheduled again (owner, 2026-09-28: \"i want it in app or telegram only\")");
    assert.equal(declared!.schedule, DIGEST_CRON, "and at the minute the module itself records");
    assert.equal(DIGEST_CRON, "55 6 * * *", "06:55 Cairo, before the field day starts");

    const sync = readFileSync(new URL("../scripts/cronjob-sync.mjs", import.meta.url), "utf8");
    assert.ok(
      sync.includes('"phoenix-crm-daily-digest": {'),
      "🔴 and there is a declaration to apply — a JOB_SCHEDULES line without one alarms every Super Admin for ever",
    );
    assert.ok(sync.includes("hours: [6], minutes: [55]"), "at the same minute, or the heartbeat calls a job that fires perfectly late");

    const docs = readFileSync(new URL("../docs/observability.md", import.meta.url), "utf8");
    assert.ok(docs.includes("| `phoenix-crm-daily-digest` | `55 6 * * *` | 2h |"), "and the observability table carries the same row");
  }

  // ── The route: authorised, watched, and safe to fire twice ────────────────────────────────────
  {
    const route = stripComments(readFileSync(new URL("../app/api/cron/phoenix-crm-daily-digest/route.ts", import.meta.url), "utf8"));
    assert.ok(route.includes('assertCronAuthorized(request, "cron/phoenix-crm-daily-digest")'), "the secret gates it");
    assert.ok(route.includes("withDeadMansSwitch(DIGEST_JOB_SLUG"), "the dead-man's switch is what proves a SILENT morning ran");
    assert.ok(route.includes("export async function POST"), "cron-job.org may use either verb");
    assert.ok(route.includes("export const maxDuration = 60"), "its own clock, not the 30s /api/notifications/daily shares");
  }

  console.log("phoenix-crm daily digest: OK");
}
