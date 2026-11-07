/**
 * Per-day field-visit workload for one person over a trip window, read through the CRM visits door
 * (`crm_visits_unified`): Phoenix CRM for every territory from its team's start, and from 6 Nov 2026 for
 * every territory; the stored iReports360 archive only before that (owner, 6 Nov 2026: "ANY SINGLE SOURCE OF
 * FIELD WORK IS NOW THE PHOENIX CRM"). A manager's own single visits, which live apart from the door in
 * phoenix_crm_manager_visits, are added through their one reader (loadManagerOwnVisitRows): a double visit a
 * rep logged with him on it and a single visit he logged himself both count to him (owner, same day).
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
import { checkinAgentKey } from "@/lib/crm/checkin-match";
import { isHandedOverLabel, loadCrmIdentityMaps, previousHolderLabel } from "@/lib/crm/identity";
import { queryCheckins, queryVisits } from "@/lib/crm/reads";
import { isMeetingVisitType, tripWorkloadMatch } from "@/lib/crm/trip-day-meetings";
import type { CrmCheckinRow } from "@/lib/crm/types";
import { addBucketToSplit, addVisitToSplit } from "@/lib/crm/visit-count-buckets";
import { isUnplannedFieldVisit } from "@/lib/crm/visit-type-meaning";
import { visitCountBucketForListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { loadManagerOwnVisitRows } from "@/lib/phoenix-crm/server/manager-plan-readers";

export type RepVisitDetail = {
  ampm: string | null;
  contact: string | null;
  /** Doctor vs pharmacy vs institution — derived from `speciality`, regular visits only (the
   * vendor sends speciality on visit_type 0 only). See classifyVisitContactKind. */
  contactKind: VisitContactKind;
  customer: string | null;
  /** "campaign" is the stored word for an UNPLANNED visit (isUnplannedFieldVisit) — the payload keeps it so
   * every reader still parses; a screen prints "Unplanned" and "Planned". "meeting" is a recorded Meeting or
   * Group Meeting (trip-day-meetings.ts): listed so the approver sees it, never counted as a visit. */
  kind: "campaign" | "meeting" | "regular";
  /**
   * On a "partner" visit, the rep who LOGGED it — the person this one was in the field with (owner,
   * 2026-11-06: a manager's visits in Expense Approvals show the rep's name, even a rep who has
   * since resigned). Named by the row's own hr id, which the sync attributes inside the rep's tenure
   * only; a row with no hr id whose label names only people hired later is a handed-over account's
   * earlier holder and reads "Previous holder ( territory )", never the later holder's name. Null on
   * the person's own visits, or when no name can be given honestly. Display only — never counted.
   */
  repName: string | null;
  /** "own" is a manager's single visit he logged himself (phoenix_crm_manager_visits). */
  role: "agent" | "own" | "partner";
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
  contactCrmId: number | null;
  lat: number | null;
  lon: number | null;
  /** Rep name when the check-in is borrowed (the person was the double/triple-visitor, not the submitter). */
  via: string | null;
  /**
   * On a borrowed check-in: true when the rep checked in at a place this person was NOT visited with
   * that day (owner, 2026-11-07, Sally Saied's 20 Sep trip: two shared visits drew the rep's whole
   * day as hers). Display only — route-checkins.ts lists these apart; nothing counts or judges them.
   */
  withoutPerson?: boolean;
};

export type RepVisitWorkloadDay = {
  /** AM · PM · Pharmacies (the golden rule): `am` and `pm` never hold a pharmacy visit, whatever
   * period the vendor tagged it with — those are in `pharmacies`. am + pm + pharmacies = total. */
  am: number;
  /** The day's UNPLANNED field visits (the key keeps its old name — see RepVisitDetail.kind). */
  campaign: number;
  checkins: RepCheckinDetail[];
  date: string;
  /** Kind split of the day's REGULAR visits (doctor + pharmacy + institution ≤ regular; the
   * remainder had no speciality). Campaign rows never classify — the vendor omits speciality. */
  doctor: number;
  institution: number;
  /** Recorded meetings that day (Meeting, Group Meeting). Never a visit and never in `total` — it
   * only makes the day a WORKED day (owner, 2026-11-07; trip-day-meetings.ts). Also inside `other`. */
  meetings?: number;
  other: number;
  /** Of the day's field visits, a manager's own single visits (inside `total` and the split). */
  own?: number;
  pharmacies: number;
  pharmacy: number;
  /**
   * Of the day's AM · PM · Pharmacies visits, how many are Phoenix CRM's own (a started team's) —
   * set by the golden-rule helper only when there are any. Phoenix CRM logs no pharmacy visit, so a
   * display says the day's pharmacy figure was never recorded rather than print 0. Display only: it is
   * never stored and never reaches a verdict.
   */
  phoenix?: number;
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
  /** A manager's own single visits on the trip, and the unplanned ones among them — counted in every figure
   * above. Absent when his own visits could not be read (the label says so). */
  managerOwnUnplannedVisits?: number;
  managerOwnVisits?: number;
  matchStatus: "matched" | "no_activity" | "partial" | "unmapped";
  matchedDates: string[];
  /** Trip days with a recorded meeting. Optional: the empty and unmapped reads carry none. */
  meetingDays?: number;
  otherVisits: number;
  /** The trip's pharmacy visits — the third workload figure, kept out of AM and PM. */
  pharmacyWorkload: number;
  pharmacyVisits: number;
  /**
   * Of the trip's AM · PM · Pharmacies visits, how many are Phoenix CRM's own. Phoenix CRM records its
   * own pharmacy calls (owner, 2026-10-03), so `pharmacyWorkload` is the whole count from both sources
   * (visit-count-buckets.ts). Display only — never stored, never compared, never a verdict. Optional: a
   * payload from before it existed reads as none.
   */
  phoenixWorkload?: number;
  pmWorkload: number;
  regularVisits: number;
  sourceLabel: string;
};

type WorkloadVisitRow = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  /** The door's name for the logger: the Phoenix display name when the row has an hr id, else the
   * vendor's label — which on a handed-over account names its LATER holder (see repName). */
  agent_name: string | null;
  ampm: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  crm_save_date: string | null;
  customer_name: string | null;
  double_crm_id: number | null;
  double_hr_id: string | null;
  /** Phoenix marked the visit out of list or out of plan. Null on an iReports360 row. */
  is_unplanned: boolean | null;
  /** 'phoenix' on a started team's Phoenix CRM visit — the helper counts it into `phoenix`. */
  source: string | null;
  speciality: string | null;
  visit_date: string;
  visit_type: number | null;
};

/**
 * A visit's or check-in's place, as the keys a borrowed check-in is matched on: the contact's CRM id
 * and its name, lower-cased. Either one matching makes the check-in a shared stop. Pure, for the test.
 */
export function sharedPlaceKeys(contactCrmId: number | null | undefined, contactName: string | null | undefined): string[] {
  const keys: string[] = [];
  if (contactCrmId != null && Number.isFinite(Number(contactCrmId))) keys.push(`id:${Number(contactCrmId)}`);
  const name = contactName?.trim().toLowerCase();
  if (name) keys.push(`n:${name}`);
  return keys;
}

/**
 * The rep's name on a visit this person was the double-visit PARTNER on — the person who logged it,
 * resigned or not. By the row's hr id (the sync attributes a row inside the rep's tenure only), through
 * the directory's display name, else the door's own name for that hr id. Null on the person's own
 * visits, and on a row with no hr id: its vendor label may name the account's LATER holder, so that
 * one is decided against hire dates after the loop (isHandedOverLabel), never here. Pure, for the test.
 */
export function partnerRepName(input: {
  agentHrId: string | null | undefined;
  nameByHrKey: ReadonlyMap<string, string>;
  role: RepVisitDetail["role"];
  vendorLabel: string | null | undefined;
}): string | null {
  if (input.role !== "partner") return null;
  const key = canonicalHrIdKey(input.agentHrId);
  if (!key) return null;
  return input.nameByHrKey.get(key) ?? (input.vendorLabel?.trim() || null);
}

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
    dateBreakdown: dates.map((date) => ({ am: 0, campaign: 0, checkins: [], date, doctor: 0, institution: 0, other: 0, pharmacies: 0, pharmacy: 0, pm: 0, regular: 0, total: 0, visits: [] })),
    doctorVisits: 0,
    idleDates: dates,
    institutionVisits: 0,
    pharmacyWorkload: 0,
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
 * Count the person's field visits per day across the trip window — planned and UNPLANNED (a Phoenix visit
 * marked out of list or out of plan, or an archive day's iReports360 campaign visit, −8:
 * isUnplannedFieldVisit) — split AM · PM · Pharmacies. Non-field visit types (Vacation/Meeting/Training/…)
 * are surfaced as `other` but excluded from the workload. No collapse of burst re-saves yet — the
 * count mirrors distinct `ireports360_visits` rows (each keyed on `crm_visit_id`).
 *
 * A pharmacy visit is its own figure and never inside AM or PM (the golden rule, owner
 * 2026-09-21) — but it is still field work. Owner decision, same day: a trip day whose only visits
 * were pharmacies is a WORKED day, so `total`, `matchedDates` and `matchStatus` keep counting it
 * and such a trip never reads "no activity".
 */
export async function getRepTripVisitWorkload(input: {
  hrId: string | null | undefined;
  /**
   * Also read each positioned Phoenix CRM visit as that day's check-in. ONLY for a reader no rep's own
   * screen reaches — an approver or a manager looking at someone else's trip, or an admin export (owner,
   * 2026-10-02: "Never on the rep's own screens"). Off by default, so the rep's own trip stays blind.
   */
  includePhoenixCheckins?: boolean;
  tripEndDate: string;
  tripStartDate: string;
}): Promise<RepVisitWorkload> {
  const start = input.tripStartDate.slice(0, 10);
  const end = input.tripEndDate.slice(0, 10);
  const dates = eachDateInclusive(start, end);
  let sourceLabel =
    "Phoenix CRM visits — every field visit, own or with a rep (iReports360 only before the team's start).";

  const hrId = String(input.hrId ?? "").trim();
  if (!hrId || dates.length === 0) {
    return emptyWorkload(dates, "No HR ID available to match CRM visits.", "unmapped");
  }

  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const key = canonicalHrIdKey(hrId);
  const employee = directory.find((row) => canonicalHrIdKey(row.hrId) === key) ?? null;
  const rawCrmId = employee?.crmId == null ? null : Number(employee.crmId);
  const crmId = rawCrmId && !Number.isNaN(rawCrmId) ? rawCrmId : null;
  // This person's identity on a visit or a check-in — the same key the check-in matcher uses: the
  // CRM id when he has one, else his hr id. `hrId` is non-blank here, so the key always exists.
  const selfKey = checkinAgentKey(crmId, hrId) ?? "";

  // Through the CRM read door. `includeResignedAgents: true` keeps this read's documented contract
  // (no departed-agent exclusion — see the module note); `visit_date` is a DATE column, so `dateTo`
  // as YYYY-MM-DD is the same bound the old `${end}T23:59:59.999Z` literal cast down to. The door
  // keyset-pages, so a window past PostgREST's 1,000-row response cap is returned in full.
  //
  // By CRM id when the person has one — exactly the read every such rep has always had, since his
  // native visits carry the same `agent_crm_id`/`double_crm_id` — and by hr id when he has none. A
  // rep hired after the CRM cutover has no CRM id, and this used to stop right here as "unmapped",
  // so his outstation trip carried no workload evidence however many visits he logged.
  const data = await queryVisits<WorkloadVisitRow>({
    columns:
      "agent_crm_id, agent_hr_id, agent_name, ampm, contact_crm_id, contact_name, crm_save_date, customer_name, double_crm_id, double_hr_id, is_unplanned, source, speciality, visit_date, visit_type",
    dateFrom: start,
    dateTo: end,
    includeResignedAgents: true,
    ...(crmId != null ? { participantCrmIds: [crmId] } : { participantHrIds: [hrId] }),
  });
  // Still "unmapped" for a person with no CRM id and nothing under his hr id either. Before the cutover
  // that is everyone without a CRM account — office staff included — and a zero read for them was never
  // evidence of anything; calling it `no_activity` would put an accusation on a trip nobody could have
  // logged against. A person with no CRM id who DID log visits is matched below like anyone else.
  // A manager's own single visits, through their one reader. Read here, before the unmapped test, so a
  // manager with no CRM id whose only field work was his own visits is matched like anyone else. A failed
  // read leaves them out and says so — the cap then treats them as unmeasured, never as zero.
  let ownVisits: Awaited<ReturnType<typeof loadManagerOwnVisitRows>> | null = null;
  try {
    ownVisits = await loadManagerOwnVisitRows({ end, managerHrIds: [hrId], start });
  } catch {
    ownVisits = null;
    sourceLabel += " The manager's own Phoenix CRM visits could not be read, so they are not counted here.";
  }
  if (crmId == null && data.length === 0 && (ownVisits?.length ?? 0) === 0) {
    return emptyWorkload(dates, "This person has no CRM id and no visits under their HR ID, so their visits can't be matched.", "unmapped");
  }

  const byDate = new Map<string, RepVisitWorkloadDay>();
  for (const date of dates) {
    byDate.set(date, { am: 0, campaign: 0, checkins: [], date, doctor: 0, institution: 0, other: 0, pharmacies: 0, pharmacy: 0, pm: 0, regular: 0, total: 0, visits: [] });
  }

  // Who logs the GPS check-in each day: the person who SUBMITTED the visit (its agent_crm_id).
  // Managers (DM/TM/NSM) never submit — the rep does and tags them as the double-visitor — so a
  // manager's route/check-in must be borrowed from the rep (memory: dv-checkin-attribution-…).
  // checkinOwnersByDate maps each active day to the submitter keys (checkinAgentKey: crm id, else
  // `hr:<id>`) whose check-ins are this person's route that day (self when they submitted, else the
  // rep(s) they were double with). `ownerIdentity` remembers which ids each key stands for.
  const checkinOwnersByDate = new Map<string, Set<string>>();
  const ownerIdentity = new Map<string, { crmId: number | null; hrId: string | null }>();

  // The rep's name on a partner visit — resigned people included (the directory read above is
  // includeInactive). `repNameByDayOwner` keeps the name per day and logger, so a borrowed check-in
  // is labelled with the same person as the visit it came from, never the account's later holder.
  const nameByHrKey = new Map<string, string>();
  for (const emp of directory) {
    const empHrKey = canonicalHrIdKey(emp.hrId);
    if (empHrKey && emp.displayName && !nameByHrKey.has(empHrKey)) nameByHrKey.set(empHrKey, emp.displayName);
  }
  const repNameByDayOwner = new Map<string, string>();
  // The places this person was visited AT with each rep, per day — the only stops of the rep's route
  // that are theirs (sharedPlaceKeys).
  const sharedPlacesByDayOwner = new Map<string, Set<string>>();
  const unattributedPartnerVisits: Array<{ crmId: number; day: string; label: string; ownerKey: string; visit: RepVisitDetail }> = [];

  for (const row of data) {
    const day = String(row.visit_date ?? "").slice(0, 10);
    const entry = byDate.get(day);
    if (!entry) continue;

    // A field visit is a customer visit (0) or an archive day's campaign visit (−8); any other code is a
    // day's activity, shown as `other` and never counted. Of the field visits, the unplanned ones are
    // counted apart (isUnplannedFieldVisit): Phoenix serves every visit as type 0 and says unplanned itself.
    if (row.visit_type !== 0 && row.visit_type !== -8) {
      entry.other += 1;
      // A meeting is not a visit, but it IS the day's work (owner, 2026-11-07): counted apart so the
      // day never reads idle, and listed so the approver sees what was recorded. Only the person's
      // OWN meeting — a partner's row is never theirs to be credited with.
      if (isMeetingVisitType(row.visit_type)) {
        const ownerCrm = row.agent_crm_id == null ? null : Number(row.agent_crm_id);
        const ownerKey = checkinAgentKey(ownerCrm != null && Number.isFinite(ownerCrm) ? ownerCrm : null, row.agent_hr_id);
        if (ownerKey === selfKey) {
          entry.meetings = (entry.meetings ?? 0) + 1;
          entry.visits.push({
            ampm: row.ampm ?? null,
            contact: row.contact_name ?? null,
            contactKind: "unclassified",
            customer: row.customer_name || "Meeting",
            kind: "meeting",
            repName: null,
            role: "agent",
            submittedAt: row.crm_save_date ?? null,
          });
        }
      }
      continue;
    }
    const isRegular = !isUnplannedFieldVisit(row);
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

    // The one bucket helper: a pharmacy goes to `pharmacies` whatever its period says, and an
    // unmarked period stays PM, so every counted field visit lands in exactly one of the three.
    addVisitToSplit(entry, row);

    const submitterCrm = row.agent_crm_id == null ? null : Number(row.agent_crm_id);
    const submitterKey = checkinAgentKey(
      submitterCrm != null && Number.isFinite(submitterCrm) ? submitterCrm : null,
      row.agent_hr_id,
    );
    if (submitterKey != null) {
      if (!checkinOwnersByDate.has(day)) checkinOwnersByDate.set(day, new Set());
      checkinOwnersByDate.get(day)!.add(submitterKey);
      if (!ownerIdentity.has(submitterKey)) {
        ownerIdentity.set(submitterKey, { crmId: submitterKey.startsWith("hr:") ? null : submitterCrm, hrId: row.agent_hr_id });
      }
    }

    const role: RepVisitDetail["role"] = submitterKey === selfKey ? "agent" : "partner";
    const agentHrKey = canonicalHrIdKey(row.agent_hr_id);
    const vendorLabel = row.agent_name?.trim() || null;
    const repName = partnerRepName({ agentHrId: row.agent_hr_id, nameByHrKey, role, vendorLabel });
    const visit: RepVisitDetail = {
      ampm: row.ampm ?? null,
      contact: row.contact_name ?? null,
      contactKind,
      customer: row.customer_name ?? null,
      kind: isRegular ? "regular" : "campaign",
      repName,
      role,
      submittedAt: row.crm_save_date ?? null,
    };
    entry.visits.push(visit);
    if (role === "partner" && submitterKey != null) {
      const placesKey = `${day}|${submitterKey}`;
      if (!sharedPlacesByDayOwner.has(placesKey)) sharedPlacesByDayOwner.set(placesKey, new Set());
      for (const place of sharedPlaceKeys(row.contact_crm_id, row.contact_name)) sharedPlacesByDayOwner.get(placesKey)!.add(place);
    }
    if (repName && submitterKey != null) repNameByDayOwner.set(`${day}|${submitterKey}`, repName);
    if (role === "partner" && !agentHrKey && vendorLabel && submitterCrm != null && Number.isFinite(submitterCrm) && submitterKey != null) {
      unattributedPartnerVisits.push({ crmId: submitterCrm, day, label: vendorLabel, ownerKey: submitterKey, visit });
    }
  }

  // His own single visits (a manager's): field work like any other, so they make a day worked and land in
  // AM · PM · Pharmacies by the customer's list, or the half for a customer of his own list (ownVisitBucket).
  let managerOwnVisits = 0;
  let managerOwnUnplannedVisits = 0;
  for (const own of ownVisits ?? []) {
    const entry = byDate.get(own.date);
    if (!entry) continue;
    const contactKind = classifyVisitContactKind(own.speciality);
    if (own.planned) {
      entry.regular += 1;
      if (contactKind === "doctor") entry.doctor += 1;
      else if (contactKind === "pharmacy") entry.pharmacy += 1;
      else if (contactKind === "institution") entry.institution += 1;
    } else {
      entry.campaign += 1;
      managerOwnUnplannedVisits += 1;
    }
    entry.total += 1;
    entry.own = (entry.own ?? 0) + 1;
    managerOwnVisits += 1;
    addBucketToSplit(entry, visitCountBucketForListType(own.bucket), 1, true);
    entry.visits.push({
      ampm: own.loggedHalf ?? (own.bucket === "AM" || own.bucket === "PM" ? own.bucket : null),
      contact: own.customerName,
      contactKind,
      customer: own.placeLabel ?? own.customerName,
      kind: own.planned ? "regular" : "campaign",
      repName: null,
      role: "own",
      submittedAt: own.loggedAt,
    });
  }

  // A partner visit with no hr id carries only the vendor's label, and on a handed-over CRM account
  // that label names the LATER holder. Phoenix's hire dates decide (identity.ts): a label naming only
  // people not yet employed that day reads "Previous holder ( territory )"; any other label is the only
  // name there is and is shown as the vendor sent it. Best-effort — if the maps cannot be read the
  // visit names nobody rather than risk naming the wrong person.
  if (unattributedPartnerVisits.length > 0) {
    const identityMaps = await loadCrmIdentityMaps().catch(() => null);
    if (identityMaps) {
      for (const pending of unattributedPartnerVisits) {
        const handedOver = isHandedOverLabel(
          { crmId: pending.crmId, label: pending.label, visitDate: pending.day, visitType: null },
          identityMaps,
        );
        pending.visit.repName = handedOver ? previousHolderLabel(pending.label) : pending.label;
        repNameByDayOwner.set(`${pending.day}|${pending.ownerKey}`, pending.visit.repName);
      }
    }
  }

  // Best-effort: pull check-ins for every submitter this person shares a visit with (self + the
  // reps they were double/triple-visited with), then attribute each to a day only if its owner is a
  // route-owner for THAT day. A check-in hiccup must never break the workload the approver relies on.
  ownerIdentity.set(selfKey, { crmId, hrId });
  const ownerCrmIds = new Set<number>();
  const ownerHrIds = new Set<string>();
  for (const [ownerKey, identity] of ownerIdentity) {
    if (!ownerKey.startsWith("hr:") && identity.crmId != null) ownerCrmIds.add(identity.crmId);
    else if (identity.hrId) ownerHrIds.add(identity.hrId);
  }
  const nameByOwnerKey = new Map<string, string>();
  for (const emp of directory) {
    if (!emp.fullName) continue;
    const empCrm = emp.crmId == null ? null : Number(emp.crmId);
    if (empCrm != null && !Number.isNaN(empCrm)) nameByOwnerKey.set(String(empCrm), emp.displayName);
    const empHrKey = canonicalHrIdKey(emp.hrId);
    if (empHrKey) nameByOwnerKey.set(`hr:${empHrKey}`, emp.displayName);
  }

  const checkinRows = await queryCheckins<CrmCheckinRow>({
    // With no owner lacking a CRM id this is the crm-id read it always was.
    ...(ownerHrIds.size === 0
      ? { agentCrmIds: [...ownerCrmIds] }
      : { agentCrmOrHrIds: { crmIds: [...ownerCrmIds], hrIds: [...ownerHrIds] } }),
    ascending: true,
    dateFrom: start,
    dateTo: end,
    // The Phoenix positions only for a reader no rep's own screen reaches — see the input.
    includePhoenixVisits: input.includePhoenixCheckins === true,
    orderBy: "check_date",
  }).catch(() => [] as CrmCheckinRow[]);

  for (const row of checkinRows) {
    const day = String(row.check_date ?? "").slice(0, 10);
    const entry = byDate.get(day);
    if (!entry) continue;
    const ownerCrm = row.agent_crm_id == null ? null : Number(row.agent_crm_id);
    const owner = checkinAgentKey(ownerCrm != null && Number.isFinite(ownerCrm) ? ownerCrm : null, row.agent_hr_id);
    const dayOwners = checkinOwnersByDate.get(day);
    if (owner == null || !dayOwners || !dayOwners.has(owner)) continue; // not part of this person's route that day
    const ownerLabel = owner.startsWith("hr:") ? (row.agent_hr_id ?? owner.slice(3)) : owner;
    // A check-in that names no place cannot be matched either way, so it stays on the route.
    const places = sharedPlaceKeys(row.contact_crm_id, row.contact_name);
    const sharedPlaces = sharedPlacesByDayOwner.get(`${day}|${owner}`);
    entry.checkins.push({
      address: row.address ?? null,
      at: row.check_date ?? null,
      contact: row.contact_name ?? null,
      contactCrmId: row.contact_crm_id ?? null,
      lat: row.lat ?? null,
      lon: row.lon ?? null,
      via: owner === selfKey ? null : repNameByDayOwner.get(`${day}|${owner}`) ?? nameByOwnerKey.get(owner) ?? `rep ${ownerLabel}`,
      ...(owner !== selfKey && places.length > 0
        ? { withoutPerson: !places.some((place) => sharedPlaces?.has(place) === true) }
        : {}),
    });
  }

  // Order each day's detail by time so the visits + check-ins read as the day's route.
  for (const entry of byDate.values()) {
    entry.visits.sort((a, b) => String(a.submittedAt ?? "").localeCompare(String(b.submittedAt ?? "")));
    entry.checkins.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  }

  const dateBreakdown = dates.map((date) => byDate.get(date)!);
  // A day with a field visit OR a recorded meeting is worked (trip-day-meetings.ts, owner 2026-11-07).
  const { idleDates, matchStatus, matchedDates } = tripWorkloadMatch(dateBreakdown);

  return {
    amWorkload: dateBreakdown.reduce((sum, day) => sum + day.am, 0),
    campaignVisits: dateBreakdown.reduce((sum, day) => sum + day.campaign, 0),
    dateBreakdown,
    doctorVisits: dateBreakdown.reduce((sum, day) => sum + day.doctor, 0),
    idleDates,
    institutionVisits: dateBreakdown.reduce((sum, day) => sum + day.institution, 0),
    ...(ownVisits === null ? {} : { managerOwnUnplannedVisits, managerOwnVisits }),
    matchStatus,
    matchedDates,
    meetingDays: dateBreakdown.filter((day) => (day.meetings ?? 0) > 0).length,
    otherVisits: dateBreakdown.reduce((sum, day) => sum + day.other, 0),
    pharmacyWorkload: dateBreakdown.reduce((sum, day) => sum + day.pharmacies, 0),
    pharmacyVisits: dateBreakdown.reduce((sum, day) => sum + day.pharmacy, 0),
    phoenixWorkload: dateBreakdown.reduce((sum, day) => sum + (day.phoenix ?? 0), 0),
    pmWorkload: dateBreakdown.reduce((sum, day) => sum + day.pm, 0),
    regularVisits: dateBreakdown.reduce((sum, day) => sum + day.regular, 0),
    sourceLabel,
  };
}
