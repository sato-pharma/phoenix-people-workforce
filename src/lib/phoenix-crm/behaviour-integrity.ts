/**
 * Phoenix CRM — does this month of work look like work? Pure arithmetic, no I/O.
 *
 * WHY THIS EXISTS, AND WHY IT IS LAST. The position checks judge one fix. The photo sweep judges one
 * picture. Both answer "is this capture real", and both can be satisfied by a rep who walks to one
 * real place and enters twelve real-looking visits from the pavement outside. What gives that away is
 * not any single capture — it is the SHAPE OF A MONTH: durations that never vary, a metronome where
 * a human day is lumpy, a list covered on paper with nothing sold behind it, an outcome that is never
 * once a negative. Its inputs are the visit's own stopwatch (D3), the visit's objection (E3) and the
 * closing's sales (C2), which is why it could only be built after all three.
 *
 * THE REP IS NEVER TOLD (owner, 2026-09-25, Golden Rule #1). Nothing here refuses a save, changes a
 * message, or adds a field to a screen a rep can open. It runs nightly over what is already on file,
 * and its output goes to a table his app cannot reach.
 *
 * ## 🔴 A MONTH IS JUDGED, NOT A PERSON, AND A THIN MONTH IS NOT JUDGED AT ALL
 *
 * Every rule below is a statistical claim, and a statistical claim over nine visits is a guess with a
 * number attached. Under `BEHAVIOUR_MIN_VISITS` the verdict is `measured: false` — NOT CHECKED, which
 * is a different thing from clean and is stored as a different thing. A rep on leave for three weeks
 * must never appear beside a rep who spent the month on his sofa.
 *
 * ## 🔴 HALF OF WHAT LOOKS SUSPICIOUS IS HONEST, AND THE THRESHOLDS ARE WHERE THEY ARE FOR THAT
 *
 * Four visits in an hour is a rep working one hospital building, floor by floor — the commonest good
 * day in the field, and an early draft of `burst_visits` would have flagged it. A rep who finishes at
 * exactly 12:40 twice in a month has finished at 12:40 twice. Durations one second apart are two
 * ordinary visits, not a script. Every bound here is set beyond what honest work reaches, and where
 * that costs a catch, it costs a catch: a false positive accuses a real person of fraud, and there
 * are about a hundred and forty real people on the other side of this file.
 *
 * ## 🔴 THE SAVE TIME IS NOT THE DOOR TIME — owner, 2026-10-02
 *
 * Three of the rules below were written when a visit's `captured_at` was the moment the server issued
 * the DOOR PHOTO's upload slot, so a capture time was where the rep stood and when. Since the one-tap
 * visit (2026-09-29) there is no photo: the server stamps a visit when the rep SAVES it, and he may
 * log his day until 02:00. So "five visits inside five minutes", "a metronome" and "the whole day
 * inside an hour" now describe how he LOGS — his morning from the car, his day at night — and an
 * honest rep doing exactly what the owner allowed trips all three.
 *
 * The owner chose (2026-10-02, asked directly): keep computing them, never strong, and show them only
 * BESIDE a strong flag — exact repeated durations this month, or a strong position or photo case for
 * the same rep in the same month. Alone they are kept in `signals.heldBack` and reach no board.
 */

/** What a month of one rep's work can be marked with. */
export type PhoenixCrmBehaviourFlag =
  /** The visit form took the same number of seconds again and again. */
  | "identical_durations"
  /** Visits SAVED like a metronome, on several days. Shown only beside a strong flag. */
  | "constant_cadence"
  /** Five visits SAVED inside a few minutes. Shown only beside a strong flag. */
  | "burst_visits"
  /** Day after day, the whole day's visits SAVED inside an hour. Shown only beside a strong flag. */
  | "day_always_short"
  /** The list is covered and nothing at all sold behind it — in a month the line DID sell. */
  | "flat_coverage_no_sales"
  /** Dozens of answered outcomes and not one of them a negative. */
  | "never_a_negative";

/**
 * 🔴 ONE of the six stands on its own (owner, 2026-10-02 — it was three).
 *
 * Seven visits in ten taking one exact number of seconds on the form is something a person does not
 * do, and that is still true of the one-tap visit: the form is open while he chooses products and
 * writes or speaks the comment the save requires. `burst_visits` and `constant_cadence` stood here
 * too, until the save time stopped being the door time — see the header and
 * `PHOENIX_CRM_SAVE_TIME_BEHAVIOUR_FLAGS`. Never put either back here: a strong flag on a rep who
 * logged his morning from the car is an accusation for doing what he was allowed to do.
 */
export const PHOENIX_CRM_STRONG_BEHAVIOUR_FLAGS: readonly PhoenixCrmBehaviourFlag[] = ["identical_durations"];

/**
 * 🔴 The three rules that read the SAVE time, shown only BESIDE a strong flag (owner, 2026-10-02).
 *
 * Each is still worked out every night and its numbers are kept in `signals`, so nothing is lost. But
 * a month carries them in `flags` — the only thing the board prints — only when the same rep has a
 * strong flag that month: this month's own exact repeated durations, or a strong position or photo
 * case (`strongCaseThisMonth`). Alone, they are `signals.heldBack` and nobody sees them.
 *
 * The other two corroborating rules are NOT here and keep listing a month on their own, in amber: a
 * covered list with nothing sold and an outcome that is never once a negative do not read the clock.
 */
export const PHOENIX_CRM_SAVE_TIME_BEHAVIOUR_FLAGS: readonly PhoenixCrmBehaviourFlag[] = [
  "burst_visits",
  "constant_cadence",
  "day_always_short",
];

/**
 * Plain English for the board. The reader is a manager, not an engineer.
 *
 * 🔴 The three save-time labels say SAVED, because that is what they measure now. "More visits in a
 * few minutes than a person can enter" was true of a photo taken at each door; with one tap it is
 * false, and a board printing it beside a real case would make an honest habit read as a lie.
 */
export const PHOENIX_CRM_BEHAVIOUR_LABELS: Record<PhoenixCrmBehaviourFlag, string> = {
  identical_durations: "The visit form took exactly the same time, again and again",
  constant_cadence: "Visits saved at metronome-even intervals on several days",
  burst_visits: "Several visits saved within a few minutes",
  day_always_short: "Each day's visits all saved within an hour, day after day",
  flat_coverage_no_sales: "The list is covered and nothing sold behind it",
  never_a_negative: "Dozens of outcomes and not one of them a negative",
};

// ── Thresholds ──────────────────────────────────────────────────────────────────────────────────
// Every one is exported and pinned by tests/phoenix-crm-behaviour-integrity.test.ts. Loosen one only
// with the owner's word: each is the line between a catch and an accusation.

/** Below this, a month says nothing either way and is stored as NOT CHECKED. */
export const BEHAVIOUR_MIN_VISITS = 12;

/** A duration is only evidence in bulk: twelve measured visits, and seven in ten sharing one second. */
export const IDENTICAL_DURATION_MIN_MEASURED = 12;
export const IDENTICAL_DURATION_SHARE = 0.7;

/**
 * A metronome, and why it takes a whole day of them.
 *
 * Five gaps means six visits, and the spread between the shortest and the longest is under a minute
 * — a day where no doctor ran late, no traffic happened and no waiting room was full. One such day
 * is luck. Three in a month is not how a field day behaves.
 *
 * 🔴 …EXCEPT THAT IT IS NOW HOW A FIELD DAY IS ENTERED. The gaps are between SAVES, and a rep
 * working steadily through his list in the evening holds them even to the second. Corroborating
 * only since 2026-10-02 (`PHOENIX_CRM_SAVE_TIME_BEHAVIOUR_FLAGS`); the bound is unchanged.
 */
export const CADENCE_MIN_GAPS_A_DAY = 5;
export const CADENCE_SPREAD_SECONDS = 60;
export const CADENCE_MIN_DAYS = 3;

/**
 * The burst — written as what is PHYSICALLY impossible, and no longer that.
 *
 * It was set when each visit needed a photo taken at the door, a customer chosen and a form saved,
 * so five inside five minutes could not be five doors. Four in an hour in one hospital is the
 * commonest good day in the field and must never be touched, and that still holds.
 *
 * 🔴 WHAT CHANGED: with the one-tap visit the rep logs the visits, not the doors — "somebody
 * entering a morning from one chair" is now the owner's own permitted habit, allowed until 02:00.
 * So the bound stays exactly where it is and the flag is corroborating only, never strong
 * (owner, 2026-10-02; `PHOENIX_CRM_SAVE_TIME_BEHAVIOUR_FLAGS`). Raising it would not help: there is
 * no number of saves in five minutes that an honest rep cannot reach.
 */
export const BURST_VISITS = 5;
export const BURST_WINDOW_SECONDS = 300;

/**
 * A day of five or more visits whose first and last capture are under 45 minutes apart.
 *
 * 🔴 The same correction as the burst: with one tap this is a rep who entered his day in one
 * sitting. It was already corroborating, and since 2026-10-02 it is also held back unless a strong
 * flag stands beside it.
 */
export const SHORT_DAY_MIN_VISITS = 5;
export const SHORT_DAY_SPAN_SECONDS = 45 * 60;
export const SHORT_DAY_MIN_DAYS = 5;

/** Covered on paper: four in five of his own list seen at least once in the month. */
export const FLAT_COVERAGE_SHARE = 0.8;

/** He filled the outcome in thirty times and said "no objection" every single one. */
export const NEVER_NEGATIVE_MIN_ANSWERED = 30;

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────

export type BehaviourVisit = {
  visitId: string;
  /** The server's capture time, never anything the phone claimed. */
  capturedAt: Date;
  /** The Cairo day it files under. */
  visitDate: string;
  customerId: string;
  /** What the phone counted with the form open. Null where it sent nothing. */
  formOpenSeconds: number | null;
  /** Null when the outcome was never answered — which is "we do not know", not "no objection". */
  objection: string | null;
};

export type BehaviourSales = {
  /**
   * Did the closing book ANY sales this month in the areas this territory captured in?
   *
   * 🔴 A boolean, never an amount, and that is on purpose twice over. The flag needs no figure, and
   * carrying one would put a masked distributor's money into a signals blob that is not the closing.
   */
  areaSawSales: boolean;
  /**
   * Did the LINE sell anywhere at all this month?
   *
   * 🔴 The guard against the oldest trap in this repository: not every distributor uploads every
   * month. A month whose files never landed reads as zero sales for everybody in it, and flagging a
   * rep for that is blaming him for a file. False here means the month cannot be judged on sales.
   */
  lineSawSales: boolean;
};

export type BehaviourInput = {
  repHrId: string;
  /** `YYYY-MM`, Cairo. */
  month: string;
  seatId: string | null;
  visits: ReadonlyArray<BehaviourVisit>;
  /** His own carried-over list, or null when it could not be measured. */
  coverage: { customers: number; visited: number } | null;
  /** Null when the closing could not be read for this month at all. */
  sales: BehaviourSales | null;
  /**
   * Does this rep already have a STRONG position or photo case in this month?
   *
   * 🔴 The second half of the owner's 2026-10-02 ruling. A save-time rule is shown only beside a
   * strong flag, and a strong flag can come from either of the other two detectors — a spoofed
   * coordinate or a re-used photograph in the same month is exactly the company this pattern needs
   * before it means anything. False is "no such case", which is also what an unread detector gives:
   * the safe direction, because it holds the weak flag back rather than printing it alone.
   */
  strongCaseThisMonth?: boolean;
};

export type BehaviourVerdict = {
  repHrId: string;
  month: string;
  seatId: string | null;
  visits: number;
  /** False when the month is too thin to carry a claim. NOT CHECKED, never clean. */
  measured: boolean;
  flags: PhoenixCrmBehaviourFlag[];
  strong: boolean;
  signals: Record<string, unknown>;
};

// ── The rules ───────────────────────────────────────────────────────────────────────────────────

function byDay(visits: ReadonlyArray<BehaviourVisit>): Map<string, BehaviourVisit[]> {
  const days = new Map<string, BehaviourVisit[]>();
  for (const visit of visits) {
    const list = days.get(visit.visitDate) ?? [];
    list.push(visit);
    days.set(visit.visitDate, list);
  }
  for (const list of days.values()) list.sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime());
  return days;
}

/** Seconds between each consecutive pair of a day's captures. */
function gapsOf(day: ReadonlyArray<BehaviourVisit>): number[] {
  const gaps: number[] = [];
  for (let index = 1; index < day.length; index += 1) {
    gaps.push((day[index].capturedAt.getTime() - day[index - 1].capturedAt.getTime()) / 1000);
  }
  return gaps;
}

export function judgeBehaviour(input: BehaviourInput): BehaviourVerdict {
  const visits = [...input.visits].sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime());
  const base = { repHrId: input.repHrId, month: input.month, seatId: input.seatId, visits: visits.length };

  // 🔴 A thin month is NOT CHECKED. Storing it as clean would let three weeks of leave read as three
  // weeks of honest work, and the difference matters to the person reading the board.
  if (visits.length < BEHAVIOUR_MIN_VISITS) {
    return { ...base, measured: false, flags: [], strong: false, signals: { tooFewVisits: visits.length } };
  }

  const flags: PhoenixCrmBehaviourFlag[] = [];
  const signals: Record<string, unknown> = {};
  const days = byDay(visits);

  // ── Identical durations ───────────────────────────────────────────────────────────────────────
  {
    const measured = visits.map((visit) => visit.formOpenSeconds).filter((value): value is number => Number.isFinite(value as number));
    if (measured.length >= IDENTICAL_DURATION_MIN_MEASURED) {
      const counts = new Map<number, number>();
      for (const value of measured) counts.set(value, (counts.get(value) ?? 0) + 1);
      let mode = measured[0];
      let modeCount = 0;
      for (const [value, count] of counts) if (count > modeCount) [mode, modeCount] = [value, count];
      const share = modeCount / measured.length;
      signals.durationMeasured = measured.length;
      signals.durationModeShare = Math.round(share * 100) / 100;
      if (share >= IDENTICAL_DURATION_SHARE) {
        flags.push("identical_durations");
        signals.durationMode = mode;
      }
    }
  }

  // ── A metronome ───────────────────────────────────────────────────────────────────────────────
  {
    const metronomic: string[] = [];
    for (const [date, day] of days) {
      const gaps = gapsOf(day);
      if (gaps.length < CADENCE_MIN_GAPS_A_DAY) continue;
      if (Math.max(...gaps) - Math.min(...gaps) <= CADENCE_SPREAD_SECONDS) metronomic.push(date);
    }
    if (metronomic.length >= CADENCE_MIN_DAYS) {
      flags.push("constant_cadence");
      signals.metronomicDays = metronomic.sort();
    }
  }

  // ── The burst ─────────────────────────────────────────────────────────────────────────────────
  {
    // A sliding window over the whole month's captures in order: BURST_VISITS of them inside
    // BURST_WINDOW_SECONDS, wherever that window falls.
    let worst: { at: string; count: number } | null = null;
    for (let start = 0; start + BURST_VISITS - 1 < visits.length; start += 1) {
      const end = start + BURST_VISITS - 1;
      const span = (visits[end].capturedAt.getTime() - visits[start].capturedAt.getTime()) / 1000;
      if (span <= BURST_WINDOW_SECONDS) {
        worst = { at: visits[start].capturedAt.toISOString(), count: BURST_VISITS };
        break;
      }
    }
    if (worst) {
      flags.push("burst_visits");
      signals.burst = worst;
    }
  }

  // ── The day that is always short ──────────────────────────────────────────────────────────────
  {
    const short: string[] = [];
    for (const [date, day] of days) {
      if (day.length < SHORT_DAY_MIN_VISITS) continue;
      const span = (day[day.length - 1].capturedAt.getTime() - day[0].capturedAt.getTime()) / 1000;
      if (span <= SHORT_DAY_SPAN_SECONDS) short.push(date);
    }
    if (short.length >= SHORT_DAY_MIN_DAYS) {
      flags.push("day_always_short");
      signals.shortDays = short.sort();
    }
  }

  // ── Covered, and nothing sold ─────────────────────────────────────────────────────────────────
  {
    const coverage = input.coverage;
    const sales = input.sales;
    const share = coverage && coverage.customers > 0 ? coverage.visited / coverage.customers : null;
    if (share !== null) signals.coverageShare = Math.round(share * 100) / 100;
    if (sales !== null && !sales.lineSawSales) {
      // 🔴 The month's files never landed. Nothing about sales can be said about anybody in it.
      signals.salesNotMeasurable = true;
    } else if (share !== null && sales !== null && share >= FLAT_COVERAGE_SHARE && !sales.areaSawSales) {
      flags.push("flat_coverage_no_sales");
      signals.areaSawSales = false;
    }
  }

  // ── Never once a negative ─────────────────────────────────────────────────────────────────────
  {
    // 🔴 Only ANSWERED outcomes count. A null is a rep on a build that never asked, or a field he
    // skipped — reading it as "no objection" would flag every rep who has not updated his app.
    const answered = visits.filter((visit) => visit.objection !== null);
    if (answered.length >= NEVER_NEGATIVE_MIN_ANSWERED) {
      const negatives = answered.filter((visit) => visit.objection !== "none").length;
      signals.outcomesAnswered = answered.length;
      signals.negatives = negatives;
      if (negatives === 0) flags.push("never_a_negative");
    }
  }

  const ordered = [...flags].sort();
  const strong = ordered.some((flag) => PHOENIX_CRM_STRONG_BEHAVIOUR_FLAGS.includes(flag));

  /**
   * 🔴 THE SAVE-TIME RULES ARE HELD BACK UNLESS SOMETHING STRONG STANDS BESIDE THEM (owner, 2026-10-02).
   *
   * `strong` above is read BEFORE this filter, so a month with a real `identical_durations` keeps its
   * save-time flags and the board shows the whole picture. Without one — and with no strong position
   * or photo case for the rep that month — they are moved to `signals.heldBack`: computed, kept,
   * auditable, and shown to nobody. The board prints `flags`, so holding them there is what stops a
   * rep who logged his morning from the car appearing as a case at all.
   */
  const corroborationStands = strong || input.strongCaseThisMonth === true;
  const heldBack = corroborationStands ? [] : ordered.filter((flag) => PHOENIX_CRM_SAVE_TIME_BEHAVIOUR_FLAGS.includes(flag));
  if (heldBack.length > 0) signals.heldBack = heldBack;

  return {
    ...base,
    measured: true,
    flags: corroborationStands ? ordered : ordered.filter((flag) => !PHOENIX_CRM_SAVE_TIME_BEHAVIOUR_FLAGS.includes(flag)),
    strong,
    signals,
  };
}

/**
 * Which months a nightly sweep recomputes.
 *
 * This month always, because it is still being written. The month before as well, but only in its
 * first week: a month's last visits land on its last evening, and a sweep that stopped at midnight
 * would leave every month judged on a day that was not finished. After the seventh there is nothing
 * left to arrive, and recomputing it every night for a year would be work with no answer in it.
 */
export function monthsToRecompute(cairoToday: string): string[] {
  const [year, month, day] = cairoToday.split("-").map((part) => Number(part));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return [];
  const current = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  if (day > 7) return [current];
  const previousMonth = month === 1 ? 12 : month - 1;
  const previousYear = month === 1 ? year - 1 : year;
  return [`${String(previousYear).padStart(4, "0")}-${String(previousMonth).padStart(2, "0")}`, current];
}

/** The first and last Cairo day of a `YYYY-MM`, inclusive — the window a month's visits are read in. */
export function monthBounds(month: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [year, index] = month.split("-").map((part) => Number(part));
  if (index < 1 || index > 12) return null;
  const lastDay = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}
