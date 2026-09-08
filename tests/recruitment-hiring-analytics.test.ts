import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";

import {
  buildChannelEffectiveness,
  buildFunnel,
  firstHumanDecisionAt,
  MIN_CHANNEL_CANDIDATES,
  offersMade,
} from "../src/lib/recruitment/hiring-analytics.ts";

/**
 * The number this module exists to stop being wrong.
 *
 * The ATS plan carried "WhatsApp 373 at 16% vs email 223 at 50%" and drew the obvious conclusion:
 * move recruitment spend to email. Re-derived from production 2026-09-05 with automated sweeps
 * excluded, it is 18.4% against 23.8% — a 5.4-point gap, not 34 — and a WhatsApp applicant hears
 * back roughly FOUR TIMES SOONER. The original counted one automated pass over 65 candidates as
 * 65 screening decisions.
 *
 * So these tests are mostly about what must NOT be counted, and about refusing to print a
 * percentage that a person would act on when the denominator cannot carry one.
 */
export function runRecruitmentHiringAnalyticsTests() {
  const t = (hours: number) => new Date(Date.UTC(2026, 0, 1, hours)).toISOString();

  // ── a batch sweep is not a decision ──────────────────────────────────────────────────────────
  {
    const decided = firstHumanDecisionAt([
      { candidateId: "a", createdAt: t(1), toStatus: "rejected", actorHrId: "ops:non-egyptian-reject-20260828" },
      { candidateId: "b", createdAt: t(1), toStatus: "shortlisted", actorHrId: "B-10" },
    ]);
    assert.equal(decided.has("a"), false, "a candidate moved only by a batch has not been decided by anyone");
    assert.equal(decided.get("b"), t(1), "a candidate moved by a person has");
  }

  // ── arriving at `new`, and being undone back to it, are both non-decisions ───────────────────
  {
    const decided = firstHumanDecisionAt([
      { candidateId: "a", createdAt: t(1), toStatus: "new", actorHrId: "B-10" },
      { candidateId: "b", createdAt: t(1), toStatus: "shortlisted", actorHrId: "B-10" },
      { candidateId: "b", createdAt: t(2), toStatus: "new", actorHrId: "B-10" },
    ]);
    assert.equal(decided.has("a"), false, "arriving at `new` is where a candidate starts, not a decision");
    assert.equal(
      decided.get("b"),
      t(1),
      "an undo back to `new` must not become a second decision - one press and its own undo would "
        + "otherwise read as two candidates screened",
    );
  }

  // ── the FIRST decision wins, in BOTH arrival orders ──────────────────────────────────────────
  //
  // Both orders, because one of them is not a test. A "keep the last write" bug returns the right
  // answer when the events happen to arrive newest-first, so asserting only that order passes a
  // broken implementation - which is exactly what the first version of this test did.
  {
    const newestFirst = firstHumanDecisionAt([
      { candidateId: "a", createdAt: t(5), toStatus: "rejected", actorHrId: "B-10" },
      { candidateId: "a", createdAt: t(2), toStatus: "shortlisted", actorHrId: "B-10" },
    ]);
    assert.equal(newestFirst.get("a"), t(2), "time-to-decision must measure the first answer, not the last");

    const oldestFirst = firstHumanDecisionAt([
      { candidateId: "a", createdAt: t(2), toStatus: "shortlisted", actorHrId: "B-10" },
      { candidateId: "a", createdAt: t(5), toStatus: "rejected", actorHrId: "B-10" },
    ]);
    assert.equal(
      oldestFirst.get("a"),
      t(2),
      "and still the first answer when the events arrive oldest-first - this is the order a "
        + "last-write-wins bug gets wrong",
    );
  }

  // ── a rate is refused when the denominator cannot carry one ──────────────────────────────────
  {
    const small = buildChannelEffectiveness(
      [
        { id: "a", source: "referral", createdAt: t(0) },
        { id: "b", source: "referral", createdAt: t(0) },
        { id: "c", source: "referral", createdAt: t(0) },
      ],
      [{ candidateId: "a", createdAt: t(1), toStatus: "shortlisted", actorHrId: "B-10" }],
    );
    assert.equal(small[0].candidates, 3);
    assert.equal(small[0].decidedByAPerson, 1);
    assert.equal(
      small[0].decidedRate,
      null,
      "1 of 3 must not be printed as 33% - a rate on a tiny denominator is noise wearing a "
        + "percentage sign, and it reads as a finding",
    );
    assert.ok(small[0].medianHoursToFirstDecision !== null, "the timings are still reported; only the rate is withheld");
  }

  // ── and given a real denominator, the rate is computed ───────────────────────────────────────
  {
    const candidates = Array.from({ length: MIN_CHANNEL_CANDIDATES }, (_, index) => ({
      id: `c${index}`,
      source: "whatsapp",
      createdAt: t(0),
    }));
    const events = candidates.slice(0, 5).map((candidate) => ({
      candidateId: candidate.id,
      createdAt: t(4),
      toStatus: "shortlisted",
      actorHrId: "B-10",
    }));
    const [channel] = buildChannelEffectiveness(candidates, events);
    assert.equal(channel.decidedRate, 5 / MIN_CHANNEL_CANDIDATES, "at the threshold the rate is reported");
    assert.equal(channel.medianHoursToFirstDecision, 4);
  }

  // ── median and mean are BOTH reported, because they disagree and both matter ─────────────────
  {
    // Four fast answers and one that took a month: the mean says six days, the median says four
    // hours. A person waiting for an answer experiences the median.
    const candidates = Array.from({ length: MIN_CHANNEL_CANDIDATES }, (_, index) => ({
      id: `c${index}`,
      source: "email",
      createdAt: t(0),
    }));
    const events = [
      ...[0, 1, 2, 3].map((index) => ({
        candidateId: `c${index}`,
        createdAt: t(4),
        toStatus: "shortlisted",
        actorHrId: "B-10",
      })),
      { candidateId: "c4", createdAt: t(720), toStatus: "shortlisted", actorHrId: "B-10" },
    ];
    const [channel] = buildChannelEffectiveness(candidates, events);
    assert.equal(channel.medianHoursToFirstDecision, 4, "the median is unmoved by the one slow answer");
    assert.ok(
      (channel.meanHoursToFirstDecision ?? 0) > 140,
      "the mean is dragged by it - reporting only one of the two would hide either the typical "
        + "experience or the backlog",
    );
  }

  // ── channel names normalise, so one channel is not reported as three ─────────────────────────
  {
    const rows = buildChannelEffectiveness(
      [
        { id: "a", source: "WhatsApp", createdAt: t(0) },
        { id: "b", source: " whatsapp ", createdAt: t(0) },
        { id: "c", source: null, createdAt: t(0) },
      ],
      [],
    );
    assert.equal(rows.length, 2, "WhatsApp and whatsapp are one channel");
    assert.equal(rows[0].channel, "whatsapp");
    assert.equal(rows[0].candidates, 2);
    assert.equal(rows[1].channel, "(unrecorded)", "a missing source is named, never dropped from the total");
  }

  // ── an event before the candidate row is a data fault, not a fast answer ─────────────────────
  {
    const [channel] = buildChannelEffectiveness(
      Array.from({ length: MIN_CHANNEL_CANDIDATES }, (_, index) => ({
        id: `c${index}`,
        source: "email",
        createdAt: t(10),
      })),
      [{ candidateId: "c0", createdAt: t(2), toStatus: "shortlisted", actorHrId: "B-10" }],
    );
    assert.equal(channel.decidedByAPerson, 1, "the decision still counts - it did happen");
    assert.equal(
      channel.medianHoursToFirstDecision,
      null,
      "but a negative span must not enter the timing - it would pull the median toward a time that "
        + "never happened",
    );
  }

  // ── the funnel converts from the step ABOVE, not from the top ────────────────────────────────
  {
    const funnel = buildFunnel([
      { label: "Candidates", count: 745 },
      { label: "Applications", count: 14 },
      { label: "Interviews", count: 1 },
      { label: "Offers", count: 0 },
    ]);
    assert.equal(funnel[0].conversionFromPrevious, null, "the first step has nothing to convert from");
    assert.ok(Math.abs((funnel[1].conversionFromPrevious ?? 0) - 14 / 745) < 1e-9);
    assert.ok(
      Math.abs((funnel[2].conversionFromPrevious ?? 0) - 1 / 14) < 1e-9,
      "1 of 14 says the interview step is where the pipeline stops; 1 of 745 only says everything "
        + "is small",
    );
    assert.equal(funnel[3].conversionFromPrevious, 0, "a real zero is a zero, not a null");
  }

  // ── a zero denominator mid-funnel must not divide ────────────────────────────────────────────
  {
    const funnel = buildFunnel([
      { label: "Offers", count: 0 },
      { label: "Hires", count: 0 },
    ]);
    assert.equal(
      funnel[1].conversionFromPrevious,
      null,
      "0 of 0 is unknown, not 0% and certainly not NaN on a screen",
    );
  }

  // ── The Offers step counted the empty table ───────────────────────────────────────────────────
  //
  // Measured on production 2026-09-08: `ats_offers` held 0 rows and had never held one, while
  // `offers` held 3 — two sent that day. The funnel read its Offers step from `ats_offers` alone,
  // so it showed ZERO while three real letters were out with real people. Zero is the worst wrong
  // answer available, because it is also exactly what "no offers yet" looks like: nothing alerts on
  // it and nothing contradicts it.
  {
    assert.equal(offersMade(0, 3), 3, "three letters and no governed offer is three offers, not zero");
    assert.equal(offersMade(2, 0), 2, "the governed chain alone still counts");
    assert.equal(offersMade(2, 3), 5, "both doors count — there is no key to deduplicate them on");
    assert.equal(offersMade(0, 0), 0, "genuinely none is still none");
    // A `head: true` count comes back null when the row is absent, and `null + 3` is 3, not NaN.
    assert.equal(offersMade(null, 3), 3, "a null count must not poison the sum");
    assert.equal(offersMade(undefined, undefined), 0, "two missing counts are zero, never NaN");
  }

  // And the reader itself must ask BOTH tables. The pure function above cannot see which tables the
  // query list names, and querying one of them is the whole original defect.
  {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "lib", "recruitment", "hiring-analytics.ts"),
      "utf8",
    );
    for (const table of ['from("ats_offers")', 'from("offers")']) {
      assert.ok(
        source.includes(table),
        `the funnel must count ${table} — reading only one of the two offer tables is the defect this fixes`,
      );
    }
    assert.ok(
      source.includes("offersMade("),
      "the Offers step must go through offersMade, so the rule stays testable",
    );
  }
}
