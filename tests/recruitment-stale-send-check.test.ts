import assert from "node:assert/strict";

import {
  buildManagerNudgeMessage,
  buildStrandedEscalationMessage,
  cairoDateLabel,
  classifyStaleSends,
  daysWaiting,
  STALE_SEND_CHANNELS,
  STALE_SEND_ESCALATE_AFTER_DAYS,
  STALE_SEND_NUDGE_AFTER_DAYS,
  type SentCandidate,
} from "../src/lib/recruitment/stale-send-check.ts";

/**
 * The rule that decides who gets chased about a CV nobody answered.
 *
 * Every fixture is shaped on the real production state of 2026-08-28: 24 CVs sitting in
 * "sent to manager", zero decisions ever recorded, and one of them addressed to a manager whose
 * employment status is `resigned`. That last one is the case worth pinning — waiting cannot fix it,
 * so it must not be treated as slowness.
 */

const NOW = new Date("2026-08-28T09:00:00Z");

function sent(overrides: Partial<SentCandidate> & { id: string }): SentCandidate {
  return {
    fullName: "Tarek Nabil Ibrahim",
    jobTitle: "Medical Representative",
    managerHrId: "A-12",
    managerName: "Ali Moh Ali",
    sentAt: "2026-08-28T09:00:00Z",
    ...overrides,
  };
}

/** `sentAt` for a send that is exactly `days` old at NOW. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

const REACHABLE = new Set(["a-12", "b-94", "pd-0001"]);

export async function runRecruitmentStaleSendCheckTests(): Promise<void> {
  // ── 1. The nudge threshold is a floor, not a rounding ──────────────────────
  // A CV that arrived two days and twenty-three hours ago has not been waiting three days. Getting
  // this wrong in the generous direction means nudging a manager about yesterday's CV, and an alert
  // that fires on ordinary behaviour is one people stop reading.
  {
    const justUnder = classifyStaleSends(
      [sent({ id: "c1", sentAt: daysAgo(STALE_SEND_NUDGE_AFTER_DAYS - 0.05) })],
      REACHABLE,
      NOW,
    );
    assert.equal(justUnder.nudges.length, 0, "two days and twenty-three hours is not three days");

    const exactly = classifyStaleSends(
      [sent({ id: "c1", sentAt: daysAgo(STALE_SEND_NUDGE_AFTER_DAYS) })],
      REACHABLE,
      NOW,
    );
    assert.equal(exactly.nudges.length, 1, "exactly three days is nudged");
    assert.equal(exactly.nudges[0].candidates[0].daysWaiting, STALE_SEND_NUDGE_AFTER_DAYS);
    assert.equal(exactly.stranded.length, 0, "three days is slowness, not a strand");
  }

  // ── 2. A manager who CANNOT answer strands the CV on day one ───────────────
  // The whole reason the two problems are separate. This candidate was sent today, so no threshold
  // has passed and nothing is "late" — but the manager has resigned, so waiting will never produce
  // an answer and only a human other than that manager can act.
  {
    const plan = classifyStaleSends(
      [sent({ id: "c1", managerHrId: "PD-0006", managerName: "Ahmed Nagy", sentAt: daysAgo(0) })],
      REACHABLE,
      NOW,
    );
    assert.equal(plan.nudges.length, 0, "a resigned manager is never nudged");
    assert.equal(plan.stranded.length, 1, "and the CV is stranded immediately");
    assert.equal(plan.stranded[0].reason, "manager_cannot_answer");
    assert.equal(plan.stranded[0].daysWaiting, 0, "stranded on the day it was sent");
  }

  // ── 3. Past the escalation threshold, BOTH parties hear about it ───────────
  // The manager can still answer, so the nudge continues; the desk is told because a week of
  // silence is long enough for the candidate to take another job.
  {
    const plan = classifyStaleSends(
      [sent({ id: "c1", sentAt: daysAgo(STALE_SEND_ESCALATE_AFTER_DAYS) })],
      REACHABLE,
      NOW,
    );
    assert.equal(plan.nudges.length, 1, "the manager is still nudged");
    assert.equal(plan.stranded.length, 1, "and the desk is told");
    assert.equal(plan.stranded[0].reason, "no_answer");

    const dayBefore = classifyStaleSends(
      [sent({ id: "c1", sentAt: daysAgo(STALE_SEND_ESCALATE_AFTER_DAYS - 1) })],
      REACHABLE,
      NOW,
    );
    assert.equal(dayBefore.nudges.length, 1, "still nudged the day before");
    assert.equal(dayBefore.stranded.length, 0, "but not escalated yet");
  }

  // ── 4. Several CVs with one manager are ONE nudge ──────────────────────────
  // Eleven separate notifications to the same person on the same morning is not a reminder, it is a
  // reason to mute the channel. Production had exactly that shape: 11 with one manager, 7 with
  // another, 4 with a third.
  {
    const plan = classifyStaleSends(
      [
        sent({ id: "c1", sentAt: daysAgo(4) }),
        sent({ id: "c2", fullName: "Mona Adel", sentAt: daysAgo(9) }),
        sent({ id: "c3", fullName: "Kareem Fouad", sentAt: daysAgo(3) }),
        sent({ id: "c4", fullName: "Sara Hany", managerHrId: "B-94", managerName: "Taha Mohamed Taha", sentAt: daysAgo(5) }),
      ],
      REACHABLE,
      NOW,
    );
    assert.equal(plan.nudges.length, 2, "one nudge per manager, not one per candidate");

    const [first, second] = plan.nudges;
    assert.equal(first.managerHrId, "A-12", "the manager keeping someone waiting longest is first");
    assert.equal(first.candidates.length, 3);
    assert.equal(first.longestWaitDays, 9);
    assert.deepEqual(
      first.candidates.map((candidate) => candidate.id),
      ["c2", "c1", "c3"],
      "longest wait first inside the nudge too",
    );
    assert.equal(second.managerHrId, "B-94");
    assert.equal(second.candidates.length, 1);
  }

  // ── 5. HR id casing cannot silently strand a working manager ───────────────
  // HR ids are stored mixed-case across this schema and a case-sensitive compare returns fewer rows
  // with no error — the trap that once hid 28% of a rep's own direct orders. Here the cost would be
  // worse than a missing row: an active manager would be read as unreachable and every one of their
  // CVs escalated as stranded.
  {
    const plan = classifyStaleSends(
      [sent({ id: "c1", managerHrId: "a-12", sentAt: daysAgo(4) })],
      REACHABLE,
      NOW,
    );
    assert.equal(plan.stranded.length, 0, "lower-case a-12 is the same manager as A-12");
    assert.equal(plan.nudges.length, 1);
    assert.equal(plan.nudges[0].managerHrId, "A-12", "and the recipient id carries the stored casing");
  }

  // ── 6. Refusals and edges ──────────────────────────────────────────────────
  {
    assert.deepEqual(classifyStaleSends([], REACHABLE, NOW), { nudges: [], stranded: [] });

    const noManager = classifyStaleSends([sent({ id: "c1", managerHrId: "   ", sentAt: daysAgo(9) })], REACHABLE, NOW);
    assert.deepEqual(noManager, { nudges: [], stranded: [] }, "a blank manager id is skipped, not crashed on");

    assert.equal(daysWaiting("not-a-date", NOW), 0, "an unparseable send time reads as zero, never NaN");
    assert.equal(daysWaiting(daysAgo(-5), NOW), 0, "a send stamped in the future is not negative days");
    assert.equal(daysWaiting(daysAgo(3.9), NOW), 3, "days are floored, never rounded up");
  }

  // ── 7. The date a human reads is Cairo's, not UTC's ────────────────────────
  // 21:30 UTC is already the next day in Cairo. Reporting the UTC date would tell a manager a CV
  // arrived on the 26th when the record says the 27th.
  {
    assert.equal(cairoDateLabel("2026-08-26T21:30:00Z"), "27 August 2026", "Cairo is ahead of UTC");
    assert.equal(cairoDateLabel("2026-08-26T09:00:00Z"), "26 August 2026");
    assert.equal(cairoDateLabel("nonsense"), "an unknown date", "an unreadable instant never prints Invalid Date");
  }

  // ── 8. The message names every candidate, and never emails ─────────────────
  // The owner's standing rules: text is never truncated with an ellipsis, and a hiring-manager push
  // is never email. A daily job that repeats makes the second one matter more, not less.
  {
    assert.ok(!STALE_SEND_CHANNELS.includes("email" as never), "a nudge is never emailed");
    assert.deepEqual([...STALE_SEND_CHANNELS], ["in_app", "telegram", "push"]);

    const plan = classifyStaleSends(
      [
        sent({ id: "c1", sentAt: daysAgo(4) }),
        sent({ id: "c2", fullName: "Mona Adel", jobTitle: null, sentAt: daysAgo(9) }),
      ],
      REACHABLE,
      NOW,
    );
    const message = buildManagerNudgeMessage(plan.nudges[0]);
    assert.ok(message.includes("2 CVs waiting"), "the count is plural without a bracketed (s)");
    assert.ok(message.includes("Tarek Nabil Ibrahim"), "every candidate is named");
    assert.ok(message.includes("Mona Adel"), "including the second");
    assert.ok(!message.includes("…") && !message.includes("..."), "nothing is cut with an ellipsis");
    assert.ok(message.includes("19 August 2026"), "the send date is a real Cairo date");
  }

  // ── 9. The escalation says which problem it is ─────────────────────────────
  // A resigned manager and a silent one need different actions from the reader, so one message that
  // said only "3 CVs are stuck" would send them looking in the wrong place.
  {
    const plan = classifyStaleSends(
      [
        sent({ id: "c1", managerHrId: "PD-0006", managerName: "Ahmed Nagy", sentAt: daysAgo(1) }),
        sent({ id: "c2", fullName: "Mona Adel", sentAt: daysAgo(9) }),
      ],
      REACHABLE,
      NOW,
    );
    const message = buildStrandedEscalationMessage(plan.stranded);
    assert.ok(message.includes("cannot answer"), "the unreachable case is named as such");
    assert.ok(message.includes("Ahmed Nagy"), "and names the manager who cannot act");
    assert.ok(message.includes("no answer for 7 days"), "the silent case reports the threshold it crossed");
    assert.ok(message.includes("Mona Adel"), "and names that candidate");
    assert.ok(!message.includes("…"), "no ellipsis here either");

    const onlySilent = buildStrandedEscalationMessage(plan.stranded.filter((send) => send.reason === "no_answer"));
    assert.ok(!onlySilent.includes("cannot answer"), "a section with nothing in it is not printed");
  }
}
