import { isCallRateWorkingDay } from "@/lib/crm/call-rate";
import { cairoWallClock } from "@/lib/format/cairo-zone";
import { cairoBusinessDay, VISIT_DAY_CUTOFF_HOURS } from "@/lib/phoenix-crm/calendar";
import type { TeamVisitDay, TeamVisitDistrict, TeamVisitRep, TeamVisitTime, TeamVisitsReport } from "@/lib/phoenix-crm/server/team-visits";

/**
 * Visits — Yesterday and Today, read at a glance (owner, 9 Nov 2026: "eyeball every report in My Team's Reports,
 * premium polish big work, every single component", then "group reps by district manager").
 *
 * Pure: every figure here is folded from the report `loadTeamVisitsReport` already built, so the panels, the phone
 * cards and the Excel file all read one arithmetic and none of them can disagree with the rows under it.
 *
 * What this module adds, and what it never does:
 *
 *   - AM · PM · Pharmacies stay three figures apart everywhere (the golden rule). "Doctor visits" is AM + PM and
 *     nothing else; a pharmacy is never a doctor visit, and a visit waiting for validation is counted only as
 *     waiting.
 *   - The times are the moments the reps SAVED the visits (`captured_at`), in Cairo. A visit copied from the old
 *     CRM has no time and is counted apart as "no time recorded", never put in an hour.
 *   - A vacant seat is not a rep: it is listed by its territory, and never counted as a rep with no visits.
 *   - Nothing here reads a location, ranks a rep or accuses anyone. A rep with no visits saved is a fact to look
 *     at, worded as one.
 */

/** "No visits saved" — a seat with someone in it and nothing saved that day. */
export const TEAM_VISITS_NONE_SAVED = "No visits saved";

/** A copied old-CRM visit, which recorded no time. */
export const TEAM_VISITS_NO_TIME = "No time recorded";

/** The two days the report covers, in the order the screen reads them. */
export const TEAM_VISIT_DAYS = ["yesterday", "today"] as const;
export type TeamVisitDayKey = (typeof TEAM_VISIT_DAYS)[number];

/**
 * The hours of the field day, two at a time, measured on the VISIT day: it opens at 02:00 Cairo and closes at 02:00
 * the next morning (`VISIT_DAY_CUTOFF_HOURS`, owner, 2026-09-29), so a visit saved at 01:30 belongs to the evening
 * before, never to "the morning". Hours are written as visit-day hours: 2 to 26, where 24 and 25 are the small hours
 * after midnight. The first and the last block reach to the edges, so every saved time falls in exactly one block
 * and the blocks add up to the timed visits.
 */
export type TeamVisitHourBlock = { key: string; label: string; fromHour: number; toHour: number };

const DAY_OPENS = VISIT_DAY_CUTOFF_HOURS;
const DAY_CLOSES = 24 + VISIT_DAY_CUTOFF_HOURS;

export const TEAM_VISIT_HOUR_BLOCKS: readonly TeamVisitHourBlock[] = [
  { fromHour: DAY_OPENS, key: "before-10", label: "Before 10 AM", toHour: 10 },
  { fromHour: 10, key: "10-12", label: "10 AM – 12 PM", toHour: 12 },
  { fromHour: 12, key: "12-14", label: "12 PM – 2 PM", toHour: 14 },
  { fromHour: 14, key: "14-16", label: "2 PM – 4 PM", toHour: 16 },
  { fromHour: 16, key: "16-18", label: "4 PM – 6 PM", toHour: 18 },
  { fromHour: 18, key: "18-20", label: "6 PM – 8 PM", toHour: 20 },
  { fromHour: 20, key: "after-20", label: "8 PM – 2 AM", toHour: DAY_CLOSES },
];

/** A Cairo clock hour (0–23) as a visit-day hour (2–25): the small hours after midnight belong to the day before. */
export function visitDayHour(hour: number): number {
  return hour < VISIT_DAY_CUTOFF_HOURS ? hour + 24 : hour;
}

/** Minutes since the visit day opened at 02:00 — 0 at 02:00, 1,439 at 01:59 the next morning. */
export function visitDayMinutes(clock: { hour: number; minute: number }): number {
  return (visitDayHour(clock.hour) - VISIT_DAY_CUTOFF_HOURS) * 60 + clock.minute;
}

/** The Cairo wall-clock hour (0–23) and minute of an instant, read through the shipped offset table. */
export function cairoClockOf(iso: string | null | undefined): { hour: number; minute: number } | null {
  if (!iso) return null;
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return null;
  const wall = cairoWallClock(value);
  return { hour: wall.getUTCHours(), minute: wall.getUTCMinutes() };
}

/** The block a Cairo clock hour falls in — every hour 0–23 falls in exactly one, read on the visit day. */
export function teamVisitHourBlockOf(hour: number): TeamVisitHourBlock {
  const dayHour = visitDayHour(hour);
  const found = TEAM_VISIT_HOUR_BLOCKS.find((block) => dayHour >= block.fromHour && dayHour < block.toHour);
  return found ?? TEAM_VISIT_HOUR_BLOCKS[TEAM_VISIT_HOUR_BLOCKS.length - 1];
}

/** Doctor visits: AM + PM, validated. A pharmacy is never a doctor visit and a waiting visit is in neither. */
export function doctorVisitsOf(day: Pick<TeamVisitDay, "am" | "pm">): number {
  return day.am + day.pm;
}

/** Every visit saved that day, waiting ones included — the length of the day's list. */
export function savedVisitsOf(day: Pick<TeamVisitDay, "times">): number {
  return day.times.length;
}

/** "3 AM · 9 PM · 5 Pharmacies" — the three figures apart, the way every line of this report prints them. */
export function teamVisitFiguresLine(day: Pick<TeamVisitDay, "am" | "pm" | "pharmacies">): string {
  return `${day.am} AM · ${day.pm} PM · ${day.pharmacies} ${day.pharmacies === 1 ? "Pharmacy" : "Pharmacies"}`;
}

/** "1 visit waiting for validation" / "4 visits waiting for validation" — null when none is waiting. */
export function teamVisitWaitingLine(waiting: number): string | null {
  if (waiting <= 0) return null;
  return `${waiting} ${waiting === 1 ? "visit" : "visits"} waiting for validation`;
}

/** "1 rep" / "4 reps". */
export function repsWord(count: number): string {
  return `${count} ${count === 1 ? "rep" : "reps"}`;
}

/** Minutes between two clock readings on one visit day, never negative — 11 PM to 1 AM is two hours, not minus 22. */
function minutesBetween(from: { hour: number; minute: number }, to: { hour: number; minute: number }): number {
  return Math.max(0, visitDayMinutes(to) - visitDayMinutes(from));
}

/** "3 h 40 min", "45 min", "5 h" — the length of the stretch between the first and the last saved visit. */
export function teamVisitSpanLabel(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} h`;
  return `${hours} h ${rest} min`;
}

export type TeamVisitTimeline = {
  /** The first saved time, "10:26 AM" — null when no visit that day carries a time. */
  first: string | null;
  /** The last saved time. */
  last: string | null;
  /** Minutes from the first to the last saved visit; null with fewer than two timed visits. */
  spanMinutes: number | null;
  /** Visits that carry a saved time. */
  timed: number;
  /** Visits copied from the old CRM, which recorded no time. */
  untimed: number;
};

/**
 * The stretch of the day the visits were saved across: the first and the last saved time, and how long between.
 * Read from the times themselves, so a waiting visit's time counts — it was saved, it is real work — and a copied
 * visit's missing time is counted apart, never as midnight.
 */
export function teamVisitTimeline(day: Pick<TeamVisitDay, "times">): TeamVisitTimeline {
  const timed = day.times.filter((time) => time.at && cairoClockOf(time.at));
  const untimed = day.times.length - timed.length;
  if (timed.length === 0) return { first: null, last: null, spanMinutes: null, timed: 0, untimed };
  const sorted = [...timed].sort((left, right) => String(left.at).localeCompare(String(right.at)));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const firstClock = cairoClockOf(first.at);
  const lastClock = cairoClockOf(last.at);
  return {
    first: first.savedAt,
    last: last.savedAt,
    spanMinutes: sorted.length > 1 && firstClock && lastClock ? minutesBetween(firstClock, lastClock) : null,
    timed: timed.length,
    untimed,
  };
}

/** "First 10:26 AM · last 08:39 PM · 10 h 13 min" — null when no visit carries a time. */
export function teamVisitTimelineLine(timeline: TeamVisitTimeline): string | null {
  if (!timeline.first) return null;
  if (timeline.timed === 1) return `Saved at ${timeline.first}`;
  if (!timeline.spanMinutes) return `${timeline.timed} visits saved at ${timeline.first}`;
  return `First ${timeline.first} · last ${timeline.last} · ${teamVisitSpanLabel(timeline.spanMinutes)}`;
}

export type TeamVisitHourCount = { block: TeamVisitHourBlock; visits: number };

export type TeamVisitHourSpread = {
  blocks: TeamVisitHourCount[];
  /** The visits that carry a saved time — the blocks add up to this. */
  timed: number;
  /** Copied visits with no time, counted apart. */
  untimed: number;
  /** The fullest block's count, for drawing the bars against. */
  peak: number;
};

/**
 * Every saved time across the given days, counted by two-hour block. The blocks always add up to the timed visits,
 * and the copied ones sit apart, so the panel can say both and the two add up to every visit saved.
 */
export function teamVisitHourSpread(days: ReadonlyArray<Pick<TeamVisitDay, "times">>): TeamVisitHourSpread {
  const counts = new Map<string, number>(TEAM_VISIT_HOUR_BLOCKS.map((block) => [block.key, 0]));
  let timed = 0;
  let untimed = 0;
  for (const day of days) {
    for (const time of day.times) {
      const clock = cairoClockOf(time.at);
      if (!clock) {
        untimed += 1;
        continue;
      }
      timed += 1;
      const block = teamVisitHourBlockOf(clock.hour);
      counts.set(block.key, (counts.get(block.key) ?? 0) + 1);
    }
  }
  const blocks = TEAM_VISIT_HOUR_BLOCKS.map((block) => ({ block, visits: counts.get(block.key) ?? 0 }));
  return { blocks, peak: Math.max(0, ...blocks.map((entry) => entry.visits)), timed, untimed };
}

/** A bar's width as a whole percent of the peak, at least 2% for any count above zero so it never vanishes. */
export function teamVisitBarWidth(value: number, peak: number): number {
  if (value <= 0 || peak <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((value / peak) * 100)));
}

/** A rep seat with nobody in it. The loader marks it; older reports named the seat "Seat is vacant". */
export function isVacantTeamVisitRep(rep: Pick<TeamVisitRep, "person"> & { vacant?: boolean }): boolean {
  return rep.vacant === true || rep.person === "Seat is vacant";
}

export type TeamVisitRepState = "vacant" | "none" | "waiting-only" | "saved";

/**
 * Where a rep stands on one day: a vacant seat, nothing saved, saved but every visit still waiting for validation,
 * or validated visits in the figures.
 */
export function teamVisitRepState(rep: Pick<TeamVisitRep, "person"> & { vacant?: boolean }, day: TeamVisitDay): TeamVisitRepState {
  if (isVacantTeamVisitRep(rep)) return "vacant";
  if (day.times.length === 0 && day.am + day.pm + day.pharmacies + day.waiting === 0) return "none";
  if (day.am + day.pm + day.pharmacies === 0 && day.waiting > 0) return "waiting-only";
  return "saved";
}

export const TEAM_VISIT_REP_STATE_LABEL: Record<TeamVisitRepState, string> = {
  none: TEAM_VISITS_NONE_SAVED,
  saved: "Visits saved",
  vacant: "Seat is vacant",
  "waiting-only": "Every visit waiting for validation",
};

export type TeamVisitDayRollup = {
  am: number;
  pm: number;
  pharmacies: number;
  waiting: number;
  doctorVisits: number;
  /** Every visit saved, waiting ones included. */
  saved: number;
  /** Reps in a seat (vacant seats are never reps). */
  reps: number;
  /** Reps who saved at least one visit that day. */
  repsWithVisits: number;
  /** Reps in a seat who saved nothing that day. */
  repsWithNone: number;
  /** Doctor visits per rep who saved a visit — null when none did. One decimal. */
  doctorVisitsPerActiveRep: number | null;
  timeline: TeamVisitTimeline;
};

function rollupDay(reps: readonly TeamVisitRep[], pick: (rep: TeamVisitRep) => TeamVisitDay): TeamVisitDayRollup {
  const occupied = reps.filter((rep) => !isVacantTeamVisitRep(rep));
  const days = occupied.map(pick);
  const am = days.reduce((sum, day) => sum + day.am, 0);
  const pm = days.reduce((sum, day) => sum + day.pm, 0);
  const pharmacies = days.reduce((sum, day) => sum + day.pharmacies, 0);
  const waiting = days.reduce((sum, day) => sum + day.waiting, 0);
  const saved = days.reduce((sum, day) => sum + day.times.length, 0);
  const repsWithVisits = days.filter((day) => day.times.length > 0 || day.am + day.pm + day.pharmacies + day.waiting > 0).length;
  const doctorVisits = am + pm;
  return {
    am,
    doctorVisits,
    doctorVisitsPerActiveRep: repsWithVisits > 0 ? Math.round((doctorVisits / repsWithVisits) * 10) / 10 : null,
    pharmacies,
    pm,
    reps: occupied.length,
    repsWithNone: occupied.length - repsWithVisits,
    repsWithVisits,
    saved,
    timeline: teamVisitTimeline({ times: days.flatMap((day) => day.times) }),
    waiting,
  };
}

export type TeamVisitDistrictRollup = {
  key: string;
  regionName: string;
  managerName: string;
  districtName: string;
  vacantSeats: number;
  yesterday: TeamVisitDayRollup;
  today: TeamVisitDayRollup;
};

/** A district's stable key — the same one the screen's sections and anchors use. */
export function teamVisitDistrictKey(district: Pick<TeamVisitDistrict, "regionName" | "districtName" | "managerName">): string {
  return `${district.regionName}|${district.districtName}|${district.managerName}`;
}

/** The anchor a roll-up row jumps to — letters, digits and dashes only. */
export function teamVisitDistrictAnchor(district: Pick<TeamVisitDistrict, "regionName" | "districtName" | "managerName">): string {
  const slug = teamVisitDistrictKey(district)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `team-${slug || "group"}`;
}

/**
 * One line per district manager: the reps' figures each day. The rows add up to the team's tiles (vacant seats and
 * the managers' own visits are in no rep's figure, on the tile as in the rows).
 */
export function teamVisitDistrictRollups(report: Pick<TeamVisitsReport, "districts">): TeamVisitDistrictRollup[] {
  return report.districts.map((district) => ({
    districtName: district.districtName,
    key: teamVisitDistrictKey(district),
    managerName: district.managerName,
    regionName: district.regionName,
    today: rollupDay(district.reps, (rep) => rep.today),
    vacantSeats: district.reps.filter((rep) => isVacantTeamVisitRep(rep)).length,
    yesterday: rollupDay(district.reps, (rep) => rep.yesterday),
  }));
}

/** The whole team's figures for one day — the same arithmetic as each district's line, over every rep. */
export function teamVisitTeamRollup(report: Pick<TeamVisitsReport, "districts">, day: TeamVisitDayKey): TeamVisitDayRollup {
  return rollupDay(
    report.districts.flatMap((district) => district.reps),
    (rep) => rep[day],
  );
}

export type TeamVisitRepRef = {
  seatId: string;
  person: string;
  territory: string;
  regionName: string;
  managerName: string;
};

export type TeamVisitAttention = {
  /** Reps in a seat who saved nothing that day. */
  none: TeamVisitRepRef[];
  /** Reps whose every visit that day still waits for validation. */
  waitingOnly: TeamVisitRepRef[];
  /** Reps with at least one visit waiting, and how many. */
  waiting: Array<TeamVisitRepRef & { waiting: number }>;
};

/**
 * The reps to look at for one day: nobody saved anything, or the visits are all waiting for validation. Vacant seats
 * are never here — they are listed by territory on their own. In report order, so the lists read like the page.
 */
export function teamVisitAttention(report: Pick<TeamVisitsReport, "districts">, day: TeamVisitDayKey): TeamVisitAttention {
  const none: TeamVisitRepRef[] = [];
  const waitingOnly: TeamVisitRepRef[] = [];
  const waiting: TeamVisitAttention["waiting"] = [];
  for (const district of report.districts) {
    for (const rep of district.reps) {
      const ref: TeamVisitRepRef = { managerName: district.managerName, person: rep.person, regionName: district.regionName, seatId: rep.seatId, territory: rep.territory };
      const state = teamVisitRepState(rep, rep[day]);
      if (state === "vacant") continue;
      // A day on approved leave or recorded admin work, with nothing saved, is accounted for — never "saved nothing".
      if (state === "none" && !(rep[day].away?.length)) none.push(ref);
      if (state === "waiting-only") waitingOnly.push(ref);
      if (rep[day].waiting > 0) waiting.push({ ...ref, waiting: rep[day].waiting });
    }
  }
  return { none, waiting, waitingOnly };
}

export type TeamVisitVacantSeat = { seatId: string; territory: string };

/** A district's vacant seats, by territory — listed once on one line, never as rows of zeros. */
export function teamVisitVacantSeats(district: Pick<TeamVisitDistrict, "reps">): TeamVisitVacantSeat[] {
  return district.reps.filter((rep) => isVacantTeamVisitRep(rep)).map((rep) => ({ seatId: rep.seatId, territory: rep.territory }));
}

/** "Alex West · Sharkia 1" — the vacant seats on one line. */
export function teamVisitVacantLine(seats: readonly TeamVisitVacantSeat[]): string | null {
  if (seats.length === 0) return null;
  return `${seats.length === 1 ? "Vacant seat" : `${seats.length} vacant seats`}: ${seats.map((seat) => seat.territory).join(" · ")}`;
}

/** Which reps the screen lists — every rep, those who saved a visit, or those who saved none. */
export const TEAM_VISIT_SHOW = ["all", "saved", "none"] as const;
export type TeamVisitShow = (typeof TEAM_VISIT_SHOW)[number];

export const TEAM_VISIT_SHOW_LABEL: Record<TeamVisitShow, string> = {
  all: "Every rep",
  none: "No visits saved",
  saved: "Saved visits",
};

/** The `show` search parameter, read strictly — anything else is every rep. */
export function parseTeamVisitShow(value: unknown): TeamVisitShow {
  const text = Array.isArray(value) ? value[0] : value;
  return (TEAM_VISIT_SHOW as readonly string[]).includes(String(text ?? "")) ? (text as TeamVisitShow) : "all";
}

/** The `day` search parameter that the Saved / None filters judge by — yesterday unless it says today. */
export function parseTeamVisitDay(value: unknown): TeamVisitDayKey {
  const text = Array.isArray(value) ? value[0] : value;
  return text === "today" ? "today" : "yesterday";
}

/**
 * Narrows the reps a district lists by the filter, on the chosen day. A vacant seat is never listed as a rep (its
 * territory is on the district's vacant line); the managers' own visits and the reps' total are untouched, so the
 * headline figures never move with the filter.
 */
export function filterTeamVisitReps(reps: readonly TeamVisitRep[], show: TeamVisitShow, day: TeamVisitDayKey): TeamVisitRep[] {
  return reps.filter((rep) => {
    const state = teamVisitRepState(rep, rep[day]);
    if (state === "vacant") return false;
    if (show === "saved") return state === "saved" || state === "waiting-only";
    if (show === "none") return state === "none";
    return true;
  });
}

/** How many reps each filter lists on the chosen day — the counts printed on the filter itself. */
export function teamVisitShowCounts(report: Pick<TeamVisitsReport, "districts">, day: TeamVisitDayKey): Record<TeamVisitShow, number> {
  const reps = report.districts.flatMap((district) => district.reps);
  return {
    all: filterTeamVisitReps(reps, "all", day).length,
    none: filterTeamVisitReps(reps, "none", day).length,
    saved: filterTeamVisitReps(reps, "saved", day).length,
  };
}

/** The order of the reps inside each team: the territory (the loader's own order), most doctor visits, earliest first visit. */
export const TEAM_VISIT_SORT = ["territory", "visits", "first"] as const;
export type TeamVisitSort = (typeof TEAM_VISIT_SORT)[number];

export const TEAM_VISIT_SORT_LABEL: Record<TeamVisitSort, string> = {
  first: "Earliest first visit",
  territory: "Territory",
  visits: "Most AM + PM visits",
};

/** The `sort` search parameter, read strictly — anything else is the territory order. */
export function parseTeamVisitSort(value: unknown): TeamVisitSort {
  const text = Array.isArray(value) ? value[0] : value;
  return (TEAM_VISIT_SORT as readonly string[]).includes(String(text ?? "")) ? (text as TeamVisitSort) : "territory";
}

/** The first saved instant of a rep's day — null when no visit carries a time. */
function firstSavedAt(day: Pick<TeamVisitDay, "times">): string | null {
  let first: string | null = null;
  for (const time of day.times) {
    if (!time.at || !cairoClockOf(time.at)) continue;
    if (first === null || time.at < first) first = time.at;
  }
  return first;
}

/**
 * The reps of one team in the chosen order, judged on the chosen day. Ties, and the "territory" order itself, fall
 * back to territory then name, so the order is the same on every load. In "Earliest first visit" a rep with no timed
 * visit that day comes last, never first.
 */
export function sortTeamVisitReps(reps: readonly TeamVisitRep[], sort: TeamVisitSort, day: TeamVisitDayKey): TeamVisitRep[] {
  const byTerritory = (left: TeamVisitRep, right: TeamVisitRep) => left.territory.localeCompare(right.territory) || left.person.localeCompare(right.person);
  const sorted = [...reps];
  if (sort === "visits") {
    sorted.sort((left, right) => doctorVisitsOf(right[day]) - doctorVisitsOf(left[day]) || savedVisitsOf(right[day]) - savedVisitsOf(left[day]) || byTerritory(left, right));
  } else if (sort === "first") {
    sorted.sort((left, right) => {
      const a = firstSavedAt(left[day]);
      const b = firstSavedAt(right[day]);
      if (a && b && a !== b) return a.localeCompare(b);
      if (a && !b) return -1;
      if (!a && b) return 1;
      return byTerritory(left, right);
    });
  } else {
    sorted.sort(byTerritory);
  }
  return sorted;
}

/**
 * The anchors a rep's own row and phone card carry, so a name in "Reps to look at" jumps to that rep. Two, because
 * the table row and the card are both in the page and only one is shown; a link to the hidden one would not scroll.
 */
export function teamVisitRepAnchor(seatId: string, surface: "row" | "card"): string {
  const slug = seatId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `rep-${slug || "seat"}${surface === "card" ? "-card" : ""}`;
}

/** The seats the screen lists under the filter — a name links to its row only when that row is on the page. */
export function teamVisitListedSeatIds(report: Pick<TeamVisitsReport, "districts">, show: TeamVisitShow, day: TeamVisitDayKey): Set<string> {
  return new Set(report.districts.flatMap((district) => filterTeamVisitReps(district.reps, show, day)).map((rep) => rep.seatId));
}

/** The screen's own address with the filter applied — a fixed path, only the three known keys. */
export function teamVisitFilterHref(show: TeamVisitShow, day: TeamVisitDayKey, sort: TeamVisitSort = "territory"): string {
  const params = new URLSearchParams();
  if (show !== "all") params.set("show", show);
  if (day !== "yesterday") params.set("day", day);
  if (sort !== "territory") params.set("sort", sort);
  const query = params.toString();
  return `/employee-portals/team-visits${query ? `?${query}` : ""}`;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** "Friday" — the weekday of an ISO day, read in UTC so no engine's zone can move it. */
export function teamVisitWeekdayOf(dateIso: string): string | null {
  const value = new Date(`${dateIso}T12:00:00Z`);
  if (Number.isNaN(value.getTime())) return null;
  return WEEKDAY_NAMES[value.getUTCDay()];
}

/**
 * A notice when a day on the screen is not a field working day — Thursday and Friday are not; Saturday to Wednesday
 * are (`isCallRateWorkingDay`, the call rate's own rule). On a Saturday morning "yesterday" is a Friday, and every
 * rep at zero would otherwise read as a team that did nothing. National holidays are not read here, so the notice
 * says only what the weekday proves.
 */
export function teamVisitNonWorkingNotice(report: Pick<TeamVisitsReport, "today" | "yesterday">): string | null {
  const off = TEAM_VISIT_DAYS.filter((key) => !isCallRateWorkingDay(key === "today" ? report.today : report.yesterday));
  if (off.length === 0) return null;
  const words = off.map((key) => `${key === "today" ? "today" : "yesterday"} (${teamVisitWeekdayOf(key === "today" ? report.today : report.yesterday) ?? "this day"})`);
  const subject = words.length === 2 ? `Both days — ${words.join(" and ")} —` : words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return `${subject} ${off.length === 2 ? "are not field working days" : "is not a field working day"}: the field week is Saturday to Wednesday, so few or no visits are expected.`;
}

/** Above this many visits, a phone card folds the day's list behind "Show the visits", so a long day does not bury the next rep. */
export const TEAM_VISIT_PHONE_FOLD = 4;

/** The visits of one day grouped AM · PM · Pharmacies, each group earliest first, a copied visit last. */
export function teamVisitTimesByList(day: Pick<TeamVisitDay, "times">): Record<TeamVisitTime["list"], TeamVisitTime[]> {
  const groups: Record<TeamVisitTime["list"], TeamVisitTime[]> = { AM: [], PM: [], Pharmacy: [] };
  for (const time of day.times) groups[time.list].push(time);
  for (const list of Object.keys(groups) as Array<TeamVisitTime["list"]>) {
    groups[list].sort((left, right) => (left.at ?? "9999").localeCompare(right.at ?? "9999"));
  }
  return groups;
}

/** "Today so far" while the visit day is still running — today is never a finished day on this screen. */
export function teamVisitDayHeading(day: TeamVisitDayKey): string {
  return day === "today" ? "Today so far" : "Yesterday";
}

/**
 * The Cairo VISIT day an instant is filed under — the day that ends at 02:00 the next morning, not the calendar day.
 * `cairoBusinessDay` itself, so this screen and every other visit-day reader agree.
 */
export function teamVisitBusinessDayOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return null;
  return cairoBusinessDay(value);
}

export type TeamVisitPaceSide = {
  /** Every visit saved, waiting ones included. */
  saved: number;
  /** AM and PM visits to a validated customer — the doctor visits. */
  doctorVisits: number;
  /** Reps who had saved at least one visit. */
  reps: number;
};

export type TeamVisitPace = {
  /** The time now, "11:20 AM" — the cut both days are read at. */
  cutoffLabel: string;
  /** Today, everything saved so far. */
  today: TeamVisitPaceSide;
  /** Yesterday, only what had been saved by the same time of its visit day. */
  yesterdayBy: TeamVisitPaceSide;
  /** Today's saved visits less yesterday's by the same time — positive is ahead. */
  difference: number;
  /** Reps in a seat — the denominator for the two `reps` figures. */
  repsInSeats: number;
};

function clockLabel(clock: { hour: number; minute: number }): string {
  const hour12 = clock.hour % 12 === 0 ? 12 : clock.hour % 12;
  return `${String(hour12).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")} ${clock.hour < 12 ? "AM" : "PM"}`;
}

function isDoctorVisit(time: Pick<TeamVisitTime, "list" | "waiting">): boolean {
  return (time.list === "AM" || time.list === "PM") && !time.waiting;
}

/** Yesterday's times saved by the same visit-day minute as `cutoff`, inside yesterday's own visit day. */
function savedBy(times: readonly TeamVisitTime[], dayIso: string, cutoff: number): TeamVisitTime[] {
  return times.filter((time) => {
    const clock = cairoClockOf(time.at);
    if (!clock) return false;
    if (teamVisitBusinessDayOf(time.at) !== dayIso) return false;
    return visitDayMinutes(clock) <= cutoff;
  });
}

/**
 * One rep's pace: what was saved today so far, against what had been saved yesterday by the same time. Null for a
 * vacant seat. A copied visit has no time and is never in "by this time".
 */
export function teamVisitRepPace(
  rep: Pick<TeamVisitRep, "person" | "today" | "yesterday"> & { vacant?: boolean },
  report: Pick<TeamVisitsReport, "yesterday">,
  nowIso: string,
): { today: number; yesterdayBy: number } | null {
  if (isVacantTeamVisitRep(rep)) return null;
  const clock = cairoClockOf(nowIso);
  if (!clock) return null;
  return { today: rep.today.times.length, yesterdayBy: savedBy(rep.yesterday.times, report.yesterday, visitDayMinutes(clock)).length };
}

/** The visit-day minute "now" is cut at, or null once today's visit day has closed (or the instant is not a time). */
function paceCutoff(report: Pick<TeamVisitsReport, "today">, nowIso: string): { clock: { hour: number; minute: number }; cutoff: number } | null {
  const clock = cairoClockOf(nowIso);
  if (!clock || teamVisitBusinessDayOf(nowIso) !== report.today) return null;
  return { clock, cutoff: visitDayMinutes(clock) };
}

/** Today against yesterday-by-the-same-minute over a set of seats; vacant seats are dropped here, never counted. */
function paceOfReps(reps: readonly TeamVisitRep[], yesterdayIso: string, cutoff: number): Omit<TeamVisitPace, "cutoffLabel"> {
  const occupied = reps.filter((rep) => !isVacantTeamVisitRep(rep));
  const today: TeamVisitPaceSide = { doctorVisits: 0, reps: 0, saved: 0 };
  const yesterdayBy: TeamVisitPaceSide = { doctorVisits: 0, reps: 0, saved: 0 };
  for (const rep of occupied) {
    const now = rep.today.times;
    const then = savedBy(rep.yesterday.times, yesterdayIso, cutoff);
    today.saved += now.length;
    today.doctorVisits += now.filter(isDoctorVisit).length;
    if (now.length > 0) today.reps += 1;
    yesterdayBy.saved += then.length;
    yesterdayBy.doctorVisits += then.filter(isDoctorVisit).length;
    if (then.length > 0) yesterdayBy.reps += 1;
  }
  return { difference: today.saved - yesterdayBy.saved, repsInSeats: occupied.length, today, yesterdayBy };
}

/**
 * Today so far against yesterday at the same hour — the only fair way to read a day that is still running. At 11 AM
 * a team with 12 visits saved is behind only if yesterday had more than 12 by 11 AM, never because yesterday ended on
 * 62. Null when "now" is not inside today's visit day (a page held open past 02:00 reads a day that has closed).
 */
export function teamVisitPace(report: Pick<TeamVisitsReport, "districts" | "today" | "yesterday">, nowIso: string): TeamVisitPace | null {
  const at = paceCutoff(report, nowIso);
  if (!at) return null;
  return { cutoffLabel: clockLabel(at.clock), ...paceOfReps(report.districts.flatMap((district) => district.reps), report.yesterday, at.cutoff) };
}

export type TeamVisitTeamPaceRow = Omit<TeamVisitPace, "cutoffLabel"> & {
  key: string;
  anchor: string;
  regionName: string;
  managerName: string;
  districtName: string;
};

/**
 * The same pace, one line per region and district manager, in report order — so the Regional Sales Manager sees
 * which team is behind its own yesterday, not only the whole team. The rows add up to `teamVisitPace` (the same
 * seats, the same cutoff). Null once today's visit day has closed, exactly as the whole team's pace is.
 */
export function teamVisitTeamPace(
  report: Pick<TeamVisitsReport, "districts" | "today" | "yesterday">,
  nowIso: string,
): { cutoffLabel: string; teams: TeamVisitTeamPaceRow[] } | null {
  const at = paceCutoff(report, nowIso);
  if (!at) return null;
  return {
    cutoffLabel: clockLabel(at.clock),
    teams: report.districts.map((district) => ({
      anchor: teamVisitDistrictAnchor(district),
      districtName: district.districtName,
      key: teamVisitDistrictKey(district),
      managerName: district.managerName,
      regionName: district.regionName,
      ...paceOfReps(district.reps, report.yesterday, at.cutoff),
    })),
  };
}

/** "+3" / "−5" / "0" — the difference as a signed figure, the minus a true minus sign. */
export function teamVisitSignedDifference(difference: number): string {
  if (difference > 0) return `+${difference}`;
  if (difference < 0) return `\u2212${Math.abs(difference)}`;
  return "0";
}

/** "3 more than yesterday by this time" / "5 fewer…" / "Level with yesterday by this time". */
export function teamVisitPaceLine(difference: number): string {
  if (difference === 0) return "Level with yesterday by this time";
  const count = Math.abs(difference);
  return `${count} ${difference > 0 ? "more" : "fewer"} than yesterday by this time`;
}

/**
 * The window a rep's day strip draws: 7 AM to midnight, as visit-day minutes. A time saved outside it sits on the
 * strip's edge, so it is still seen.
 */
export const TEAM_VISIT_STRIP_FROM = (7 - VISIT_DAY_CUTOFF_HOURS) * 60;
export const TEAM_VISIT_STRIP_TO = (24 - VISIT_DAY_CUTOFF_HOURS) * 60;

/** The hours printed under the strip. */
export const TEAM_VISIT_STRIP_TICKS: ReadonlyArray<{ label: string; left: number }> = [8, 12, 16, 20].map((hour) => ({
  label: clockLabel({ hour, minute: 0 }).replace(":00", ""),
  left: stripLeft(visitDayMinutes({ hour, minute: 0 })),
}));

function stripLeft(minutes: number): number {
  const span = TEAM_VISIT_STRIP_TO - TEAM_VISIT_STRIP_FROM;
  const clamped = Math.min(TEAM_VISIT_STRIP_TO, Math.max(TEAM_VISIT_STRIP_FROM, minutes));
  return Math.round(((clamped - TEAM_VISIT_STRIP_FROM) / span) * 1000) / 10;
}

export type TeamVisitStripMark = { left: number; list: TeamVisitTime["list"]; waiting: boolean; savedAt: string | null };

/**
 * A rep's day as marks on one line, 7 AM to midnight: one mark per timed visit, AM · PM · Pharmacies in their own
 * shade, a waiting visit in amber. A copied visit has no time and no mark. The marks are positions, not a score.
 */
export function teamVisitDayStrip(day: Pick<TeamVisitDay, "times">): { marks: TeamVisitStripMark[]; untimed: number } {
  const marks: TeamVisitStripMark[] = [];
  let untimed = 0;
  for (const time of day.times) {
    const clock = cairoClockOf(time.at);
    if (!clock) {
      untimed += 1;
      continue;
    }
    marks.push({ left: stripLeft(visitDayMinutes(clock)), list: time.list, savedAt: time.savedAt, waiting: time.waiting === true });
  }
  marks.sort((left, right) => left.left - right.left);
  return { marks, untimed };
}

export type TeamVisitManagerDay = {
  am: number;
  pm: number;
  pharmacies: number;
  saved: number;
  timeline: TeamVisitTimeline;
};

export type TeamVisitManagerInField = {
  key: string;
  anchor: string;
  regionName: string;
  managerName: string;
  /** The district manager seat is empty, or the reps have no district manager: nobody's own visits to read. */
  noManager: boolean;
  yesterday: TeamVisitManagerDay | null;
  today: TeamVisitManagerDay | null;
};

function managerDay(day: TeamVisitDay): TeamVisitManagerDay {
  return { am: day.am, pharmacies: day.pharmacies, pm: day.pm, saved: day.times.length, timeline: teamVisitTimeline(day) };
}

/**
 * The district managers' own visits side by side — the visits each saved in person, which are counted in no rep's
 * figure. A team with no district manager in the seat says so, never a row of zeros.
 */
export function teamVisitManagersInField(report: Pick<TeamVisitsReport, "districts">): TeamVisitManagerInField[] {
  return report.districts.map((district) => ({
    anchor: teamVisitDistrictAnchor(district),
    key: teamVisitDistrictKey(district),
    managerName: district.managerName,
    noManager: !district.managerOwn,
    regionName: district.regionName,
    today: district.managerOwn ? managerDay(district.managerOwn.today) : null,
    yesterday: district.managerOwn ? managerDay(district.managerOwn.yesterday) : null,
  }));
}
