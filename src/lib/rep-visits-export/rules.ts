/**
 * Rep visits export — one rep, one date range, as the workbook the owner reviewed on Ebtissam Alaa's case
 * (owner, 24 Nov 2026: "i want 2 be able to extract from system exactly the same as this sheet plus the
 * doctor by brick and doctor list i filter rep duration and exaclty same data and add another tab list all
 * days as visits but showing everyday record first", then "in everyday tab in must be formated as a table bec
 * i will pivot it .. in visits per day add all month days and mention vacation no records meeting etc").
 *
 * PURE: the day's record, the day type, the repeat colours, the coverage standing and the range check.
 * `server.ts` loads the rows, `workbook.ts` draws them. Nothing here reaches the database.
 *
 * 🔴 EVERY VISIT RECORDED IS LISTED. This is an evidence sheet of what was saved, not a KPI figure: a visit
 * still waiting for validation or approval is work the rep did and appears here. The workbook says so in
 * words, and no figure in it is presented as a KPI or a call rate.
 */

export const REP_VISITS_EXPORT_MAX_DAYS = 186;

export type ExportListType = "AM" | "PM" | "Pharmacy";

export type ExportVisit = {
  /** Cairo visit day, YYYY-MM-DD. */
  day: string;
  list: ExportListType;
  kind: string;
  unplanned: boolean;
  customerKey: string;
  customerName: string;
  speciality: string | null;
  /** Cairo HH:MM the visit was captured; null for a visit copied from the old CRM, which kept no time. */
  time: string | null;
  distanceMeters: number | null;
  grade: string | null;
  locationFlag: string | null;
  copiedFromOldCrm: boolean;
  brickName: string | null;
};

export type ExportDoctorStatus = "active" | "pending" | "outside";

export type ExportDoctor = {
  customerKey: string;
  status: ExportDoctorStatus;
  list: ExportListType;
  grade: string | null;
  name: string;
  speciality: string | null;
  brickId: string | null;
  brickName: string | null;
  areaCode: string | null;
  areaName: string | null;
};

/** `list → grade → visits a month`, as `phoenix_crm_settings.grade_targets` stores it. */
export type GradeTargets = Record<string, Record<string, number | null> | undefined>;

export type ExportDayFacts = {
  starts: ReadonlyMap<string, string>;
  activities: ReadonlyMap<string, readonly string[]>;
  holidays: ReadonlyMap<string, string>;
  leave: ReadonlyMap<string, string>;
  charged: ReadonlySet<string>;
};

export type ExportBrickSales = {
  /** Published closing months, YYYY-MM, oldest first. */
  months: string[];
  bricks: Array<{ brickId: string; brickName: string; areaCode: string; current: boolean; byMonth: Record<string, number> }>;
};

export type RepVisitsExportData = {
  rep: {
    hrId: string;
    name: string;
    role: string;
    line: string;
    areaName: string;
    areaCode: string | null;
    /** YYYY-MM-DD, or null when the record has none. */
    hireDate: string | null;
    birthDate: string | null;
    /** As stored on the employee record, EGP a month — read, never derived here. */
    salary: { base: number | null; basic: number | null; gross: number | null; net: number | null };
  };
  from: string;
  to: string;
  today: string;
  visits: ExportVisit[];
  doctors: ExportDoctor[];
  gradeTargets: GradeTargets;
  days: ExportDayFacts;
  brickSales: ExportBrickSales;
};

// ── Dates ───────────────────────────────────────────────────────────────────────────────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function utc(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

export function isIsoDay(value: unknown): value is string {
  return typeof value === "string" && ISO_DAY.test(value) && !Number.isNaN(utc(value).getTime()) && utc(value).toISOString().slice(0, 10) === value;
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let at = utc(from); at <= utc(to); at = new Date(at.getTime() + 86_400_000)) out.push(at.toISOString().slice(0, 10));
  return out;
}

export function weekdayShort(day: string): string {
  return WEEKDAYS[utc(day).getUTCDay()];
}

/** The company's weekly day off for the field: Friday. */
export function isWeeklyOff(day: string): boolean {
  return utc(day).getUTCDay() === 5;
}

/** "12-Sep", the grid's column heading. */
export function gridDayLabel(day: string): string {
  return `${Number(day.slice(8, 10))}-${MONTHS_SHORT[Number(day.slice(5, 7)) - 1]}`;
}

/** "12 Sep". */
export function shortDay(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS_SHORT[Number(day.slice(5, 7)) - 1]}`;
}

/** "12 September 2026". */
export function longDay(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS_LONG[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

export function monthName(month: string, short = false): string {
  return (short ? MONTHS_SHORT : MONTHS_LONG)[Number(month.slice(5, 7)) - 1];
}

/** The months the range touches, each with its own days — a part month keeps only the days in range. */
export function monthsOfRange(from: string, to: string): Array<{ month: string; days: string[] }> {
  const out: Array<{ month: string; days: string[] }> = [];
  for (const day of daysBetween(from, to)) {
    const month = day.slice(0, 7);
    const last = out[out.length - 1];
    if (last?.month === month) last.days.push(day);
    else out.push({ month, days: [day] });
  }
  return out;
}

function lastDayOfMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** "October", or "September 12–30" for a part month. */
export function monthLabel(entry: { month: string; days: string[] }, short = false): string {
  const name = monthName(entry.month, short);
  const first = Number(entry.days[0].slice(8, 10));
  const last = Number(entry.days[entry.days.length - 1].slice(8, 10));
  return first === 1 && last === lastDayOfMonth(entry.month) ? name : `${name} ${first}–${last}`;
}

export type RangeCheck = { ok: true; from: string; to: string } | { ok: false; error: string };

/** The filter's range: real days, in order, not past today, at most six months. */
export function checkExportRange(from: unknown, to: unknown, today: string): RangeCheck {
  if (!isIsoDay(from) || !isIsoDay(to)) return { ok: false, error: "Choose a from date and a to date." };
  if (from > to) return { ok: false, error: "The from date must be on or before the to date." };
  if (from > today) return { ok: false, error: "The from date is in the future." };
  const end = to > today ? today : to;
  if (daysBetween(from, end).length > REP_VISITS_EXPORT_MAX_DAYS) {
    return { ok: false, error: `Choose ${REP_VISITS_EXPORT_MAX_DAYS} days or fewer.` };
  }
  return { ok: true, from, to: end };
}

// ── Labels ──────────────────────────────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<string, string> = {
  single: "Alone",
  double: "Double visit (with the manager)",
  chain: "Chain visit",
  product_manager: "With the product manager",
};
export function visitKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

const LOCATION_LABELS: Record<string, string> = {
  ok: "At the place",
  far: "Far from the place",
  no_place: "No place to check against",
};
export function locationLabel(flag: string | null): string {
  if (!flag) return "At the place";
  return LOCATION_LABELS[flag] ?? flag.replace(/_/g, " ");
}

const ACTIVITY_LABELS: Record<string, string> = { meeting: "Meeting", training: "Training", sales_day: "Sales day" };
/** "Meeting: Phoenix go-live training in Tanta", "Training (set by HR)". */
export function activityLabel(type: string, note: string | null, setByOther: boolean): string {
  const base = ACTIVITY_LABELS[type] ?? type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const clean = (note ?? "").trim();
  let text = base;
  if (clean && !["today", "sales day", base.toLowerCase()].includes(clean.toLowerCase())) text += `: ${clean}`;
  return setByOther ? `${text} (set by HR)` : text;
}

/** "Sick leave asked · manager approved, HR refused" — the leave as asked and as decided. */
export function leaveLabel(input: { type: string; status: string; managerDecision: string | null }): string | null {
  const status = input.status.toLowerCase();
  if (status === "cancelled" || status === "withdrawn") return null;
  const raw = input.type.replace(/_/g, " ").trim();
  const type = /leave|vacation/i.test(raw) ? raw.replace(/^\w/, (c) => c.toUpperCase()) : `${raw.replace(/^\w/, (c) => c.toUpperCase())} leave`;
  if (status === "approved") return `${type} · approved`;
  if (status === "rejected") return input.managerDecision === "approved" ? `${type} asked · manager approved, HR refused` : `${type} asked · refused`;
  return `${type} asked · waiting`;
}

export function savedAtText(visit: Pick<ExportVisit, "time" | "copiedFromOldCrm">): string {
  return visit.copiedFromOldCrm || !visit.time ? "Old CRM" : visit.time;
}

// ── The day's record ────────────────────────────────────────────────────────────────────────────────

export function visitsByDay(visits: readonly ExportVisit[]): Map<string, ExportVisit[]> {
  const out = new Map<string, ExportVisit[]>();
  for (const visit of visits) out.set(visit.day, [...(out.get(visit.day) ?? []), visit]);
  return out;
}

/** Every fact the system holds for a day, in words, in a fixed order. */
export function dayRecord(day: string, visits: readonly ExportVisit[], facts: ExportDayFacts, today: string): string[] {
  const parts: string[] = [];
  if (day === today) parts.push("Today");
  if (isWeeklyOff(day)) parts.push("Friday · weekly off");
  const holiday = facts.holidays.get(day);
  if (holiday) parts.push(`Holiday: ${holiday}`);
  const start = facts.starts.get(day);
  if (start) parts.push(`Day started ${start}`);
  const leave = facts.leave.get(day);
  if (leave && !isWeeklyOff(day)) parts.push(leave);
  if (facts.charged.has(day)) parts.push("No activity · charged");
  parts.push(...(facts.activities.get(day) ?? []));
  if (visits.length > 0 && visits.every((visit) => visit.copiedFromOldCrm)) parts.push("Visits brought from the old CRM, no time");
  if (parts.length === 0) parts.push(visits.length === 0 ? "No visit · nothing recorded" : "Visits · no day start recorded");
  return parts;
}

/** One short word for the day, for a pivot. */
export function dayType(day: string, visits: readonly ExportVisit[], facts: ExportDayFacts, today: string): string {
  if (visits.length > 0) return "Visits";
  if (isWeeklyOff(day)) return "Friday · weekly off";
  if (facts.holidays.has(day)) return "Holiday";
  const activity = facts.activities.get(day)?.[0];
  if (activity) return activity.split(":")[0].split(" (")[0];
  const leave = facts.leave.get(day);
  if (leave && facts.charged.has(day)) return /refused/.test(leave) ? "Leave refused · charged" : "Leave · charged";
  if (leave) return /refused/.test(leave) ? "Leave asked · refused" : /approved/.test(leave) ? "Leave" : "Leave asked · waiting";
  if (facts.charged.has(day)) return "No activity · charged";
  if (day === today) return "Today";
  if (facts.starts.has(day)) return "Day started, no visits";
  return "No record";
}

/** A day type the reader should look at: red in the workbook. */
export function isConcernDayType(type: string): boolean {
  return /charged|refused|No record|no visits/.test(type);
}

// ── Repeats and their colours ───────────────────────────────────────────────────────────────────────

/** Visits to the same customer in the same month, by `month|customer`. */
export function repeatCounts(visits: readonly ExportVisit[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const visit of visits) {
    const key = `${visit.day.slice(0, 7)}|${visit.customerKey}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

export function repeatCountOf(counts: ReadonlyMap<string, number>, visit: ExportVisit): number {
  return counts.get(`${visit.day.slice(0, 7)}|${visit.customerKey}`) ?? 0;
}

const BASE_PALETTE = [
  "FFE066", "8EC5FF", "FFB066", "8FDB8F", "C9A0FF", "66D9CC", "FF9EC7", "FF8A80", "D4F06B", "D9B38C", "B0B0B0", "7FE3F0",
  "E0A3E0", "C2C27A", "FFCBA4", "9FA8DA", "B9F6CA", "E6C04D",
];

function hsvHex(h: number, s: number, v: number): string {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [r, g, b].map((x) => Math.floor(x * 255).toString(16).padStart(2, "0").toUpperCase()).join("");
}

/** 18 named colours, then generated pastels — enough that no month ever runs out. */
export function repeatPalette(size: number): string[] {
  const out = [...BASE_PALETTE];
  let h = 0.07;
  while (out.length < size) {
    out.push(hsvHex(h % 1, 0.55, 0.95), hsvHex(h % 1, 0.32, 0.88));
    h += 0.618034;
  }
  return out;
}

/**
 * One colour per repeated customer, kept across months, and never two customers in one colour inside
 * the same month — so every cell in the same colour on a month's grid is the same customer.
 */
export function repeatColours(visits: readonly ExportVisit[]): Map<string, string> {
  const counts = repeatCounts(visits);
  const monthsOf = new Map<string, Set<string>>();
  for (const [key, count] of counts) {
    if (count < 2) continue;
    const [month, customer] = [key.slice(0, 7), key.slice(8)];
    monthsOf.set(customer, new Set([...(monthsOf.get(customer) ?? []), month]));
  }
  const order: string[] = [];
  for (const visit of visits) if (monthsOf.has(visit.customerKey) && !order.includes(visit.customerKey)) order.push(visit.customerKey);
  const palette = repeatPalette(Math.max(60, order.length + 18));
  const colour = new Map<string, string>();
  for (const customer of order) {
    const mine = monthsOf.get(customer) ?? new Set<string>();
    const taken = new Set<string>();
    for (const [other, c] of colour) if ([...(monthsOf.get(other) ?? [])].some((month) => mine.has(month))) taken.add(c);
    colour.set(customer, palette.find((c) => !taken.has(c)) ?? palette[0]);
  }
  return colour;
}

export function repeatColourOf(colours: ReadonlyMap<string, string>, counts: ReadonlyMap<string, number>, visit: ExportVisit): string | null {
  return repeatCountOf(counts, visit) > 1 ? (colours.get(visit.customerKey) ?? null) : null;
}

// ── Coverage against the grade's monthly number ─────────────────────────────────────────────────────

export type Standing = "Not visited" | "Behind" | "On number" | "Over" | "Visited";

export function monthlyNumber(targets: GradeTargets, doctor: Pick<ExportDoctor, "list" | "grade">): number | null {
  if (!doctor.grade) return null;
  const value = targets[doctor.list]?.[doctor.grade];
  return typeof value === "number" && value > 0 ? value : null;
}

export function standing(visits: number, need: number | null): Standing {
  if (visits === 0) return "Not visited";
  if (need === null) return "Visited";
  if (visits < need) return "Behind";
  return visits === need ? "On number" : "Over";
}

export function isCovered(value: Standing): boolean {
  return value === "On number" || value === "Over" || value === "Visited";
}

// ── The cover ───────────────────────────────────────────────────────────────────────────────────────

/** Whole years from a birth date to a day, both YYYY-MM-DD; null when the birth date is missing or later. */
export function ageOn(birthDate: string | null, day: string): number | null {
  if (!isIsoDay(birthDate) || !isIsoDay(day) || birthDate > day) return null;
  const years = Number(day.slice(0, 4)) - Number(birthDate.slice(0, 4));
  return day.slice(5) < birthDate.slice(5) ? years - 1 : years;
}

// ── File name ───────────────────────────────────────────────────────────────────────────────────────

export function repVisitsExportFileName(repName: string, from: string, to: string): string {
  const safe = repName.replace(/[^A-Za-z0-9 \-]+/g, "").trim().replace(/\s+/g, " ") || "Rep";
  return `${safe} - Visits, Bricks and Doctors - ${shortDay(from)} ${from.slice(0, 4)} to ${shortDay(to)} ${to.slice(0, 4)}.xlsx`;
}
