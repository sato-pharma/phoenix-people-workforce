import assert from "node:assert/strict";

import {
  computePipelineMetrics,
  daysInStage,
  STALLED_AFTER_DAYS,
  wholeDaysBetween,
} from "../src/lib/recruitment/pipeline-metrics.ts";
import { applicationStages, terminalApplicationStages } from "../src/lib/recruitment/types.ts";

/**
 * Everything the recruitment module counted before this was a size — how many requisitions, how
 * many applications, how many candidates. These three say whether hiring is MOVING, which is the
 * question actually being asked, and each of them is only useful if it is honest about what it
 * cannot see.
 */

const now = "2026-08-21T09:00:00.000Z";
const daysAgo = (days: number) => new Date(new Date(now).getTime() - days * 86_400_000).toISOString();

const application = (stage: string, options: { created?: string; moved?: string } = {}) => ({
  createdAt: options.created ?? daysAgo(30),
  lastStageChangedAt: options.moved ?? daysAgo(1),
  stage,
});

export function runRecruitmentPipelineMetricsTests() {
  // ── THE HEADLINE: "stalled" never counts work that is finished ───────────────────────────────
  // A rejected candidate is not waiting for anybody. Counting one would leave the number climbing
  // forever on applications nobody can act on, and a card that only ever goes up is a card that
  // gets ignored — which is exactly what happened to every count this module had before.
  for (const finished of terminalApplicationStages) {
    const metrics = computePipelineMetrics([application(finished, { moved: daysAgo(400) })], now);
    assert.equal(
      metrics.stalled,
      0,
      `a ${finished} application has been sitting for 400 days and must NEVER be counted as stalled — nobody is waiting on it`,
    );
  }

  // Every live stage does count, once it passes the threshold.
  const live = applicationStages.filter((stage) => !terminalApplicationStages.includes(stage as never));
  assert.ok(live.length > 0);
  for (const stage of live) {
    assert.equal(
      computePipelineMetrics([application(stage, { moved: daysAgo(STALLED_AFTER_DAYS) })], now).stalled,
      1,
      `a live ${stage} application untouched for ${STALLED_AFTER_DAYS} days is stalled`,
    );
  }

  // The threshold is a floor, not a window: one day short does not count, exactly on it does.
  assert.equal(computePipelineMetrics([application("cv_screening", { moved: daysAgo(13) })], now).stalled, 0);
  assert.equal(computePipelineMetrics([application("cv_screening", { moved: daysAgo(14) })], now).stalled, 1);
  assert.equal(STALLED_AFTER_DAYS, 14);

  // ── Time to hire ─────────────────────────────────────────────────────────────────────────────
  // The MIDDLE value, never the average: with a handful of hires one application that sat for
  // months would describe a pipeline nobody recognises.
  const hires = computePipelineMetrics(
    [
      application("hired", { created: daysAgo(40), moved: daysAgo(30) }), // 10 days
      application("hired", { created: daysAgo(50), moved: daysAgo(30) }), // 20 days
      application("hired", { created: daysAgo(400), moved: daysAgo(30) }), // 370 days
    ],
    now,
  );
  assert.equal(hires.medianDaysToHire, 20, "the middle hire, not the mean of 133");
  assert.equal(hires.hiresMeasured, 3, "how many hires the figure rests on is shown, so 1 never reads as a rule");

  // An even count takes the midpoint of the two middle values, rounded to a whole day.
  assert.equal(
    computePipelineMetrics(
      [
        application("hired", { created: daysAgo(40), moved: daysAgo(30) }), // 10
        application("hired", { created: daysAgo(45), moved: daysAgo(30) }), // 15
      ],
      now,
    ).medianDaysToHire,
    13,
  );

  // Nothing hired yet is the production state today, and it must read as "no answer", never as 0 —
  // a zero here would say hiring is instant.
  const empty = computePipelineMetrics([], now);
  assert.equal(empty.medianDaysToHire, null);
  assert.equal(empty.hiresMeasured, 0);
  assert.equal(empty.stalled, 0);
  assert.equal(empty.offersSent, 0);
  assert.equal(empty.offersAccepted, 0);

  // A hired application is never also counted as stalled, however long it took.
  assert.equal(computePipelineMetrics([application("hired", { moved: daysAgo(400) })], now).stalled, 0);

  // ── Offers out, offers accepted ──────────────────────────────────────────────────────────────
  // Every stage that can only be reached after an offer left the building counts as sent, including
  // the ones where it came back badly — an offer that was declined was still an offer.
  for (const sent of ["offer_sent", "offer_negotiation", "offer_accepted", "offer_declined", "offer_expired", "pre_boarding", "hired"]) {
    assert.equal(computePipelineMetrics([application(sent)], now).offersSent, 1, `${sent} means an offer went out`);
  }
  // Everything before the send does not.
  for (const notYet of ["offer_initiated", "offer_draft", "offer_pending_approval", "offer_approved", "offer_generated"]) {
    assert.equal(
      computePipelineMetrics([application(notYet)], now).offersSent,
      0,
      `${notYet} is still preparing an offer — nothing has reached the candidate`,
    );
  }
  for (const accepted of ["offer_accepted", "pre_boarding", "hired"]) {
    assert.equal(computePipelineMetrics([application(accepted)], now).offersAccepted, 1);
  }
  for (const notAccepted of ["offer_sent", "offer_negotiation", "offer_declined", "offer_expired"]) {
    assert.equal(computePipelineMetrics([application(notAccepted)], now).offersAccepted, 0);
  }
  // Accepted can never exceed sent — the two sets have to stay nested, or the card reads "4 of 2".
  for (const stage of applicationStages) {
    const metrics = computePipelineMetrics([application(stage)], now);
    assert.ok(
      metrics.offersAccepted <= metrics.offersSent,
      `${stage} counts as accepted without counting as sent, which would print "1 of 0"`,
    );
  }

  // ── The arithmetic underneath ────────────────────────────────────────────────────────────────
  assert.equal(wholeDaysBetween("2026-08-01T00:00:00.000Z", "2026-08-21T00:00:00.000Z"), 20);
  assert.equal(wholeDaysBetween("2026-08-01T00:00:00.000Z", "2026-08-01T23:59:00.000Z"), 0, "part of a day is not a day");
  assert.equal(wholeDaysBetween(null, now), null);
  assert.equal(wholeDaysBetween("not a date", now), null);
  assert.equal(
    wholeDaysBetween("2026-08-21T00:00:00.000Z", "2026-08-01T00:00:00.000Z"),
    0,
    "a clock skew must read as zero, never as a negative wait",
  );
  assert.equal(daysInStage(application("cv_screening", { moved: daysAgo(7) }), now), 7);
}
