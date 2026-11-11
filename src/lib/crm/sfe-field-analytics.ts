// ─────────────────────────────────────────────────────────────────────────────
// SFE field analytics — the CRM half of the SFE Manager's overview.
//
// The SFE Manager owns sales and CRM, so his overview measures FIELD ACTIVITY, not HR
// attendance. "Did the rep show up" here means "did the rep check in on a customer", read from
// the CRM check-in mirror — never from a fingerprint punch.
//
// Lives inside src/lib/crm because the mirror tables have a single-source door: every read goes
// through reads.ts (enforced by the "crm single-source door" test), which also applies the
// departed-agent exclusion so these totals reconcile with DV Analytics, FWC and the CRM master tab.
// ─────────────────────────────────────────────────────────────────────────────

import { isPhoenixNativeVisitRow, PHOENIX_VISIT_SOURCE } from "@/lib/crm/phoenix-team-starts";
import { collapseDuplicateVisitSubmissions, queryCheckins, queryVisits } from "@/lib/crm/reads";
import { visitCountBucket } from "@/lib/crm/visit-count-buckets";
import { UNLABELED_FIELD_VISIT_TYPE, resolveVisitTypeLabel } from "@/lib/crm/visit-types";
import { EARLY_BIRDS_EARLIEST_PLAUSIBLE_START_MINUTES } from "@/lib/early-birds/scoring";
import { normalizeHrIdForAccess } from "@/lib/hr-id";

export type SfeStartTimeRow = {
  agentHrId: string | null;
  agentName: string;
  /** Median first-check-in, in minutes past midnight Cairo. */
  medianStartMinutes: number;
  /** Earliest single first-check-in observed in the window. */
  earliestStartMinutes: number;
  /** How many distinct days this rep produced a check-in on. */
  daysObserved: number;
};

export type SfeCrmFieldAnalytics = {
  dateFrom: string;
  dateTo: string;
  /** Visits after duplicate-submission collapse — the same grain every other CRM surface reports. */
  totalVisits: number;
  /** Distinct reps who logged at least one visit in the window. */
  activeReps: number;
  /** Distinct rep-days with at least one visit — the denominator for visits-per-day. */
  repDays: number;
  avgVisitsPerRepDay: number;
  /** Distinct contacts actually seen; the reach behind the visit count. */
  contactsCovered: number;
  // THE AM · PM · PHARMACIES GOLDEN RULE (src/lib/crm/visit-count-buckets.ts): three figures
  // apart, and a pharmacy visit is counted in pharmacyVisits only — never in pmVisits, whatever
  // period the vendor tagged it with.
  amVisits: number;
  pmVisits: number;
  pharmacyVisits: number;
  /**
   * How many of those three figures' visits are Phoenix CRM's own (a started team's). Phoenix CRM logs
   * no pharmacy visit, so `pharmacyVisits` counts the iReports360 visits alone and the bar says so
   * through the golden-rule helper. Optional: a payload cached before it existed reads as none.
   */
  phoenixVisits?: number;
  /** Visits carrying a double/triple visitor — manager field presence. */
  doubleVisits: number;
  byVisitType: Array<{ label: string; count: number }>;
  topReps: Array<{ label: string; visits: number; contacts: number }>;
  /** Reps whose check-in day starts earliest, then latest. Both sorted by median start. */
  earlyBirds: SfeStartTimeRow[];
  lateStarters: SfeStartTimeRow[];
  /** Reps with visits but no GPS check-in at all in the window — the visit time is unverifiable. */
  repsWithoutCheckins: number;
  checkinsMatched: number;
};

type VisitRow = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  agent_name: string | null;
  ampm: string | null;
  contact_crm_id: number | null;
  crm_save_date: string | null;
  double_crm_id: number | null;
  /** The partner's resolved HR id — the only way a Phoenix double visit names a manager with no CRM account. */
  double_hr_id?: string | null;
  crm_visit_id: number | null;
  speciality: string | null;
  visit_date: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
};

type CheckinRow = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  check_date: string | null;
  source?: string | null;
};

const VISIT_COLUMNS =
  "agent_crm_id,agent_hr_id,agent_name,ampm,contact_crm_id,crm_save_date,double_crm_id,double_hr_id,crm_visit_id,speciality,visit_date,visit_type,visit_type_description";
// The -30 field visit carries no contact, so only the rep's comment says it was a pharmacy. The
// comment is read for those rows alone — across every visit in the window it would dominate the
// payload (see the note on resolveVisitTypeLabel below).
const UNLABELED_COMMENT_COLUMNS = "crm_visit_id,comment";
const CHECKIN_COLUMNS = "agent_crm_id,agent_hr_id,check_date,source";

/**
 * Minutes past midnight from a CRM timestamp.
 *
 * CRM/iReports360 timestamps are ALREADY Africa/Cairo wall-clock — they carry no zone and must
 * never be run through a UTC parse, which would shift every start time by the Cairo offset and
 * silently rank the early birds wrong. So the clock is read straight out of the string.
 */
export function crmMinutesPastMidnight(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /[T ](\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  // 00:00 is the vendor's "no real time" placeholder, not a rep who started at midnight.
  if (hour === 0 && minute === 0) return null;
  return hour * 60 + minute;
}

/** Calendar day (YYYY-MM-DD) from a CRM timestamp — again read as-is, never re-zoned. */
function crmDayKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/** A visit row as the day-start helper reads it — every visit reader's own columns, nothing more. */
export type PhoenixStartRow = {
  agent_hr_id: string | null;
  crm_save_date: string | null;
  crm_visit_id?: number | null;
  source?: string | null;
  visit_date: string | null;
  visit_type: number | null;
};

/**
 * THE START OF A STARTED PHOENIX CRM TEAM'S REP-DAY (owner, 2026-10-02: "His first Phoenix visit is his
 * start"): `${key}|${visit day}` -> minutes past Cairo midnight of the rep's FIRST countable Phoenix
 * visit that day — its capture time, which the read door carries as Cairo wall clock in
 * `crm_save_date`. Early Birds (its start and its "#1 days") and the SFE start-time table below read
 * this one helper, never a copy.
 *
 * The read door serves a Phoenix row only within a team's start and only when it counts, so every row
 * here already is one. A day activity is never a visit (its code is never 0) and never a start. The day
 * is the visit's own day, which ends at 02:00 Cairo — so a capture between midnight and 02:00 belongs
 * to the day before, and its clock, like any clock before 05:00, is never a start
 * (EARLY_BIRDS_EARLIEST_PLAUSIBLE_START_MINUTES, the floor Early Birds puts on a check-in too).
 * `keyOf` names the person as the caller keys him; by default the roster key.
 */
export function phoenixFirstVisitStarts<R extends PhoenixStartRow>(
  rows: readonly R[],
  keyOf: (row: R) => string | null = (row) => normalizeHrIdForAccess(row.agent_hr_id),
): Map<string, number> {
  const starts = new Map<string, number>();
  for (const row of rows) {
    if (!isPhoenixNativeVisitRow(row) || row.visit_type !== 0) continue;
    const dateIso = String(row.visit_date ?? "").slice(0, 10);
    const personKey = keyOf(row);
    if (!dateIso || !personKey) continue;
    const minutes = crmMinutesPastMidnight(row.crm_save_date);
    if (minutes === null || minutes < EARLY_BIRDS_EARLIEST_PLAUSIBLE_START_MINUTES) continue;
    const key = `${personKey}|${dateIso}`;
    const current = starts.get(key);
    if (current === undefined || minutes < current) starts.set(key, minutes);
  }
  return starts;
}

/** "07:45" from minutes past midnight. Formatting lives here so every surface renders it alike. */
export function formatStartMinutes(minutes: number): string {
  const safe = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  const hour = Math.floor(safe / 60);
  const minute = safe % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Build the start-time table: for each rep, the median of their FIRST check-in per day.
 *
 * Median rather than mean so one 05:00 airport run or one 14:00 half-day cannot move a rep's
 * ranking — this is meant to describe habit, not incidents.
 *
 * `minDays` guards the same thing from the other side: a rep with a single observed day has no
 * habit to report, and would otherwise top the "early birds" list off one lucky morning.
 */
export function buildStartTimeRows(
  checkins: ReadonlyArray<{ agentHrId: string | null; agentKey: string; agentName: string; checkDate: string | null }>,
  minDays = 3,
): SfeStartTimeRow[] {
  const firstByAgentDay = new Map<string, { agentHrId: string | null; agentName: string; days: Map<string, number> }>();

  for (const row of checkins) {
    const minutes = crmMinutesPastMidnight(row.checkDate);
    const day = crmDayKey(row.checkDate);
    if (minutes === null || !day) continue;
    let entry = firstByAgentDay.get(row.agentKey);
    if (!entry) {
      entry = { agentHrId: row.agentHrId, agentName: row.agentName, days: new Map() };
      firstByAgentDay.set(row.agentKey, entry);
    }
    // A name can arrive null on some rows; keep the first real one we see.
    if (entry.agentName === "" && row.agentName) entry.agentName = row.agentName;
    const current = entry.days.get(day);
    if (current === undefined || minutes < current) entry.days.set(day, minutes);
  }

  const rows: SfeStartTimeRow[] = [];
  for (const entry of firstByAgentDay.values()) {
    const starts = [...entry.days.values()];
    if (starts.length < minDays) continue;
    rows.push({
      agentHrId: entry.agentHrId,
      agentName: entry.agentName || "Unmapped agent",
      medianStartMinutes: median(starts),
      earliestStartMinutes: Math.min(...starts),
      daysObserved: starts.length,
    });
  }
  return rows.sort((a, b) => a.medianStartMinutes - b.medianStartMinutes || a.agentName.localeCompare(b.agentName));
}

/**
 * Company-wide CRM field analytics for a date window.
 *
 * Returns real zeros only when the mirror genuinely has no rows; a missing CRM schema surfaces as
 * an empty result from the door rather than an exception, so callers should treat a zero
 * `totalVisits` together with zero `checkinsMatched` as "nothing loaded", not "nobody worked".
 */
export async function getSfeCrmFieldAnalytics(input: {
  dateFrom: string;
  dateTo: string;
  topN?: number;
}): Promise<SfeCrmFieldAnalytics> {
  const topN = input.topN ?? 6;
  // A display-only overview of the whole company's window, so all three reads may come from a copy up
  // to a minute old (owner, 2026-10-16) — the same window costs a probe plus a request per day each.
  const [rawVisits, checkins, unlabeledComments] = await Promise.all([
    // Counts visits: only the rows that count (counts_in_kpi, and a customer validated — sweep of 11 Nov 2026).
    queryVisits<VisitRow>({ dateFrom: input.dateFrom, dateTo: input.dateTo, columns: VISIT_COLUMNS, kpiOnly: true, reuseRecentWindow: true }),
    // The SFE Manager's and the CEO's overview — no rep reaches it, so a started Phoenix CRM team's visits
    // count as its check-ins here (owner, 2026-10-02; src/lib/crm/phoenix-team-starts.ts lists every
    // reader that asks).
    queryCheckins<CheckinRow>({
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      columns: CHECKIN_COLUMNS,
      includePhoenixVisits: true,
      reuseRecentWindow: true,
    }),
    queryVisits<{ comment: string | null; crm_visit_id: number | null }>({
      columns: UNLABELED_COMMENT_COLUMNS,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      visitTypes: [UNLABELED_FIELD_VISIT_TYPE],
      reuseRecentWindow: true,
    }),
  ]);
  const unlabeledCommentById = new Map(
    unlabeledComments
      .filter((row) => row.crm_visit_id !== null && row.crm_visit_id !== undefined)
      .map((row) => [row.crm_visit_id as number, row.comment]),
  );

  // Same collapse every other CRM consumer applies, so this page's visit count cannot disagree
  // with DV Analytics or the Visits Report for the same window.
  const visits = collapseDuplicateVisitSubmissions(rawVisits);

  const agentKeyOf = (row: { agent_hr_id: string | null; agent_crm_id: number | null }) =>
    row.agent_hr_id ? `hr:${row.agent_hr_id.toLowerCase()}` : `crm:${row.agent_crm_id ?? "unknown"}`;

  const repDays = new Set<string>();
  const activeReps = new Set<string>();
  const contacts = new Set<number>();
  const byType = new Map<string, number>();
  const perRep = new Map<string, { label: string; visits: number; contacts: Set<number> }>();
  const hrIdByKey = new Map<string, string | null>();
  let amVisits = 0;
  let pmVisits = 0;
  let pharmacyVisits = 0;
  let phoenixVisits = 0;
  let doubleVisits = 0;

  for (const visit of visits) {
    const key = agentKeyOf(visit);
    activeReps.add(key);
    if (!hrIdByKey.has(key)) hrIdByKey.set(key, visit.agent_hr_id);
    if (visit.visit_date) repDays.add(`${key}|${visit.visit_date}`);
    if (visit.contact_crm_id) contacts.add(visit.contact_crm_id);

    // A visit with no period at all stays out of the split, as it always has; a pharmacy is a
    // pharmacy whatever period it carries.
    const ampm = (visit.ampm ?? "").trim().toUpperCase();
    const bucket = visitCountBucket({
      ampm: visit.ampm,
      comment: visit.visit_type === UNLABELED_FIELD_VISIT_TYPE && visit.crm_visit_id !== null ? unlabeledCommentById.get(visit.crm_visit_id) ?? null : null,
      speciality: visit.speciality,
      visit_type: visit.visit_type,
    });
    if (bucket === "Pharmacies") pharmacyVisits++;
    else if (ampm === "AM") amVisits++;
    else if (ampm === "PM") pmVisits++;
    if ((bucket === "Pharmacies" || ampm === "AM" || ampm === "PM") && isPhoenixNativeVisitRow(visit)) phoenixVisits++;
    // A partner by CRM id, or — on a Phoenix row — by HR id alone: a Phoenix double visit whose manager
    // has no CRM account carries him only as `double_hr_id` (re-audit, 2026-10-22). A stray resolved HR
    // id on a VENDOR row is not a partner, the same rule as isCrmDoubleVisitRow.
    if (visit.double_crm_id || (isPhoenixNativeVisitRow(visit) && (visit.double_hr_id ?? "").trim())) doubleVisits++;

    // The vendor sends the literal string "Unknown" for seven visit-type codes, which collapsed
    // 2,965 production visits into a single meaningless bucket in this breakdown. Resolve them to
    // what Phoenix already knows each code means. `comment` is deliberately NOT selected by this
    // query — it spans every rep in the window and the free text would dominate the payload — so
    // the two comment-split codes (-7, -30) land on their default label rather than a variant.
    const hasType = visit.visit_type != null || (visit.visit_type_description ?? "").trim() !== "";
    const typeLabel = hasType
      ? resolveVisitTypeLabel(visit.visit_type, visit.visit_type_description, null)
      : "Unclassified";
    byType.set(typeLabel, (byType.get(typeLabel) ?? 0) + 1);

    let rep = perRep.get(key);
    if (!rep) {
      rep = { label: (visit.agent_name ?? "").trim() || "Unmapped agent", visits: 0, contacts: new Set() };
      perRep.set(key, rep);
    }
    rep.visits++;
    if (visit.contact_crm_id) rep.contacts.add(visit.contact_crm_id);
  }

  // The day's start: an iReports360 rep's first GPS check-in; a started Phoenix CRM team's rep's first
  // countable Phoenix visit (owner, 2026-10-02) — the helper Early Birds reads, never the Phoenix
  // check-in rows, which are those same visits again and would carry an after-midnight capture into
  // the next calendar day.
  const phoenixStarts = [...phoenixFirstVisitStarts(visits, agentKeyOf)].map(([key, minutes]) => {
    const split = key.lastIndexOf("|");
    const agentKey = key.slice(0, split);
    return {
      agentHrId: hrIdByKey.get(agentKey) ?? null,
      agentKey,
      agentName: perRep.get(agentKey)?.label ?? "",
      checkDate: `${key.slice(split + 1)}T${formatStartMinutes(minutes)}:00`,
    };
  });
  const startRows = buildStartTimeRows([
    ...checkins
      .filter((row) => row.source !== PHOENIX_VISIT_SOURCE)
      .map((row) => ({
        agentHrId: row.agent_hr_id,
        agentKey: agentKeyOf(row),
        // The check-in mirror carries no agent name; borrow it from the visit rows for the same agent.
        agentName: perRep.get(agentKeyOf(row))?.label ?? "",
        checkDate: row.check_date,
      })),
    ...phoenixStarts,
  ]);

  const checkinAgents = new Set(checkins.map((row) => agentKeyOf(row)));
  const repsWithoutCheckins = [...activeReps].filter((key) => !checkinAgents.has(key)).length;

  return {
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    totalVisits: visits.length,
    activeReps: activeReps.size,
    repDays: repDays.size,
    avgVisitsPerRepDay: repDays.size > 0 ? Math.round((visits.length / repDays.size) * 10) / 10 : 0,
    contactsCovered: contacts.size,
    amVisits,
    pmVisits,
    pharmacyVisits,
    phoenixVisits,
    doubleVisits,
    byVisitType: [...byType.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    topReps: [...perRep.values()]
      .map((rep) => ({ label: rep.label, visits: rep.visits, contacts: rep.contacts.size }))
      .sort((a, b) => b.visits - a.visits || a.label.localeCompare(b.label))
      .slice(0, topN),
    earlyBirds: startRows.slice(0, topN),
    lateStarters: [...startRows].reverse().slice(0, topN),
    repsWithoutCheckins,
    checkinsMatched: checkins.length,
  };
}
