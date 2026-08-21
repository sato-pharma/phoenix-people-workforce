/**
 * Rep Doctor Lists — each medical rep's ASSIGNED doctor list from the CRM, and how much of it they
 * actually saw.
 *
 * WHAT THIS ADDS THAT DOCTOR COVERAGE CANNOT. sfe-doctor-coverage.ts builds its panel from visit
 * HISTORY: a contact enters the board because someone visited it. A doctor who sits on a rep's list
 * and is never visited therefore has no row anywhere in Phoenix and is invisible to that board by
 * construction — which is precisely the population a coverage question is about. Measured live
 * 2026-08-21 for 1-21 August: of 7,085 planned rep-to-doctor pairs, 2,941 (42%) had no visit at all.
 * Those 2,941 are the rows this module exists to show.
 *
 * The two boards therefore answer different questions and are both correct:
 *   Doctor Coverage  — of the doctors we DID see, who is short of their visit norm?
 *   Rep Doctor Lists — of the doctors we were SUPPOSED to see, who did we never reach?
 *
 * SCOPE RULES (deliberate, and surfaced on the board):
 *  - Plan side: every weekly plan entry whose `plan_date` falls in the selected month.
 *  - Actual side: visit_type 0 (regular customer visits) only, duplicate submissions collapsed —
 *    the same door Doctor Coverage and DV Analytics read through, so the numbers agree.
 *  - Departed agents are excluded from BOTH sides. The reads door already drops them from visits;
 *    the plan side must drop them too, or a leaver whose plan is still on file scores 0% forever.
 *  - The join is on the vendor's own keys (agent_crm_id + contact_crm_id), present and identical on
 *    both sides, rather than on a resolved hr id — nothing here depends on identity resolution
 *    having succeeded, and the 79 planning agents measured on 2026-08-21 all resolved anyway.
 *  - Contact kind comes from the shared taxonomy (contact-taxonomy.ts). A speciality it has never
 *    seen stays `unclassified` and is COUNTED AND NAMED on the board, never folded into the doctor
 *    total — the plan carries two such values today ("Nephrology", "Dermatologist") that the
 *    taxonomy was written before the vendor started sending.
 *
 * DATE DISCIPLINE (same test-enforced rule as sfe-doctor-coverage.ts): CRM dates are Cairo
 * wall-clock and `plan_date`/`visit_date` are plain YYYY-MM-DD, so all month math is string
 * arithmetic — never Date-object parsing or ISO re-serialization, either of which shifts the clock.
 */

import { CRM_PLAN_ENTRIES_TABLE } from "@/lib/crm/tables";
import { cairoTodayIso } from "@/lib/crm/dates";
import { classifyCrmContactSpeciality, type CrmContactKind } from "@/lib/crm/contact-taxonomy";
import { getEffectiveExcludedAgentCrmIds, queryVisits } from "@/lib/crm/reads";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_NAMES = [
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
 * How many doctor rows the drill-down ships when no single rep is selected. The company-wide list
 * is ~9,000 rows a month, which is a multi-megabyte payload for a table nobody reads end to end.
 * The cap is NEVER silent: `doctorsTotal` always reports the true count and the board says so, so a
 * truncated list can never be mistaken for a complete one.
 */
export const REP_DOCTOR_DRILLDOWN_CAP = 500;

/** Rows per page when scanning the plan mirror. Matches the CRM reads door. */
const PLAN_PAGE_SIZE = 1000;

export type RepDoctorStatus = "seen" | "missed" | "off_plan";

export type RepDoctorListRepRow = {
  /** Percentage of planned doctors actually visited this month. 0 when nothing was planned. */
  adherencePct: number;
  agentCrmId: number;
  agentHrId: string | null;
  gradeA: number;
  gradeB: number;
  gradeC: number;
  /** Planned doctors with no type-0 visit this month. */
  missedDoctors: number;
  /** Doctors visited this month who are NOT on this rep's plan. */
  offPlanDoctors: number;
  /** Distinct HCP accounts (pharmacies, hospitals, contracts) on the plan. */
  plannedAccounts: number;
  /** Total plan ENTRIES, i.e. planned calls — higher than plannedDoctors when a doctor is planned
   * more than once in the month. */
  plannedCalls: number;
  /** Distinct SP contacts on the plan — the doctor list itself. */
  plannedDoctors: number;
  plannedUnclassified: number;
  repKey: string;
  repName: string;
  /** Plan entries still at vendor status 0 (New) — never verified by a supervisor. */
  unverifiedCalls: number;
  /** Planned doctors with at least one type-0 visit this month. */
  visitedDoctors: number;
};

export type RepDoctorListDoctorRow = {
  contactCrmId: number;
  contactName: string;
  gradeRaw: string | null;
  kind: CrmContactKind;
  /** null for an off-plan doctor — there is no planned call to point at. */
  lastPlanDate: string | null;
  lastVisitDate: string | null;
  /** How many times the plan asks for this contact this month. 0 for an off-plan doctor. */
  plannedCalls: number;
  regionName: string | null;
  repKey: string;
  repName: string;
  speciality: string | null;
  status: RepDoctorStatus;
  visits: number;
};

export type RepDoctorListFilters = {
  kind?: string;
  repKey?: string;
  search?: string;
  status?: string;
};

export type RepDoctorListsBoard = {
  appliedFilters: RepDoctorListFilters;
  doctors: RepDoctorListDoctorRow[];
  /** True count before REP_DOCTOR_DRILLDOWN_CAP — so the cap is always visible. */
  doctorsTotal: number;
  isCurrentMonth: boolean;
  month: string;
  monthLabel: string;
  /** Latest `synced_at` on any plan row in the window, or null when the mirror is empty. */
  planSyncedAt: string | null;
  repOptions: Array<{ repKey: string; repName: string }>;
  reps: RepDoctorListRepRow[];
  /** Reps with type-0 visits this month but no plan entries at all. */
  repsWithoutPlan: number;
  totals: {
    adherencePct: number;
    missedDoctors: number;
    offPlanDoctors: number;
    plannedAccounts: number;
    plannedCalls: number;
    plannedDoctors: number;
    reps: number;
    unverifiedCalls: number;
    visitedDoctors: number;
  };
  /** Speciality values the shared taxonomy has never seen, with their contact counts. Surfaced so a
   * new vendor value is a visible decision rather than a silent omission from the doctor total. */
  unclassifiedSpecialities: Array<{ contacts: number; label: string }>;
};

/** The plan-mirror projection this board reads. Exported so tests can build fixtures against the
 * real shape rather than a hand-written lookalike that can drift from it. */
export type PlanRow = {
  agent_crm_id: number;
  agent_hr_id: string | null;
  contact_crm_id: number | null;
  contact_grade: string | null;
  contact_name: string | null;
  crm_region_name: string | null;
  plan_date: string | null;
  plan_status: number | null;
  speciality: string | null;
  synced_at: string | null;
};

/** The visits-mirror projection this board reads (see the `columns` list in getRepDoctorLists). */
export type VisitRow = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  agent_name: string | null;
  contact_crm_id: number | null;
  crm_contact_grade: string | null;
  speciality: string | null;
  visit_date: string | null;
};

/** "YYYY-MM" for a "YYYY-MM-DD" date string. String slice only — never Date parsing. */
export function monthKeyOfDate(dateIso: string): string {
  return dateIso.slice(0, 7);
}

/** First and last day of a month key, inclusive. */
export function monthBounds(monthKey: string): { from: string; to: string } {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  // Day 0 of the NEXT month is the last day of this one. UTC-only construction, and only the day
  // NUMBER is read back out — no instant derived from it ever reaches a stored or displayed value.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${monthKey}-01`, to: `${monthKey}-${String(lastDay).padStart(2, "0")}` };
}

export function resolveRepDoctorListMonth(month: string | undefined): string {
  if (month && MONTH_KEY_PATTERN.test(month)) return month;
  return monthKeyOfDate(cairoTodayIso());
}

export function monthLabelOf(monthKey: string): string {
  const monthIndex = Number(monthKey.slice(5, 7)) - 1;
  return `${MONTH_NAMES[monthIndex] ?? monthKey} ${monthKey.slice(0, 4)}`;
}

/** A+ folds into A, matching Doctor Coverage's tiering so the two boards grade identically. */
export function gradeTierOf(grade: string | null | undefined): "A" | "B" | "C" | null {
  const normalized = String(grade ?? "").trim().toUpperCase();
  if (normalized === "A+" || normalized === "A") return "A";
  if (normalized === "B") return "B";
  if (normalized === "C") return "C";
  return null;
}

/** Reads every plan entry whose date falls inside the window. Returns [] before the migration
 * ships, so the page renders an honest empty state instead of a crash. */
async function scanPlanEntries(from: string, to: string): Promise<PlanRow[]> {
  const supabase = getSupabaseAdmin();
  const rows: PlanRow[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(CRM_PLAN_ENTRIES_TABLE)
      .select(
        "agent_crm_id, agent_hr_id, contact_crm_id, contact_grade, contact_name, crm_region_name, plan_date, plan_status, speciality, synced_at",
      )
      .gte("plan_date", from)
      .lte("plan_date", to)
      .order("crm_plan_entry_id", { ascending: true })
      .range(offset, offset + PLAN_PAGE_SIZE - 1);
    if (error) {
      if (isPlanSchemaMissing(error)) return [];
      throw new Error(error.message);
    }
    const page = (data ?? []) as unknown as PlanRow[];
    rows.push(...page);
    if (page.length < PLAN_PAGE_SIZE) break;
    offset += PLAN_PAGE_SIZE;
  }
  return rows;
}

/** The plan mirror is newer than several environments' schemas; a missing table degrades to an
 * empty board rather than a crash page, matching every other CRM reader's posture. */
function isPlanSchemaMissing(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? error ?? "").toLowerCase();
  return (
    message.includes(CRM_PLAN_ENTRIES_TABLE) ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

function contactKey(agentCrmId: number, contactCrmId: number): string {
  return `${agentCrmId}:${contactCrmId}`;
}

export type RepDoctorListsInput = {
  /** Canonical (upper-cased, trimmed) hr id → the employee's display name. */
  employeeNameByHrId: ReadonlyMap<string, string>;
  /** Departed agents, from the CRM reads door. Applied to the PLAN side here; the visits side has
   * already had them removed by the door itself. */
  excludedAgentCrmIds: readonly number[];
  filters?: RepDoctorListFilters;
  month: string;
  planRows: readonly PlanRow[];
  /** Type-0 visits for the same window, duplicate submissions already collapsed. */
  visitRows: readonly VisitRow[];
};

/**
 * Builds the board for one month.
 *
 * Both halves are read for the same window and joined in memory. That is deliberate rather than a
 * SQL join: the plan mirror and the visits mirror have different exclusion rules (the visits door
 * owns departed-agent and duplicate-submission logic and must stay the single source of it), and
 * pushing the join into SQL would fork that logic into a second place.
 */
export async function getRepDoctorLists(input: {
  filters?: RepDoctorListFilters;
  month: string;
}): Promise<RepDoctorListsBoard> {
  const { from, to } = monthBounds(input.month);

  const [planRows, visitRows, excludedAgentCrmIds, directory] = await Promise.all([
    scanPlanEntries(from, to),
    queryVisits<VisitRow>({
      collapseDoubleVisits: true,
      columns: "agent_crm_id, agent_hr_id, agent_name, contact_crm_id, crm_contact_grade, speciality, visit_date",
      dateFrom: from,
      dateTo: to,
      visitTypes: [0],
    }),
    getEffectiveExcludedAgentCrmIds(),
    getEmployeeDirectoryRows({ includeInactive: true }),
  ]);

  const employeeNameByHrId = new Map<string, string>();
  for (const employee of directory) {
    employeeNameByHrId.set(employee.hrId.trim().toUpperCase(), employee.displayName || employee.fullName);
  }

  return buildRepDoctorListsBoard({
    employeeNameByHrId,
    excludedAgentCrmIds,
    filters: input.filters,
    month: input.month,
    planRows,
    visitRows,
  });
}

/**
 * The whole join, as a pure function — every number this board reports is produced here.
 *
 * Separated from the IO deliberately. This is the half that can be wrong in a way nobody notices:
 * "this rep never visited 59 doctors" is an accusation, and it has to be verifiable without a
 * database. tests/crm-rep-doctor-lists.test.ts drives it with fixtures.
 */
export function buildRepDoctorListsBoard(input: RepDoctorListsInput): RepDoctorListsBoard {
  const month = input.month;
  const filters = input.filters ?? {};
  const visitRows = input.visitRows;

  // Symmetry with the visits door, which has already dropped these agents from `visitRows`.
  const excluded = new Set(input.excludedAgentCrmIds);
  const planRows = input.planRows.filter((row) => !excluded.has(row.agent_crm_id));

  // Rep display names: the employee record first (the owner's rule is human-readable names, and the
  // directory carries the nickname-aware one), then the vendor's own label from the visits mirror,
  // then an explicit unmapped marker. A plan entry carries no agent name field at all, so a rep who
  // planned but never visited has only the first source.
  const nameByHrId = input.employeeNameByHrId;
  const vendorNameByCrmId = new Map<number, string>();
  for (const visit of visitRows) {
    const crmId = visit.agent_crm_id;
    const name = visit.agent_name?.trim();
    if (crmId && name && !vendorNameByCrmId.has(crmId)) vendorNameByCrmId.set(crmId, name);
  }
  const hrIdByCrmId = new Map<number, string | null>();
  for (const row of planRows) {
    if (!hrIdByCrmId.has(row.agent_crm_id)) hrIdByCrmId.set(row.agent_crm_id, row.agent_hr_id);
  }
  for (const visit of visitRows) {
    if (visit.agent_crm_id && !hrIdByCrmId.has(visit.agent_crm_id)) {
      hrIdByCrmId.set(visit.agent_crm_id, visit.agent_hr_id);
    }
  }
  const repNameOf = (agentCrmId: number): string => {
    const hrId = hrIdByCrmId.get(agentCrmId);
    const fromDirectory = hrId ? nameByHrId.get(hrId.trim().toUpperCase()) : undefined;
    if (fromDirectory) return fromDirectory;
    const fromVendor = vendorNameByCrmId.get(agentCrmId);
    if (fromVendor) return fromVendor;
    return `Unmapped CRM agent ${agentCrmId}`;
  };

  // ── Plan side ────────────────────────────────────────────────────────────────────────────────
  type PlanContact = {
    agentCrmId: number;
    contactCrmId: number;
    gradeRaw: string | null;
    kind: CrmContactKind;
    lastPlanDate: string | null;
    name: string;
    plannedCalls: number;
    regionName: string | null;
    speciality: string | null;
    unverifiedCalls: number;
  };
  const planned = new Map<string, PlanContact>();
  const unclassifiedContacts = new Map<string, Set<number>>();
  let planSyncedAt: string | null = null;

  for (const row of planRows) {
    if (row.synced_at && (!planSyncedAt || row.synced_at > planSyncedAt)) planSyncedAt = row.synced_at;
    const contactCrmId = row.contact_crm_id;
    // 0 is the vendor's "unspecified contact" sentinel, exactly as on a visit — not a real person.
    if (!contactCrmId) continue;
    const key = contactKey(row.agent_crm_id, contactCrmId);
    const kind = classifyCrmContactSpeciality(row.speciality);
    if (kind === "unclassified" && row.speciality?.trim()) {
      const label = row.speciality.trim();
      const bucket = unclassifiedContacts.get(label) ?? new Set<number>();
      bucket.add(contactCrmId);
      unclassifiedContacts.set(label, bucket);
    }
    const existing = planned.get(key);
    if (existing) {
      existing.plannedCalls += 1;
      if (row.plan_status === 0) existing.unverifiedCalls += 1;
      if (row.plan_date && (!existing.lastPlanDate || row.plan_date > existing.lastPlanDate)) {
        existing.lastPlanDate = row.plan_date;
      }
      continue;
    }
    planned.set(key, {
      agentCrmId: row.agent_crm_id,
      contactCrmId,
      gradeRaw: row.contact_grade,
      kind,
      lastPlanDate: row.plan_date,
      name: row.contact_name?.trim() || `Contact ${contactCrmId}`,
      plannedCalls: 1,
      regionName: row.crm_region_name,
      speciality: row.speciality,
      unverifiedCalls: row.plan_status === 0 ? 1 : 0,
    });
  }

  // ── Actual side ──────────────────────────────────────────────────────────────────────────────
  type VisitedContact = {
    agentCrmId: number;
    contactCrmId: number;
    gradeRaw: string | null;
    lastVisitDate: string | null;
    speciality: string | null;
    visits: number;
  };
  const visited = new Map<string, VisitedContact>();
  const repsWithVisits = new Set<number>();
  for (const visit of visitRows) {
    const agentCrmId = visit.agent_crm_id;
    const contactCrmId = visit.contact_crm_id;
    if (!agentCrmId) continue;
    repsWithVisits.add(agentCrmId);
    if (!contactCrmId) continue;
    const key = contactKey(agentCrmId, contactCrmId);
    const visitDate = visit.visit_date ? visit.visit_date.slice(0, 10) : null;
    const existing = visited.get(key);
    if (existing) {
      existing.visits += 1;
      if (visitDate && (!existing.lastVisitDate || visitDate > existing.lastVisitDate)) {
        existing.lastVisitDate = visitDate;
      }
      continue;
    }
    visited.set(key, {
      agentCrmId,
      contactCrmId,
      gradeRaw: visit.crm_contact_grade,
      lastVisitDate: visitDate,
      speciality: visit.speciality,
      visits: 1,
    });
  }

  // ── Join ─────────────────────────────────────────────────────────────────────────────────────
  const doctorRows: RepDoctorListDoctorRow[] = [];
  const repAccumulator = new Map<number, RepDoctorListRepRow>();
  const repFor = (agentCrmId: number): RepDoctorListRepRow => {
    const existing = repAccumulator.get(agentCrmId);
    if (existing) return existing;
    const created: RepDoctorListRepRow = {
      adherencePct: 0,
      agentCrmId,
      agentHrId: hrIdByCrmId.get(agentCrmId) ?? null,
      gradeA: 0,
      gradeB: 0,
      gradeC: 0,
      missedDoctors: 0,
      offPlanDoctors: 0,
      plannedAccounts: 0,
      plannedCalls: 0,
      plannedDoctors: 0,
      plannedUnclassified: 0,
      repKey: String(agentCrmId),
      repName: repNameOf(agentCrmId),
      unverifiedCalls: 0,
      visitedDoctors: 0,
    };
    repAccumulator.set(agentCrmId, created);
    return created;
  };

  for (const [key, contact] of planned) {
    const rep = repFor(contact.agentCrmId);
    rep.plannedCalls += contact.plannedCalls;
    rep.unverifiedCalls += contact.unverifiedCalls;
    if (contact.kind === "hcp") rep.plannedAccounts += 1;
    else if (contact.kind === "unclassified") rep.plannedUnclassified += 1;

    const seen = visited.get(key);
    // Only SP contacts count toward the doctor list and its adherence — a pharmacy is not a doctor,
    // the same split the taxonomy was written to enforce on Doctor Coverage.
    if (contact.kind === "sp") {
      rep.plannedDoctors += 1;
      const tier = gradeTierOf(contact.gradeRaw);
      if (tier === "A") rep.gradeA += 1;
      else if (tier === "B") rep.gradeB += 1;
      else if (tier === "C") rep.gradeC += 1;
      if (seen) rep.visitedDoctors += 1;
      else rep.missedDoctors += 1;
    }

    doctorRows.push({
      contactCrmId: contact.contactCrmId,
      contactName: contact.name,
      gradeRaw: contact.gradeRaw,
      kind: contact.kind,
      lastPlanDate: contact.lastPlanDate,
      lastVisitDate: seen?.lastVisitDate ?? null,
      plannedCalls: contact.plannedCalls,
      regionName: contact.regionName,
      repKey: rep.repKey,
      repName: rep.repName,
      speciality: contact.speciality,
      status: seen ? "seen" : "missed",
      visits: seen?.visits ?? 0,
    });
  }

  // Visited but never planned. Counted for doctors only, for the same reason as above.
  for (const [key, contact] of visited) {
    if (planned.has(key)) continue;
    const kind = classifyCrmContactSpeciality(contact.speciality);
    const rep = repFor(contact.agentCrmId);
    if (kind === "sp") rep.offPlanDoctors += 1;
    doctorRows.push({
      contactCrmId: contact.contactCrmId,
      contactName: `Contact ${contact.contactCrmId}`,
      gradeRaw: contact.gradeRaw,
      kind,
      lastPlanDate: null,
      lastVisitDate: contact.lastVisitDate,
      plannedCalls: 0,
      regionName: null,
      repKey: rep.repKey,
      repName: rep.repName,
      speciality: contact.speciality,
      status: "off_plan",
      visits: contact.visits,
    });
  }

  // The visit projection carries no contact name, so an off-plan row would print a bare id — which
  // the owner's naming rule forbids. Fill it from any planned row for the same contact (a doctor
  // off THIS rep's plan is usually on another's) before falling back to the id form.
  const nameByContactId = new Map<number, string>();
  for (const contact of planned.values()) nameByContactId.set(contact.contactCrmId, contact.name);
  for (const row of doctorRows) {
    if (row.status !== "off_plan") continue;
    const known = nameByContactId.get(row.contactCrmId);
    if (known) row.contactName = known;
  }

  for (const rep of repAccumulator.values()) {
    rep.adherencePct = rep.plannedDoctors > 0 ? Math.round((rep.visitedDoctors / rep.plannedDoctors) * 100) : 0;
  }

  const repsWithPlan = new Set([...planned.values()].map((contact) => contact.agentCrmId));
  const repsWithoutPlan = [...repsWithVisits].filter((agentCrmId) => !repsWithPlan.has(agentCrmId)).length;

  // ── Filters ──────────────────────────────────────────────────────────────────────────────────
  const search = filters.search?.trim().toLowerCase() ?? "";
  const filteredDoctors = doctorRows.filter((row) => {
    if (filters.repKey && row.repKey !== filters.repKey) return false;
    if (filters.status && row.status !== filters.status) return false;
    if (filters.kind && row.kind !== filters.kind) return false;
    if (search) {
      const haystack = `${row.contactName} ${row.speciality ?? ""} ${row.repName} ${row.regionName ?? ""}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  // Missed first (the actionable half), then most-planned, then name — a stable order that puts the
  // doctors nobody reached at the top without needing a sort click.
  const statusRank: Record<RepDoctorStatus, number> = { missed: 0, off_plan: 1, seen: 2 };
  filteredDoctors.sort(
    (left, right) =>
      statusRank[left.status] - statusRank[right.status] ||
      right.plannedCalls - left.plannedCalls ||
      left.contactName.localeCompare(right.contactName),
  );

  const reps = [...repAccumulator.values()]
    .filter((rep) => !filters.repKey || rep.repKey === filters.repKey)
    .sort((left, right) => left.adherencePct - right.adherencePct || right.plannedDoctors - left.plannedDoctors);

  const totals = {
    adherencePct: 0,
    missedDoctors: 0,
    offPlanDoctors: 0,
    plannedAccounts: 0,
    plannedCalls: 0,
    plannedDoctors: 0,
    reps: 0,
    unverifiedCalls: 0,
    visitedDoctors: 0,
  };
  for (const rep of reps) {
    totals.missedDoctors += rep.missedDoctors;
    totals.offPlanDoctors += rep.offPlanDoctors;
    totals.plannedAccounts += rep.plannedAccounts;
    totals.plannedCalls += rep.plannedCalls;
    totals.plannedDoctors += rep.plannedDoctors;
    totals.reps += 1;
    totals.unverifiedCalls += rep.unverifiedCalls;
    totals.visitedDoctors += rep.visitedDoctors;
  }
  totals.adherencePct =
    totals.plannedDoctors > 0 ? Math.round((totals.visitedDoctors / totals.plannedDoctors) * 100) : 0;

  // A single rep's whole list is ~250 rows at the observed maximum, so it ships uncapped — the cap
  // exists only to stop the company-wide view (~9,000 rows) becoming a multi-megabyte payload.
  const capped = filters.repKey ? filteredDoctors : filteredDoctors.slice(0, REP_DOCTOR_DRILLDOWN_CAP);

  return {
    appliedFilters: filters,
    doctors: capped,
    doctorsTotal: filteredDoctors.length,
    isCurrentMonth: month === monthKeyOfDate(cairoTodayIso()),
    month,
    monthLabel: monthLabelOf(month),
    planSyncedAt,
    repOptions: [...repAccumulator.values()]
      .map((rep) => ({ repKey: rep.repKey, repName: rep.repName }))
      .sort((left, right) => left.repName.localeCompare(right.repName)),
    reps,
    repsWithoutPlan,
    totals,
    unclassifiedSpecialities: [...unclassifiedContacts.entries()]
      .map(([label, contacts]) => ({ contacts: contacts.size, label }))
      .sort((left, right) => right.contacts - left.contacts),
  };
}
