// Business Review — activity by ROLE, and by the individual behind it.
//
// "Visits per rep, per DM, per product manager, per training manager, per every role" is a
// question the sales engine cannot answer on its own: it knows seats, not job titles. So the
// directory is read once and every person carrying activity in the window is classified through
// `resolveJobFunctionRole` — the repo's existing job-function classifier, not a second one grown
// here. That classifier is explicitly a BUSINESS-RULE mapping and never a permission decision,
// which is exactly the use this is.
//
// EACH ROLE IS MEASURED BY WHAT IT ACTUALLY DOES, AND THE GAPS ARE NAMED RATHER THAN FILLED:
//
//   Medical Rep        own field visits, doctors reached, outstation claims.
//   District Manager   rides delivered, reps coached, own district's sales (from the sales half).
//   Regional / National Sales Manager   rides delivered across districts.
//   Training Manager   rides delivered plus coaching reports. Production holds 41 coaching reports
//                      for 2026 from a SINGLE coach, so this row is thin by nature, and it says so
//                      instead of implying the role does nothing.
//   Product Manager    rides delivered, and their line's sales. VISITS PER PRODUCT DO NOT EXIST —
//                      `ireports360_visits` has no product column at all. Inventing one from the
//                      rep's line would be a guess wearing a metric's clothes, so the row carries
//                      an explicit note instead.
//
// A person with no activity at all in the window still appears in `headcount` but not in `people`:
// the difference between "12 DMs employed" and "9 DMs with recorded activity" is one of the more
// useful numbers on the page, and collapsing them would hide it.

import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";

import { hrKey } from "./attribution";
import type { MarketingLoad } from "./marketing";
import type { OutstationLoad } from "./outstation";
import type { VisitsLoad } from "./visits";
import type { ReviewWindow } from "../period";

export type ReviewDirectoryEntry = {
  hrId: string;
  name: string;
  jobTitle: string;
  role: string;
  lineId: number | null;
  employmentStatus: string;
  hireDate: string | null;
};

export type ReviewDirectory = Map<string, ReviewDirectoryEntry>;

export type ReviewRoleRow = {
  role: string;
  /** People holding this title in the directory today, whatever they did in the window. */
  headcount: number;
  /** People of this role with at least one recorded action inside the window. */
  people: number;
  fieldVisits: number;
  regularVisits: number;
  campaignVisits: number;
  /** Double visits this role DELIVERED (rode along on). */
  ridesLed: number;
  /** Distinct reps ridden with. */
  repsCoached: number;
  /** Distinct doctors reached — a union across the role's people, never a sum. */
  customersReached: number;
  coachingReports: number;
  outstationClaimed: number;
  outstationApproved: number;
  marketingRequests: number;
  marketingCommitted: number;
  fieldVisitsByMonth: Record<string, number>;
  ridesLedByMonth: Record<string, number>;
  /** What this role's footprint deliberately does NOT measure. Rendered verbatim. */
  note: string | null;
};

export type ReviewPersonRow = {
  hrId: string;
  name: string;
  role: string;
  jobTitle: string;
  employmentStatus: string;
  hireDate: string | null;
  fieldVisits: number;
  regularVisits: number;
  campaignVisits: number;
  ridesLed: number;
  repsCoached: number;
  customers: number;
  coachingReports: number;
  outstationClaimed: number;
  marketingRequests: number;
  /** Months inside the window in which this person recorded anything. */
  activeMonths: number;
  /** Field visits per active month — never per window month, which would punish a March joiner. */
  avgPerActiveMonth: number;
};

export type RolesLoad = {
  roles: ReviewRoleRow[];
  people: ReviewPersonRow[];
  directory: ReviewDirectory;
  coachingReports: number;
  coachingCoaches: number;
  /** People carrying activity whose HR id matches nobody in the directory. */
  unknownPeople: number;
};

const ROLE_NOTES: Record<string, string> = {
  "Product Manager":
    "Visits per product cannot be measured — the CRM visit feed carries no product column. A " +
    "Product Manager's recorded footprint is the double visits they rode on, beside their line's sales.",
  "Group Product Manager":
    "Visits per product cannot be measured — the CRM visit feed carries no product column. A " +
    "Group Product Manager's recorded footprint is the double visits they rode on, beside their line's sales.",
  "Training Manager":
    "Measured through double visits and coaching reports rather than owned territory. Production " +
    "holds very few coaching reports, from a single coach, so a low count here reflects the record, not the role.",
};

/** Role display order: field first, then the roles that ride along, then everyone else. */
const ROLE_ORDER = [
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Training Manager",
  "Product Manager",
  "Group Product Manager",
];

export async function loadReviewDirectory(): Promise<ReviewDirectory> {
  const supabase = getSupabaseAdmin();
  const directory: ReviewDirectory = new Map();
  let rows: Record<string, unknown>[] = [];
  try {
    rows = await fetchAllRows<Record<string, unknown>>(
      () =>
        supabase
          .from("employees")
          .select("hr_id, full_name, nickname, job_title, line_id, employment_status, hire_date"),
      "hr_id",
    );
  } catch {
    return directory;
  }
  for (const row of rows) {
    const hrId = String(row.hr_id ?? "").trim();
    if (!hrId) continue;
    const jobTitle = String(row.job_title ?? "").trim();
    directory.set(hrKey(hrId), {
      hrId,
      name: String(row.full_name ?? "").trim() || String(row.nickname ?? "").trim() || hrId,
      jobTitle,
      role: resolveJobFunctionRole(jobTitle),
      lineId: row.line_id == null ? null : Number(row.line_id),
      employmentStatus: String(row.employment_status ?? "").trim(),
      hireDate: row.hire_date == null ? null : String(row.hire_date).slice(0, 10),
    });
  }
  return directory;
}

type CoachingFact = { period: string; coachHrId: string; repHrId: string };

async function loadCoachingFacts(window: ReviewWindow): Promise<CoachingFact[]> {
  const supabase = getSupabaseAdmin();
  try {
    const rows = await fetchAllRows<Record<string, unknown>>(
      () =>
        supabase
          .from("coaching_reports")
          .select("id, coach_hr_id, medical_rep_hr_id, coaching_date")
          .not("coaching_date", "is", null)
          .gte("coaching_date", `${window.from}-01`)
          .lte("coaching_date", `${window.to}-31`),
      "id",
    );
    const facts: CoachingFact[] = [];
    for (const row of rows) {
      const period = String(row.coaching_date ?? "").slice(0, 7);
      if (!window.periods.includes(period)) continue;
      facts.push({
        period,
        coachHrId: hrKey(row.coach_hr_id as string | null),
        repHrId: hrKey(row.medical_rep_hr_id as string | null),
      });
    }
    return facts;
  } catch {
    return [];
  }
}

type PersonAcc = {
  hrId: string;
  fieldVisits: number;
  regularVisits: number;
  campaignVisits: number;
  ridesLed: number;
  reps: Set<string>;
  customers: Set<number>;
  coachingReports: number;
  outstationClaimed: number;
  marketingRequests: number;
  months: Set<string>;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function loadRoleFacts(input: {
  window: ReviewWindow;
  visits: VisitsLoad;
  outstation: OutstationLoad;
  marketing: MarketingLoad;
  directory?: ReviewDirectory;
}): Promise<RolesLoad> {
  const [directory, coaching] = await Promise.all([
    input.directory ? Promise.resolve(input.directory) : loadReviewDirectory(),
    loadCoachingFacts(input.window),
  ]);

  const people = new Map<string, PersonAcc>();
  const of = (key: string): PersonAcc => {
    let acc = people.get(key);
    if (!acc) {
      acc = {
        hrId: key,
        fieldVisits: 0, regularVisits: 0, campaignVisits: 0,
        ridesLed: 0, reps: new Set(), customers: new Set(),
        coachingReports: 0, outstationClaimed: 0, marketingRequests: 0,
        months: new Set(),
      };
      people.set(key, acc);
    }
    return acc;
  };

  for (const fact of input.visits.agents) {
    if (!fact.agentHrId) continue;
    const acc = of(fact.agentHrId);
    acc.fieldVisits += fact.fieldVisits;
    acc.regularVisits += fact.regularVisits;
    acc.campaignVisits += fact.campaignVisits;
    for (const id of fact.customers) acc.customers.add(id);
    if (fact.fieldVisits > 0 || fact.adminRows > 0) acc.months.add(fact.period);
  }
  for (const fact of input.visits.managers) {
    const acc = of(fact.managerHrId);
    acc.ridesLed += fact.rides;
    for (const rep of fact.ridesByRep.keys()) acc.reps.add(rep);
    for (const id of fact.customers) acc.customers.add(id);
    if (fact.rides > 0) acc.months.add(fact.period);
  }
  for (const fact of input.outstation.facts) {
    if (!fact.hrId) continue;
    const acc = of(hrKey(fact.hrId));
    acc.outstationClaimed += fact.claimed;
    if (fact.claimed !== 0) acc.months.add(fact.period);
  }
  for (const fact of input.marketing.facts) {
    if (!fact.requesterHrId) continue;
    const acc = of(hrKey(fact.requesterHrId));
    acc.marketingRequests += 1;
    acc.months.add(fact.period);
  }
  for (const fact of coaching) {
    if (!fact.coachHrId) continue;
    const acc = of(fact.coachHrId);
    acc.coachingReports += 1;
    if (fact.repHrId) acc.reps.add(fact.repHrId);
    acc.months.add(fact.period);
  }

  // ── Person rows ──
  let unknownPeople = 0;
  const personRows: ReviewPersonRow[] = [...people.values()].map((acc) => {
    const entry = directory.get(acc.hrId);
    if (!entry) unknownPeople += 1;
    const activeMonths = acc.months.size;
    return {
      hrId: entry?.hrId ?? acc.hrId,
      name: entry?.name ?? `Unmapped HR id ${acc.hrId}`,
      role: entry?.role ?? "Employee",
      jobTitle: entry?.jobTitle ?? "",
      employmentStatus: entry?.employmentStatus ?? "",
      hireDate: entry?.hireDate ?? null,
      fieldVisits: acc.fieldVisits,
      regularVisits: acc.regularVisits,
      campaignVisits: acc.campaignVisits,
      ridesLed: acc.ridesLed,
      repsCoached: acc.reps.size,
      customers: acc.customers.size,
      coachingReports: acc.coachingReports,
      outstationClaimed: round2(acc.outstationClaimed),
      marketingRequests: acc.marketingRequests,
      activeMonths,
      avgPerActiveMonth: activeMonths > 0 ? round2(acc.fieldVisits / activeMonths) : 0,
    };
  });
  personRows.sort((a, b) => b.fieldVisits + b.ridesLed - (a.fieldVisits + a.ridesLed));

  // ── Role rows ──
  type RoleAcc = {
    role: string;
    headcount: number;
    people: Set<string>;
    fieldVisits: number;
    regularVisits: number;
    campaignVisits: number;
    ridesLed: number;
    reps: Set<string>;
    customers: Set<number>;
    coachingReports: number;
    outstationClaimed: number;
    outstationApproved: number;
    marketingRequests: number;
    marketingCommitted: number;
    fieldVisitsByMonth: Map<string, number>;
    ridesLedByMonth: Map<string, number>;
  };
  const roles = new Map<string, RoleAcc>();
  const roleOf = (role: string): RoleAcc => {
    let acc = roles.get(role);
    if (!acc) {
      acc = {
        role, headcount: 0, people: new Set(),
        fieldVisits: 0, regularVisits: 0, campaignVisits: 0, ridesLed: 0,
        reps: new Set(), customers: new Set(), coachingReports: 0,
        outstationClaimed: 0, outstationApproved: 0,
        marketingRequests: 0, marketingCommitted: 0,
        fieldVisitsByMonth: new Map(), ridesLedByMonth: new Map(),
      };
      roles.set(role, acc);
    }
    return acc;
  };

  // Headcount is the directory's live answer, restricted to people who are actually employed —
  // a resigned rep is counted in the activity above (they worked those months) but is not a seat
  // the business holds today, and mixing the two makes "visits per head" nonsense.
  for (const entry of directory.values()) {
    if (/resign|terminat|exit/i.test(entry.employmentStatus)) continue;
    roleOf(entry.role).headcount += 1;
  }

  const roleFor = (hrIdKey: string) => directory.get(hrIdKey)?.role ?? "Employee";

  for (const fact of input.visits.agents) {
    if (!fact.agentHrId) continue;
    const acc = roleOf(roleFor(fact.agentHrId));
    acc.people.add(fact.agentHrId);
    acc.fieldVisits += fact.fieldVisits;
    acc.regularVisits += fact.regularVisits;
    acc.campaignVisits += fact.campaignVisits;
    for (const id of fact.customers) acc.customers.add(id);
    if (fact.fieldVisits > 0) {
      acc.fieldVisitsByMonth.set(fact.period, (acc.fieldVisitsByMonth.get(fact.period) ?? 0) + fact.fieldVisits);
    }
  }
  for (const fact of input.visits.managers) {
    const acc = roleOf(roleFor(fact.managerHrId));
    acc.people.add(fact.managerHrId);
    acc.ridesLed += fact.rides;
    for (const rep of fact.ridesByRep.keys()) acc.reps.add(rep);
    for (const id of fact.customers) acc.customers.add(id);
    acc.ridesLedByMonth.set(fact.period, (acc.ridesLedByMonth.get(fact.period) ?? 0) + fact.rides);
  }
  for (const fact of input.outstation.facts) {
    if (!fact.hrId) continue;
    const key = hrKey(fact.hrId);
    const acc = roleOf(roleFor(key));
    acc.people.add(key);
    acc.outstationClaimed += fact.claimed;
    acc.outstationApproved += fact.approved;
  }
  for (const fact of input.marketing.facts) {
    if (!fact.requesterHrId) continue;
    const key = hrKey(fact.requesterHrId);
    const acc = roleOf(roleFor(key));
    acc.people.add(key);
    acc.marketingRequests += 1;
    if (fact.bucket === "committed") acc.marketingCommitted += fact.cost;
  }
  for (const fact of coaching) {
    if (!fact.coachHrId) continue;
    const acc = roleOf(roleFor(fact.coachHrId));
    acc.people.add(fact.coachHrId);
    acc.coachingReports += 1;
    if (fact.repHrId) acc.reps.add(fact.repHrId);
  }

  const fill = (map: Map<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const period of input.window.periods) out[period] = map.get(period) ?? 0;
    return out;
  };

  const roleRows: ReviewRoleRow[] = [...roles.values()]
    .map((acc) => ({
      role: acc.role,
      headcount: acc.headcount,
      people: acc.people.size,
      fieldVisits: acc.fieldVisits,
      regularVisits: acc.regularVisits,
      campaignVisits: acc.campaignVisits,
      ridesLed: acc.ridesLed,
      repsCoached: acc.reps.size,
      customersReached: acc.customers.size,
      coachingReports: acc.coachingReports,
      outstationClaimed: round2(acc.outstationClaimed),
      outstationApproved: round2(acc.outstationApproved),
      marketingRequests: acc.marketingRequests,
      marketingCommitted: round2(acc.marketingCommitted),
      fieldVisitsByMonth: fill(acc.fieldVisitsByMonth),
      ridesLedByMonth: fill(acc.ridesLedByMonth),
      note: ROLE_NOTES[acc.role] ?? null,
    }))
    // Roles that did nothing AND employ nobody are noise; every other role stays visible, at zero
    // if that is the truth, because "the Training Manager rode along 0 times" is a finding.
    .filter((row) => row.headcount > 0 || row.people > 0)
    .sort((a, b) => {
      const ai = ROLE_ORDER.indexOf(a.role);
      const bi = ROLE_ORDER.indexOf(b.role);
      if (ai !== bi) return (ai < 0 ? ROLE_ORDER.length : ai) - (bi < 0 ? ROLE_ORDER.length : bi);
      return a.role < b.role ? -1 : 1;
    });

  return {
    roles: roleRows,
    people: personRows,
    directory,
    coachingReports: coaching.length,
    coachingCoaches: new Set(coaching.map((c) => c.coachHrId).filter(Boolean)).size,
    unknownPeople,
  };
}

export const ROLES_ORIGIN = "public.employees job titles, via the shared job-function classifier";
export const COACHING_ORIGIN = "public.coaching_reports, keyed on coaching_date";
