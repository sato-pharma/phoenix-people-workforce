/**
 * THE VISIT LIFECYCLE, REBUILT IN TYPESCRIPT — what each door SHOULD hold for one rep-day.
 *
 * A Phoenix CRM visit is saved by `phoenix_crm_save_visit` into `phoenix_crm_visits`, then has to pass
 * three doors before anybody reads it: `phoenix_crm_countable_visits` (S1, an off-plan visit only once
 * approved, a recorded one only once reviewed), `crm_visits_unified` (S2, a started team's REP seat,
 * from its start, before its stop) and the read door `queryVisits` (S3, the departed-agent exclusion
 * and the duplicate collapse). The Private Calendar (S4) and the KPIs call rate (S5) read S3.
 *
 * This file states every business rule that DELIBERATELY keeps a saved visit out of a door, so the
 * detector (visit-lifecycle.ts) can tell a visit the rules left out — no finding — from a visit that
 * was lost. It reads nothing and writes nothing: the detector hands it what each door returned.
 * 🔴 It never decides what a door SHOULD do differently. A rule here that disagrees with the database
 * is a finding for a person to read, never a reason to change a visit or a figure.
 *
 * The rules, each with where it lives:
 *   · a test row is nobody's work (`is_test`, every door);
 *   · a visit with no rep is a manager's own, counted nowhere (`phoenix_crm_rep_entry_days`);
 *   · a visit the Super Admin removed is gone (`phoenix_crm_removed_visits`);
 *   · an off-plan visit counts once approved — `out_of_list` always counts — and a recorded visit once
 *     the Administrator approves the recording (`20261023040102_countable_visits_customer_join_is_removable`);
 *   · a visit saved and held for the SFE after five far refusals from one spot counts once he approves it
 *     (`phoenix_crm_far_visit_holds`, 20261110170000);
 *   · the door serves a REP seat of a started team, from its start, before its stop — and, from the day
 *     iReports360 was retired, every REP seat whatever its start or stop (`phoenix_crm_counted_seat_windows()`,
 *     inner-joined in `crm_visits_unified`, 20261106235920);
 *   · a departed agent is invisible on every counting door (`getEffectiveExcludedAgentCrmIds`);
 *   · one rep, one contact, one day is one stop (`collapseDuplicateVisitSubmissions`);
 *   · a partnered visit sits on the Double Visit feed, not the field-visit chip (`fieldVisitActivityKind`);
 *   · the call rate counts Saturday to Wednesday, minus holidays, through yesterday, and leaves out an
 *     unvalidated customer, the catch-all contact and pharmacies (`callRateExclusionOf`, `phoenix-kpi-rules.ts`).
 */

import { createHash } from "node:crypto";

import { CATCH_ALL_CONTACT_CRM_ID, isCallRateWorkingDay } from "@/lib/crm/call-rate";
import { addDaysIso } from "@/lib/crm/dates";
import { isMedicalRepJobTitle } from "@/lib/crm/medical-rep";
import { collapseDuplicateVisitSubmissions, isDepartedFromCrm } from "@/lib/crm/reads";
import { visitCountBucket } from "@/lib/crm/visit-count-buckets";
import { classifyVisit } from "@/lib/crm/visit-types";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { fieldVisitActivityKind } from "@/lib/private-calendar/field-visits";

// ── The shapes the detector hands in ───────────────────────────────────────────────────────────────

/** One `phoenix_crm_visits` row with the facts the countable rule reads beside it. */
export type SavedVisit = {
  id: string;
  seatId: string;
  repHrId: string | null;
  managerHrId: string | null;
  productManagerHrId: string | null;
  seniorHrId: string | null;
  customerId: string;
  /** The visit's own `list_type` — AM, PM or Pharmacy. */
  listType: string | null;
  visitDate: string;
  capturedAt: string | null;
  createdAt: string;
  isTest: boolean;
  isUnplanned: boolean;
  unplannedKind: string | null;
  /** `phoenix_crm_unplanned_visits.status`; null when the visit has no approval row at all. */
  unplannedStatus: string | null;
  /** `review_status` of every recording claimed by this visit. */
  recordingStatuses: string[];
  /** `phoenix_crm_far_visit_holds.status` — a visit held for the SFE (owner, 2026-11-10). Absent or null: no hold. */
  farHoldStatus?: string | null;
  /** The countable view's `customer_validated`: validated, or a pharmacy. Null when the customer was not read. */
  customerValidated: boolean | null;
  /** `coalesce(reference_contact_crm_id, own_contact_crm_id)` — the contact id every door emits. */
  contactCrmId: number | null;
  /** The newest change to anything the countable rule reads: the save, the approval, the recording. */
  factsChangedAt: string;
  /** True when `phoenix_crm_removed_visits` holds this visit id. */
  removed: boolean;
};

/** The `crm_visits_unified` columns the lifecycle reads — the door shape, S2 and S3 alike. */
export type DoorRow = {
  id: string;
  source: string | null;
  agent_hr_id: string | null;
  agent_crm_id: number | null;
  exclusion_crm_id: number | null;
  contact_crm_id: number | null;
  visit_date: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
  comment: string | null;
  double_hr_id: string | null;
  double_crm_id: number | null;
  crm_save_date: string | null;
  crm_visit_id: number | null;
  ampm: string | null;
  speciality: string | null;
  phoenix_customer_validated: boolean | null;
};

/** The projection a door read asks for — every column of {@link DoorRow}, nothing else. */
export const DOOR_COLUMNS =
  "id,source,agent_hr_id,agent_crm_id,exclusion_crm_id,contact_crm_id,visit_date,visit_type,visit_type_description,comment,double_hr_id,double_crm_id,crm_save_date,crm_visit_id,ampm,speciality,phoenix_customer_validated";

/**
 * One row of `phoenix_crm_counted_seat_windows()`: a REP seat counted over [startsOn, stopsOn). `teamSeatId` is the
 * started team it sits under, or "" for a territory under no started team (counted from the retirement day only).
 */
export type StartedSeatWindow = { seatId: string; teamSeatId: string; startsOn: string; stopsOn: string | null };

/** What the employee directory says about the rep. */
export type PersonFacts = {
  hrKey: string;
  hrId: string;
  fullName: string | null;
  crmId: number | null;
  employmentStatus: string | null;
  lastWorkingDate: string | null;
  hireDate: string | null;
  jobTitle: string | null;
};

/** Why a saved visit is DELIBERATELY not expected at a door. Each is counted, never dropped silently. */
export type LifecycleExclusion =
  | "test_row"
  | "manager_own_visit"
  | "removed_by_admin"
  | "not_quiet"
  | "offplan_pending_admin"
  | "offplan_pending_manager"
  | "offplan_pending_sfe"
  | "offplan_refused"
  | "recording_not_approved"
  | "far_visit_held"
  | "seat_not_in_started_team"
  | "team_not_started"
  | "team_stopped"
  | "departed_agent"
  | "repeat_save_collapsed"
  | "partnered_double_feed";

export type LifecycleStage = 1 | 2 | 3 | 4 | 5;

/**
 * A stage where a visit that should have arrived did not (`missing`, and its three named shapes), or
 * where a door holds what it should not (`extra`, `vendor`).
 *   no_approval — an off-plan visit saved without the approval request that could ever count it;
 *   departed    — a rep still employed hidden by the departed-agent exclusion (leads R2/R10);
 *   merged      — two DIFFERENT customers folded into one stop by the duplicate collapse (lead R3);
 *   vendor      — an iReports360 row served beside the rep's own Phoenix CRM day (lead R12).
 */
export type LifecycleFailureKind = "missing" | "no_approval" | "departed" | "merged" | "extra" | "vendor";

export type StageFailure = {
  stage: LifecycleStage;
  kind: LifecycleFailureKind;
  /** The visit ids concerned (a count-only stage leaves this empty and says so in `expected`/`found`). */
  ids: string[];
  expected: number;
  found: number;
};

export type StageUnreadable = { stage: LifecycleStage; sources: string[]; ids: string[] };

// ── S1 — the countable rule ────────────────────────────────────────────────────────────────────────

export type CountableVerdict =
  | { countable: true }
  | { countable: false; stuck: false; reason: LifecycleExclusion }
  /** Off-plan, not `out_of_list`, and NO approval row: nothing can ever count it. A defect, not a rule. */
  | { countable: false; stuck: true };

/**
 * `phoenix_crm_countable_visits`' WHERE clause, word for word:
 *   (not is_unplanned or u.status = 'approved' or unplanned_kind = 'out_of_list')
 *   and not exists (a recording of this visit whose review_status <> 'approved')
 *   and id not in (a far-visit hold whose status <> 'approved')
 */
export function countableVerdict(visit: SavedVisit): CountableVerdict {
  if (visit.isUnplanned && visit.unplannedKind !== "out_of_list" && visit.unplannedStatus !== "approved") {
    switch (visit.unplannedStatus) {
      case "admin_pending":
        return { countable: false, stuck: false, reason: "offplan_pending_admin" };
      case "manager_pending":
        return { countable: false, stuck: false, reason: "offplan_pending_manager" };
      case "sfe_pending":
        return { countable: false, stuck: false, reason: "offplan_pending_sfe" };
      case "refused":
        return { countable: false, stuck: false, reason: "offplan_refused" };
      default:
        // `phoenix_crm_save_visit` writes the approval row in the same transaction as an out_of_plan
        // visit, so a missing one is never a rule — the visit can never be approved, and so never count.
        return { countable: false, stuck: true };
    }
  }
  if (visit.recordingStatuses.some((status) => status !== "approved")) {
    return { countable: false, stuck: false, reason: "recording_not_approved" };
  }
  if (visit.farHoldStatus && visit.farHoldStatus !== "approved") {
    return { countable: false, stuck: false, reason: "far_visit_held" };
  }
  return { countable: true };
}

// ── S2 — the started team's window ─────────────────────────────────────────────────────────────────

/** The join `crm_visits_unified` makes: `seat_id`, `visit_date >= starts_on`, `visit_date < stops_on`. */
export function seatWindowVerdict(
  seatId: string,
  visitDate: string,
  windows: readonly StartedSeatWindow[],
): { covered: true; window: StartedSeatWindow } | { covered: false; reason: LifecycleExclusion } {
  const mine = windows.filter((window) => window.seatId === seatId);
  const covering = mine.find((window) => visitDate >= window.startsOn && (window.stopsOn === null || visitDate < window.stopsOn));
  if (covering) return { covered: true, window: covering };
  if (mine.length === 0) return { covered: false, reason: "seat_not_in_started_team" };
  return mine.some((window) => visitDate < window.startsOn)
    ? { covered: false, reason: "team_not_started" }
    : { covered: false, reason: "team_stopped" };
}

// ── R1 — the team the seat sat under ON the visit day ──────────────────────────────────────────────

/** One dated row of `au_v_seat_occupancy_all`: the seat sat under `managerSeatId` over [from, to). */
export type SeatHistoryRow = { seatId: string; managerSeatId: string | null; effectiveFrom: string; effectiveTo: string | null };

/** One row of `phoenix_crm_team_starts`: the team counts Phoenix CRM visits over [startsOn, stopsOn). */
export type TeamStartWindow = { teamSeatId: string; startsOn: string; stopsOn: string | null };

/** A visit whose team on the visit day would decide it differently from the team the view reads today. */
export type TeamMove = { id: string; seatId: string; teamThen: string; teamNow: string | null; countedThen: boolean; countedNow: boolean };

export type TeamMoveNote = "team_moved_same_verdict" | "seat_history_missing" | "seat_history_ambiguous";

/** The team a seat sat under on a day, from its dated history. Half-open, as the history is written. */
export function teamOnDay(
  seatId: string,
  date: string,
  history: readonly SeatHistoryRow[],
): { team: string } | { team: null; reason: "seat_history_missing" | "seat_history_ambiguous" } {
  const teams = new Set(
    history
      .filter((row) => row.seatId === seatId && row.effectiveFrom <= date && (row.effectiveTo === null || date < row.effectiveTo))
      .map((row) => row.managerSeatId)
      .filter((team): team is string => Boolean(team)),
  );
  if (teams.size === 1) return { team: [...teams][0] };
  return { team: null, reason: teams.size === 0 ? "seat_history_missing" : "seat_history_ambiguous" };
}

/**
 * Lead R1. `crm_visits_unified` decides a visit by the seat's team TODAY — `phoenix_crm_started_team_seats()`
 * joins `au.seats.parent_seat_id`, which carries no date. A seat that moved teams has its older visits
 * judged by the new team's start. For each countable, quiet visit this compares the team the seat sat
 * under on the visit day (the dated history) with today's team, and returns only the visits where the
 * two teams' starts DISAGREE about counting it — a move that changes nothing is counted, not returned.
 */
export function teamMoveVerdicts(input: {
  visits: readonly SavedVisit[];
  quietCutoff: string;
  windows: readonly StartedSeatWindow[];
  history: readonly SeatHistoryRow[];
  teamStarts: readonly TeamStartWindow[];
}): { moved: TeamMove[]; notes: Partial<Record<TeamMoveNote, number>> } {
  const moved: TeamMove[] = [];
  const notes: Partial<Record<TeamMoveNote, number>> = {};
  const note = (reason: TeamMoveNote) => {
    notes[reason] = (notes[reason] ?? 0) + 1;
  };
  const cutoff = Date.parse(input.quietCutoff);
  for (const visit of input.visits) {
    if (visit.isTest || visit.removed || !canonicalHrIdKey(visit.repHrId) || Date.parse(visit.factsChangedAt) > cutoff) continue;
    if (!countableVerdict(visit).countable) continue;
    const then = teamOnDay(visit.seatId, visit.visitDate, input.history);
    if (then.team === null) {
      note(then.reason);
      continue;
    }
    // Today's team: the one the view joins, else the seat's open history row.
    const open = input.history
      .filter((row) => row.seatId === visit.seatId && row.effectiveTo === null && row.managerSeatId)
      .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0];
    const teamNow = input.windows.find((window) => window.seatId === visit.seatId)?.teamSeatId || open?.managerSeatId || null;
    if (teamNow === then.team) continue;
    const countedNow = seatWindowVerdict(visit.seatId, visit.visitDate, input.windows).covered;
    const countedThen = input.teamStarts.some(
      (start) => start.teamSeatId === then.team && visit.visitDate >= start.startsOn && (start.stopsOn === null || visit.visitDate < start.stopsOn),
    );
    if (countedNow === countedThen) note("team_moved_same_verdict");
    else moved.push({ id: visit.id, seatId: visit.seatId, teamThen: then.team, teamNow, countedThen, countedNow });
  }
  return { moved, notes };
}

/**
 * The door row `crm_visits_unified` builds from a saved visit, for a visit the door did not return —
 * the same column formulas as its Phoenix branch, so a lost visit can still be followed downstream.
 */
export function predictDoorRow(visit: SavedVisit, person: PersonFacts | null): DoorRow {
  const crmId = person?.crmId ?? null;
  return {
    id: visit.id,
    source: "phoenix",
    agent_hr_id: visit.repHrId ?? visit.managerHrId,
    agent_crm_id: crmId,
    exclusion_crm_id: crmId ?? -1,
    contact_crm_id: visit.contactCrmId,
    visit_date: visit.visitDate,
    visit_type: 0,
    visit_type_description: "Regular Visit",
    comment: null,
    double_hr_id: visit.repHrId ? (visit.managerHrId ?? visit.productManagerHrId ?? visit.seniorHrId) : null,
    double_crm_id: null,
    crm_save_date: null,
    crm_visit_id: null,
    ampm: visit.listType,
    speciality: null,
    phoenix_customer_validated: visit.customerValidated,
  };
}

// ── One rep-day through S1, S2 and S3 ──────────────────────────────────────────────────────────────

export type RepDayInputs = {
  hrKey: string;
  date: string;
  /** Cairo today — the departed-agent test is asked as of today, exactly as the read door asks it. */
  today: string;
  /** A visit whose facts changed after this instant is not judged yet (the two-hour quiet rule). */
  quietCutoff: string;
  person: PersonFacts | null;
  /** False when the employee directory could not be read at all (not merely: no row for him). */
  personReadable: boolean;
  /** S0 — every `phoenix_crm_visits` row of the rep on the day, tests included. */
  saved: readonly SavedVisit[];
  /** S1 — which ids `phoenix_crm_countable_visits` returned; null when it could not be read. */
  countableIds: ReadonlySet<string> | null;
  /** S2 — `phoenix_crm_started_team_seats()`; null when it could not be read. */
  windows: readonly StartedSeatWindow[] | null;
  /** S2 — the `crm_visits_unified` rows asked for by id (no exclusion); null when unreadable. */
  unifiedRows: readonly DoorRow[] | null;
  /** S3 — what `queryVisits` returned for the rep on the day, before any collapse; null when unreadable. */
  doorRows: readonly DoorRow[] | null;
  /** The effective departed-agent exclusion; null when unreadable. */
  excludedCrmIds: ReadonlySet<number> | null;
};

export type RepDayVerdict = {
  hrKey: string;
  date: string;
  /** Saved visits judged (real, a rep's, quiet). */
  checked: number;
  excluded: Partial<Record<LifecycleExclusion, number>>;
  /** Where visits were lost, in stage order. The first is the root. */
  failures: StageFailure[];
  /** Doors holding more than they should — their own root rows, never part of a lost visit. */
  extras: StageFailure[];
  unreadable: StageUnreadable[];
  /** Every visit that should reach the consumers (S4, S5), lost ones included, in door shape. */
  should: Map<string, DoorRow>;
  /** Every visit lost at S1, S2 or S3 — the ids the correlation id is built from. */
  lostIds: string[];
  /** The Phoenix rows the door actually serves for the rep-day, after the duplicate collapse. */
  doorPhoenixKept: DoorRow[];
  /** The iReports360 rows the door serves for the rep-day (attributed to him). */
  doorVendorRows: DoorRow[];
  /** Whether the day is a Phoenix entry day (a countable visit on a started seat). */
  entryDay: boolean;
  /** Earliest `created_at` among the lost visits, for the row's first-event time. */
  firstLostSavedAt: string | null;
  /** True when a visit was captured between 00:00 and 02:00 Cairo (lead R5: a reader slicing the clock). */
  earlyHoursIds: string[];
};

function bump(counts: Partial<Record<LifecycleExclusion, number>>, reason: LifecycleExclusion, by = 1): void {
  if (by <= 0) return;
  counts[reason] = (counts[reason] ?? 0) + by;
}

/** One stop's key in the duplicate collapse: agent, contact, day, type (`duplicateSubmissionGroupKey`). */
function collapseKeyOf(row: DoorRow): string | null {
  if (row.agent_crm_id == null || row.contact_crm_id == null || !row.visit_date || row.visit_type !== 0) return null;
  return `${row.agent_crm_id}|${row.contact_crm_id}|${row.visit_date}|${row.visit_type}`;
}

/** Whether a door row is the rep's own — his hr id, or no hr id and his CRM account. */
export function isRowOfRep(row: DoorRow, hrKey: string, person: PersonFacts | null): boolean {
  const key = canonicalHrIdKey(row.agent_hr_id);
  if (key) return key === hrKey;
  return person?.crmId != null && row.agent_crm_id === person.crmId;
}

function cairoHourOf(iso: string | null): number | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Africa/Cairo" })
    .formatToParts(at)
    .find((part) => part.type === "hour")?.value;
  return hour === undefined ? null : Number(hour);
}

/**
 * S1, S2 and S3 for one rep-day. Every visit ends in exactly one of: excluded by a rule (counted),
 * lost at the first stage it failed to reach, or arrived. A stage that could not be read is reported
 * as unreadable for the visits it would have judged — never as a pass, never as a loss.
 */
export function evaluateRepDay(input: RepDayInputs): RepDayVerdict {
  const excluded: Partial<Record<LifecycleExclusion, number>> = {};
  const failures: StageFailure[] = [];
  const extras: StageFailure[] = [];
  const unreadable: StageUnreadable[] = [];
  const lost = new Set<string>();
  const judged: SavedVisit[] = [];
  const should = new Map<string, DoorRow>();
  let doorPhoenixKept: DoorRow[] = [];
  let doorVendorRows: DoorRow[] = [];
  let entryDay = false;
  const verdict = (): RepDayVerdict => {
    const lostIds = [...lost].sort();
    const lostSaved = input.saved.filter((visit) => lost.has(visit.id)).map((visit) => visit.createdAt).sort();
    return {
      hrKey: input.hrKey,
      date: input.date,
      checked: judged.length,
      excluded,
      failures,
      extras,
      unreadable,
      should,
      lostIds,
      doorPhoenixKept,
      doorVendorRows,
      entryDay,
      firstLostSavedAt: lostSaved[0] ?? null,
      earlyHoursIds: judged.filter((visit) => {
        const hour = cairoHourOf(visit.capturedAt);
        return hour !== null && hour < 2;
      }).map((visit) => visit.id),
    };
  };

  // S0 — the saved visits worth judging. Instants are compared as instants: the database writes
  // `+00:00` with microseconds and the cutoff is a `Z` string, so a text comparison would lie.
  const cutoff = Date.parse(input.quietCutoff);
  for (const visit of input.saved) {
    if (visit.isTest) bump(excluded, "test_row");
    else if (visit.removed) bump(excluded, "removed_by_admin");
    else if (!canonicalHrIdKey(visit.repHrId)) bump(excluded, "manager_own_visit");
    else if (Date.parse(visit.factsChangedAt) > cutoff) bump(excluded, "not_quiet");
    else judged.push(visit);
  }
  const savedById = new Map(judged.map((visit) => [visit.id, visit]));

  // S1 — the countable set, rebuilt, against phoenix_crm_countable_visits.
  const countable: SavedVisit[] = [];
  const stuck: string[] = [];
  const notCountable: SavedVisit[] = [];
  for (const visit of judged) {
    const answer = countableVerdict(visit);
    if (answer.countable) countable.push(visit);
    else if (answer.stuck) stuck.push(visit.id);
    else {
      bump(excluded, answer.reason);
      notCountable.push(visit);
    }
  }
  if (stuck.length > 0) {
    failures.push({ stage: 1, kind: "no_approval", ids: stuck, expected: stuck.length, found: 0 });
    for (const id of stuck) lost.add(id);
  }
  if (input.countableIds === null) {
    if (countable.length > 0) unreadable.push({ stage: 1, sources: ["phoenix_crm_countable_visits"], ids: countable.map((visit) => visit.id) });
  } else {
    const missing = countable.filter((visit) => !input.countableIds?.has(visit.id)).map((visit) => visit.id);
    if (missing.length > 0) {
      failures.push({ stage: 1, kind: "missing", ids: missing, expected: countable.length, found: countable.length - missing.length });
      for (const id of missing) lost.add(id);
    }
    const counted = notCountable.filter((visit) => input.countableIds?.has(visit.id)).map((visit) => visit.id);
    if (counted.length > 0) extras.push({ stage: 1, kind: "extra", ids: counted, expected: 0, found: counted.length });
  }

  // S2 — the started team's window, against crm_visits_unified. A stuck visit is followed downstream
  // too: it is a visit the rep made that reaches nothing, and every consumer it misses says so.
  if (input.windows === null) {
    const ids = [...countable.map((visit) => visit.id), ...stuck];
    if (ids.length > 0) unreadable.push({ stage: 2, sources: ["phoenix_crm_started_team_seats"], ids });
    return verdict();
  }
  const reachDoor: SavedVisit[] = [];
  for (const visit of countable) {
    const window = seatWindowVerdict(visit.seatId, visit.visitDate, input.windows);
    if (window.covered) reachDoor.push(visit);
    else bump(excluded, window.reason);
  }
  // A stuck visit inside a started window is followed to every consumer it never reaches; outside one
  // its S1 failure already says everything, and it is not counted as an exclusion as well.
  for (const visit of judged) {
    if (stuck.includes(visit.id) && seatWindowVerdict(visit.seatId, visit.visitDate, input.windows).covered) reachDoor.push(visit);
  }
  entryDay = reachDoor.some((visit) => !stuck.includes(visit.id) && (input.countableIds?.has(visit.id) ?? true));
  const unifiedById = new Map((input.unifiedRows ?? []).map((row) => [row.id, row]));
  if (input.unifiedRows === null) {
    const ids = reachDoor.filter((visit) => !lost.has(visit.id)).map((visit) => visit.id);
    if (ids.length > 0) unreadable.push({ stage: 2, sources: ["crm_visits_unified"], ids });
  } else {
    const missing = reachDoor.filter((visit) => !lost.has(visit.id) && !unifiedById.has(visit.id)).map((visit) => visit.id);
    if (missing.length > 0) {
      const found = reachDoor.filter((visit) => unifiedById.has(visit.id)).length;
      failures.push({ stage: 2, kind: "missing", ids: missing, expected: reachDoor.length, found });
      for (const id of missing) lost.add(id);
    }
  }
  const shapes = reachDoor.map((visit) => unifiedById.get(visit.id) ?? predictDoorRow(visit, input.person));

  // S3 — the read door: the departed-agent exclusion, then the duplicate collapse, then what it returned.
  let survivors = shapes;
  const departedIds: string[] = [];
  const exclusionUnknown: string[] = [];
  if (shapes.length > 0) {
    const hit = (row: DoorRow) => row.exclusion_crm_id != null && (input.excludedCrmIds?.has(Number(row.exclusion_crm_id)) ?? false);
    if (input.excludedCrmIds === null) {
      exclusionUnknown.push(...shapes.map((row) => row.id));
    } else if (shapes.some(hit)) {
      if (!input.personReadable || !input.person) {
        exclusionUnknown.push(...shapes.filter(hit).map((row) => row.id));
        survivors = shapes.filter((row) => !hit(row));
      } else if (isDepartedFromCrm(input.person, input.today)) {
        bump(excluded, "departed_agent", shapes.filter(hit).length);
        survivors = shapes.filter((row) => !hit(row));
      } else {
        // Still employed, and hidden as departed: the CRM id on the exclusion list is his own today.
        for (const row of shapes.filter(hit)) {
          departedIds.push(row.id);
          lost.add(row.id);
        }
      }
    }
  }
  if (departedIds.length > 0) {
    failures.push({ stage: 3, kind: "departed", ids: departedIds, expected: shapes.length, found: shapes.length - departedIds.length });
  }
  // The collapse, asked of the rows that SHOULD reach a reader: a re-save of one customer is one stop
  // (expected); two different customers folded together because they share a contact id is a loss.
  const kept = new Set(collapseDuplicateVisitSubmissions(survivors).map((row) => row.id));
  const keptByKey = new Map<string, DoorRow>();
  for (const row of survivors) {
    const key = collapseKeyOf(row);
    if (key && kept.has(row.id)) keptByKey.set(key, row);
  }
  const mergedIds: string[] = [];
  for (const row of survivors) {
    if (kept.has(row.id)) {
      should.set(row.id, row);
      continue;
    }
    const key = collapseKeyOf(row);
    const survivor = key ? keptByKey.get(key) : undefined;
    const sameCustomer = survivor && savedById.get(survivor.id)?.customerId === savedById.get(row.id)?.customerId;
    if (sameCustomer) {
      bump(excluded, "repeat_save_collapsed");
    } else {
      mergedIds.push(row.id);
      should.set(row.id, row);
      lost.add(row.id);
    }
  }
  for (const id of departedIds) {
    const row = shapes.find((shape) => shape.id === id);
    if (row) should.set(id, row);
  }
  if (mergedIds.length > 0) {
    failures.push({ stage: 3, kind: "merged", ids: mergedIds, expected: survivors.length, found: survivors.length - mergedIds.length });
  }

  if (input.doorRows === null) {
    const ids = [...should.keys()].filter((id) => !lost.has(id));
    if (ids.length > 0) unreadable.push({ stage: 3, sources: ["crm_visits_unified via queryVisits"], ids });
  } else {
    const mine = input.doorRows.filter((row) => row.visit_date === input.date && isRowOfRep(row, input.hrKey, input.person));
    const doorIds = new Set(mine.map((row) => row.id));
    const missing = [...should.keys()].filter((id) => !lost.has(id) && !exclusionUnknown.includes(id) && !doorIds.has(id));
    if (missing.length > 0) {
      const found = [...should.keys()].filter((id) => doorIds.has(id)).length;
      failures.push({ stage: 3, kind: "missing", ids: missing, expected: should.size, found });
      for (const id of missing) lost.add(id);
    }
    const phoenix = mine.filter((row) => row.source === "phoenix");
    doorPhoenixKept = collapseDuplicateVisitSubmissions(phoenix);
    doorVendorRows = mine.filter((row) => row.source !== "phoenix");
    // On his Phoenix entry day the door drops his iReports360 rows; one still served counts twice.
    if (entryDay && doorVendorRows.length > 0) {
      extras.push({ stage: 3, kind: "vendor", ids: doorVendorRows.map((row) => row.id), expected: 0, found: doorVendorRows.length });
    }
  }
  if (exclusionUnknown.length > 0) {
    unreadable.push({
      stage: 3,
      sources: input.excludedCrmIds === null ? ["departed-agent exclusion"] : ["employee directory"],
      ids: exclusionUnknown,
    });
  }
  failures.sort((left, right) => left.stage - right.stage);
  return verdict();
}

// ── S4 — the Private Calendar ──────────────────────────────────────────────────────────────────────

/** Whether a door row is counted on the field-visit chip (`visitCounts`) rather than the Double Visit feed. */
export function countsOnFieldVisitChip(row: DoorRow): boolean {
  const kind = fieldVisitActivityKind(row);
  return kind !== null && kind !== "vacation" && kind !== "other_crm";
}

export type CalendarVerdict = {
  /** Visits that should be on the day's field-visit chip. */
  expected: number;
  /** The Phoenix visits the chip counts (`visitCounts.phoenix`). */
  found: number;
  /** What the door itself serves for the chip, after the collapse. */
  served: number;
  /** Of the expected, how many were already lost upstream (S1–S3). */
  lostUpstream: number;
  missing: number;
  /** Visits counted beyond what the door serves — the same visit on the day twice (lead R8). */
  extra: number;
  shouldIds: string[];
  excludedPartnered: number;
};

export function calendarVerdict(day: RepDayVerdict, foundPhoenix: number): CalendarVerdict {
  const rows = [...day.should.values()];
  const onChip = rows.filter(countsOnFieldVisitChip);
  const lostSet = new Set(day.lostIds);
  const served = day.doorPhoenixKept.filter(countsOnFieldVisitChip).length;
  return {
    expected: onChip.length,
    found: foundPhoenix,
    served,
    lostUpstream: onChip.filter((row) => lostSet.has(row.id)).length,
    missing: Math.max(0, onChip.length - foundPhoenix),
    extra: Math.max(0, foundPhoenix - served),
    shouldIds: onChip.map((row) => row.id).sort(),
    excludedPartnered: rows.length - onChip.length,
  };
}

// ── S5 — the KPIs call rate ────────────────────────────────────────────────────────────────────────

export type KpiMonth = { start: string; end: string };

export function monthOf(date: string): KpiMonth {
  const start = `${date.slice(0, 7)}-01`;
  const next = new Date(`${start}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { start, end: addDaysIso(next.toISOString().slice(0, 10), -1) };
}

/** The call rate's last day: yesterday while the month runs (owner ruling C1), else the month's end. */
export function callRateToFor(month: KpiMonth, today: string): string {
  const yesterday = addDaysIso(today, -1);
  return yesterday < month.end ? yesterday : month.end;
}

/**
 * Whether the board scores this rep-month by the Phoenix rules at all. A team that went live INSIDE
 * the period keeps the old rules for it (`phoenixRuleRepKeys`, read on the period's first day) — and
 * the KPIs board lists medical reps only (`isMedicalRepJobTitle`, the title arm it uses).
 */
export function kpiApplicability(input: {
  month: KpiMonth;
  person: PersonFacts | null;
  seatIds: readonly string[];
  windows: readonly StartedSeatWindow[];
}): { applies: true } | { applies: false; reason: "kpi_not_medical_rep" | "kpi_old_rules_mid_period" } {
  if (!isMedicalRepJobTitle(input.person?.jobTitle)) return { applies: false, reason: "kpi_not_medical_rep" };
  const live = input.seatIds.some((seatId) =>
    input.windows.some(
      (window) => window.seatId === seatId && window.startsOn <= input.month.start && (window.stopsOn === null || window.stopsOn > input.month.start),
    ),
  );
  return live ? { applies: true } : { applies: false, reason: "kpi_old_rules_mid_period" };
}

export type KpiExpectation = {
  /** Visits the call rate must count (every rule applied, nothing optional). */
  min: number;
  /** `min` plus the visits a rule may or may not count (an unvalidated customer, the catch-all, a pharmacy, an unattributed vendor row). */
  max: number;
  /** Lost visits the call rate must have counted, by day — what a KPI shortfall is linked to. */
  lostByDay: Map<string, string[]>;
  excluded: Record<string, number>;
};

type KpiRowInput = { row: DoorRow; mandatory: boolean };

/**
 * The call rate's count for one rep-month, from the visits that SHOULD reach it — counted
 * independently of `computePhoenixRepKpis`, with its rules: the month to `callRateTo`, Saturday to
 * Wednesday minus holidays, a regular or campaign call (`classifyVisit`). A visit to a customer not
 * validated yet, to the catch-all contact or to a pharmacy may sit on one side of the rate and not
 * the other (the call rate and the Phoenix board rule them differently), so it widens the range and
 * never makes a finding on its own.
 */
export function kpiExpectation(input: {
  month: KpiMonth;
  callRateTo: string;
  holidays: ReadonlySet<string>;
  days: readonly RepDayVerdict[];
  /** iReports360 rows the door serves for him in the month: `attributed` by hr id, else by CRM id only. */
  vendorRows: ReadonlyArray<{ row: DoorRow; attributedByHrId: boolean }>;
}): KpiExpectation {
  const excluded: Record<string, number> = {};
  const note = (reason: string) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };
  const rows: KpiRowInput[] = [];
  const lostById = new Map<string, string>();
  for (const day of input.days) {
    for (const row of day.should.values()) rows.push({ row, mandatory: true });
    for (const id of day.lostIds) lostById.set(id, day.date);
  }
  const vendorKept = new Set(collapseDuplicateVisitSubmissions(input.vendorRows.map((entry) => entry.row)).map((row) => row.id));
  for (const entry of input.vendorRows) {
    if (vendorKept.has(entry.row.id)) rows.push({ row: entry.row, mandatory: entry.attributedByHrId });
  }

  let min = 0;
  let max = 0;
  const lostByDay = new Map<string, string[]>();
  for (const { row, mandatory } of rows) {
    const day = String(row.visit_date ?? "").slice(0, 10);
    if (!day || day < input.month.start || day > input.callRateTo) {
      note(day > input.callRateTo ? "kpi_today_or_later" : "kpi_outside_month");
      continue;
    }
    if (!isCallRateWorkingDay(day)) {
      note("kpi_thursday_friday");
      continue;
    }
    if (input.holidays.has(day)) {
      note("kpi_holiday");
      continue;
    }
    const { bucket } = classifyVisit(row.visit_type, row.comment, row.visit_type_description);
    if (bucket !== "regular" && bucket !== "campaign") {
      note("kpi_not_a_call");
      continue;
    }
    const optional =
      !mandatory ||
      row.contact_crm_id === CATCH_ALL_CONTACT_CRM_ID ||
      (row.source === "phoenix" && row.phoenix_customer_validated === false) ||
      visitCountBucket(row) === "Pharmacies";
    max += 1;
    if (optional) {
      note(
        row.contact_crm_id === CATCH_ALL_CONTACT_CRM_ID
          ? "kpi_catch_all_contact"
          : row.source === "phoenix" && row.phoenix_customer_validated === false
            ? "kpi_unvalidated_customer"
            : !mandatory
              ? "kpi_unattributed_vendor_row"
              : "kpi_pharmacy",
      );
      continue;
    }
    min += 1;
    const lostDay = lostById.get(row.id);
    if (lostDay) lostByDay.set(lostDay, [...(lostByDay.get(lostDay) ?? []), row.id]);
  }
  return { min, max, lostByDay, excluded };
}

// ── One lost visit counts once: the correlation id ─────────────────────────────────────────────────

/** The namespace every visit-lifecycle correlation id is minted in. Never change it: rows written
 * before the change would stop linking to the rows written after. */
export const VISIT_LIFECYCLE_UUID_NAMESPACE = "5b2f7c1e-8d4a-4e3b-9f6a-0c1d2e3f4a5b";

/** RFC 4122 version-5 UUID (SHA-1, name-based). */
export function uuidV5(name: string, namespace: string): string {
  const hex = namespace.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`Not a UUID namespace: ${namespace}`);
  const bytes = createHash("sha1").update(Buffer.from(hex, "hex")).update(Buffer.from(name, "utf8")).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const out = bytes.toString("hex");
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

/**
 * The id every row about the same lost visits shares — the rep, the day and the SORTED ids, so the
 * root row and each consumer's row written on any night agree. `scope` keeps the kinds that carry no
 * ids (a calendar-only or a month-level shortfall, an extra) from colliding with a day's lost visits.
 */
export function lifecycleCorrelationId(hrKey: string, date: string, ids: readonly string[], scope = "day"): string {
  return uuidV5(`${scope}|${hrKey}|${date}|${[...ids].sort().join(",")}`, VISIT_LIFECYCLE_UUID_NAMESPACE);
}
