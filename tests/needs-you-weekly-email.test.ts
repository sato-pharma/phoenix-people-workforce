import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { NEEDS_YOU_BOARD_PATH } from "../src/lib/needs-you/deliver/daily.ts";
import {
  NEEDS_YOU_WEEKLY_WEEKDAY,
  buildNeedsYouWeeklyEmail,
  buildNeedsYouWeeklySubject,
  cairoWeekday,
} from "../src/lib/needs-you/deliver/weekly.ts";
import { needsYouSourceIds, type NeedsYouBoard, type NeedsYouItem } from "../src/lib/needs-you/types.ts";

import { stripComments } from "./support/comment-strip.ts";

/**
 * 🔴 THE WEEKLY EMAIL EXISTS TO BE COMPLETE. That is the whole reason it is a second channel rather
 * than a louder copy of the daily digest.
 *
 * Telegram is 900 characters sliced from the END, mid-word, with no marker, so the daily message is
 * built TO A BUDGET: it fits what it can and counts what it left out. Email has no ceiling, so this
 * one carries every item in every lane AND all sixteen source verdicts — "which sources answered
 * this week" is a question a budgeted message structurally cannot answer. An email that quietly
 * started dropping items would leave the board with two fitted channels and no complete one, and
 * nothing outside this file would notice.
 *
 * 🔴 AND IT REACHES EXACTLY ONE PERSON. A sent email cannot be recalled, and this board is a list of
 * the decisions waiting on the owner — pending payroll months, unpublished closings, approval
 * backlogs. Two independent layers keep it his: this module resolves him by his own hr id and skips
 * if it cannot, and `enforceNeedsYouOwnerOnlyEmail` strips `email` at the end of
 * `basePolicyChannels` unless the resolved recipient is provably him.
 *
 * WHAT EACH ASSERTION CATCHES, in the words of the change that would break it:
 *
 *  1. The weekly firing every day — it rides the 06:36 route, so the day gate IS the schedule.
 *  2. The body dropping an item or a source, which would leave no complete channel at all.
 *  3. Could-not-be-read demoted below the fold.
 *  4. `telegram` added to the channels — the email already mirrors a preview there, so the board
 *     would arrive twice on the same wire.
 *  5. The recipient resolved by role, or a failure falling back to somebody else.
 *  6. A subject that reads the same every week, which is a subject nobody opens.
 *  7. `subjectHrId` set instead of `title`. They are NOT the same field: `title` is the subject
 *     line, `subjectHrId` names the person a notification is ABOUT and feeds the sensitive-module
 *     recipient checks — setting it here would hand the governance layer a bogus subject and change
 *     who is allowed to receive this.
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const WEEKLY = "src/lib/needs-you/deliver/weekly.ts";
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

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
    sources: needsYouSourceIds.map((id) => ({ id, label: `source ${id}`, status: "ok" as const, because: null, itemCount: 0 })),
    worthKnowing: [],
    yours: [],
    ...over,
  };
}

export function runNeedsYouWeeklyEmailTests() {
  // 1 — exactly one day in seven is the weekly day.
  {
    const start = Date.UTC(2026, 8, 20, 9, 0, 0);
    const hits = Array.from({ length: 7 }, (_, i) => cairoWeekday(new Date(start + i * 86_400_000))).filter(
      (day) => day === NEEDS_YOU_WEEKLY_WEEKDAY,
    );
    assert.equal(
      hits.length,
      1,
      "exactly one day in any seven must be the weekly day. This job rides the DAILY 06:36 route, so " +
        "the day gate is the entire schedule — a gate that never matches sends nothing for ever, and " +
        "one that always matches emails him every morning.",
    );
    const weekly = stripComments(read(WEEKLY));
    assert.match(
      weekly,
      /cairoWeekday\(now\) !== NEEDS_YOU_WEEKLY_WEEKDAY/,
      `${WEEKLY}: the day gate must be present, or the weekly email is a daily one`,
    );
    assert.match(weekly, /options\?\.force/, `${WEEKLY}: the gate needs a force override or it cannot be exercised`);
  }

  // 2 — COMPLETE: every item in every lane, and every source, reaches the body.
  {
    const many = (lane: NeedsYouItem["lane"], n: number) =>
      Array.from({ length: n }, (_, i) => item({ key: `${lane}-${i}`, lane, label: `${lane} item number ${i}` }));
    const full = board({
      notProven: [{ id: "payroll-publish", label: "Payroll months waiting to publish", because: "it did not answer" }],
      someoneElse: many("someone-else", 12),
      worthKnowing: many("worth-knowing", 12),
      yours: many("yours", 12),
    });
    const body = buildNeedsYouWeeklyEmail({ board: full, boardUrl: NEEDS_YOU_BOARD_PATH });

    for (const lane of ["yours", "someone-else", "worth-knowing"] as const) {
      for (let i = 0; i < 12; i += 1) {
        assert.ok(
          body.includes(`${lane} item number ${i}`),
          `the weekly email dropped "${lane} item number ${i}". Completeness is the ONLY thing this ` +
            "channel has that the 900-character daily digest does not — an email that fits to a budget " +
            "leaves the board with two fitted channels and no complete one.",
        );
      }
    }
    for (const id of needsYouSourceIds) {
      assert.ok(
        body.includes(`source ${id}`),
        `the weekly email omitted source "${id}". All ${needsYouSourceIds.length} verdicts belong here ` +
          "precisely because they cannot fit in Telegram — this is the only channel that can answer " +
          "which sources answered.",
      );
    }
    assert.doesNotMatch(body, /…/, "nothing it prints may carry an ellipsis (AGENTS.md §4)");
    assert.doesNotMatch(body, /\n{3,}/, "blank-line runs would arrive as dead space in the email body");
  }

  // 3 — could-not-be-read leads, even though email never truncates.
  {
    const body = buildNeedsYouWeeklyEmail({
      board: board({
        notProven: [{ id: "monthly-closings", label: "Monthly closings not published", because: "it did not answer" }],
        yours: [item({ key: "y" })],
      }),
      boardUrl: NEEDS_YOU_BOARD_PATH,
    });
    const notProvenAt = body.indexOf("Monthly closings not published");
    const yoursAt = body.indexOf("y label");
    assert.ok(notProvenAt >= 0 && yoursAt >= 0, "both sections must be present for this comparison to mean anything");
    assert.ok(
      notProvenAt < yoursAt,
      "a source that did not answer must lead. Email does not truncate, but a reader leaves after the " +
        "first screen — and an unread source changes how every number below it should be read.",
    );
  }

  // 4 — in_app and email, never telegram.
  {
    const weekly = stripComments(read(WEEKLY));
    const channels = weekly.match(/channels:\s*\[[^\]]*\]/);
    assert.ok(channels, `${WEEKLY}: the channel list could not be located.`);
    assert.match(channels[0], /email/, "the weekly digest is the EMAIL one");
    assert.doesNotMatch(
      channels[0],
      /telegram/,
      "the weekly email must not also request telegram. Every Phoenix email already mirrors a preview " +
        "to his Telegram on the way out, so asking for the channel delivers the same board twice.",
    );
  }

  // 5 — his id, never a role, and it fails closed.
  {
    const weekly = stripComments(read(WEEKLY));
    assert.match(
      weekly,
      /\.eq\("hr_id", NEEDS_YOU_EMAIL_HR_ID\)/,
      `${WEEKLY}: the recipient must be resolved by the owner's own hr id — a role query hands back ` +
        "everyone holding the role, and a sent email cannot be recalled",
    );
    assert.doesNotMatch(weekly, /resolveNotificationRoleRecipients/, `${WEEKLY}: no role-resolved audience`);
    assert.match(weekly, /failClosed:\s*true/, `${WEEKLY}: an unresolved recipient must fail closed and be audited`);
  }

  // 6 — the subject states the week's verdict rather than a fixed phrase.
  {
    const quiet = buildNeedsYouWeeklySubject(board({ allClearProvable: true }));
    const busy = buildNeedsYouWeeklySubject(board({ yours: [item({ key: "a" }), item({ key: "b" })] }));
    const blind = buildNeedsYouWeeklySubject(
      board({ notProven: [{ id: "resignations", label: "Resignations", because: "it did not answer" }] }),
    );
    assert.notEqual(quiet, busy, "a subject that reads the same on a quiet week and a busy one is one nobody opens");
    assert.notEqual(busy, blind, "a week with unread sources must not read like a week with none");
    for (const subject of [quiet, busy, blind]) {
      assert.ok(subject.startsWith("Needs You — "), "every subject keeps the same recognisable prefix");
      assert.doesNotMatch(subject, /…/, "no ellipsis in a subject line");
    }
  }

  // 7 — `title` carries the subject; `subjectHrId` is a different field and must stay unset.
  {
    const weekly = stripComments(read(WEEKLY));
    assert.match(
      weekly,
      /title:\s*buildNeedsYouWeeklySubject\(board\)/,
      `${WEEKLY}: \`title\` IS the subject line for this input — there is no \`subject\` field`,
    );
    assert.doesNotMatch(
      weekly,
      /subjectHrId/,
      `${WEEKLY}: \`subjectHrId\` is NOT the subject line. It names the person a notification is ABOUT ` +
        "and feeds the sensitive-module recipient checks, so setting it here would hand the governance " +
        "layer a bogus subject and change who is allowed to receive this.",
    );
  }
}
