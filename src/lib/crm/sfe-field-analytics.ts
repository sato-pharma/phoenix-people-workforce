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

import { collapseDuplicateVisitSubmissions, queryCheckins, queryVisits } from "@/lib/crm/reads";
import { resolveVisitTypeLabel } from "@/lib/crm/visit-types";

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
  amVisits: number;
  pmVisits: number;
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
  crm_visit_id: number | null;
  visit_date: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
};

type CheckinRow = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  check_date: string | null;
};

const VISIT_COLUMNS =
  "agent_crm_id,agent_hr_id,agent_name,ampm,contact_crm_id,crm_save_date,double_crm_id,crm_visit_id,visit_date,visit_type,visit_type_description";
const CHECKIN_COLUMNS = "agent_crm_id,agent_hr_id,check_date";

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
  const [rawVisits, checkins] = await Promise.all([
    queryVisits<VisitRow>({ dateFrom: input.dateFrom, dateTo: input.dateTo, columns: VISIT_COLUMNS }),
    queryCheckins<CheckinRow>({ dateFrom: input.dateFrom, dateTo: input.dateTo, columns: CHECKIN_COLUMNS }),
  ]);

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
  let amVisits = 0;
  let pmVisits = 0;
  let doubleVisits = 0;

  for (const visit of visits) {
    const key = agentKeyOf(visit);
    activeReps.add(key);
    if (visit.visit_date) repDays.add(`${key}|${visit.visit_date}`);
    if (visit.contact_crm_id) contacts.add(visit.contact_crm_id);

    const ampm = (visit.ampm ?? "").trim().toUpperCase();
    if (ampm === "AM") amVisits++;
    else if (ampm === "PM") pmVisits++;
    if (visit.double_crm_id) doubleVisits++;

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

  const startRows = buildStartTimeRows(
    checkins.map((row) => ({
      agentHrId: row.agent_hr_id,
      agentKey: agentKeyOf(row),
      // The check-in mirror carries no agent name; borrow it from the visit rows for the same agent.
      agentName: perRep.get(agentKeyOf(row))?.label ?? "",
      checkDate: row.check_date,
    })),
  );

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
