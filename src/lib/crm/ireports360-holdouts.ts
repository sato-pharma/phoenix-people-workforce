import type { PhoenixTeamState } from "@/lib/crm/phoenix-team-starts";

/**
 * WHO STILL RECORDS A DAY ONLY IN iREPORTS360 (owner, 2026-11-03).
 *
 * The runbook's gate for closing iReports360 ("Nobody is still counted from iReports360",
 * `docs/crm-cutover-runbook.md`) was one SQL query by hand. This is that question as a tab on the CRM
 * hub, per person: a day recorded only there comes up empty the moment the vendor is closed.
 *
 * 🔴 IT REPORTS AND NEVER DECIDES. No closing, retiring, cutover date or team start is offered from it,
 * and it says "ready" about nobody: an empty list means only that nobody appears in this window.
 *
 * WHAT COUNTS ON EACH SIDE.
 *   - iReports360: a vendor row's own rep, or its real double partner. `double_hr_id` alone is not a
 *     partner on a vendor row (REAL_DOUBLE_PARTNER_OR_FILTER): the crm id has to be real too.
 *   - Phoenix: a visit or a day activity (`phoenixWorkEvidenceProvesWorkedDay`), or a manager's own single
 *     visit. A bare day-start press proves nothing and the loader leaves it out.
 *
 * Nobody is hidden. A person with no charge, or a manager who keeps both apps by ruling, wears a tag and
 * stays on the list, because whether they matter is the owner's reading.
 */

/** The runbook's own window. */
export const HOLDOUT_WINDOW_DAYS = 14;

export const IREPORTS360_SOURCE = "ireports360";

export type HoldoutVisitRow = {
  source?: string | null;
  visit_date?: string | null;
  agent_hr_id?: string | null;
  double_hr_id?: string | null;
  double2_hr_id?: string | null;
  double_crm_id?: number | string | null;
  partner_credit_only?: boolean | null;
};

export type HoldoutDay = { key: string; date: string; via: "own" | "partner" };

export type HoldoutTag = "keeps both apps by ruling" | "no CRM charge" | "no deduction" | "leaving or left";

export type HoldoutTeam = { team: string; state: PhoenixTeamState; startsOn: string | null };

export type HoldoutPerson = {
  name: string;
  tag: HoldoutTag | null;
  teams: readonly HoldoutTeam[];
};

export type HoldoutRow = {
  key: string;
  name: string;
  tag: HoldoutTag | null;
  teams: readonly HoldoutTeam[];
  /** No Phoenix day at all in the window. */
  onlyIReports360: boolean;
  daysOnlyThere: number;
  lastDayOnlyThere: string;
  /** Of those days, the ones they stand on only as somebody else's double partner. */
  daysOnSomeoneElsesRow: number;
};

export type HoldoutsReport = {
  rows: HoldoutRow[];
  onlyIReports360: number;
  recordsInBoth: number;
  personDaysOnlyThere: number;
  /** Vendor rows naming nobody the directory holds, or with no HR id yet. Named so they are not lost. */
  rowsOutsideThisList: number;
};

function isRealCrmId(value: number | string | null | undefined): boolean {
  if (value === null || value === undefined || value === "") return false;
  return Number(value) !== 0;
}

/**
 * The vendor rows turned into credited days. A Phoenix row out of the same door is dropped: the door
 * serves a started team's Phoenix visits too, and those are the other side of the question.
 */
export function vendorDaysFromRows(
  rows: readonly HoldoutVisitRow[],
  keyOf: (hrId: string) => string,
): { days: HoldoutDay[]; rowsNamingNobody: number } {
  const days: HoldoutDay[] = [];
  let rowsNamingNobody = 0;
  for (const row of rows) {
    if (row.source !== IREPORTS360_SOURCE) continue;
    const date = String(row.visit_date ?? "").slice(0, 10);
    if (!date) continue;
    const own = row.partner_credit_only ? "" : keyOf(String(row.agent_hr_id ?? ""));
    if (own) days.push({ date, key: own, via: "own" });
    const partners = isRealCrmId(row.double_crm_id)
      ? [row.double_hr_id, row.double2_hr_id].map((hrId) => keyOf(String(hrId ?? ""))).filter(Boolean)
      : [];
    for (const key of partners) days.push({ date, key, via: "partner" });
    if (!own && partners.length === 0) rowsNamingNobody += 1;
  }
  return { days, rowsNamingNobody };
}

export function buildHoldoutsReport(input: {
  vendorDays: readonly HoldoutDay[];
  phoenixDays: readonly { key: string; date: string }[];
  people: ReadonlyMap<string, HoldoutPerson>;
  rowsNamingNobody: number;
}): HoldoutsReport {
  const phoenixByPerson = new Map<string, Set<string>>();
  for (const day of input.phoenixDays) {
    if (!day.key) continue;
    const held = phoenixByPerson.get(day.key) ?? new Set<string>();
    held.add(day.date);
    phoenixByPerson.set(day.key, held);
  }

  // Person -> day -> whether they stood on any row of their own that day.
  const vendorByPerson = new Map<string, Map<string, boolean>>();
  for (const day of input.vendorDays) {
    const held = vendorByPerson.get(day.key) ?? new Map<string, boolean>();
    held.set(day.date, (held.get(day.date) ?? false) || day.via === "own");
    vendorByPerson.set(day.key, held);
  }

  const rows: HoldoutRow[] = [];
  let rowsOutsideThisList = input.rowsNamingNobody;
  for (const [key, vendorDays] of vendorByPerson) {
    const person = input.people.get(key);
    if (!person) {
      rowsOutsideThisList += 1;
      continue;
    }
    const phoenix = phoenixByPerson.get(key);
    const onlyThere = [...vendorDays.keys()].filter((date) => !phoenix?.has(date)).sort();
    if (onlyThere.length === 0) continue;
    rows.push({
      daysOnSomeoneElsesRow: onlyThere.filter((date) => !vendorDays.get(date)).length,
      daysOnlyThere: onlyThere.length,
      key,
      lastDayOnlyThere: onlyThere[onlyThere.length - 1],
      name: person.name,
      onlyIReports360: !phoenix || phoenix.size === 0,
      tag: person.tag,
      teams: person.teams,
    });
  }

  rows.sort(
    (a, b) =>
      Number(b.onlyIReports360) - Number(a.onlyIReports360) || b.daysOnlyThere - a.daysOnlyThere || a.name.localeCompare(b.name),
  );
  return {
    onlyIReports360: rows.filter((row) => row.onlyIReports360).length,
    personDaysOnlyThere: rows.reduce((sum, row) => sum + row.daysOnlyThere, 0),
    recordsInBoth: rows.filter((row) => !row.onlyIReports360).length,
    rows,
    rowsOutsideThisList,
  };
}

/**
 * Who has no row on either side only because approved leave covered the window: every day of it but
 * Fridays. Shown as its own line, so a person who was simply away never reads as having moved.
 */
export function peopleOnLeaveAllWindow(input: {
  candidates: readonly string[];
  leaveDays: readonly { key: string; date: string }[];
  windowDays: readonly string[];
  appearing: ReadonlySet<string>;
}): string[] {
  const needed = input.windowDays.filter((date) => new Date(`${date}T00:00:00Z`).getUTCDay() !== 5);
  const byPerson = new Map<string, Set<string>>();
  for (const day of input.leaveDays) {
    const held = byPerson.get(day.key) ?? new Set<string>();
    held.add(day.date);
    byPerson.set(day.key, held);
  }
  return input.candidates.filter((key) => {
    if (input.appearing.has(key)) return false;
    const held = byPerson.get(key);
    return held !== undefined && needed.length > 0 && needed.every((date) => held.has(date));
  });
}
