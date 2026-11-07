// CRM-aware day maps for the weekly-digest reconciliation gate (see
// digest-reconcile.ts). Owner-confirmed addendum (2026-07-21): the digest
// engine previously only checked Phoenix's own vacation_requests/
// excuse_requests tables and (Tier-2 only) the weekly plan -- it had no
// awareness of CRM (iReports360) at all, so a day covered only by a
// CRM-recorded leave, or explained only by a real CRM field visit, was judged
// purely on device-punch timing. This module reads through the sanctioned CRM
// door (scanVisitsForRangeCreditingPartners) once per digest week and classifies each active
// employee's days using the SAME three-tier precedence as dayCellValue
// (field-workforce-compliance/ireports360-source.ts) and the leaver CRM
// classifier (automated-payroll/recommend.ts): a real regular visit always
// wins (proves a genuine field day); otherwise a CP-type entry (Conference,
// Group Meeting, Campaign, Training, Meeting, Traveling) ALSO counts as a
// legitimate field day — owner-confirmed 2026-07-21 after a post-settlement
// audit found two employees deducted on days they'd logged a real Campaign/
// Meeting visit — matching the precedent already used in those two other
// places rather than silently diverging from it; only when neither a regular
// nor a CP-type visit exists does an Annual-Vacation entry count as
// CRM-recorded leave.
//
// THE AV/CP RULING ITSELF LIVES IN ONE PLACE: src/lib/crm/visit-type-meaning.ts.
// This module used to hold a hand-kept third copy of it as two Sets, and that
// copy drifted (it kept Health Day (-15) as leave after the ruling, and never
// received the Public Holiday (-5) / Casual Leave (-6) ruling). It now reads the
// shared table.
//
// What is still different here is the LOOKUP, not the table: this module uses
// the STRICT lookup. A code the table does not list sets no flag at all, the day
// falls through the classification loop's `continue`, and NO cancel reaches
// reconcileDay — the day is then judged on device-punch timing alone. The
// Field Workforce Compliance matrix uses the lenient lookup and calls such a
// code CP. That is deliberate — silently cancelling a deduction for a code
// nobody has classified is the riskier default. While the iReports360 sync ran it
// raised an alert the first time an unclassified vendor code appeared, against
// CRM_DAY_CLASSIFIED_VISIT_TYPES below; the vendor was retired on 6 November 2026,
// so no new vendor code can arrive.
// If a new code ever appears, classify it in visit-type-meaning.ts, deliberately.

import { queryOwnVisitsOfDepartedAgents, queryVisits, scanVisitsForRangeCreditingPartners } from "@/lib/crm/reads";
import {
  describePhoenixWorkEvidence,
  indexPhoenixWorkEvidence,
  loadPhoenixWorkEvidenceDays,
  phoenixWorkEvidenceProvesWorkedDay,
} from "@/lib/crm/phoenix-work-evidence";
import {
  CRM_CLASSIFIED_NON_REGULAR_VISIT_TYPES,
  CRM_LEAVE_VISIT_TYPE_CODES,
  CRM_REGULAR_VISIT_TYPE,
  CRM_WORKING_VISIT_TYPE_CODES,
  crmVisitTypeMeaningStrict,
} from "@/lib/crm/visit-type-meaning";
import { resolveVisitTypeLabel } from "@/lib/crm/visit-types";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { isIsoDate } from "@/lib/attendance/working-days";
import { describeManagerOwnVisitDay, loadManagerOwnVisitDays } from "@/lib/phoenix-crm/server/manager-plan-readers";

/** Leave-day codes (the AV half of the shared table) — Annual Vacation (-4) only. Health Day
 * (-15), Public Holiday (-5) and Casual Leave (-6) are working time. Derived, never hand-listed. */
const CRM_LEAVE_VISIT_TYPES: ReadonlySet<number> = CRM_LEAVE_VISIT_TYPE_CODES;

/** Working-but-not-a-regular-visit codes (the CP half of the shared table). Treated identically to
 * a regular visit here: proof of real field/CRM-logged work that day, same "regular > CP > AV"
 * precedence as dayCellValue. Derived, never hand-listed. */
const CRM_CAMPAIGN_VISIT_TYPES: ReadonlySet<number> = CRM_WORKING_VISIT_TYPE_CODES;

/**
 * The AV/CP ruling as this module applies it — the STRICT lookup over the shared table.
 *
 * Returns undefined for a type the table does not list. That is this module's strict-whitelist
 * fall-through (no flag, no cancel) and deliberately NOT the lenient "CP" the Field Workforce
 * Compliance matrix applies — see the header note. A regular visit (type 0) is counted by
 * `regularCount` in the classification loop and never looked up, so it too returns undefined here.
 */
export function crmDayVisitTypeStatus(visitType: number): "AV" | "CP" | undefined {
  return crmVisitTypeMeaningStrict(visitType);
}

/**
 * Every visit type this module knows how to classify — the shared table's codes plus the
 * regular-visit code.
 *
 * Existed so the CRM sync could raise an alert when iReports360 sent a code the table did not list
 * (that alert was retired with the vendor, 6 November 2026). Such a code
 * falls through the classification loop to `continue`, setting no flag, so `reconcileDay` never
 * sees a cancel and the day is judged on device-punch timing alone.
 *
 * DERIVED from the shared table, never a hand-written list, so it cannot disagree with it.
 */
export const CRM_DAY_CLASSIFIED_VISIT_TYPES: ReadonlySet<number> = new Set<number>([
  CRM_REGULAR_VISIT_TYPE,
  ...CRM_CLASSIFIED_NON_REGULAR_VISIT_TYPES,
]);

export type CrmDayVisitRow = {
  visit_date: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
  comment: string | null;
  customer_name: string | null;
  agent_hr_id: string | null;
  double_hr_id: string | null;
  double2_hr_id: string | null;
};

/** Short human-readable label for the CRM entry that won a day (regular > CP > AV, same
 * precedence as the classification loop below) — so a consumer showing "CRM field visit" can
 * also show WHAT it was (e.g. "Meeting: Digital marketing meeting") instead of a bare boolean.
 * A stored "Unknown" takes the shared display label (a -16 day reads "Training: …"); every other
 * stored description is shown as the vendor sent it. Display only — the day's meaning comes from
 * the strict lookup above, never from this text. */
export function describeCrmDay(rows: CrmDayVisitRow[]): string | null {
  const regular = rows.find((row) => Number(row.visit_type ?? 0) === 0);
  const campaign = rows.find((row) => CRM_CAMPAIGN_VISIT_TYPES.has(Number(row.visit_type ?? 0)));
  const leave = rows.find((row) => CRM_LEAVE_VISIT_TYPES.has(Number(row.visit_type ?? 0)));
  const winner = regular ?? campaign ?? leave;
  if (!winner) return null;
  const stored = winner.visit_type_description?.trim();
  const label = stored
    ? resolveVisitTypeLabel(Number(winner.visit_type ?? 0), stored, winner.comment)
    : regular
      ? "Visit"
      : null;
  const detail = (winner.customer_name?.trim() || winner.comment?.trim() || "").slice(0, 120);
  if (!label) return detail || null;
  return detail ? `${label}: ${detail}` : label;
}

/**
 * The day's ruling from its CRM rows: "field" for a regular visit or a CP-type activity, "leave" for
 * the CRM's own leave code on a day with neither, null for a day holding only codes the table does
 * not list (the strict fall-through above). The ONE ruling {@link getCrmActivityDayMaps} applies,
 * exported so a reader of rows this module never fetched classifies them identically rather than
 * keeping a second copy (the Field Absence Calendar, for a departed person's own visits).
 */
export function crmDayKind(rows: ReadonlyArray<Pick<CrmDayVisitRow, "visit_type">>): "field" | "leave" | null {
  let regularCount = 0;
  let hasCampaignType = false;
  let hasLeaveType = false;
  for (const row of rows) {
    const visitType = Number(row.visit_type ?? 0);
    if (visitType === 0) regularCount += 1;
    else if (CRM_CAMPAIGN_VISIT_TYPES.has(visitType)) hasCampaignType = true;
    else if (CRM_LEAVE_VISIT_TYPES.has(visitType)) hasLeaveType = true;
  }
  if (regularCount > 0 || hasCampaignType) return "field";
  if (hasLeaveType) return "leave";
  return null;
}

export const DAY_MAP_VISIT_COLUMNS =
  "visit_date,visit_type,visit_type_description,comment,customer_name,agent_hr_id,double_hr_id,double2_hr_id";

/** Above this many distinct employees, fetching each person's own visits by index stops being
 * cheaper than one sequential window scan, so we fall back to the company-wide scan. The
 * per-employee day report asks for exactly one id; a small team is a handful — those are the cases
 * that were paying for a full-company scan and get the biggest win. The whole-company caller (the
 * fingerprint report) sits far above this and keeps the original single scan unchanged. */
const DAY_MAP_PUSHDOWN_MAX_IDS = 40;

/** Merge the agent-role and double-role visit pages into the SAME shape a single company-wide keyset
 * scan returns: one row per visit `id` (a visit whose agent AND double are both wanted is returned by
 * both reads — keep the first, they are the same row), ordered by `id` ascending so the downstream
 * classification counts and the `describeCrmDay` first-match label are byte-identical to the old scan.
 * Pure and side-effect-free so the merge/dedup/order is unit-tested without a database. */
export function mergeDayMapVisitPages<T extends { id: string }>(pages: ReadonlyArray<readonly T[]>): T[] {
  const byId = new Map<string, T>();
  for (const page of pages) {
    for (const row of page) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

type DayMapKeyedRow = CrmDayVisitRow & { id: string };

/**
 * The CRM reads the day map is assembled from — the real doors by default. Swappable so the rule that
 * assembles them is provable without a database (tests/crm-day-map-departed-own-visits.test.ts).
 */
export type DayMapVisitReaders = {
  /** Every company visit in the window, a departed agent's row kept for its partner only. */
  companyWindow: (dateFromIso: string, dateToIso: string) => Promise<DayMapKeyedRow[]>;
  asAgent: (dateFromIso: string, dateToIso: string, wantedIds: string[]) => Promise<DayMapKeyedRow[]>;
  asDouble: (dateFromIso: string, dateToIso: string, wantedIds: string[]) => Promise<DayMapKeyedRow[]>;
  /** What the departed people among `wantedIds` logged themselves, through their last working day. */
  ownRowsOfDeparted: (dateFromIso: string, dateToIso: string, wantedIds: string[]) => Promise<DayMapKeyedRow[]>;
};

const CRM_DOOR_DAY_MAP_READERS: DayMapVisitReaders = {
  companyWindow: (dateFromIso, dateToIso) =>
    scanVisitsForRangeCreditingPartners<DayMapKeyedRow>({
      dateFrom: dateFromIso,
      dateTo: dateToIso,
      columns: DAY_MAP_VISIT_COLUMNS,
    }),
  asAgent: (dateFromIso, dateToIso, wantedIds) =>
    queryVisits<DayMapKeyedRow>({ dateFrom: dateFromIso, dateTo: dateToIso, columns: DAY_MAP_VISIT_COLUMNS, agentHrIds: wantedIds }),
  // The double-role read asks about the people named on the DOUBLE side, so a row whose AGENT has
  // since resigned must still reach them: otherwise a manager's field day vanishes the day the rep
  // he spent it with leaves, and the fingerprint report then shows "no CRM activity" for a day he
  // provably worked (owner report 2026-10-07). The door nulls the departed agent's `agent_hr_id`,
  // and the gate below only ever credits an hr id in `wanted`, so nothing is credited to a leaver.
  asDouble: (dateFromIso, dateToIso, wantedIds) =>
    queryVisits<DayMapKeyedRow>({
      dateFrom: dateFromIso,
      dateTo: dateToIso,
      columns: DAY_MAP_VISIT_COLUMNS,
      doubleHrIds: wantedIds,
      creditDepartedAgentPartners: true,
    }),
  ownRowsOfDeparted: (dateFromIso, dateToIso, wantedIds) =>
    queryOwnVisitsOfDepartedAgents<DayMapKeyedRow>({
      columns: DAY_MAP_VISIT_COLUMNS,
      dateFrom: dateFromIso,
      dateTo: dateToIso,
      hrIds: wantedIds,
    }),
};

/**
 * Fetch exactly the visits the day map needs for `wantedIds` over the window.
 *
 * For a bounded id set (the per-employee / small-team callers) this reads only those people's rows
 * via the existing `(agent_hr_id, visit_date)` / `(double_hr_id, visit_date)` indexes — a visit
 * counts whether the person was the agent OR the double, so both roles are queried and merged —
 * instead of scanning EVERY company visit in the window and discarding ~all of them in JS. The two
 * reads run in parallel, are de-duplicated by `id` (a visit whose agent AND double are both wanted
 * is returned by both), and returned in the SAME `id`-ascending order the company-wide keyset scan
 * produced, so the downstream classification and the `describeCrmDay` first-match label stay
 * byte-identical. `queryVisits` applies the identical date range and departed-agent handling as
 * {@link scanVisitsForRangeCreditingPartners} — a departed agent's row survives for its PARTNER's
 * sake only, anonymous on the agent side — and matches hr ids case-insensitively
 * (`expandHrIdFilterValues`), so
 * the fetched set is a superset of the rows the caller's own `normalizeAttendanceHrId` gate keeps —
 * the gate below stays the exact decision. Stored `agent_hr_id`/`double_hr_id` are already canonical
 * (upper, no whitespace — 0 of 123,657 rows differ), so the superset is exact in practice.
 *
 * A LEAVER IS STILL JUDGED ON THEIR OWN VISITS. The fingerprint report keeps a resigned or terminated
 * person in scope up to their last working day, and the exclusion behind both reads above hides
 * every row they logged from the minute HR records the resignation — notice period included, every
 * day of it. So a leaver who punched late on a day they also logged real CRM visits lost the cancel
 * and was charged. `ownRowsOfDeparted` puts those rows back, through the last working day only, and
 * comes FIRST in the merge so its copy wins over the partner door's anonymised one of the same row.
 */
export async function fetchDayMapVisits(
  dateFromIso: string,
  dateToIso: string,
  wantedIds: string[],
  readers: DayMapVisitReaders = CRM_DOOR_DAY_MAP_READERS,
): Promise<CrmDayVisitRow[]> {
  if (wantedIds.length > DAY_MAP_PUSHDOWN_MAX_IDS) {
    const [company, ownDeparted] = await Promise.all([
      readers.companyWindow(dateFromIso, dateToIso),
      readers.ownRowsOfDeparted(dateFromIso, dateToIso, wantedIds),
    ]);
    if (ownDeparted.length === 0) return company;
    return mergeDayMapVisitPages<DayMapKeyedRow>([ownDeparted, company]);
  }
  const [ownDeparted, asAgent, asDouble] = await Promise.all([
    readers.ownRowsOfDeparted(dateFromIso, dateToIso, wantedIds),
    readers.asAgent(dateFromIso, dateToIso, wantedIds),
    readers.asDouble(dateFromIso, dateToIso, wantedIds),
  ]);
  return mergeDayMapVisitPages<DayMapKeyedRow>([ownDeparted, asAgent, asDouble]);
}

/** Exported for its unit test; callers use {@link getCrmActivityDayMaps}. */
export async function scanCompanyVisitsByEmployee(
  input: {
    dateFromIso: string;
    dateToIso: string;
    employeeHrIds: string[];
  },
  readers: DayMapVisitReaders = CRM_DOOR_DAY_MAP_READERS,
): Promise<Map<string, Map<string, CrmDayVisitRow[]>>> {
  const result = new Map<string, Map<string, CrmDayVisitRow[]>>();
  if (!isIsoDate(input.dateFromIso) || !isIsoDate(input.dateToIso)) return result;

  const wanted = new Set(
    input.employeeHrIds.map((id) => normalizeAttendanceHrId(id)).filter((value): value is string => Boolean(value)),
  );
  if (wanted.size === 0) return result;

  const visits = await fetchDayMapVisits(input.dateFromIso, input.dateToIso, [...wanted], readers);

  for (const visit of visits) {
    const dateIso = (visit.visit_date ?? "").slice(0, 10);
    if (!dateIso) continue;
    // A visit counts for whoever it belongs to, whether as the primary agent
    // or as a double — either role means the employee was genuinely present.
    //
    // BOTH partner slots. `doubleHrIds` above already returns a slot-2 row, so without the slot here
    // the row arrived and was silently discarded — and the day the chain's other person spent in the
    // field read as a day he did not work, which is the owner's reported defect itself.
    for (const rawHrId of [visit.agent_hr_id, visit.double_hr_id, visit.double2_hr_id]) {
      const hrId = normalizeAttendanceHrId(rawHrId ?? "");
      if (!hrId || !wanted.has(hrId)) continue;
      const byDate = result.get(hrId) ?? new Map<string, CrmDayVisitRow[]>();
      const list = byDate.get(dateIso) ?? [];
      list.push(visit);
      byDate.set(dateIso, list);
      result.set(hrId, byDate);
    }
  }
  return result;
}

export type CrmActivityDayMaps = {
  /** Map<employeeHrId, Set<dateIso>> of CRM-recorded leave days (universal cancel in reconcileDay). */
  leaveMap: Map<string, Set<string>>;
  /** Map<employeeHrId, Set<dateIso>> of days with a real CRM field visit — a regular visit or a
   * CP-type activity (universal cancel in reconcileDay). */
  fieldVisitMap: Map<string, Set<string>>;
  /** Map<employeeHrId, Map<dateIso, string>> — a short label describing the winning CRM entry for
   * every date present in leaveMap/fieldVisitMap, for display only (never a branching key). */
  detailMap: Map<string, Map<string, string>>;
};

/**
 * Classifies every active employee's CRM activity for a digest week into two
 * day-sets in a single scan: real field-visit days (a regular visit OR a
 * CP-type activity — Conference/Meeting/Campaign/Training/Traveling/Public
 * Holiday/Casual Leave/Health Day — wins the day, same "regular > CP > AV"
 * precedence as dayCellValue/computeLeaverCrmDates) and CRM-recorded leave days
 * (Annual Vacation only, and only on a day with neither a regular visit nor a
 * CP-type activity). Both feed reconcileDay as universal cancels.
 */
export async function getCrmActivityDayMaps(input: {
  dateFromIso: string;
  dateToIso: string;
  employeeHrIds: string[];
}): Promise<CrmActivityDayMaps> {
  // PHOENIX CRM, WHETHER OR NOT THE TEAM WAS STARTED. Everything above reads the CRM door, whose
  // Phoenix branches are inner-joined to the STARTED teams — so a rep on an unstarted team who spent
  // the day logging real visits reads here as a day with no CRM activity, and a fingerprint
  // deduction that his field day should have cancelled stands. Added to `fieldVisitMap` only, which
  // is a universal CANCEL in reconcileDay: this can only ever excuse a day, never flag one.
  const datesValid = isIsoDate(input.dateFromIso) && isIsoDate(input.dateToIso);
  const [byEmployee, phoenixEvidence, managerOwnDays] = await Promise.all([
    scanCompanyVisitsByEmployee(input),
    datesValid ? loadPhoenixWorkEvidenceDays({ end: input.dateToIso, start: input.dateFromIso }) : Promise.resolve([]),
    // A MANAGER'S OWN SINGLE VISITS (owner, 2026-10-19: "proof he worked the day"). Since 2026-10-16 they
    // sit in phoenix_crm_manager_visits — outside the CRM door and outside the work-evidence read — so a
    // district manager who spent the day on his own calls read here as a day with no CRM activity.
    // proven-worked-days.ts already counts them; this is the same source, for the same cancel.
    datesValid
      ? loadManagerOwnVisitDays({ end: input.dateToIso, managerHrIds: input.employeeHrIds, start: input.dateFromIso })
      : Promise.resolve([]),
  ]);
  const leaveMap = new Map<string, Set<string>>();
  const fieldVisitMap = new Map<string, Set<string>>();
  const detailMap = new Map<string, Map<string, string>>();

  for (const [hrId, byDate] of byEmployee) {
    const leaveDates = new Set<string>();
    const fieldDates = new Set<string>();
    const dayDetails = new Map<string, string>();
    for (const [dateIso, rows] of byDate) {
      const kind = crmDayKind(rows);
      if (kind === "field") fieldDates.add(dateIso);
      else if (kind === "leave") leaveDates.add(dateIso);
      else continue;
      const detail = describeCrmDay(rows);
      if (detail) dayDetails.set(dateIso, detail);
    }
    if (leaveDates.size > 0) leaveMap.set(hrId, leaveDates);
    if (fieldDates.size > 0) fieldVisitMap.set(hrId, fieldDates);
    if (dayDetails.size > 0) detailMap.set(hrId, dayDetails);
  }

  // Phoenix work-evidence days join `fieldVisitMap` — the day's own cancel — and name themselves in
  // `detailMap`, so a report showing "CRM field visit" says WHAT it was instead of a bare boolean.
  // A day Phoenix only STARTED (the GPS press, nothing recorded after it) is deliberately not a
  // cancel: phoenixWorkEvidenceProvesWorkedDay draws that line in one place.
  const wantedAttendanceKeys = new Set(
    input.employeeHrIds.map((id) => normalizeAttendanceHrId(id)).filter((value): value is string => Boolean(value)),
  );
  for (const [key, day] of indexPhoenixWorkEvidence(phoenixEvidence, normalizeAttendanceHrId)) {
    if (!phoenixWorkEvidenceProvesWorkedDay(day)) continue;
    const hrId = key.slice(0, key.lastIndexOf("|"));
    if (!wantedAttendanceKeys.has(hrId)) continue;
    const fieldDates = fieldVisitMap.get(hrId) ?? new Set<string>();
    fieldDates.add(day.date);
    fieldVisitMap.set(hrId, fieldDates);
    // Only where the vendor read named nothing: a real iReports360 entry stays the day's label.
    const dayDetails = detailMap.get(hrId) ?? new Map<string, string>();
    if (!dayDetails.has(day.date)) dayDetails.set(day.date, describePhoenixWorkEvidence(day));
    detailMap.set(hrId, dayDetails);
  }

  // His own single visits join `fieldVisitMap` the same way — a cancel only, never a flag — and name
  // themselves where nothing above named the day.
  for (const day of managerOwnDays) {
    if (day.visits <= 0) continue;
    const hrId = normalizeAttendanceHrId(day.hrId);
    if (!hrId || !wantedAttendanceKeys.has(hrId)) continue;
    const fieldDates = fieldVisitMap.get(hrId) ?? new Set<string>();
    fieldDates.add(day.date);
    fieldVisitMap.set(hrId, fieldDates);
    const dayDetails = detailMap.get(hrId) ?? new Map<string, string>();
    if (!dayDetails.has(day.date)) dayDetails.set(day.date, describeManagerOwnVisitDay(day));
    detailMap.set(hrId, dayDetails);
  }

  return { detailMap, fieldVisitMap, leaveMap };
}
