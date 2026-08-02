/**
 * Per-day field-visit workload for one rep over a trip window, read straight from the
 * synced CRM mirror (`ireports360_visits`) — the admin/CRM source of truth.
 *
 * Why this exists separately from `getDoubleVisitExpenseWorkloadEvidence` (double-visit
 * analytics) and `getIReports360RepDayVisits` (the rep-day drill-down):
 *   - The double-visit evidence only sees rows in the double-visit mirror, so a rep's SOLO
 *     field days never appear.
 *   - The rep-day drill-down drops any visit whose PRIMARY agent has since departed — correct
 *     for the double-visit analytics it feeds, but it silently erases a rep's own field
 *     activity on days they were the double-visit PARTNER of a now-departed colleague.
 * Both under-counted real activity (confirmed on A-7, Jun 2026), which for an outstation expense
 * means wrongly flagging worked days as "no activity". This read counts every field visit where
 * the rep is EITHER the primary agent OR the double-visit partner, with no departed-agent
 * exclusion, so it reflects the rep's actual presence in the field.
 */

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { queryCheckins } from "@/lib/crm/reads";
import { CRM_VISITS_TABLE } from "@/lib/crm/tables";
import type { CrmCheckinRow } from "@/lib/crm/types";

export type RepVisitDetail = {
  ampm: string | null;
  contact: string | null;
  /** Doctor vs pharmacy vs institution — derived from `speciality`, regular visits only (the
   * vendor sends speciality on visit_type 0 only). See classifyVisitContactKind. */
  contactKind: VisitContactKind;
  customer: string | null;
  kind: "campaign" | "regular";
  role: "agent" | "partner";
  submittedAt: string | null;
};

export type VisitContactKind = "doctor" | "institution" | "pharmacy" | "unclassified";

/** The vendor's `speciality` values that are places rather than people. Everything else with a
 * value is a medical specialty → doctor. DISPLAY-ONLY classification (owner ruling 2026-08-02):
 * nothing in eligibility, amounts, or deductions consumes this — it exists so approvers can see
 * the mix. */
const INSTITUTION_SPECIALITIES = new Set([
  "armed forces hospital",
  "contract",
  "educational hospital",
  "health insurance",
  "hospital",
  "polyclinics",
  "private hospital",
  "university hospital",
]);

/** speciality → doctor / pharmacy / institution; null/blank → unclassified (campaign and other
 * non-regular rows carry no speciality by vendor contract). Pure and exported for the unit test. */
export function classifyVisitContactKind(speciality: string | null | undefined): VisitContactKind {
  const normalized = speciality?.trim().toLowerCase();
  if (!normalized) return "unclassified";
  if (normalized === "pharmacy") return "pharmacy";
  if (INSTITUTION_SPECIALITIES.has(normalized)) return "institution";
  return "doctor";
}

export type RepCheckinDetail = {
  address: string | null;
  at: string | null;
  contact: string | null;
  lat: number | null;
  lon: number | null;
  /** Rep name when the check-in is borrowed (the person was the double/triple-visitor, not the submitter). */
  via: string | null;
};

export type RepVisitWorkloadDay = {
  am: number;
  campaign: number;
  checkins: RepCheckinDetail[];
  date: string;
  /** Kind split of the day's REGULAR visits (doctor + pharmacy + institution ≤ regular; the
   * remainder had no speciality). Campaign rows never classify — the vendor omits speciality. */
  doctor: number;
  institution: number;
  other: number;
  pharmacy: number;
  pm: number;
  regular: number;
  total: number;
  visits: RepVisitDetail[];
};

export type RepVisitWorkload = {
  amWorkload: number;
  campaignVisits: number;
  dateBreakdown: RepVisitWorkloadDay[];
  /** Trip-total kind split of REGULAR visits — display-only context for approvers. */
  doctorVisits: number;
  idleDates: string[];
  institutionVisits: number;
  matchStatus: "matched" | "no_activity" | "partial" | "unmapped";
  matchedDates: string[];
  otherVisits: number;
  pharmacyVisits: number;
  pmWorkload: number;
  regularVisits: number;
  sourceLabel: string;
};

type WorkloadVisitRow = {
  agent_crm_id: number | null;
  ampm: string | null;
  contact_name: string | null;
  crm_save_date: string | null;
  customer_name: string | null;
  double_crm_id: number | null;
  speciality: string | null;
  visit_date: string;
  visit_type: number | null;
};

function eachDateInclusive(startIso: string, endIso: string): string[] {
  const start = startIso.slice(0, 10);
  const end = endIso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
    return /^\d{4}-\d{2}-\d{2}$/.test(start) ? [start] : [];
  }
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  // Hard cap so a malformed range can never spin: outstation trips are a handful of days.
  for (let guard = 0; cursor <= last && guard < 400; guard += 1) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function emptyWorkload(dates: string[], sourceLabel: string, matchStatus: RepVisitWorkload["matchStatus"]): RepVisitWorkload {
  return {
    amWorkload: 0,
    campaignVisits: 0,
    dateBreakdown: dates.map((date) => ({ am: 0, campaign: 0, checkins: [], date, doctor: 0, institution: 0, other: 0, pharmacy: 0, pm: 0, regular: 0, total: 0, visits: [] })),
    doctorVisits: 0,
    idleDates: dates,
    institutionVisits: 0,
    pharmacyVisits: 0,
    matchStatus,
    matchedDates: [],
    otherVisits: 0,
    pmWorkload: 0,
    regularVisits: 0,
    sourceLabel,
  };
}

/**
 * Count the rep's field visits (Regular = visit_type 0, Campaign = visit_type -8) per day across
 * the trip window, split AM/PM. Non-field visit types (Vacation/Meeting/Training/…) are surfaced
 * as `other` but excluded from the AM/PM workload. No collapse of burst re-saves yet — the count
 * mirrors distinct `ireports360_visits` rows (each keyed on `crm_visit_id`).
 */
export async function getRepTripVisitWorkload(input: {
  hrId: string | null | undefined;
  tripEndDate: string;
  tripStartDate: string;
}): Promise<RepVisitWorkload> {
  const start = input.tripStartDate.slice(0, 10);
  const end = input.tripEndDate.slice(0, 10);
  const dates = eachDateInclusive(start, end);
  const sourceLabel = "Live iReports360 Visits Report (admin/CRM — every field visit, agent or double-visit partner).";

  const hrId = String(input.hrId ?? "").trim();
  if (!hrId || dates.length === 0) {
    return emptyWorkload(dates, "No HR ID available to match CRM visits.", "unmapped");
  }

  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const key = canonicalHrIdKey(hrId);
  const employee = directory.find((row) => canonicalHrIdKey(row.hrId) === key) ?? null;
  const crmId = employee?.crmId == null ? null : Number(employee.crmId);
  if (!crmId || Number.isNaN(crmId)) {
    return emptyWorkload(dates, "This rep has no CRM id, so their visits can't be matched.", "unmapped");
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(CRM_VISITS_TABLE)
    .select("agent_crm_id, ampm, contact_name, crm_save_date, customer_name, double_crm_id, speciality, visit_date, visit_type")
    .gte("visit_date", start)
    .lte("visit_date", `${end}T23:59:59.999Z`)
    .or(`agent_crm_id.eq.${crmId},double_crm_id.eq.${crmId}`);
  if (error) throw new Error(error.message);

  const byDate = new Map<string, RepVisitWorkloadDay>();
  for (const date of dates) {
    byDate.set(date, { am: 0, campaign: 0, checkins: [], date, doctor: 0, institution: 0, other: 0, pharmacy: 0, pm: 0, regular: 0, total: 0, visits: [] });
  }

  // Who logs the GPS check-in each day: the person who SUBMITTED the visit (its agent_crm_id).
  // Managers (DM/TM/NSM) never submit — the rep does and tags them as the double-visitor — so a
  // manager's route/check-in must be borrowed from the rep (memory: dv-checkin-attribution-…).
  // checkinOwnersByDate maps each active day to the submitter crm_ids whose check-ins are this
  // person's route that day (self when they submitted, else the rep(s) they were double with).
  const checkinOwnersByDate = new Map<string, Set<number>>();

  for (const row of (data ?? []) as WorkloadVisitRow[]) {
    const day = String(row.visit_date ?? "").slice(0, 10);
    const entry = byDate.get(day);
    if (!entry) continue;

    const isRegular = row.visit_type === 0;
    const isCampaign = row.visit_type === -8;
    if (!isRegular && !isCampaign) {
      entry.other += 1;
      continue;
    }
    const contactKind = classifyVisitContactKind(row.speciality);
    if (isRegular) {
      entry.regular += 1;
      if (contactKind === "doctor") entry.doctor += 1;
      else if (contactKind === "pharmacy") entry.pharmacy += 1;
      else if (contactKind === "institution") entry.institution += 1;
    } else {
      entry.campaign += 1;
    }
    entry.total += 1;

    const ampm = String(row.ampm ?? "").trim().toUpperCase();
    if (ampm.startsWith("A")) entry.am += 1;
    else entry.pm += 1; // PM or unmarked → PM, so every counted field visit lands in AM or PM

    const submitter = Number(row.agent_crm_id);
    if (Number.isFinite(submitter)) {
      if (!checkinOwnersByDate.has(day)) checkinOwnersByDate.set(day, new Set());
      checkinOwnersByDate.get(day)!.add(submitter);
    }

    entry.visits.push({
      ampm: row.ampm ?? null,
      contact: row.contact_name ?? null,
      contactKind,
      customer: row.customer_name ?? null,
      kind: isRegular ? "regular" : "campaign",
      role: submitter === crmId ? "agent" : "partner",
      submittedAt: row.crm_save_date ?? null,
    });
  }

  // Best-effort: pull check-ins for every submitter this person shares a visit with (self + the
  // reps they were double/triple-visited with), then attribute each to a day only if its owner is a
  // route-owner for THAT day. A check-in hiccup must never break the workload the approver relies on.
  const ownerIds = new Set<number>([crmId]);
  for (const owners of checkinOwnersByDate.values()) for (const id of owners) ownerIds.add(id);
  const nameByCrm = new Map<number, string>();
  for (const emp of directory) {
    const empCrm = emp.crmId == null ? null : Number(emp.crmId);
    if (empCrm != null && !Number.isNaN(empCrm) && emp.fullName) nameByCrm.set(empCrm, emp.fullName);
  }

  const checkinRows = await queryCheckins<CrmCheckinRow>({
    agentCrmIds: [...ownerIds],
    ascending: true,
    dateFrom: start,
    dateTo: end,
    orderBy: "check_date",
  }).catch(() => [] as CrmCheckinRow[]);

  for (const row of checkinRows) {
    const day = String(row.check_date ?? "").slice(0, 10);
    const entry = byDate.get(day);
    if (!entry) continue;
    const owner = Number(row.agent_crm_id);
    const dayOwners = checkinOwnersByDate.get(day);
    if (!dayOwners || !dayOwners.has(owner)) continue; // not part of this person's route that day
    entry.checkins.push({
      address: row.address ?? null,
      at: row.check_date ?? null,
      contact: row.contact_name ?? null,
      lat: row.lat ?? null,
      lon: row.lon ?? null,
      via: owner === crmId ? null : nameByCrm.get(owner) ?? `rep ${owner}`,
    });
  }

  // Order each day's detail by time so the visits + check-ins read as the day's route.
  for (const entry of byDate.values()) {
    entry.visits.sort((a, b) => String(a.submittedAt ?? "").localeCompare(String(b.submittedAt ?? "")));
    entry.checkins.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  }

  const dateBreakdown = dates.map((date) => byDate.get(date)!);
  const matchedDates = dateBreakdown.filter((day) => day.total > 0).map((day) => day.date);
  const idleDates = dateBreakdown.filter((day) => day.total === 0).map((day) => day.date);
  const matchStatus: RepVisitWorkload["matchStatus"] =
    matchedDates.length === 0 ? "no_activity" : idleDates.length > 0 ? "partial" : "matched";

  return {
    amWorkload: dateBreakdown.reduce((sum, day) => sum + day.am, 0),
    campaignVisits: dateBreakdown.reduce((sum, day) => sum + day.campaign, 0),
    dateBreakdown,
    doctorVisits: dateBreakdown.reduce((sum, day) => sum + day.doctor, 0),
    idleDates,
    institutionVisits: dateBreakdown.reduce((sum, day) => sum + day.institution, 0),
    matchStatus,
    matchedDates,
    otherVisits: dateBreakdown.reduce((sum, day) => sum + day.other, 0),
    pharmacyVisits: dateBreakdown.reduce((sum, day) => sum + day.pharmacy, 0),
    pmWorkload: dateBreakdown.reduce((sum, day) => sum + day.pm, 0),
    regularVisits: dateBreakdown.reduce((sum, day) => sum + day.regular, 0),
    sourceLabel,
  };
}
