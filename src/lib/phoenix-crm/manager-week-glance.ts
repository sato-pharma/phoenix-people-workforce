import { MANAGER_SLOT_KINDS, type ManagerHalf, type ManagerSlotKind } from "@/lib/phoenix-crm/manager-plan-rules";
import type { DistrictManagerDay, ManagerBoardDay, ManagerBoardScope, ManagerBoardSlot, ManagerBoardSlotCustomer, ManagerPlanBoardView } from "@/lib/phoenix-crm/view-types";

/**
 * Phoenix CRM — A MANAGER'S OWN WEEK AT A GLANCE, on the plan board (owner, 2026-11-09: "eyeball every report in My
 * Team's Reports, premium polish big work, every single component"; Plan your week in Phoenix CRM is the sixth item of
 * Dr. Hany Saad's menu, and his fifth need is "know who he goes with and whom he will visit").
 *
 * Pure: it reads the board the server answered and nothing else, so the panel, the Excel file and the tests read one
 * arithmetic.
 *
 * 🔴 THE SAVED WEEK ONLY. A half-day typed but not saved yet is never counted — the board's own "Not saved yet" says so
 *    where it is typed. The glance is what an approver would read if the week were sent now.
 * 🔴 A HOLIDAY AND A DAY WITH NO HALF ARE NOT FIELD DAYS — they are shown, never counted as open.
 * 🔴 A HALF ON A DAY THAT HAS PASSED IS NEVER "STILL OPEN" — it cannot be planned any more; it is counted apart.
 * 🔴 A CUSTOMER TICKED ON TWO HALF-DAYS IS TWO TICKS AND ONE CUSTOMER — the grades count customers, never ticks.
 * 🔴 NO KIND IS A WARNING COLOUR — a half-day kind is a fact about the week, never a judgement.
 */

export type ManagerGlanceView = Pick<ManagerPlanBoardView, "days" | "scopes" | "slotKinds" | "customersOptional">;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "Sat 7" — the short day the grid, the open list and the file use. */
export function managerGlanceShortDay(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  const at = new Date(Date.UTC(year, month - 1, day, 12));
  return `${WEEKDAY_SHORT[at.getUTCDay()]} ${day}`;
}

/** The word for a half: "Sat 7 AM". */
export function managerGlanceHalfName(date: string, half: ManagerHalf): string {
  return `${managerGlanceShortDay(date)} ${half}`;
}

// ── The kinds ──────────────────────────────────────────────────────────────────────────────────

/** Every kind, in the order the form offers them. */
export const MANAGER_GLANCE_KINDS: readonly ManagerSlotKind[] = MANAGER_SLOT_KINDS.map((entry) => entry.key);

/** The flat swatch of each kind — the same colours as District Managers' Plans, and none is a warning colour. */
export const MANAGER_GLANCE_KIND_SWATCH: Record<ManagerSlotKind, string> = {
  admin: "bg-slate-500",
  single_visit: "bg-violet-700",
  with_area: "bg-teal-700",
  with_dm: "bg-indigo-700",
  with_rep: "bg-sky-700",
  with_senior: "bg-indigo-500",
};

/** The left edge a planned half wears on the grid, in its kind's colour. */
export const MANAGER_GLANCE_KIND_EDGE: Record<ManagerSlotKind, string> = {
  admin: "border-l-slate-500",
  single_visit: "border-l-violet-700",
  with_area: "border-l-teal-700",
  with_dm: "border-l-indigo-700",
  with_rep: "border-l-sky-700",
  with_senior: "border-l-indigo-500",
};

/** A kind's words as this planner's board offers them (a senior manager's "With a peer" included), else the form's. */
export function managerGlanceKindLabel(view: Pick<ManagerGlanceView, "slotKinds">, kind: ManagerSlotKind): string {
  return view.slotKinds.find((entry) => entry.key === kind)?.label ?? MANAGER_SLOT_KINDS.find((entry) => entry.key === kind)?.label ?? kind;
}

// ── The days ───────────────────────────────────────────────────────────────────────────────────

/** A day with somewhere to be: not a holiday and with at least one half to plan. */
export function isManagerFieldDay(day: Pick<ManagerBoardDay, "holiday" | "halves">): boolean {
  return !day.holiday && day.halves.length > 0;
}

/** A half planned on the saved week: a slot for it with a kind. */
export function managerSavedSlot(day: Pick<ManagerBoardDay, "slots">, half: ManagerHalf): ManagerBoardSlot | null {
  return day.slots.find((slot) => slot.half === half && slot.kind !== null) ?? null;
}

/**
 * Whether a day reads as finished on the day list: both its halves — or one, where AM and PM are each optional
 * (a national sales manager and the Group Product Manager, `customersOptional`).
 */
export function managerDayIsPlanned(day: Pick<ManagerBoardDay, "halves" | "slots">, anyHalfIsEnough: boolean): boolean {
  const planned = (half: ManagerHalf) => managerSavedSlot(day, half) !== null;
  return day.halves.length > 0 && (anyHalfIsEnough ? day.halves.some(planned) : day.halves.every(planned));
}

/** What the board knows of a half typed but not saved: whether it can save, and if not, why. */
export type ManagerWaitingHalf = { problem: string | null };

/**
 * The day step's note under each day: "AM: With Ahmed Ali · 6 customers · PM: Nothing planned". A half typed and not
 * saved says so — and why it cannot save, when it cannot — because the saved summary would be stale.
 */
export function managerDayNote(day: Pick<ManagerBoardDay, "holiday" | "halves" | "slots">, waitingOf: (half: ManagerHalf) => ManagerWaitingHalf | null): string {
  if (day.holiday) return `${day.holiday} · no plan`;
  if (day.halves.length === 0) return "No field day";
  return day.halves
    .map((half) => {
      const waiting = waitingOf(half);
      const summary = waiting
        ? waiting.problem
          ? `Not saved: ${waiting.problem}`
          : "Not saved yet"
        : (day.slots.find((slot) => slot.half === half)?.summary ?? "Nothing planned");
      return `${half}: ${summary}`;
    })
    .join(" · ");
}

/** "2 of 5 areas ticked" — a With a district manager or a With my manager half's area count. */
export function managerAreasTickedLine(ticked: number, offered: number): string {
  return `${ticked} of ${offered} ${offered === 1 ? "area" : "areas"} ticked`;
}

// ── One cell of the week ───────────────────────────────────────────────────────────────────────

export type ManagerGlanceCellState = "planned" | "open" | "passed_open";

export type ManagerGlanceCell = {
  half: ManagerHalf;
  state: ManagerGlanceCellState;
  kind: ManagerSlotKind | null;
  /** The saved summary ("With Ahmed Ali · 6 customers"), or the words for an empty half. */
  text: string;
  customers: number;
};

export type ManagerGlanceDayRow = {
  date: string;
  dateText: string;
  shortDay: string;
  holiday: string | null;
  passed: boolean;
  fieldDay: boolean;
  /** The halves this day holds, AM first — Thursday has its morning only; a holiday none. */
  cells: ManagerGlanceCell[];
  /** Planned as the day list judges it. */
  planned: boolean;
};

/** The words an empty half reads: still to plan, or passed and never planned. */
export const MANAGER_GLANCE_OPEN_WORDS = "Nothing planned yet";
export const MANAGER_GLANCE_PASSED_WORDS = "Passed · nothing was planned";

function cellOf(day: ManagerBoardDay, half: ManagerHalf): ManagerGlanceCell {
  const slot = managerSavedSlot(day, half);
  if (slot) return { customers: slot.customers.length, half, kind: slot.kind, state: "planned", text: slot.summary ?? slot.kindLabel ?? "Planned" };
  return day.passed
    ? { customers: 0, half, kind: null, state: "passed_open", text: MANAGER_GLANCE_PASSED_WORDS }
    : { customers: 0, half, kind: null, state: "open", text: MANAGER_GLANCE_OPEN_WORDS };
}

/** The week's grid: one row per day the board holds, Saturday first, each with its AM and PM. */
export function managerGlanceDays(view: Pick<ManagerGlanceView, "days" | "customersOptional">): ManagerGlanceDayRow[] {
  return view.days.map((day) => {
    const fieldDay = isManagerFieldDay(day);
    return {
      cells: fieldDay ? day.halves.map((half) => cellOf(day, half)) : [],
      date: day.date,
      dateText: day.dateText,
      fieldDay,
      holiday: day.holiday,
      passed: day.passed,
      planned: fieldDay && managerDayIsPlanned(day, view.customersOptional),
      shortDay: managerGlanceShortDay(day.date),
    };
  });
}

/** What a day row reads when it has no half to plan: its holiday, or no field day. */
export function managerGlanceNoFieldWords(row: Pick<ManagerGlanceDayRow, "holiday">): string {
  return row.holiday ? `${row.holiday} · no plan` : "No field day";
}

/** The day's own word under its name: passed, planned, still open, a holiday, or no field day. */
export function managerGlanceDayState(row: Pick<ManagerGlanceDayRow, "fieldDay" | "holiday" | "passed" | "planned">): string {
  if (row.passed) return "Passed";
  if (row.fieldDay) return row.planned ? "Planned" : "Still open";
  return row.holiday ? "Holiday" : "No field day";
}

/**
 * A half the day does not hold (Thursday has its morning only): said by which half it is. The grid read "No afternoon
 * to plan" under Morning too, on a day holding its afternoon only.
 */
export function managerGlanceMissingHalfWords(half: ManagerHalf): string {
  return half === "AM" ? "No morning to plan" : "No afternoon to plan";
}

/**
 * The grid as text — Day, its word, Morning, Afternoon — for the file's Week sheet, so the file reads as the screen's
 * grid does: a holiday across both halves, a missing half by its name.
 */
export function managerGlanceGridRow(row: ManagerGlanceDayRow): [string, string, string, string] {
  if (!row.fieldDay) return [row.dateText, managerGlanceDayState(row), managerGlanceNoFieldWords(row), ""];
  const textOf = (half: ManagerHalf) => row.cells.find((cell) => cell.half === half)?.text ?? managerGlanceMissingHalfWords(half);
  return [row.dateText, managerGlanceDayState(row), textOf("AM"), textOf("PM")];
}

// ── The customers ──────────────────────────────────────────────────────────────────────────────

export const MANAGER_GLANCE_GRADES = ["A", "B", "C", "none"] as const;
export type ManagerGlanceGrade = (typeof MANAGER_GLANCE_GRADES)[number];

/** "A", "B" or "C" whatever the list holds ("a", " B "); anything else is no grade. */
export function managerGlanceGrade(value: string | null | undefined): ManagerGlanceGrade {
  const grade = (value ?? "").trim().toUpperCase();
  return grade === "A" || grade === "B" || grade === "C" ? grade : "none";
}

/** One customer, the same whichever half names them: the list's id, Manager's own list's id, or the name folded. */
export function managerGlanceCustomerKey(customer: Pick<ManagerBoardSlotCustomer, "customerId" | "managerCustomerId" | "name">): string {
  if (customer.customerId) return `c:${customer.customerId}`;
  if (customer.managerCustomerId) return `m:${customer.managerCustomerId}`;
  return `n:${customer.name.trim().toLowerCase()}`;
}

export type ManagerGlanceCustomers = {
  /** Every tick of the saved week — one customer on two half-days is two ticks. */
  ticked: number;
  /** The different customers behind them. */
  distinct: number;
  /** Different customers by grade. */
  byGrade: Record<ManagerGlanceGrade, number>;
  /** Different customers from Manager's own list. */
  own: number;
  /** Different customers the board flags (no longer on the rep's day, off the list). */
  flagged: Array<{ name: string; flagLabel: string }>;
  /** Ticked on more than one half-day, most first, then by name. */
  repeated: Array<{ name: string; times: number }>;
};

export function managerGlanceCustomers(days: ReadonlyArray<Pick<ManagerBoardDay, "holiday" | "halves" | "slots">>): ManagerGlanceCustomers {
  const byKey = new Map<string, { customer: ManagerBoardSlotCustomer; times: number }>();
  let ticked = 0;
  for (const day of days) {
    if (!isManagerFieldDay(day)) continue;
    for (const half of day.halves) {
      const slot = managerSavedSlot(day, half);
      for (const customer of slot?.customers ?? []) {
        ticked += 1;
        const key = managerGlanceCustomerKey(customer);
        const held = byKey.get(key);
        if (held) {
          held.times += 1;
          // A flag on any half is the customer's flag: the later half may be the one the rep dropped.
          if (!held.customer.flag && customer.flag) held.customer = { ...held.customer, flag: customer.flag, flagLabel: customer.flagLabel };
        } else {
          byKey.set(key, { customer, times: 1 });
        }
      }
    }
  }
  const byGrade: Record<ManagerGlanceGrade, number> = { A: 0, B: 0, C: 0, none: 0 };
  let own = 0;
  const flagged: ManagerGlanceCustomers["flagged"] = [];
  for (const { customer } of byKey.values()) {
    byGrade[managerGlanceGrade(customer.grade)] += 1;
    if (customer.own) own += 1;
    if (customer.flag) flagged.push({ flagLabel: customer.flagLabel ?? "Flagged", name: customer.name });
  }
  flagged.sort((left, right) => left.name.localeCompare(right.name));
  const repeated = [...byKey.values()]
    .filter((entry) => entry.times > 1)
    .map((entry) => ({ name: entry.customer.name, times: entry.times }))
    .sort((left, right) => right.times - left.times || left.name.localeCompare(right.name));
  return { byGrade, distinct: byKey.size, flagged, own, repeated, ticked };
}

// ── The people and the districts ───────────────────────────────────────────────────────────────

/**
 * What a planner's choice of where to plan is: a district manager's district (a regional or national sales manager,
 * a product manager), a whole line with no district manager ("Any rep in Pedia"), or a region (the Training Manager,
 * owner 2026-10-24). The glance and its file word each one as what it is — never "a vacant seat" for a line or a region.
 */
export type ManagerGlanceScopeKind = "district" | "line" | "region";

export function managerGlanceScopeKind(scope: Pick<ManagerBoardScope, "dmSeatId" | "regionCode">): ManagerGlanceScopeKind {
  if (scope.regionCode) return "region";
  return scope.dmSeatId ? "district" : "line";
}

export type ManagerGlanceDistrict = {
  key: string;
  /** "Delta (1) · Pedia — Nermeen Adel", as the district manager picker names it. */
  name: string;
  dmName: string | null;
  /** A district, a whole line or a region — from the scope the half was planned in; a district when none is found. */
  kind: ManagerGlanceScopeKind;
  halves: number;
  /** The different days the district is in the week. */
  days: number;
  /** Of those halves, the ones spent with the district manager. */
  withDm: number;
};

export type ManagerGlancePerson = { name: string; halves: number; halfNames: string[] };

function districtOf(view: Pick<ManagerGlanceView, "scopes">, slot: ManagerBoardSlot): Pick<ManagerGlanceDistrict, "dmName" | "key" | "kind" | "name"> | null {
  if (slot.scopeKey) {
    const scope = view.scopes.find((entry) => entry.key === slot.scopeKey);
    return {
      dmName: scope?.dmName ?? slot.dmName,
      key: slot.scopeKey,
      kind: scope ? managerGlanceScopeKind(scope) : "district",
      name: scope?.name ?? slot.scopeName ?? slot.dmName ?? "A district",
    };
  }
  if (slot.kind === "with_dm" && slot.dmName) return { dmName: slot.dmName, key: `dm:${slot.dmName}`, kind: "district", name: slot.dmName };
  return null;
}

/** Who a district of the week is planned with, for the file's second column: the district manager, or what it is. */
export function managerGlanceDistrictWho(district: Pick<ManagerGlanceDistrict, "dmName" | "kind">): string {
  if (district.dmName) return district.dmName;
  if (district.kind === "region") return "The whole region";
  if (district.kind === "line") return "Any rep of the line";
  return "Seat is vacant";
}

/**
 * The words for where this planner plans, on the screen and in the file alike. A board whose every choice is a region
 * (the Training Manager's) speaks of regions; every other board of district managers. The empty line names no kind of
 * half: the list counts every half planned in a district, not only the ones with its district manager.
 */
export type ManagerGlanceScopeWords = {
  /** The tile's label and the file's column head. */
  label: string;
  /** One of them, for a table column. */
  column: string;
  /** The section's title. */
  title: string;
  /** Nothing planned in any of them yet. */
  none: string;
  /** Every one offered is in the week. */
  every: string;
  /** The file's note over the table of them. */
  note: string;
};

export function managerGlanceScopeWords(view: Pick<ManagerGlanceView, "scopes">): ManagerGlanceScopeWords {
  const regions = view.scopes.length > 0 && view.scopes.every((scope) => managerGlanceScopeKind(scope) === "region");
  return regions
    ? {
        column: "Region",
        every: "Every region offered is in the week.",
        label: "Regions",
        none: "No half-day is planned in a region yet.",
        note: "Every region this planner plans in; the ones the week does not go to are listed last.",
        title: "Regions in the week",
      }
    : {
        column: "District",
        every: "Every district manager offered is in the week.",
        label: "District managers",
        none: "No half-day is planned in a district yet.",
        note: "Every district manager this planner plans with; the ones the week does not go to are listed last.",
        title: "District managers in the week",
      };
}

function addPerson(people: Map<string, ManagerGlancePerson>, name: string, halfName: string) {
  const held = people.get(name) ?? { halfNames: [], halves: 0, name };
  held.halves += 1;
  held.halfNames.push(halfName);
  people.set(name, held);
}

// ── The whole week ─────────────────────────────────────────────────────────────────────────────

export type ManagerGlance = {
  /** Days with a half to plan, a holiday left out. */
  fieldDays: number;
  /** Every half of those days. */
  halves: number;
  planned: number;
  /** Empty halves still ahead — the ones that can still be planned. */
  open: number;
  /** Empty halves on days that have passed. */
  passedOpen: number;
  /** Days finished as the day list judges them. */
  daysPlanned: number;
  byKind: Record<ManagerSlotKind, number>;
  /** The kinds to show in the key: every kind this planner is offered, and any other a saved half holds. */
  kinds: ManagerSlotKind[];
  /** The empty halves still ahead, in order — "Mon 9 AM". */
  openHalves: Array<{ date: string; half: ManagerHalf; name: string }>;
  /** The districts the week goes to, most half-days first. Empty for a district manager, who plans his own district. */
  districts: ManagerGlanceDistrict[];
  /** The districts this planner could go to and the week does not, by name. Empty when nothing is offered. */
  districtsNotIn: string[];
  /** The reps the week goes with, most half-days first. */
  reps: ManagerGlancePerson[];
  /** The district managers and senior managers the week goes with, most half-days first. */
  managers: ManagerGlancePerson[];
  customers: ManagerGlanceCustomers;
  rows: ManagerGlanceDayRow[];
};

export function managerWeekGlance(view: ManagerGlanceView): ManagerGlance {
  const rows = managerGlanceDays(view);
  const byKind = Object.fromEntries(MANAGER_GLANCE_KINDS.map((kind) => [kind, 0])) as Record<ManagerSlotKind, number>;
  const openHalves: ManagerGlance["openHalves"] = [];
  const districts = new Map<string, ManagerGlanceDistrict & { dates: Set<string> }>();
  const reps = new Map<string, ManagerGlancePerson>();
  const managers = new Map<string, ManagerGlancePerson>();
  let halves = 0;
  let planned = 0;
  let passedOpen = 0;
  for (const day of view.days) {
    if (!isManagerFieldDay(day)) continue;
    for (const half of day.halves) {
      halves += 1;
      const slot = managerSavedSlot(day, half);
      const halfName = managerGlanceHalfName(day.date, half);
      if (!slot || !slot.kind) {
        if (day.passed) passedOpen += 1;
        else openHalves.push({ date: day.date, half, name: halfName });
        continue;
      }
      planned += 1;
      byKind[slot.kind] += 1;
      const district = districtOf(view, slot);
      if (district) {
        const held = districts.get(district.key) ?? { ...district, dates: new Set<string>(), days: 0, halves: 0, withDm: 0 };
        held.halves += 1;
        held.dates.add(day.date);
        if (slot.kind === "with_dm") held.withDm += 1;
        districts.set(district.key, held);
      }
      if (slot.kind === "with_rep" && slot.repName) addPerson(reps, slot.repName, halfName);
      if (slot.kind === "with_dm" && slot.dmName) addPerson(managers, slot.dmName, halfName);
      if (slot.kind === "with_senior" && slot.seniorName) addPerson(managers, slot.seniorName, halfName);
    }
  }
  const byMost = <T extends { halves: number; name: string }>(left: T, right: T) => right.halves - left.halves || left.name.localeCompare(right.name);
  const districtList = [...districts.values()].map(({ dates, ...rest }) => ({ ...rest, days: dates.size })).sort(byMost);
  const inWeek = new Set(districtList.map((entry) => entry.key));
  const offered = new Set(view.slotKinds.map((entry) => entry.key));
  return {
    byKind,
    customers: managerGlanceCustomers(view.days),
    daysPlanned: rows.filter((row) => row.planned).length,
    districts: districtList,
    districtsNotIn: view.scopes.filter((scope) => !inWeek.has(scope.key)).map((scope) => scope.name),
    fieldDays: rows.filter((row) => row.fieldDay).length,
    halves,
    kinds: MANAGER_GLANCE_KINDS.filter((kind) => offered.has(kind) || byKind[kind] > 0),
    managers: [...managers.values()].sort(byMost),
    open: openHalves.length,
    openHalves,
    passedOpen,
    planned,
    reps: [...reps.values()].sort(byMost),
    rows,
  };
}

// ── The bar ────────────────────────────────────────────────────────────────────────────────────

/**
 * Whole per cent shares that always add up to exactly 100 — the largest-remainder method, as District Managers'
 * Plans uses: each share is floored, then the points left go to the largest remainders, ties to the first.
 * Nothing to share is all zeros.
 */
export function managerGlanceShares(counts: readonly number[]): number[] {
  const total = counts.reduce((sum, count) => sum + Math.max(0, count), 0);
  if (total === 0) return counts.map(() => 0);
  const exact = counts.map((count) => (Math.max(0, count) * 100) / total);
  const shares = exact.map(Math.floor);
  let left = 100 - shares.reduce((sum, share) => sum + share, 0);
  const order = exact.map((value, index) => ({ index, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    if (counts[index] <= 0) continue;
    shares[index] += 1;
    left -= 1;
  }
  return shares;
}

export type ManagerGlanceBarPart = { kind: ManagerSlotKind; label: string; count: number; share: number; swatch: string };

/** The planned half-days by kind, as one flat bar: only the kinds with a half; the shares add up to 100. */
export function managerGlanceKindBar(view: Pick<ManagerGlanceView, "slotKinds">, glance: Pick<ManagerGlance, "byKind" | "kinds">): ManagerGlanceBarPart[] {
  const kinds = glance.kinds.filter((kind) => glance.byKind[kind] > 0);
  const shares = managerGlanceShares(kinds.map((kind) => glance.byKind[kind]));
  return kinds.map((kind, index) => ({ count: glance.byKind[kind], kind, label: managerGlanceKindLabel(view, kind), share: shares[index], swatch: MANAGER_GLANCE_KIND_SWATCH[kind] }));
}

// ── The words ──────────────────────────────────────────────────────────────────────────────────

function halfDays(count: number): string {
  return `${count} ${count === 1 ? "half-day" : "half-days"}`;
}

/** "9 of 11 half-days planned" — or "No field half-day this week". */
export function managerGlancePlannedLine(glance: Pick<ManagerGlance, "planned" | "halves">): string {
  if (glance.halves === 0) return "No field half-day this week";
  return `${glance.planned} of ${halfDays(glance.halves)} planned`;
}

/** "2 still to plan · 1 passed with nothing planned" — or "Every half-day is planned". */
export function managerGlanceOpenLine(glance: Pick<ManagerGlance, "open" | "passedOpen" | "halves">): string {
  if (glance.halves === 0) return "Nothing to plan";
  const parts: string[] = [];
  if (glance.open > 0) parts.push(`${glance.open} still to plan`);
  if (glance.passedOpen > 0) parts.push(`${glance.passedOpen} passed with nothing planned`);
  return parts.length > 0 ? parts.join(" · ") : "Every half-day is planned";
}

/** "With a rep 5 · Admin 2" — the kinds with a half, in the form's order; "Nothing planned yet" with none. */
export function managerGlanceKindsLine(view: Pick<ManagerGlanceView, "slotKinds">, glance: Pick<ManagerGlance, "byKind" | "kinds">): string {
  const parts = glance.kinds.filter((kind) => glance.byKind[kind] > 0).map((kind) => `${managerGlanceKindLabel(view, kind)} ${glance.byKind[kind]}`);
  return parts.length > 0 ? parts.join(" · ") : MANAGER_GLANCE_OPEN_WORDS;
}

/** "3 half-days on 2 days · 1 with the district manager". */
export function managerGlanceDistrictLine(district: Pick<ManagerGlanceDistrict, "halves" | "days" | "withDm">): string {
  const base = `${halfDays(district.halves)} on ${district.days} ${district.days === 1 ? "day" : "days"}`;
  return district.withDm > 0 ? `${base} · ${district.withDm} with the district manager` : base;
}

/** "Ahmed Ali 2 · Mai Hassan 1" — the people, most first; null with none. */
export function managerGlancePeopleLine(people: readonly ManagerGlancePerson[]): string | null {
  return people.length > 0 ? people.map((person) => `${person.name} ${person.halves}`).join(" · ") : null;
}

/** "12 ticks · 10 different customers" — or "No customer ticked". */
export function managerGlanceCustomerLine(customers: Pick<ManagerGlanceCustomers, "ticked" | "distinct">): string {
  if (customers.ticked === 0) return "No customer ticked";
  return `${customers.ticked} ${customers.ticked === 1 ? "tick" : "ticks"} · ${customers.distinct} different ${customers.distinct === 1 ? "customer" : "customers"}`;
}

/** "4 A · 3 B · 2 C · 1 with no grade" — the grades with customers; null with none. */
export function managerGlanceGradeLine(customers: Pick<ManagerGlanceCustomers, "byGrade" | "distinct">): string | null {
  if (customers.distinct === 0) return null;
  return MANAGER_GLANCE_GRADES.filter((grade) => customers.byGrade[grade] > 0)
    .map((grade) => (grade === "none" ? `${customers.byGrade[grade]} with no grade` : `${customers.byGrade[grade]} ${grade}`))
    .join(" · ");
}

/** The share of the graded customers that are A, in whole per cent; null with no graded customer. */
export function managerGlanceAShare(customers: Pick<ManagerGlanceCustomers, "byGrade">): number | null {
  const graded = customers.byGrade.A + customers.byGrade.B + customers.byGrade.C;
  return graded === 0 ? null : Math.round((customers.byGrade.A * 100) / graded);
}

/** "Ticked more than once: Dr. Mona Saleh ×2" — null with none. */
export function managerGlanceRepeatedLine(customers: Pick<ManagerGlanceCustomers, "repeated">): string | null {
  if (customers.repeated.length === 0) return null;
  return `Ticked more than once: ${customers.repeated.map((entry) => `${entry.name} ×${entry.times}`).join(" · ")}`;
}

/** "Still open: Mon 9 AM · Tue 10 PM" — null when nothing ahead is open. */
export function managerGlanceOpenHalvesLine(glance: Pick<ManagerGlance, "openHalves">): string | null {
  return glance.openHalves.length > 0 ? `Still open: ${glance.openHalves.map((entry) => entry.name).join(" · ")}` : null;
}

// ── The district manager's own day, as the senior manager's board shows it ─────────────────────

// ── The Excel file's doors ─────────────────────────────────────────────────────────────────────

/**
 * The week as Excel from the Approvals Hub (owner, 2026-11-09): the export route's `?plan=` door, which opens the week
 * through `loadManagerPlanHubDetail` — the same proof as the hub's own page — so whoever may read the week there may
 * download it, and nobody else. The board's own door is `?week=&manager=`, built on the board.
 */
export function managerHubWeekExportHref(planId: string): string {
  return `/api/phoenix-crm/manager-plans/export?plan=${encodeURIComponent(planId)}`;
}

/**
 * An empty half on the Approvals Hub's half-by-half read. A sent week is read, not planned, so it never says "yet":
 * the half was left empty when the week was saved.
 */
export const MANAGER_HUB_EMPTY_HALF_WORDS = "Nothing planned for this half";

// ── The Send step ──────────────────────────────────────────────────────────────────────────────

/** A half typed on the board and not saved yet: its kind, and why it cannot save (null when it can). */
export type ManagerSendWaiting = { kind: ManagerSlotKind | null; problem: string | null };

export type ManagerSendTally = {
  /** Half-days still to come that will go with the week: saved, or typed and able to save. */
  planned: number;
  /** Every half of the days still to come. */
  fieldHalves: number;
  /** The halves of the days still open to plan that go empty — "Tuesday 10 November PM". */
  emptyHalves: string[];
  /** Ticks the board flags (no longer on the rep's day) — every tick, the way the Send step has always said it. */
  offRepDay: number;
};

/**
 * What the Send step counts before the week goes (moved here 2026-11-09 from the board, so the step and the glance
 * read one module). Unlike the glance it counts the halves typed and not saved yet — Send saves them first — and only
 * the days still to come: a passed day is history, never a gap to fill (owner walk, 2026-10-28: "2 of 11 planned" on
 * a Tuesday counted Saturday to Monday against him). A typed half counts when it has a kind and nothing stops it.
 */
export function managerSendTally(
  days: ReadonlyArray<Pick<ManagerBoardDay, "date" | "dateText" | "editable" | "halves" | "passed" | "slots">>,
  waitingOf: (date: string, half: ManagerHalf) => ManagerSendWaiting | null,
): ManagerSendTally {
  const isPlanned = (day: (typeof days)[number], half: ManagerHalf) => {
    const waiting = waitingOf(day.date, half);
    if (waiting) return waiting.kind !== null && !waiting.problem;
    return managerSavedSlot(day, half) !== null;
  };
  const coming = days.filter((day) => !day.passed);
  return {
    emptyHalves: coming.flatMap((day) => (day.editable ? day.halves.filter((half) => !isPlanned(day, half)).map((half) => `${day.dateText} ${half}`) : [])),
    fieldHalves: coming.reduce((sum, day) => sum + day.halves.length, 0),
    offRepDay: days.reduce((sum, day) => sum + day.slots.reduce((inDay, slot) => inDay + slot.customers.filter((customer) => customer.flag).length, 0), 0),
    planned: coming.reduce((sum, day) => sum + day.halves.filter((half) => isPlanned(day, half)).length, 0),
  };
}

export type DistrictManagerDayStanding = DistrictManagerDay["standing"];

/**
 * The pill on a district manager's own day (owner, 2026-11-08). One set of words, never a sentence put together on
 * the screen: "Draft · not sent yet" said the same thing twice, and a week returned for changes wore a sent week's
 * colour. A sent week reads its own status (an ended one included); an approved one is good; a returned week or a
 * draft may still change. The tone follows `standing`, never the words.
 */
/**
 * What follows a doctor's name on the district manager's own day: speciality, grade read whatever its case, and — for
 * a doctor no longer on the list — words, not a strike-through alone, which a screen reader never says.
 */
export function districtManagerDayCustomerTail(customer: { speciality: string | null; grade: string | null; gone: boolean }): string {
  const grade = managerGlanceGrade(customer.grade);
  const parts = [customer.speciality?.trim() || null, grade === "none" ? null : `Grade ${grade}`, customer.gone ? "No longer on the list" : null];
  return parts.filter((part): part is string => part !== null).map((part) => ` · ${part}`).join("");
}

export function districtManagerDayPill(day: Pick<DistrictManagerDay, "statusLabel" | "standing">): { text: string; tone: "good" | "info" | "warn" | "neutral" } {
  if (day.standing === "approved") return { text: day.statusLabel, tone: "good" };
  if (day.standing === "waiting") return { text: day.statusLabel, tone: "info" };
  if (day.standing === "returned") return { text: "Returned for changes · may still change", tone: "warn" };
  if (day.standing === "draft") return { text: "Draft · may still change", tone: "warn" };
  return { text: "Not started", tone: "neutral" };
}
