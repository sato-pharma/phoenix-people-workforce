import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  NEEDS_YOU_BOARD_PATH,
  NEEDS_YOU_DAILY_JOB,
  boardToTelegramSections,
  buildNeedsYouDailyMessage,
} from "../src/lib/needs-you/deliver/daily.ts";
import { SAFE_BUDGET } from "../src/lib/needs-you/render/telegram.ts";
import { needsYouSourceIds, type NeedsYouBoard, type NeedsYouItem } from "../src/lib/needs-you/types.ts";
import { DAILY_JOBS } from "../src/lib/scheduled-jobs/daily-jobs.ts";

import { stripComments } from "./support/comment-strip.ts";

/**
 * 🔴 THE DIGEST CARRIES THE SAME RULE AS THE BOARD: UNDER-REPORTING IS WORSE THAN SILENCE.
 *
 * A message that arrives at 06:36 saying nothing is waiting, on a morning when a source simply did
 * not answer, costs the decision more surely than no message would — because the looking has been
 * delegated. Every assertion here is that rule in one of the shapes that could break it.
 *
 * THE ROUTE IT RIDES ON CARRIED A DOCUMENTED OFF-BY-ONE. `/api/notifications/daily` destructured
 * its `Promise.all` positionally, and a job once added without its name put every later result one
 * position off for weeks; `totalJobs` was hand-kept beside it. Since 13 Nov 2026 every morning job is
 * an entry in one list with its own named runner, which the fan-out and the per-job route
 * (`/api/cron/daily/<job>`, once `PHOENIX_DAILY_JOBS_SPLIT` is on) both run, so each result carries its
 * own name; the digest is the job `needs-you-daily-digest` at 06:36 — so §4 now pins that instead.
 *
 * WHAT EACH ASSERTION CATCHES, in the words of the change that would break it:
 *
 *  1. The could-not-be-read section rendered anywhere but FIRST. Telegram truncates from the END,
 *     mid-word, with no marker, so a section that renders last is one that silently disappears.
 *  2. The all-clear sentence reached from an empty list rather than from `allClearProvable` —
 *     "no items" and "no source answered" collapsed into one reading.
 *  3. A tier-2 summary that can do more than prefix a sentence.
 *  4. The digest losing its own morning job: its key, its 06:36 minute, its place first in the
 *     morning, or the job label its failures are logged under.
 *  5. A job failure whose fallback reports a ZERO rather than `skipped` with a reason. A zero from
 *     a crashed job is indistinguishable from a quiet morning.
 *  6. Email added to the DAILY digest. One email to him is already two deliveries (the email plus
 *     its Telegram mirror), which is why email is weekly and this is not.
 *  7. The recipient resolved by ROLE rather than by his own id — this board is one person's private
 *     decision queue, and a "safe" fallback audience is how it reaches somebody else.
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");
const DAILY_ROUTE = "app/api/cron/daily/_lib/daily-job-runners.ts";
const DELIVER = "src/lib/needs-you/deliver/daily.ts";

function item(over: Partial<NeedsYouItem> & { key: string }): NeedsYouItem {
  return {
    ageDays: null,
    count: 1,
    externalUrl: null,
    href: "/admin/needs-you",
    kind: "approval",
    label: `${over.key} label`,
    lane: "yours",
    note: null,
    oldestAt: null,
    overdue: false,
    people: [],
    sourceId: "action-inbox",
    ...over,
  } as NeedsYouItem;
}

function board(over: Partial<NeedsYouBoard> = {}): NeedsYouBoard {
  return {
    allClearProvable: false,
    generatedAt: "2026-09-28T04:36:00.000Z",
    notProven: [],
    someoneElse: [],
    sources: needsYouSourceIds.map((id) => ({ id, label: id, status: "ok" as const, because: null, itemCount: 0 })),
    worthKnowing: [],
    yours: [],
    ...over,
  };
}

export function runNeedsYouDailyDigestTests() {
  // 1 — could-not-be-read leads, whatever else is on the board.
  {
    const sections = boardToTelegramSections(
      board({
        notProven: [{ id: "payroll-publish", label: "Payroll months waiting to publish", because: "it did not answer" }],
        worthKnowing: [item({ key: "w", lane: "worth-knowing" })],
        yours: [item({ key: "y" })],
        someoneElse: [item({ key: "s", lane: "someone-else" })],
      }),
    );
    assert.equal(
      sections[0]?.kind,
      "not-proven",
      "the could-not-be-read section must render FIRST. Telegram truncates from the END, mid-word, " +
        "with no marker — a section rendered last is a section that silently disappears.",
    );
    assert.deepEqual(
      sections.map((section) => section.kind),
      ["not-proven", "yours", "elsewhere", "worth-knowing"],
      "all four lanes must reach the digest, or it disagrees with the board it links to",
    );
  }

  // 2 — the all-clear is gated on the board's verdict, never on an empty list.
  {
    const quiet = buildNeedsYouDailyMessage({ board: board({ allClearProvable: true }), boardUrl: NEEDS_YOU_BOARD_PATH });
    assert.match(quiet, /every source answered/i, "a provable all-clear should say so plainly");

    const unproven = buildNeedsYouDailyMessage({
      board: board({ allClearProvable: false }),
      boardUrl: NEEDS_YOU_BOARD_PATH,
    });
    assert.doesNotMatch(
      unproven,
      /every source answered/i,
      "an EMPTY board whose sources did not all answer must never produce the all-clear sentence — " +
        '"no items" and "nothing could be read" are the two readings this module exists to keep apart',
    );
    assert.match(unproven, /not an all-clear/i, "it must say outright that this is not an all-clear");
  }

  // 3 — the tier-2 summary is a PREFIX and can be nothing else.
  {
    const withLead = buildNeedsYouDailyMessage({
      board: board({ yours: [item({ key: "y" })] }),
      boardUrl: NEEDS_YOU_BOARD_PATH,
      summaryLead: "Two payroll months are the long poles today.",
    });
    const without = buildNeedsYouDailyMessage({
      board: board({ yours: [item({ key: "y" })] }),
      boardUrl: NEEDS_YOU_BOARD_PATH,
    });
    assert.ok(
      withLead.endsWith(without),
      "the deterministic render must survive a summary UNCHANGED — the model prefixes a sentence and " +
        "does nothing else, which is why no summary can reassure over a board that did not prove itself",
    );
    assert.equal(
      buildNeedsYouDailyMessage({ board: board({ yours: [item({ key: "y" })] }), boardUrl: NEEDS_YOU_BOARD_PATH, summaryLead: "   " }),
      without,
      "a blank summary must leave the message byte-identical rather than adding stray whitespace",
    );
  }

  // 4 — the digest is its own morning job, first, at its old 06:36, under its own job label.
  {
    const job = DAILY_JOBS.find((entry) => entry.key === NEEDS_YOU_DAILY_JOB);
    assert.ok(job, `the Needs You digest must be a morning job of its own, keyed "${NEEDS_YOU_DAILY_JOB}"`);
    assert.equal(DAILY_JOBS[0]?.key, NEEDS_YOU_DAILY_JOB, "it runs FIRST of the morning — he reads it first thing");
    assert.deepEqual([job.hour, job.minute], [6, 36], "at 06:36 Cairo, the minute it has always arrived");
    assert.ok(
      DAILY_JOBS.every((entry) => entry === job || entry.hour !== 6 || entry.minute !== 36),
      "no other morning job shares its minute — company on its minute is what starved its sources",
    );
    const runners = stripComments(read(DAILY_ROUTE));
    assert.match(
      runners,
      /"needs-you-daily-digest": \{\s*resultName: "needsYouDailyDigest",/,
      `${DAILY_ROUTE}: its answer names the result needsYouDailyDigest, as the old route's answer did`,
    );
  }

  // 5 — a crashed job reports SKIPPED with a reason, never a zero that reads as a quiet morning.
  {
    const route = stripComments(read(DAILY_ROUTE));
    const call = route.slice(route.indexOf("runNeedsYouDailyDigest()"), route.indexOf("runNeedsYouDailyDigest()") + 320);
    assert.ok(call.includes(NEEDS_YOU_DAILY_JOB), `the digest must register under the job name "${NEEDS_YOU_DAILY_JOB}"`);
    assert.match(
      call,
      /skipped:\s*true/,
      "the failure fallback must report skipped:true with the reason. A bare zero from a job that " +
        "CRASHED is indistinguishable from a morning when nothing was waiting.",
    );
    assert.match(call, /reason:\s*message/, "the fallback must carry the failure's own message, never drop it");
  }

  // 6 — the daily digest never requests email.
  {
    const deliver = stripComments(read(DELIVER));
    const channels = deliver.match(/channels:\s*\[[^\]]*\]/);
    assert.ok(channels, `${DELIVER}: the channel list could not be located.`);
    assert.doesNotMatch(
      channels[0],
      /email/,
      "the DAILY digest must not request email. One email to him is already two deliveries — the " +
        "email plus its Telegram mirror — which is precisely why email is weekly and this is daily.",
    );
    assert.match(channels[0], /telegram/, "the daily digest is a Telegram digest");
  }

  // 7 — the recipient is resolved by HIS id, never by role.
  {
    const deliver = stripComments(read(DELIVER));
    assert.match(
      deliver,
      /\.eq\("hr_id", NEEDS_YOU_EMAIL_HR_ID\)/,
      `${DELIVER}: the recipient must be resolved by the owner's own hr id. A role query hands back ` +
        "everyone holding the role, and this board names pending payroll, unpublished closings and " +
        "approval backlogs — it is one person's private decision queue.",
    );
    assert.doesNotMatch(
      deliver,
      /resolveNotificationRoleRecipients/,
      `${DELIVER}: a role-resolved audience is exactly the fallback this digest must not have`,
    );
    assert.match(
      deliver,
      /failClosed:\s*true/,
      `${DELIVER}: an unresolved recipient must fail CLOSED and be audited, never fall back to anyone else`,
    );
  }

  // 8 — the render still fits Telegram's real budget when every lane is full.
  {
    const many = (lane: NeedsYouItem["lane"], n: number) =>
      Array.from({ length: n }, (_, i) => item({ key: `${lane}-${i}`, lane, label: `${lane} item number ${i} waiting` }));
    const message = buildNeedsYouDailyMessage({
      board: board({
        notProven: [{ id: "monthly-closings", label: "Monthly closings not published", because: "it did not answer within 8 seconds" }],
        someoneElse: many("someone-else", 20),
        worthKnowing: many("worth-knowing", 20),
        yours: many("yours", 20),
      }),
      boardUrl: NEEDS_YOU_BOARD_PATH,
    });
    assert.ok(
      message.length <= SAFE_BUDGET,
      `a full board rendered ${message.length} characters against a ${SAFE_BUDGET} budget — Telegram ` +
        "slices at 900 mid-word with no marker, so the fit has to hold by construction",
    );
    assert.doesNotMatch(message, /…/, "nothing the digest prints may carry an ellipsis (AGENTS.md §4)");
    assert.ok(
      message.indexOf("Could not be read") < message.indexOf("Waiting on you"),
      "under budget pressure the could-not-be-read section must still lead",
    );
  }
}
