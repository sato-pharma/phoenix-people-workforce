import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BEHAVIOUR_MIN_VISITS,
  BURST_VISITS,
  BURST_WINDOW_SECONDS,
  CADENCE_MIN_DAYS,
  FLAT_COVERAGE_SHARE,
  IDENTICAL_DURATION_SHARE,
  NEVER_NEGATIVE_MIN_ANSWERED,
  PHOENIX_CRM_STRONG_BEHAVIOUR_FLAGS,
  SHORT_DAY_MIN_DAYS,
  judgeBehaviour,
  monthBounds,
  monthsToRecompute,
  type BehaviourInput,
  type BehaviourVisit,
} from "../src/lib/phoenix-crm/behaviour-integrity.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the behaviour check (D4 of the owner's plan, and the last point in it).
 *
 * The position checks judge one fix; the photo sweep judges one picture. Both can be satisfied by a
 * rep who walks to one real place and enters twelve real-looking visits from the pavement outside.
 * What gives that away is the SHAPE OF A MONTH.
 *
 * ## 🔴 HALF OF EVERY FIXTURE BELOW IS DELIBERATELY INNOCENT
 *
 * That is the owner's own instruction for this phase, and it is the whole risk of the feature. There
 * are about a hundred and forty real people on the other side of this file, and a false positive
 * accuses one of them of fraud. So every rule is tested twice: once on work that should fire, and
 * once on the honest work that looks most like it —
 *
 *   * four visits in an hour inside one hospital building (the commonest good day in the field),
 *   * a rep who genuinely finishes at the same second twice,
 *   * durations one second apart,
 *   * a month whose distributor files never landed,
 *   * a rep who never filled the outcome field in at all,
 *   * a month of nine visits, because he was on leave.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

/** `n` visits on one day, `gapSeconds` apart, starting at 09:00 Cairo. */
function day(date: string, count: number, gapSeconds: number, patch: Partial<BehaviourVisit> = {}, jitter: number[] = []): BehaviourVisit[] {
  const start = Date.parse(`${date}T06:00:00Z`);
  const out: BehaviourVisit[] = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    out.push({
      visitId: `${date}-${index}`,
      capturedAt: new Date(start + offset * 1000),
      visitDate: date,
      customerId: `CUST-${date}-${index}`,
      formOpenSeconds: 200 + index,
      objection: null,
      ...patch,
    });
    offset += gapSeconds + (jitter[index % Math.max(1, jitter.length)] ?? 0);
  }
  return out;
}

function input(patch: Partial<BehaviourInput> = {}): BehaviourInput {
  return {
    repHrId: "B-200",
    month: "2026-09",
    seatId: "FAISAL",
    // A perfectly ordinary month: three days of six visits, twenty minutes apart with real jitter.
    visits: [
      ...day("2026-09-07", 6, 1_200, {}, [0, 340, -190, 520, -260, 80]),
      ...day("2026-09-09", 6, 1_150, {}, [90, -220, 410, -130, 300, 0]),
      ...day("2026-09-14", 6, 1_320, {}, [-180, 250, 60, -300, 470, 110]),
    ],
    coverage: { customers: 60, visited: 18 },
    sales: { areaSawSales: true, lineSawSales: true },
    ...patch,
  };
}

export function runPhoenixCrmBehaviourIntegrityTests(): void {
  // ── 1. An ordinary month is clean, and a thin one is NOT CHECKED ───────────────────────────────
  {
    const ordinary = judgeBehaviour(input());
    assert.deepEqual(ordinary.flags, [], "🔴 three ordinary field days must produce nothing at all");
    assert.equal(ordinary.measured, true);

    // 🔴 A month of leave is not a month of nothing. Storing it as clean would put a rep who was
    // away beside a rep who stayed home, and only one of those is a question.
    const thin = judgeBehaviour(input({ visits: day("2026-09-07", BEHAVIOUR_MIN_VISITS - 1, 1_500, {}, [0, 300, -200]) }));
    assert.equal(thin.measured, false, `under ${BEHAVIOUR_MIN_VISITS} visits a month carries no claim`);
    assert.deepEqual(thin.flags, [], "and it is never flagged on the way past");
    assert.equal(thin.signals.tooFewVisits, BEHAVIOUR_MIN_VISITS - 1, "the board is told WHY it was not judged");
  }

  // ── 2. Identical durations — and the rep who really did finish twice at the same second ────────
  {
    // Twelve of eighteen on one exact value is two thirds, just under the share. Thirteen is over.
    const same = (howMany: number): BehaviourVisit[] =>
      input()
        .visits.map((visit, index) => ({ ...visit, formOpenSeconds: index < howMany ? 214 : 190 + index }));

    const innocent = judgeBehaviour(input({ visits: same(6) }));
    assert.deepEqual(innocent.flags, [], "🔴 six visits at the same second out of eighteen is a rep with a rhythm, not a script");

    const guilty = judgeBehaviour(input({ visits: same(16) }));
    assert.deepEqual(guilty.flags, ["identical_durations"], `sixteen of eighteen is past ${IDENTICAL_DURATION_SHARE}`);
    assert.equal(guilty.signals.durationMode, 214, "and the board is told which value it was");
    assert.equal(guilty.strong, true, "an exact duration repeated in seven visits of ten is not something a person does");

    // Durations ONE SECOND apart are two ordinary visits, and the mode share is tiny.
    const varying = judgeBehaviour(input({ visits: input().visits.map((visit, index) => ({ ...visit, formOpenSeconds: 200 + index })) }));
    assert.deepEqual(varying.flags, [], "🔴 durations a second apart are not identical durations");
  }

  // ── 3. The metronome, and the rep whose day merely went well ───────────────────────────────────
  {
    // Six visits a day, exactly 1,200 seconds apart, on three days: no traffic, no waiting room.
    const metronome = judgeBehaviour(
      input({ visits: [...day("2026-09-07", 6, 1_200), ...day("2026-09-09", 6, 1_200), ...day("2026-09-14", 6, 1_200)] }),
    );
    assert.ok(metronome.flags.includes("constant_cadence"), `${CADENCE_MIN_DAYS} metronomic days in a month is not how a field day behaves`);
    assert.equal(metronome.strong, true);

    // Two such days is luck, not a pattern — the third is what makes it one.
    const twice = judgeBehaviour(
      input({ visits: [...day("2026-09-07", 6, 1_200), ...day("2026-09-09", 6, 1_200), ...day("2026-09-14", 6, 1_320, {}, [-180, 250, 60, -300, 470, 110])] }),
    );
    assert.equal(twice.flags.includes("constant_cadence"), false, "🔴 two tidy days in a month is luck");

    // Gaps a couple of minutes apart are an ordinary good morning, not a metronome.
    const nearlyTidy = judgeBehaviour(
      input({
        visits: [
          ...day("2026-09-07", 6, 1_200, {}, [0, 130, -140, 200, -90, 0]),
          ...day("2026-09-09", 6, 1_200, {}, [0, 130, -140, 200, -90, 0]),
          ...day("2026-09-14", 6, 1_200, {}, [0, 130, -140, 200, -90, 0]),
        ],
      }),
    );
    assert.equal(nearlyTidy.flags.includes("constant_cadence"), false, "🔴 gaps two minutes apart are a good morning, not a machine");
  }

  // ── 4. 🔴 THE BURST, and the hospital building that must never trip it ─────────────────────────
  {
    // The commonest good day in the field: four visits inside one hour, floor by floor.
    const hospital = judgeBehaviour(
      input({ visits: [...day("2026-09-07", 4, 900), ...day("2026-09-09", 7, 1_400, {}, [0, 300, -200, 150]), ...day("2026-09-14", 7, 1_500, {}, [0, -250, 400, 90])] }),
    );
    assert.equal(hospital.flags.includes("burst_visits"), false, "🔴 four visits in an hour in one hospital is the commonest good day in the field");

    // A date of its own: layered on top of a day the ordinary month already uses, two sets of
    // captures interleave and the window would be measured across both, which proves nothing.
    const burst = judgeBehaviour(input({ visits: [...day("2026-09-02", BURST_VISITS, 40), ...input().visits] }));
    assert.ok(burst.flags.includes("burst_visits"), `${BURST_VISITS} captures inside ${BURST_WINDOW_SECONDS} seconds is not a fast rep`);
    assert.equal(burst.strong, true);

    // One second outside the window is outside it.
    const justOutside = judgeBehaviour(
      input({ visits: [...day("2026-09-03", BURST_VISITS, Math.ceil(BURST_WINDOW_SECONDS / (BURST_VISITS - 1)) + 2), ...input().visits] }),
    );
    assert.equal(justOutside.flags.includes("burst_visits"), false, "the window is a window, not a direction");
  }

  // ── 5. The day that is always short ────────────────────────────────────────────────────────────
  {
    // Real jitter on the gaps, so this fixture tests the SHORT DAY and nothing else: perfectly even
    // gaps would also be a metronome, and the assertion below would then be passing on that instead.
    const shortDays = Array.from({ length: SHORT_DAY_MIN_DAYS }, (_unused, index) =>
      day(`2026-09-0${index + 1}`, 6, 300, {}, [0, 120, -90, 60, -30, 0]),
    );
    const always = judgeBehaviour(input({ visits: shortDays.flat() }));
    assert.deepEqual(always.flags, ["day_always_short"], `${SHORT_DAY_MIN_DAYS} whole field days inside 45 minutes is a pattern, and only that`);
    assert.equal(always.strong, false, "🔴 but only corroborating — a short day is also a day with two cancellations");

    // A day of THREE quick visits is not a short day: it is a light day, and light days are normal.
    const light = judgeBehaviour(input({ visits: [...Array.from({ length: 6 }, (_unused, index) => day(`2026-09-0${index + 1}`, 3, 300)).flat()] }));
    assert.equal(light.flags.includes("day_always_short"), false, "🔴 three visits close together is a light day, not a fake one");
  }

  // ── 6. 🔴 Covered with nothing sold — and the month whose files never landed ───────────────────
  {
    const covered = { customers: 50, visited: 45 };
    assert.ok(45 / 50 >= FLAT_COVERAGE_SHARE);

    const flat = judgeBehaviour(input({ coverage: covered, sales: { areaSawSales: false, lineSawSales: true } }));
    assert.ok(flat.flags.includes("flat_coverage_no_sales"), "a list covered on paper with nothing behind it is worth a look");
    assert.equal(flat.strong, false, "🔴 and only a look — a flat month is also a month the stock did not arrive");
    assert.equal(flat.signals.areaSawSales, false);

    // 🔴 THE OLDEST TRAP IN THIS REPOSITORY: not every distributor uploads every month. A month
    // whose files never landed reads as zero for everybody in it, and flagging a rep for that is
    // blaming him for a file.
    const noFiles = judgeBehaviour(input({ coverage: covered, sales: { areaSawSales: false, lineSawSales: false } }));
    assert.equal(noFiles.flags.includes("flat_coverage_no_sales"), false, "🔴 a month the line never uploaded says nothing about any rep in it");
    assert.equal(noFiles.signals.salesNotMeasurable, true, "and the board is told that, rather than shown a clean month");

    // Low coverage is not this flag's business — that is the exceptions board's job, in his own view.
    const behind = judgeBehaviour(input({ coverage: { customers: 50, visited: 10 }, sales: { areaSawSales: false, lineSawSales: true } }));
    assert.equal(behind.flags.includes("flat_coverage_no_sales"), false, "a rep who is simply behind is not a rep who is inventing visits");

    // Nothing known about sales at all.
    const unknown = judgeBehaviour(input({ coverage: covered, sales: null }));
    assert.equal(unknown.flags.includes("flat_coverage_no_sales"), false, "an unread closing is not evidence");
  }

  // ── 7. 🔴 Never a negative — counted only where the question was ANSWERED ──────────────────────
  {
    const many = (objection: string | null, count: number): BehaviourVisit[] =>
      Array.from({ length: count }, (_unused, index) => ({
        visitId: `V-${index}`,
        capturedAt: new Date(Date.parse(`2026-09-${String((index % 20) + 1).padStart(2, "0")}T06:00:00Z`) + index * 1_800_000),
        visitDate: `2026-09-${String((index % 20) + 1).padStart(2, "0")}`,
        customerId: `C-${index}`,
        formOpenSeconds: 180 + index,
        objection,
      }));

    const never = judgeBehaviour(input({ visits: many("none", NEVER_NEGATIVE_MIN_ANSWERED) }));
    assert.ok(never.flags.includes("never_a_negative"), `${NEVER_NEGATIVE_MIN_ANSWERED} answered outcomes and not one negative`);
    assert.equal(never.strong, false, "🔴 corroborating only — an easy territory really can be an easy territory");

    // 🔴 A rep on a build that never asked the question sends null every time. Reading that as "no
    // objection" would flag every rep who has not updated his app.
    const neverAsked = judgeBehaviour(input({ visits: many(null, NEVER_NEGATIVE_MIN_ANSWERED + 10) }));
    assert.equal(neverAsked.flags.includes("never_a_negative"), false, "🔴 a field he was never shown is not an answer he gave");
    assert.equal(neverAsked.signals.outcomesAnswered, undefined, "and nothing is counted from it");

    const oneNegative = judgeBehaviour(input({ visits: [...many("none", NEVER_NEGATIVE_MIN_ANSWERED), ...many("price", 1)] }));
    assert.equal(oneNegative.flags.includes("never_a_negative"), false, "one real objection is enough to be a person");
  }

  // ── 8. Which months a sweep recomputes ─────────────────────────────────────────────────────────
  {
    assert.deepEqual(monthsToRecompute("2026-09-27"), ["2026-09"], "after the seventh, only the month being written");
    assert.deepEqual(monthsToRecompute("2026-09-03"), ["2026-08", "2026-09"], "a month's last visits land on its last evening");
    assert.deepEqual(monthsToRecompute("2026-01-02"), ["2025-12", "2026-01"], "and January reaches back over the year");
    assert.deepEqual(monthsToRecompute("nonsense"), []);

    assert.deepEqual(monthBounds("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
    assert.deepEqual(monthBounds("2028-02"), { from: "2028-02-01", to: "2028-02-29" }, "a leap February is 29 days");
    assert.deepEqual(monthBounds("2026-09"), { from: "2026-09-01", to: "2026-09-30" });
    assert.equal(monthBounds("2026-13"), null);
  }

  // ── 9. The strong three, the raw table, and the mask that must NOT be applied ──────────────────
  {
    assert.deepEqual(
      [...PHOENIX_CRM_STRONG_BEHAVIOUR_FLAGS].sort(),
      ["burst_visits", "constant_cadence", "identical_durations"],
      "🔴 only what a person cannot do stands on its own; a short day, a flat month and an easy territory never do",
    );

    const service = source("src/lib/phoenix-crm/server/behaviour.ts");
    assert.ok(
      service.includes('.from("phoenix_crm_visits")'),
      "🔴 the RAW table — an off-plan visit waiting for approval is the one you most want judged, and the countable view hides it",
    );
    assert.equal(service.includes("phoenix_crm_countable_visits"), false, "so the countable view is deliberately absent here");
    assert.equal(
      service.includes("withoutMaskedSourceRows"),
      false,
      "🔴 the El Qema mask must NOT be applied — it removes real money from a total and would manufacture 'the area sold nothing' for every territory that distributor serves",
    );
    assert.ok(service.includes("areaSawSales"), "and what is stored is a boolean, never an amount, so no masked money reaches the signals");
    // 🔴 Anchored BETWEEN the judging and the insert, not merely "a delete exists somewhere in the
    // file": this service deletes the month twice — once on the empty-month early return, once here
    // — so a bare presence check passes with the recompute's own clear removed. It did.
    const recompute = service.slice(service.indexOf("const verdicts ="), service.indexOf(".insert("));
    assert.ok(
      /\.from\("phoenix_crm_behaviour_integrity"\)\s*\.delete\(\)\s*\.eq\("month", month\)/.test(recompute),
      "a month is RECOMPUTED WHOLE — the old rows go immediately before the new ones, or a verdict that no longer holds lingers for ever",
    );

    // The sweep tells nobody, in either direction.
    for (const word of ["notify", "sendNotification", "telegram", "sendEmail"]) {
      assert.equal(service.toLowerCase().includes(word.toLowerCase()), false, `the behaviour pass must not ${word} anybody`);
    }

    const sweep = source("src/lib/phoenix-crm/server/photo-dupes.ts");
    assert.ok(sweep.includes("runPhoenixCrmBehaviourSweep"), "it rides the same nightly cron as the photo pass");
    assert.ok(
      sweep.indexOf("runPhoenixCrmPhotoSweep({ limit: options.limit })") < sweep.indexOf("runPhoenixCrmBehaviourSweep("),
      "🔴 photos FIRST — the behaviour pass is recomputed whole, so it must run after anything that adds evidence about the same month",
    );

    const board = source("src/lib/phoenix-crm/server/integrity-board.ts");
    assert.ok(board.includes("phoenix_crm_behaviour_integrity"), "the board reads it");
    assert.ok(board.includes("canReadIntegrityBoard"), "behind the same audience as everything else here");
    assert.ok(board.includes("behaviourNotChecked"), "and counts the months it could NOT judge, which is not the same as clean");

    const page = source("app/(admin)/admin/phoenix-crm/integrity/page.tsx");
    assert.ok(page.includes("Months that do not look like months"), "the Super Admin's page prints them");
    assert.ok(page.includes("table-fixed"), "as a fixed table with a colgroup, never a min-width in a scroller");
  }

  // ── 10. 🔒 The board KEEPS its name (owner decision, 2026-09-27) ───────────────────────────────
  //
  // It began as GPS evidence and now carries three kinds of case: the position, the photo sweep and
  // this behaviour pass. The name says one of the three, which is why it was put to the owner once
  // it had stopped describing the board — and he answered "keep the name Location integrity".
  // Settled, not deferred. This pins it so a later session's tidy-up rename goes red in CI instead
  // of quietly changing a screen he chose the wording of.
  {
    const nav = source("src/config/system-navigation.ts");
    assert.ok(
      nav.includes('label: "Location Integrity"'),
      "🔒 the sidebar keeps the wording the owner chose — do not rename it, widen the description instead",
    );

    const page = source("app/(admin)/admin/phoenix-crm/integrity/page.tsx");
    assert.ok(page.includes('title="Location integrity"'), "🔒 and so does the page it opens");

    // The descriptions are what may grow, and they must name all three or the name misleads alone.
    const navCard = nav.slice(nav.indexOf('label: "Location Integrity"'), nav.indexOf('label: "Location Integrity"') + 600);
    for (const word of ["position", "photograph", "month"]) {
      assert.ok(navCard.includes(word), `the sidebar description names the ${word} — the name cannot, so the description must`);
    }
  }

  console.log("phoenix-crm behaviour integrity: OK");
}
