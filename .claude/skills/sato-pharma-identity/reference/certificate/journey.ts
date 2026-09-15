/**
 * Four weeks, told back as a story.
 *
 * Everything an intern did is already in the portal, spread across six screens
 * that each answer one question: how many visits, how many points, which
 * papers, what the coordinator adjusted. None of them answers the question
 * somebody asks on the last day, which is "what did I actually do here". This
 * file is that answer — the same rows, ordered by the day they happened on and
 * given a sentence each.
 *
 * NOTHING HERE COMPUTES A POINT. Every figure arrives already decided by SQL —
 * the ledger for the money, v_intern_score for the totals, home_board for the
 * rank — exactly as CLAUDE.md requires. What this file adds is sequence and
 * words. If a number on the journey disagrees with the same number on
 * /points, the bug is here and not in the scoring.
 *
 * THE SENTENCES ARE GENERATED, NOT WRITTEN. Every one of them is assembled
 * from counts this file was handed, so there is no line of copy that can be
 * true of one intern and false of another. That constraint is the whole
 * design: this is going on LinkedIn under a real person's name, next to Sato
 * Pharma's, and a generous adjective nobody earned would be the programme
 * lying on their behalf. Where there is nothing to say, it says that instead.
 */

import type { VisitType } from "./types.ts";
import { num, type PointLedgerEntry } from "./point-ledger.ts";
import { addDaysISO } from "./dates.ts";

/* -------------------------------------------------------------- the input -- */

/** A visit, stripped to what the story needs. */
export type JourneyVisit = {
  id: string;
  visit_date: string;
  visit_type: VisitType;
  mode?: string | null;
  contact_name: string;
  specialty?: string | null;
  area?: string | null;
  /** How many products were detailed on this call. */
  products?: number;
};

export type JourneySession = {
  id: string;
  session_date: string;
  title: string;
  minutes: number;
  points: number;
  /** The programme session this attendance row is for. */
  sessionId?: string;
};

/**
 * A session this intern was expected at, with its length. The loader decides
 * which sessions those are; attendance is measured against this list and
 * nothing else, so a meeting held for another line never lowers the share.
 */
export type JourneyExpectedSession = { id: string; duration: number };

export type JourneyQuiz = {
  id: string;
  title: string;
  /** The day it counts on, which is the day it closed. */
  date: string | null;
  score: number;
  outOf: number;
  points: number;
  closed: boolean;
};

export type JourneyOrder = {
  id: string;
  order_date: string;
  place_name: string | null;
  status: string;
};

export type JourneyWeekDef = {
  week_no: number;
  title: string;
  subtitle?: string | null;
  accent?: string | null;
  target_points?: number | null;
};

export type JourneySocial = {
  comments: number;
  reactions: number;
  points: number;
  place?: number | null;
  posts: number;
};

export type JourneyInput = {
  /** The last day of the story. Usually today. */
  today: string;
  programmeStart: string;
  weekCount: number;
  programmeName: string;
  profile: {
    fullName: string;
    submissionId: string;
    /** profiles.verification_id (112): what the QR codes carry. Never printed. */
    verificationId: string;
    line: string | null;
    area: string;
    mentor?: string | null;
  };
  weeks: JourneyWeekDef[];
  visits: JourneyVisit[];
  ledger: PointLedgerEntry[];
  sessions: JourneySession[];
  /**
   * The sessions attendance is measured against. Absent means nobody said, and
   * the share is then null rather than a figure over an unknown whole.
   */
  programmeSessions?: JourneyExpectedSession[];
  quizzes: JourneyQuiz[];
  orders: JourneyOrder[];
  /** The days this intern topped their line. */
  awardDates: string[];
  social: JourneySocial | null;
  totals: {
    points: number;
    target: number;
    /** Field plus social, which is what the programme is ranked on. */
    finalPoints: number;
  };
  standing: {
    place: number;
    of: number;
    linePlace: number;
    lineSize: number;
    scored: boolean;
  } | null;
};

/* ------------------------------------------------------------- the output -- */

export type JourneyAdjustment = { points: number; reason: string };

export type JourneyDay = {
  date: string;
  /** 1 on the programme's first day, whether or not anything happened on it. */
  dayNo: number;
  weekNo: number | null;
  weekday: string;
  visits: JourneyVisit[];
  byType: Partial<Record<VisitType, number>>;
  /** Distinct places or people called on. */
  contacts: string[];
  products: number;
  soloVisits: number;
  sessions: JourneySession[];
  quizzes: JourneyQuiz[];
  orders: JourneyOrder[];
  adjustments: JourneyAdjustment[];
  toppedLine: boolean;
  /** What this day added to the score, from the ledger and nowhere else. */
  points: number;
  /** Milestone labels first reached on this day. */
  firsts: string[];
  /** The one sentence this day gets. */
  headline: string;
  /** True when nothing at all is recorded against it. */
  quiet: boolean;
};

export type JourneyChapter = {
  weekNo: number;
  title: string;
  subtitle: string | null;
  accent: string;
  from: string;
  to: string;
  days: JourneyDay[];
  visits: number;
  points: number;
  daysActive: number;
  /** The dominant visit type of the week, or null when there were none. */
  focus: VisitType | null;
  narrative: string;
};

export type JourneyMilestone = {
  label: string;
  date: string | null;
  detail: string;
};

export type JourneyTotals = {
  days: number;
  daysActive: number;
  visits: number;
  byType: Partial<Record<VisitType, number>>;
  contacts: number;
  products: number;
  sessions: number;
  sessionMinutes: number;
  /** Whole per cent of the expected sessions' minutes attended, or null. */
  attendancePct: number | null;
  quizzes: number;
  quizMarks: string | null;
  orders: number;
  /** Orders a coordinator approved; a rejected order is not a sale. */
  approvedOrders: number;
  rejectedOrders: number;
  daysTopped: number;
  bestDay: { date: string; visits: number } | null;
  longestStreak: { days: number; from: string; to: string } | null;
  perActiveDay: string;
};

export type Journey = {
  identity: JourneyInput["profile"] & { programmeName: string };
  /**
   * The programme's days, and whether it has finished.
   *
   * `end` is the last day of the story: today while the programme is running,
   * its final day ever after. `closed` is what the document reads to know
   * which of those two it is holding.
   */
  span: { start: string; end: string; days: number; closed: boolean };
  totals: JourneyTotals;
  points: {
    field: number;
    social: number;
    final: number;
    target: number;
    byChannel: { label: string; points: number; detail: string }[];
  };
  standing: JourneyInput["standing"];
  social: JourneySocial | null;
  chapters: JourneyChapter[];
  days: JourneyDay[];
  milestones: JourneyMilestone[];
  /** The paragraph under the name on the cover. */
  opening: string;
  /** The line that closes the document. */
  closing: string;
  /**
   * The rank, kept out of the closing line on purpose.
   *
   * Both ranks, in the order the cover prints them, so an intern reading
   * "2nd of 18" here and "7th of 65" there never has to wonder which is true.
   * Null while nobody has scored.
   */
  closingRank: string | null;
  /** That the programme has finished, once it has. Null while it runs. */
  closingNote: string | null;
  /**
   * Which day this copy was built on, when that is not the day the figures are
   * from.
   *
   * The journey is generated on demand, so an adjustment, a late quiz closing
   * or an engagement recount changes a document somebody has already attached
   * to an application. Nothing can stop that without a stored artifact, and a
   * stored artifact needs a privileged client this app deliberately does not
   * have. What this line does instead is make two copies distinguishable: a
   * reader holding both can see which one is later, rather than finding two
   * files with the same name saying different things. Null while the programme
   * is still running, when "as at today" is all it could say.
   */
  issuedNote: string | null;
  /** Ready to paste into a LinkedIn post. */
  caption: string;
};

/* ------------------------------------------------------------- the words -- */

const ONES = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/**
 * Small numbers as words, larger ones as figures.
 *
 * The house rule of every style guide, and it matters more here than usual:
 * these sentences sit beside a grid of tabular figures, so a spelled number is
 * how a reader's eye tells the prose from the data.
 */
export function spell(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  const whole = Math.round(count);
  return whole <= 12 ? ONES[whole] : String(whole);
}

/** Sentence case for a spelled number that opens a sentence. */
function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The noun a visit type takes in a sentence, singular and plural. */
const TYPE_NOUN: Record<VisitType, [string, string]> = {
  pharmacy: ["pharmacy", "pharmacies"],
  hospital: ["hospital", "hospitals"],
  polyclinic: ["polyclinic", "polyclinics"],
  doctor: ["doctor", "doctors"],
  session: ["session", "sessions"],
  other: ["call", "calls"],
};

/** "the OTC line", or just "the line" when nobody set one. */
function lineName(line: string | null): string {
  return line ? `${line} line` : "line";
}

function noun(type: VisitType, count: number): string {
  const [one, many] = TYPE_NOUN[type] ?? TYPE_NOUN.other;
  return count === 1 ? one : many;
}

/** "three pharmacies", "one doctor". */
function countOf(type: VisitType, count: number): string {
  return `${spell(count)} ${noun(type, count)}`;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Weekday and date arithmetic on the ISO string alone.
 *
 * Deliberately not `toLocaleDateString`: everything in this app is Cairo time,
 * these strings are already Cairo dates, and handing one to a Date the server
 * then formats in UTC is how a Saturday becomes a Friday. See lib/dates.ts,
 * which makes the same argument at greater length.
 */
export function weekdayOf(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return WEEKDAYS[date.getUTCDay()] ?? "";
}

/** "24 August". */
export function dayMonth(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

/**
 * "24 Aug" — the timeline's date column and nothing else.
 *
 * The column is fixed and the spine beside it is fixed, so the binding string
 * is the longest month: "24 September" sets 56pt at 9pt bold and would run
 * into the rule, where "24 Sep" sets 30pt and clears it twice over.
 */
export function shortDayMonth(iso: string): string {
  const month = MONTHS[Number(iso.slice(5, 7)) - 1] ?? "";
  return `${Number(iso.slice(8, 10))} ${month.slice(0, 3)}`;
}

/** "24 August 2026". */
export function fullDate(iso: string): string {
  return `${dayMonth(iso)} ${iso.slice(0, 4)}`;
}

/**
 * "16 August to 9 September 2026", with the year said once when it can be.
 */
export function dateSpan(from: string, to: string): string {
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return sameYear
    ? `${dayMonth(from)} to ${fullDate(to)}`
    : `${fullDate(from)} to ${fullDate(to)}`;
}

/** Whole days between two ISO dates, inclusive of both. */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10)),
  );
  return Math.round((b - a) / 86_400_000) + 1;
}

/** "a, b and c" — the list separator this app uses everywhere. */
export function joinWords(parts: string[]): string {
  const list = parts.filter(Boolean);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** Points, with the two decimals sessions need and nothing else carries. */
export function tidyPoints(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

/* ---------------------------------------------------------- the assembly -- */

const ACCENTS = ["brand", "teal", "violet", "amber"];

/** Which programme week a date falls in, or null before the start. */
function weekOf(date: string, start: string, weekCount: number): number | null {
  const offset = daysBetween(start, date) - 1;
  if (offset < 0) return null;
  const week = Math.floor(offset / 7) + 1;
  return week > weekCount ? weekCount : week;
}

/**
 * The dominant visit type of a set of visits.
 *
 * Ties go to the rarer type, which sounds backwards and is not: a day of six
 * pharmacies and six doctors is worth describing as a doctor day, because
 * doctors are the harder call and the one an intern will want named.
 */
function dominant(byType: Partial<Record<VisitType, number>>): VisitType | null {
  const RARITY: VisitType[] = [
    "doctor",
    "hospital",
    "polyclinic",
    "pharmacy",
    "session",
    "other",
  ];
  let best: VisitType | null = null;
  let bestCount = 0;
  for (const type of RARITY) {
    const count = byType[type] ?? 0;
    if (count > bestCount) {
      best = type;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The one sentence a day gets.
 *
 * Ordered by what a person would lead with if they were telling you about
 * their day, which is not the same as what scored the most: topping the line
 * is the headline even on a day a quiz paid more, because it is the thing that
 * happened rather than the thing that was awarded.
 */
function headlineFor(
  day: Omit<JourneyDay, "headline" | "quiet">,
  line: string | null,
): string {
  const parts: string[] = [];
  const visits = day.visits.length;
  const type = dominant(day.byType);

  if (day.toppedLine) {
    parts.push(`Top of the ${lineName(line)} with ${countOf("other", visits)}`);
  } else if (day.firsts.includes("first-call")) {
    parts.push(
      `The record opens with ${countOf("other", visits)}`,
    );
  } else if (visits > 0) {
    const named = type ? (day.byType[type] ?? 0) : 0;
    if (type && named === visits) {
      parts.push(countOf(type, visits));
    } else if (type && named > 0) {
      /* The apposition rides on the lead fragment rather than joining the list
         below, because it describes the calls rather than adding to them:
         "Two calls, one of them a doctor" is a sentence, where "Two calls and
         one of them a doctor" is a miscount. The article is what stops it
         reading as a telegram. */
      parts.push(
        `${countOf("other", visits)}, ${spell(named)} of them ` +
          `${named === 1 ? `a ${noun(type, 1)}` : noun(type, named)}`,
      );
    } else {
      parts.push(countOf("other", visits));
    }
  }

  if (day.products > 0 && visits > 0) {
    parts.push(`${spell(day.products)} ${day.products === 1 ? "product detailed" : "products detailed"}`);
  }

  for (const session of day.sessions) {
    parts.push(
      visits > 0
        ? `${session.minutes} minutes of ${session.title}`
        : `${session.minutes} minutes in ${session.title}`,
    );
  }

  for (const quiz of day.quizzes) {
    parts.push(
      quiz.closed
        ? `${quiz.title} marked ${quiz.score} of ${quiz.outOf}`
        : `${quiz.title} handed in`,
    );
  }

  if (day.orders.length > 0) {
    parts.push(
      day.orders.length === 1
        ? "an order collected"
        : `${spell(day.orders.length)} orders collected`,
    );
  }

  if (parts.length === 0) {
    for (const adjustment of day.adjustments) {
      parts.push(adjustment.reason);
    }
  }

  if (parts.length === 0) return "Nothing logged.";

  /* joinWords rather than a plain comma join: the last fragment takes "and",
     which is the difference between a sentence and a list of things that
     happened to occur on the same day. Sentence case on the first fragment
     only — the rest are mid-sentence. */
  return `${cap(joinWords(parts))}.`;
}

/**
 * The week's paragraph.
 *
 * Two sentences at most, and the second one only when there is a second thing
 * to say. A chapter that pads to a fixed length is a chapter that invents.
 */
function narrativeFor(
  chapter: Omit<JourneyChapter, "narrative">,
  line: string | null,
): string {
  if (chapter.visits === 0 && chapter.points === 0) {
    return "Nothing was logged this week.";
  }

  const bits: string[] = [];
  if (chapter.visits > 0) {
    bits.push(
      `${cap(spell(chapter.visits))} ${chapter.visits === 1 ? "call" : "calls"} across ${spell(chapter.daysActive)} ${chapter.daysActive === 1 ? "day" : "days"}`,
    );
    if (chapter.focus) {
      const count = chapter.days.reduce(
        (total, day) => total + (day.byType[chapter.focus as VisitType] ?? 0),
        0,
      );
      /* "Mostly" only when it actually was. Forty of seventy-six is the
         commonest type and not most of them, and a week described as mostly
         pharmacies when it was half doctors is the kind of small untruth this
         whole file exists to avoid. */
      bits.push(
        count * 2 > chapter.visits
          ? `mostly ${noun(chapter.focus, count)}`
          : `${spell(count)} of them ${noun(chapter.focus, count)}`,
      );
    }
  }

  const sessions = chapter.days.reduce((n, d) => n + d.sessions.length, 0);
  if (sessions > 0) {
    bits.push(
      `${spell(sessions)} ${sessions === 1 ? "session" : "sessions"} attended`,
    );
  }

  const topped = chapter.days.filter((d) => d.toppedLine).length;
  if (topped > 0) {
    bits.push(
      `top of the ${lineName(line)} on ${spell(topped)} ${topped === 1 ? "day" : "days"}`,
    );
  }

  const first = bits.length > 0 ? `${joinWords(bits)}.` : "";
  const second =
    chapter.points > 0
      ? ` Worth ${tidyPoints(chapter.points)} ${chapter.points === 1 ? "point" : "points"}.`
      : "";
  return `${cap(first)}${second}`.trim();
}

/* ------------------------------------------------------------- the build -- */

/**
 * Build the whole journey.
 *
 * Pure: every figure comes in through `input` and nothing is read from a
 * clock, a database or a locale. That is what lets tests/journey.test.mts
 * assert the sentences without a Postgres anywhere near it.
 */
/**
 * The key cards both documents close on (owner, 13 Sep 2026): AM visits, PM
 * visits, the Pharmacy Campaign and the share of sessions attended, then
 * approved orders — but only for somebody who has one. One function, so the
 * certificate and the journey's last page cannot quote different figures.
 *
 * A zero call count prints as a zero, because "no AM calls" is a true thing to
 * say. Orders are the exception by ruling: a card reading "0 approved orders"
 * is left off rather than printed. Attendance with nothing to measure against
 * prints a dash, because 0% would say every session was missed.
 */
export function keyCards(journey: Journey): [string, string][] {
  const { byType, attendancePct, approvedOrders } = journey.totals;
  const cards: [string, string][] = [
    [String(byType.hospital ?? 0), "AM visits"],
    [String(byType.polyclinic ?? 0), "PM visits"],
    [String(byType.pharmacy ?? 0), "Pharmacy campaign"],
    [attendancePct === null ? "—" : `${attendancePct}%`, "Session attendance"],
  ];
  if (approvedOrders > 0) {
    cards.push([String(approvedOrders), approvedOrders === 1 ? "Approved order" : "Approved orders"]);
  }
  return cards;
}

/**
 * Every order, and what became of it, for the journey only (owner, 13 Sep
 * 2026) — "13 orders submitted: 5 approved, 8 rejected." The certificate never
 * carries it: a signed page lists what was achieved, not what was turned down.
 * Null with no orders at all, and a zero part is left out rather than printed.
 */
export function orderSummary(journey: Journey): string | null {
  const { orders, approvedOrders, rejectedOrders } = journey.totals;
  if (orders === 0) return null;
  const waiting = orders - approvedOrders - rejectedOrders;
  const parts = [
    approvedOrders > 0 ? `${approvedOrders} approved` : null,
    rejectedOrders > 0 ? `${rejectedOrders} rejected` : null,
    waiting > 0 ? `${waiting} awaiting review` : null,
  ].filter(Boolean);
  return `${orders} ${orders === 1 ? "order" : "orders"} submitted: ${parts.join(", ")}.`;
}

export function buildJourney(input: JourneyInput): Journey {
  const { profile, programmeStart, today, weekCount } = input;

  /* The story runs from the programme's first day to today, and not from the
     first row: a week with nothing in it is part of what happened, and a
     timeline that silently skips it reads as a shorter, busier internship
     than the one that took place.

     It stops on the programme's last day, though, and that clamp is not
     cosmetic. `today` is the real clock, so without it a document read in
     December describes a four-week internship as a seventeen-week one that
     went quiet in September: a hundred days of "Nothing logged.", fifteen more
     calendar rows, a date span nobody worked, and "Read on" printing the day
     the reader happened to open it. The end of the programme is a fact about
     the programme and not about when somebody looks. */
  const start = programmeStart;
  const programmeEnd = addDaysISO(start, Math.max(1, weekCount) * 7 - 1);
  const reached = today >= start ? today : start;
  const closed = reached > programmeEnd;
  const end = closed ? programmeEnd : reached;

  // ------------------------------------------------------------- the days --
  const byDate = new Map<string, JourneyDay>();
  const dayCount = daysBetween(start, end);
  for (let i = 0; i < dayCount; i++) {
    const date = addDaysISO(start, i);
    byDate.set(date, {
      date,
      dayNo: i + 1,
      weekNo: weekOf(date, start, weekCount),
      weekday: weekdayOf(date),
      visits: [],
      byType: {},
      contacts: [],
      products: 0,
      soloVisits: 0,
      sessions: [],
      quizzes: [],
      orders: [],
      adjustments: [],
      toppedLine: false,
      points: 0,
      firsts: [],
      headline: "",
      quiet: true,
    });
  }

  /* Anything dated outside the programme window still belongs to somebody's
     record, so it lands on the nearest end rather than being dropped. A visit
     logged the day before the official start is the commonest case. */
  const bucket = (date: string | null): JourneyDay | null => {
    if (!date) return null;
    if (byDate.has(date)) return byDate.get(date) ?? null;
    if (date < start) return byDate.get(start) ?? null;
    if (date > end) return byDate.get(end) ?? null;
    return null;
  };

  const contactsSeen = new Set<string>();
  const sortedVisits = [...input.visits].sort((a, b) =>
    a.visit_date < b.visit_date ? -1 : a.visit_date > b.visit_date ? 1 : 0,
  );
  for (const visit of sortedVisits) {
    const day = bucket(visit.visit_date);
    if (!day) continue;
    day.visits.push(visit);
    day.byType[visit.visit_type] = (day.byType[visit.visit_type] ?? 0) + 1;
    day.products += visit.products ?? 0;
    if (visit.mode === "solo") day.soloVisits += 1;
    const who = (visit.contact_name ?? "").trim();
    if (who && !day.contacts.includes(who)) day.contacts.push(who);
    if (who) contactsSeen.add(who.toLowerCase());
  }

  for (const session of input.sessions) {
    bucket(session.session_date)?.sessions.push(session);
  }
  for (const quiz of input.quizzes) {
    bucket(quiz.date)?.quizzes.push(quiz);
  }
  for (const order of input.orders) {
    bucket(order.order_date)?.orders.push(order);
  }
  for (const date of input.awardDates) {
    const day = bucket(date);
    if (day) day.toppedLine = true;
  }

  /* Points come off the ledger and only off the ledger, which is what keeps a
     day's figure here equal to the same day's figure on /points. The rounding
     row carries no date and is deliberately not placed on a day — it belongs
     to the whole programme, exactly as 088 has it. */
  for (const entry of input.ledger) {
    const day = bucket(entry.occurred_on);
    if (!day) continue;
    day.points += num(entry.points);
    if (entry.kind === "adjustment" && num(entry.points) !== 0) {
      day.adjustments.push({
        points: num(entry.points),
        reason: entry.detail || entry.title,
      });
    }
  }

  const days = [...byDate.values()].sort((a, b) =>
    a.date < b.date ? -1 : 1,
  );

  // -------------------------------------------------------- the milestones --
  const firstsClaimed = new Set<string>();
  const firstOf = (day: JourneyDay, key: string) => {
    if (firstsClaimed.has(key)) return;
    firstsClaimed.add(key);
    day.firsts.push(key);
  };

  let running = 0;
  let crossedHalf: string | null = null;
  const halfway = input.totals.target > 0 ? input.totals.target / 2 : 0;

  for (const day of days) {
    if (day.visits.length > 0) firstOf(day, "first-call");
    if ((day.byType.doctor ?? 0) > 0) firstOf(day, "first-doctor");
    if ((day.byType.pharmacy ?? 0) > 0) firstOf(day, "first-pharmacy");
    if ((day.byType.hospital ?? 0) > 0) firstOf(day, "first-hospital");
    if ((day.byType.polyclinic ?? 0) > 0) firstOf(day, "first-polyclinic");
    if (day.sessions.length > 0) firstOf(day, "first-session");
    if (day.quizzes.length > 0) firstOf(day, "first-quiz");
    if (day.orders.length > 0) firstOf(day, "first-order");
    if (day.toppedLine) firstOf(day, "first-top");

    running += day.points;
    if (!crossedHalf && halfway > 0 && running >= halfway) crossedHalf = day.date;

    day.quiet =
      day.visits.length === 0 &&
      day.sessions.length === 0 &&
      day.quizzes.length === 0 &&
      day.orders.length === 0 &&
      day.adjustments.length === 0 &&
      !day.toppedLine;
    day.headline = headlineFor(day, profile.line);
  }

  // ------------------------------------------------------------ the totals --
  const byType: Partial<Record<VisitType, number>> = {};
  for (const visit of input.visits) {
    byType[visit.visit_type] = (byType[visit.visit_type] ?? 0) + 1;
  }

  const activeDays = days.filter((d) => d.visits.length > 0);
  const bestDay = activeDays.reduce<{ date: string; visits: number } | null>(
    (best, day) =>
      !best || day.visits.length > best.visits
        ? { date: day.date, visits: day.visits.length }
        : best,
    null,
  );

  // The longest unbroken run of days with a call on them.
  let streak: JourneyTotals["longestStreak"] = null;
  let runFrom: string | null = null;
  let runLength = 0;
  for (const day of days) {
    if (day.visits.length > 0) {
      if (runLength === 0) runFrom = day.date;
      runLength += 1;
      if (!streak || runLength > streak.days) {
        streak = { days: runLength, from: runFrom as string, to: day.date };
      }
    } else {
      runLength = 0;
      runFrom = null;
    }
  }

  const sessionMinutes = input.sessions.reduce((n, s) => n + s.minutes, 0);
  /* Each session is clamped to its own length, as 088 prices it, so staying on
     after a call ended cannot make up for missing another one. A session the
     intern was not expected at counts neither for nor against. */
  const expected = new Map(
    (input.programmeSessions ?? []).map((s) => [s.id, s.duration] as const),
  );
  const expectedMinutes = [...expected.values()].reduce((n, d) => n + Math.max(0, d), 0);
  const attendedMinutes = input.sessions.reduce((n, s) => {
    const duration = s.sessionId ? expected.get(s.sessionId) : undefined;
    return duration === undefined ? n : n + Math.min(Math.max(0, s.minutes), Math.max(0, duration));
  }, 0);
  const attendancePct =
    expectedMinutes > 0 ? Math.round((attendedMinutes / expectedMinutes) * 100) : null;
  const closedQuizzes = input.quizzes.filter((q) => q.closed);
  const quizMarks =
    closedQuizzes.length > 0
      ? `${closedQuizzes.reduce((n, q) => n + q.score, 0)} of ${closedQuizzes.reduce((n, q) => n + q.outOf, 0)}`
      : null;

  const totals: JourneyTotals = {
    days: dayCount,
    daysActive: activeDays.length,
    visits: input.visits.length,
    byType,
    contacts: contactsSeen.size,
    products: input.visits.reduce((n, v) => n + (v.products ?? 0), 0),
    sessions: input.sessions.length,
    sessionMinutes,
    attendancePct,
    quizzes: input.quizzes.length,
    quizMarks,
    orders: input.orders.length,
    approvedOrders: input.orders.filter((o) => o.status === "approved").length,
    rejectedOrders: input.orders.filter((o) => o.status === "rejected").length,
    daysTopped: days.filter((d) => d.toppedLine).length,
    bestDay,
    longestStreak: streak,
    perActiveDay:
      activeDays.length > 0
        ? (input.visits.length / activeDays.length).toFixed(1)
        : "0",
  };

  // ---------------------------------------------------------- the chapters --
  const weekDefs =
    input.weeks.length > 0
      ? [...input.weeks].sort((a, b) => a.week_no - b.week_no)
      : Array.from({ length: weekCount }, (_, i) => ({
          week_no: i + 1,
          title: `Week ${i + 1}`,
          subtitle: null,
          accent: ACCENTS[i % ACCENTS.length],
        }));

  const chapters: JourneyChapter[] = weekDefs.map((week, index) => {
    const weekDays = days.filter((d) => d.weekNo === week.week_no);
    const chapterByType: Partial<Record<VisitType, number>> = {};
    for (const day of weekDays) {
      for (const [type, count] of Object.entries(day.byType)) {
        chapterByType[type as VisitType] =
          (chapterByType[type as VisitType] ?? 0) + (count ?? 0);
      }
    }
    const base: Omit<JourneyChapter, "narrative"> = {
      weekNo: week.week_no,
      title: week.title,
      subtitle: week.subtitle ?? null,
      accent: week.accent ?? ACCENTS[index % ACCENTS.length],
      from: weekDays[0]?.date ?? addDaysISO(start, index * 7),
      to: weekDays[weekDays.length - 1]?.date ?? addDaysISO(start, index * 7 + 6),
      days: weekDays,
      visits: weekDays.reduce((n, d) => n + d.visits.length, 0),
      points:
        Math.round(weekDays.reduce((n, d) => n + d.points, 0) * 100) / 100,
      daysActive: weekDays.filter((d) => d.visits.length > 0).length,
      focus: dominant(chapterByType),
    };
    return { ...base, narrative: narrativeFor(base, profile.line) };
  });

  // ------------------------------------------------------------ the points --
  const channelTotals = new Map<string, number>();
  for (const entry of input.ledger) {
    const kind = entry.kind === "session_rounding" ? "session" : entry.kind;
    channelTotals.set(kind, (channelTotals.get(kind) ?? 0) + num(entry.points));
  }
  const CHANNELS: { kind: string; label: string; detail: string }[] = [
    { kind: "visit", label: "Field calls", detail: `${input.visits.length} logged` },
    {
      kind: "session",
      label: "Sessions",
      detail: `${totals.sessions} attended, ${sessionMinutes} minutes`,
    },
    { kind: "quiz", label: "Quizzes", detail: totals.quizMarks ? `marked ${totals.quizMarks}` : "none closed yet" },
    {
      kind: "daily_award",
      label: "Top of the line",
      detail: `${totals.daysTopped} ${totals.daysTopped === 1 ? "day" : "days"}`,
    },
    {
      kind: "adjustment",
      label: "By hand",
      detail: "added or deducted by your coordinator",
    },
  ];

  const byChannel = CHANNELS.map((channel) => ({
    label: channel.label,
    points: Math.round((channelTotals.get(channel.kind) ?? 0) * 100) / 100,
    detail: channel.detail,
  })).filter((row) => row.points !== 0);

  if (input.social && input.social.points > 0) {
    byChannel.push({
      label: "LinkedIn",
      points: input.social.points,
      detail: `${input.social.comments + input.social.reactions} comments and reactions`,
    });
  }

  const milestones = buildMilestones(days, totals, crossedHalf, input);

  const journey: Journey = {
    identity: { ...profile, programmeName: input.programmeName },
    span: { start, end, days: dayCount, closed },
    totals,
    points: {
      field: input.totals.points,
      social: input.social?.points ?? 0,
      final: input.totals.finalPoints,
      target: input.totals.target,
      byChannel,
    },
    standing: input.standing,
    social: input.social,
    chapters,
    days,
    milestones,
    opening: "",
    closing: "",
    closingRank: null,
    closingNote: null,
    issuedNote: null,
    caption: "",
  };

  journey.opening = openingFor(journey);
  journey.closing = closingFor(journey);
  journey.closingRank = closingRankFor(journey);
  /* Nothing on the last page said the programme had ended, so the day list
     simply stopped and read as a truncated file rather than as a finish. */
  journey.closingNote = journey.span.closed
    ? `The programme ended on ${fullDate(journey.span.end)}.`
    : null;
  journey.issuedNote =
    journey.span.closed && today !== journey.span.end
      ? `This copy was issued on ${fullDate(today)}, from the record as it stood at the close of the programme.`
      : null;
  journey.caption = captionFor(journey);
  return journey;
}

/* --------------------------------------------------------- the milestones -- */

function buildMilestones(
  days: JourneyDay[],
  totals: JourneyTotals,
  crossedHalf: string | null,
  input: JourneyInput,
): JourneyMilestone[] {
  const out: JourneyMilestone[] = [];
  const dayWith = (key: string) => days.find((d) => d.firsts.includes(key));

  const firstCall = dayWith("first-call");
  if (firstCall) {
    out.push({
      label: "First call",
      date: firstCall.date,
      detail:
        firstCall.visits[0]?.contact_name ??
        `${firstCall.visits.length} logged on day ${firstCall.dayNo}`,
    });
  }

  const firstDoctor = dayWith("first-doctor");
  if (firstDoctor) {
    /* The first DOCTOR of that day, not the first call of it. Those are
       rarely the same visit, and naming a pharmacy here would put a wrong
       fact on a document somebody attaches to a job application. */
    const doctorName =
      firstDoctor.visits.find((v) => v.visit_type === "doctor")?.contact_name ??
      "the first of many";
    /* When the very first call of the programme WAS a doctor, these two
       milestones are the same event and print as the same name on the same
       date, one line under the other — which reads as a list padded out to
       look longer rather than as two things that happened. The rarer fact is
       the one kept: everybody has a first call, not everybody starts on a
       clinician. */
    const sameEvent =
      out[0]?.label === "First call" &&
      out[0]?.date === firstDoctor.date &&
      out[0]?.detail === doctorName;
    if (sameEvent) {
      out[0] = { ...out[0], label: "First call, a doctor" };
    } else {
      out.push({
        label: "First doctor",
        date: firstDoctor.date,
        detail: doctorName,
      });
    }
  }

  if (totals.bestDay) {
    out.push({
      label: "Busiest day",
      date: totals.bestDay.date,
      detail: `${totals.bestDay.visits} calls in one day`,
    });
  }

  if (totals.longestStreak && totals.longestStreak.days > 1) {
    out.push({
      label: "Longest run",
      date: totals.longestStreak.to,
      detail: `${totals.longestStreak.days} days out in a row`,
    });
  }

  const firstTop = dayWith("first-top");
  if (firstTop) {
    out.push({
      label: "Top of the line",
      date: firstTop.date,
      detail:
        totals.daysTopped > 1
          ? `first of ${totals.daysTopped} days`
          : `most calls on the ${input.profile.line ?? "line"} that day`,
    });
  }

  const closed = input.quizzes.filter((q) => q.closed);
  if (closed.length > 0) {
    const best = closed.reduce((a, b) =>
      b.score / Math.max(1, b.outOf) > a.score / Math.max(1, a.outOf) ? b : a,
    );
    out.push({
      label: "Best paper",
      date: best.date,
      detail: `${best.title} — ${best.score} of ${best.outOf}`,
    });
  }

  const firstOrder = dayWith("first-order");
  if (firstOrder) {
    out.push({
      label: "First order",
      date: firstOrder.date,
      detail: firstOrder.orders[0]?.place_name ?? "collected in the field",
    });
  }

  if (crossedHalf && input.totals.target > 0) {
    out.push({
      label: "Halfway to target",
      date: crossedHalf,
      detail: `${Math.round(input.totals.target / 2)} of ${input.totals.target} points`,
    });
  }

  /* In the order they HAPPENED, not the order this function thinks of them.
     They are built by kind — the firsts, then the bests, then the crossings —
     and printed as a column of dates, so unsorted they ran 16 Aug, 16 Aug,
     23 Aug, 20 Aug, 19 Aug, 8 Sep, 30 Aug, 5 Sep down the cover. A date column
     that walks backwards is the single clearest sign a page was assembled
     rather than written. Sorted on the ISO date, which sorts lexically, and
     stable in V8 — so two milestones on one day keep the order above, where
     the first call precedes what it was. */
  return out
    .map((milestone, index) => ({ milestone, index }))
    .sort(
      (a, b) =>
        (a.milestone.date ?? "").localeCompare(b.milestone.date ?? "") ||
        a.index - b.index,
    )
    .map((entry) => entry.milestone);
}

/* -------------------------------------------------------------- the prose -- */

function openingFor(journey: Journey): string {
  const { totals, identity, span } = journey;
  if (totals.visits === 0 && totals.sessions === 0) {
    return `${identity.fullName} joined ${identity.programmeName} on ${dayMonth(span.start)}. There is nothing logged against this record yet.`;
  }

  const bits: string[] = [];
  if (totals.visits > 0) {
    bits.push(
      `${totals.visits} field ${totals.visits === 1 ? "call" : "calls"}`,
    );
  }
  if (totals.contacts > 0) {
    bits.push(
      `${totals.contacts} ${totals.contacts === 1 ? "pharmacy or clinician" : "pharmacies and clinicians"}`,
    );
  }
  if (totals.sessions > 0) {
    bits.push(
      `${totals.sessions} training ${totals.sessions === 1 ? "session" : "sessions"}`,
    );
  }
  if (totals.products > 0) {
    bits.push(`${totals.products} products detailed`);
  }

  const where = identity.line
    ? `on the ${identity.line} line in ${identity.area}`
    : `in ${identity.area}`;

  return `${dateSpan(span.start, span.end)}, ${where}: ${joinWords(bits)}.`;
}

function closingFor(journey: Journey): string {
  const { points, totals } = journey;
  const score = `${tidyPoints(points.final)} ${points.final === 1 ? "point" : "points"}`;

  /* The work first, the score last, and the rank not at all.
     This line is set reversed out of black at 15pt — the loudest thing on the
     last page — and it used to open "Finished on 249.82 points, 2nd of 18",
     which means the intern who came sixtieth of sixty-five ended four weeks
     looking at their worst number in the biggest type in the document. The
     figures are identical; what changed is which of them the sentence leads
     with. The rank is still printed, at figure size, underneath. */
  const bits: string[] = [];
  if (totals.daysActive > 0) {
    bits.push(
      `${totals.daysActive} ${totals.daysActive === 1 ? "day" : "days"} in the field`,
    );
  }
  if (totals.visits > 0) {
    bits.push(`${totals.visits} ${totals.visits === 1 ? "call" : "calls"}`);
  }
  bits.push(score);
  return `${bits.join(". ")}.`;
}

/**
 * Both ranks, or neither.
 *
 * The cover prints the line rank and the programme rank; the closing printed
 * only the line one, so the same document said "2nd of 18" on the last page and
 * "7th of 65" on the first, and an intern comparing them has no way to know
 * which is the real one. They are both real and they are now both here, in the
 * cover's order. The `scored` test is the one every other surface applies:
 * while nobody has scored, my_standing() puts everybody first, and "1st of 65"
 * under a score of zero is a claim sixty-five people would each be making in
 * Sato Pharma's name.
 */
function closingRankFor(journey: Journey): string | null {
  const { standing, identity } = journey;
  if (!standing?.scored) return null;

  const parts: string[] = [];
  if (standing.linePlace > 0 && identity.line) {
    parts.push(
      `${ordinalWord(standing.linePlace)} of ${standing.lineSize} on the ${identity.line} line`,
    );
  }
  if (standing.place > 0) {
    parts.push(
      `${ordinalWord(standing.place)} of ${standing.of} across the programme`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** 1st, 2nd, 3rd. The same rule as lib/metrics.ts, kept local so this file stays pure. */
export function ordinalWord(place: number): string {
  const rest = place % 100;
  if (rest >= 11 && rest <= 13) return `${place}th`;
  return `${place}${["th", "st", "nd", "rd"][place % 10] ?? "th"}`;
}

/**
 * The LinkedIn post, written for them.
 *
 * It is theirs to edit before it goes out — the share sheet puts it in the
 * clipboard rather than posting it — but it has to be good enough to send
 * unedited, because most of them will. So: what they did, in their own
 * numbers, with the programme named once and no adjective that was not
 * earned by a figure on the same line.
 */
function captionFor(journey: Journey): string {
  const { totals, identity, span, standing, points } = journey;
  const lines: string[] = [];

  lines.push(
    `${identity.programmeName} — ${dateSpan(span.start, span.end)}.`,
  );
  lines.push("");

  if (totals.visits > 0) {
    const where = identity.line
      ? `${identity.line} line, ${identity.area}`
      : identity.area;
    lines.push(
      `Four weeks in the field with Sato Pharma on the ${where}. What that came to:`,
    );
    lines.push("");
    lines.push(
      `• ${totals.visits} field ${totals.visits === 1 ? "call" : "calls"} across ` +
        `${totals.daysActive} ${totals.daysActive === 1 ? "day" : "days"}`,
    );
    if (totals.contacts > 0) {
      lines.push(
        totals.contacts === 1
          ? "• 1 pharmacy or clinician met"
          : `• ${totals.contacts} pharmacies and clinicians met`,
      );
    }
    if (totals.products > 0) {
      lines.push(
        `• ${totals.products} ${totals.products === 1 ? "product" : "products"} detailed`,
      );
    }
    if (totals.sessions > 0) {
      lines.push(
        `• ${totals.sessions} training ${totals.sessions === 1 ? "session" : "sessions"}, ` +
          `${totals.sessionMinutes} minutes`,
      );
    }
    if (totals.quizMarks) {
      lines.push(`• Assessments marked ${totals.quizMarks}`);
    }
    if (totals.daysTopped > 0) {
      lines.push(
        `• Top of my line on ${totals.daysTopped} ${totals.daysTopped === 1 ? "day" : "days"}`,
      );
    }
    lines.push("");
  }

  if (standing?.scored && standing.linePlace > 0 && identity.line) {
    lines.push(
      `Finished on ${tidyPoints(points.final)} points — ${ordinalWord(standing.linePlace)} of ${standing.lineSize} on the ${identity.line} line.`,
    );
  } else if (points.final > 0) {
    lines.push(`Finished on ${tidyPoints(points.final)} points.`);
  }

  lines.push("");
  lines.push(
    "Thank you to the Sato Pharma team and to everyone who opened a door for me these four weeks.",
  );
  lines.push("");
  lines.push("#SatoPharma #FutureTalents2026 #Pharma #FieldSales #Internship");

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
