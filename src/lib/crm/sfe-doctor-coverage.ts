/**
 * Doctor Coverage & Frequency — the SFE board answering "which doctors are properly covered,
 * which are slipping, and which have we lost" per rep and company-wide.
 *
 * Scope rules (all deliberate, all surfaced on the card):
 *  - visit_type === 0 (Regular customer visits) ONLY — grade/speciality are NULL on every other
 *    type, and contact_crm_id on non-regular types is a shared vendor sentinel, not a real person.
 *  - contact_crm_id must be truthy (0 is the vendor's "unspecified contact" sentinel).
 *  - Duplicate submissions are collapsed via the canonical read-door collapse, so counts agree
 *    with DV Analytics / FWC.
 *  - Departed agents are excluded for free by the reads door (scanVisitsForRange).
 *  - The vendor only began sending contactGrade on 2026-07-24, so months before 2026-07 have a
 *    near-empty graded panel by construction — the board renders that as an empty state, never an
 *    error.
 *
 * Coverage norms (owner-confirmed 2026-08-02): A-grade (A+ folds into A) doctors need 2 visits in
 * the month to count covered; B and C need 1. A doctor with zero visits this month who WAS seen in
 * the prior two months is "lapsed" (red). A doctor last seen 3+ months ago is inactive — out of the
 * panel and out of the denominator entirely.
 *
 * DATE DISCIPLINE (same test-enforced rule as sfe-field-analytics.ts): CRM date strings are Cairo
 * wall-clock and `visit_date` is a plain YYYY-MM-DD — all month math here is string arithmetic,
 * never Date-object parsing or ISO re-serialization (either would shift the wall-clock).
 */

import { collapseDuplicateVisitSubmissions, scanVisitsForRange } from "@/lib/crm/reads";
import { cairoTodayIso } from "@/lib/crm/dates";

/** Editable coverage norms: required type-0 visits per month, by grade tier. A+ folds into A. */
export const DOCTOR_COVERAGE_TARGETS: Record<DoctorCoverageGradeTier, number> = { A: 2, B: 1, C: 1 };
/** Selected month plus this many prior months are scanned — lapse detection needs the prior 2;
 * the trend line wants 4 points. */
export const DOCTOR_COVERAGE_MONTHS_BACK = 3;
/** A doctor with zero visits in the selected month counts as lapsed only if seen within this many
 * prior months; older than that they are inactive and leave the panel. */
export const DOCTOR_COVERAGE_LAPSE_LOOKBACK_MONTHS = 2;
/** Specialty mix lists this many named specialties before folding the rest into "Other". */
const SPECIALTY_MIX_TOP_N = 8;

export type DoctorCoverageGradeTier = "A" | "B" | "C";
export type DoctorCoverageStatus = "green" | "yellow" | "red";

export type DoctorCoverageDoctorRow = {
  contactCrmId: number;
  /** Latest contact_name seen in the window — human names, never raw ids (owner rule). */
  contactName: string;
  gradeRaw: string;
  gradeTier: DoctorCoverageGradeTier;
  /** Latest type-0 visit date ≤ the selected month's end, YYYY-MM-DD. */
  lastVisitDate: string | null;
  repKey: string;
  repName: string;
  speciality: string | null;
  status: DoctorCoverageStatus;
  targetVisits: number;
  visitsThisMonth: number;
};

export type DoctorCoverageRepRow = {
  aDoctors: number;
  agentHrId: string | null;
  bDoctors: number;
  cDoctors: number;
  /** 0-100; 0 when the panel is empty. */
  coveragePct: number;
  green: number;
  panelSize: number;
  red: number;
  repKey: string;
  repName: string;
  yellow: number;
};

export type SfeDoctorCoverageBoard = {
  doctors: DoctorCoverageDoctorRow[];
  gradeSplit: Array<{ covered: number; doctors: number; tier: DoctorCoverageGradeTier }>;
  /** True → the selected month is still running (render "month to date"). */
  isCurrentMonth: boolean;
  month: string;
  monthLabel: string;
  reps: DoctorCoverageRepRow[];
  specialtyMix: Array<{ doctors: number; label: string }>;
  totals: {
    activePanel: number;
    coveragePct: number;
    green: number;
    red: number;
    /** Contacts seen in the selected month whose grade is absent/unknown across the whole window —
     * outside the panel, surfaced so a vendor grading gap is visible instead of silent. */
    ungradedContacts: number;
    visitsCounted: number;
    yellow: number;
  };
  trend: Array<{ activePanel: number; coveragePct: number; label: string; month: string }>;
  windowFrom: string;
  windowTo: string;
};

/** Exact row shape the pure core consumes — also the test-fixture shape. Includes the two columns
 * the duplicate collapse keys on even though the aggregation itself ignores them. */
export type DoctorCoverageVisitInput = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  agent_name: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  crm_contact_grade: string | null;
  crm_save_date: string | null;
  crm_visit_id: number | null;
  double_crm_id: number | null;
  speciality: string | null;
  visit_date: string | null;
  visit_type: number | null;
};

const VISIT_COLUMNS =
  "agent_crm_id, agent_hr_id, agent_name, contact_crm_id, contact_name, crm_contact_grade, crm_save_date, crm_visit_id, double_crm_id, speciality, visit_date, visit_type";

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

/** "2026-07-31" → "2026-07". Callers guarantee a YYYY-MM-DD-shaped string. */
export function monthKeyOfVisitDate(visitDate: string): string {
  return visitDate.slice(0, 7);
}

/** Pure YYYY-MM arithmetic — addMonthsToMonthKey("2026-01", -3) === "2025-10". No Date objects. */
export function addMonthsToMonthKey(monthKey: string, delta: number): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const zeroBased = year * 12 + (month - 1) + delta;
  const outYear = Math.floor(zeroBased / 12);
  const outMonth = (zeroBased % 12) + 1;
  return `${String(outYear).padStart(4, "0")}-${String(outMonth).padStart(2, "0")}`;
}

/** Last day of the month as YYYY-MM-DD — day-count table + Gregorian leap rule, no Date parsing. */
export function lastDayOfMonthKeyIso(monthKey: string): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return `${monthKey}-${String(days).padStart(2, "0")}`;
}

/** A valid "YYYY-MM" passes through; anything else falls back to the current Cairo month —
 * same validate-or-default posture as attendance's resolveSummaryMonth. */
export function resolveCoverageMonth(month: string | undefined): string {
  if (month && MONTH_KEY_PATTERN.test(month)) return month;
  return monthKeyOfVisitDate(cairoTodayIso());
}

/** "A+"/"A" → 2, "B"/"C" → 1, anything else (null, blank, unknown code) → null = ungraded. */
export function coverageTargetForGrade(grade: string | null | undefined): number | null {
  const tier = gradeTierOf(grade);
  return tier ? DOCTOR_COVERAGE_TARGETS[tier] : null;
}

function gradeTierOf(grade: string | null | undefined): DoctorCoverageGradeTier | null {
  if (grade === "A+" || grade === "A") return "A";
  if (grade === "B") return "B";
  if (grade === "C") return "C";
  return null;
}

function monthLabelOf(monthKey: string): string {
  const monthIndex = Number(monthKey.slice(5, 7)) - 1;
  return `${MONTH_NAMES[monthIndex] ?? monthKey} ${monthKey.slice(0, 4)}`;
}

/** Same agent-key convention as sfe-field-analytics.ts — hr id when mapped, crm id otherwise. */
function repKeyOf(visit: DoctorCoverageVisitInput): string {
  if (visit.agent_hr_id) return `hr:${visit.agent_hr_id.toLowerCase()}`;
  return `crm:${visit.agent_crm_id ?? 0}`;
}

type ContactAccumulator = {
  contactCrmId: number;
  /** Latest-visit-wins fields, tracked with their visit date (tie → higher crm_visit_id). */
  latestGrade: { date: string; grade: string; visitId: number } | null;
  latestName: { date: string; name: string; visitId: number } | null;
  latestSpeciality: { date: string; speciality: string; visitId: number } | null;
  lastVisitDate: string | null;
  /** Visit count per month key, selected window only. */
  visitsByMonth: Map<string, number>;
  /** Type-0 visit count per repKey in the whole window — drives the primary-rep assignment. */
  visitsByRep: Map<string, { count: number; latestDate: string; latestVisitId: number; repName: string }>;
};

function trackLatest<T extends { date: string; visitId: number }>(current: T | null, candidate: T): T {
  if (!current) return candidate;
  if (candidate.date > current.date) return candidate;
  if (candidate.date === current.date && candidate.visitId > current.visitId) return candidate;
  return current;
}

/**
 * Pure aggregation core — no IO, fixture-testable. `visits` must already be duplicate-collapsed;
 * rows that are not regular customer visits (visit_type !== 0), carry the sentinel/absent contact,
 * or have no visit_date are ignored here so fixtures and the IO wrapper share one contract.
 */
export function buildDoctorCoverageBoard(
  visits: readonly DoctorCoverageVisitInput[],
  selectedMonth: string,
): SfeDoctorCoverageBoard {
  const windowMonths: string[] = [];
  for (let back = DOCTOR_COVERAGE_MONTHS_BACK; back >= 0; back -= 1) {
    windowMonths.push(addMonthsToMonthKey(selectedMonth, -back));
  }
  const lapseMonths = new Set(
    Array.from({ length: DOCTOR_COVERAGE_LAPSE_LOOKBACK_MONTHS }, (_, index) =>
      addMonthsToMonthKey(selectedMonth, -(index + 1)),
    ),
  );
  const windowFrom = `${windowMonths[0]}-01`;
  const windowTo = lastDayOfMonthKeyIso(selectedMonth);
  const currentCairoMonth = monthKeyOfVisitDate(cairoTodayIso());

  const contacts = new Map<number, ContactAccumulator>();
  let visitsCountedSelectedMonth = 0;

  for (const visit of visits) {
    if (visit.visit_type !== 0) continue;
    if (!visit.contact_crm_id) continue; // null and the 0 sentinel
    const visitDate = visit.visit_date ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) continue;
    const monthKey = monthKeyOfVisitDate(visitDate);
    if (monthKey < windowMonths[0] || monthKey > selectedMonth) continue;

    let contact = contacts.get(visit.contact_crm_id);
    if (!contact) {
      contact = {
        contactCrmId: visit.contact_crm_id,
        lastVisitDate: null,
        latestGrade: null,
        latestName: null,
        latestSpeciality: null,
        visitsByMonth: new Map(),
        visitsByRep: new Map(),
      };
      contacts.set(visit.contact_crm_id, contact);
    }

    const visitId = visit.crm_visit_id ?? 0;
    if (visit.contact_name?.trim()) {
      contact.latestName = trackLatest(contact.latestName, { date: visitDate, name: visit.contact_name.trim(), visitId });
    }
    const normalizedGrade = visit.crm_contact_grade?.trim().toUpperCase() ?? "";
    if (gradeTierOf(normalizedGrade)) {
      contact.latestGrade = trackLatest(contact.latestGrade, { date: visitDate, grade: normalizedGrade, visitId });
    }
    if (visit.speciality?.trim()) {
      contact.latestSpeciality = trackLatest(contact.latestSpeciality, {
        date: visitDate,
        speciality: visit.speciality.trim(),
        visitId,
      });
    }
    if (!contact.lastVisitDate || visitDate > contact.lastVisitDate) contact.lastVisitDate = visitDate;
    contact.visitsByMonth.set(monthKey, (contact.visitsByMonth.get(monthKey) ?? 0) + 1);

    const repKey = repKeyOf(visit);
    const repEntry = contact.visitsByRep.get(repKey);
    const repName = visit.agent_name?.trim() || (visit.agent_hr_id ? visit.agent_hr_id : "Unmapped agent");
    if (!repEntry) {
      contact.visitsByRep.set(repKey, { count: 1, latestDate: visitDate, latestVisitId: visitId, repName });
    } else {
      repEntry.count += 1;
      if (visitDate > repEntry.latestDate || (visitDate === repEntry.latestDate && visitId > repEntry.latestVisitId)) {
        repEntry.latestDate = visitDate;
        repEntry.latestVisitId = visitId;
        repEntry.repName = repName;
      }
    }
    if (monthKey === selectedMonth) visitsCountedSelectedMonth += 1;
  }

  // ── Classify every contact for the selected month ──────────────────────────────────────────────
  const doctors: DoctorCoverageDoctorRow[] = [];
  let ungradedContacts = 0;
  // Per-month green/panel counts for the trend, computed with the SAME latest-grade-in-window rule.
  const trendPanel = new Map<string, { green: number; panel: number }>();
  for (const month of windowMonths) trendPanel.set(month, { green: 0, panel: 0 });

  for (const contact of contacts.values()) {
    const gradeRaw = contact.latestGrade?.grade ?? null;
    const tier = gradeTierOf(gradeRaw);
    const visitsThisMonth = contact.visitsByMonth.get(selectedMonth) ?? 0;

    if (!tier) {
      if (visitsThisMonth > 0) ungradedContacts += 1;
      continue;
    }
    const target = DOCTOR_COVERAGE_TARGETS[tier];

    // Trend: every window month gets the same green-vs-target math (panel = visited that month
    // OR lapsed relative to that month's own prior-2 window, bounded to months we scanned).
    for (const month of windowMonths) {
      const monthVisits = contact.visitsByMonth.get(month) ?? 0;
      let inPanel = monthVisits > 0;
      if (!inPanel) {
        for (let back = 1; back <= DOCTOR_COVERAGE_LAPSE_LOOKBACK_MONTHS; back += 1) {
          const prior = addMonthsToMonthKey(month, -back);
          if (prior < windowMonths[0]) break;
          if ((contact.visitsByMonth.get(prior) ?? 0) > 0) {
            inPanel = true;
            break;
          }
        }
      }
      if (!inPanel) continue;
      const bucket = trendPanel.get(month);
      if (!bucket) continue;
      bucket.panel += 1;
      if (monthVisits >= target) bucket.green += 1;
    }

    let status: DoctorCoverageStatus;
    if (visitsThisMonth >= target) status = "green";
    else if (visitsThisMonth > 0) status = "yellow";
    else {
      const seenRecently = Array.from(lapseMonths).some((month) => (contact.visitsByMonth.get(month) ?? 0) > 0);
      if (!seenRecently) continue; // inactive — out of panel and denominator
      status = "red";
    }

    // Primary rep: most window visits; tie → latest visit, then higher crm_visit_id.
    let primary: { count: number; latestDate: string; latestVisitId: number; repKey: string; repName: string } | null =
      null;
    for (const [repKey, entry] of contact.visitsByRep) {
      if (
        !primary ||
        entry.count > primary.count ||
        (entry.count === primary.count &&
          (entry.latestDate > primary.latestDate ||
            (entry.latestDate === primary.latestDate && entry.latestVisitId > primary.latestVisitId)))
      ) {
        primary = { ...entry, repKey };
      }
    }

    doctors.push({
      contactCrmId: contact.contactCrmId,
      contactName: contact.latestName?.name ?? `Contact #${contact.contactCrmId}`,
      gradeRaw: gradeRaw as string,
      gradeTier: tier,
      lastVisitDate: contact.lastVisitDate,
      repKey: primary?.repKey ?? "crm:0",
      repName: primary?.repName ?? "Unmapped agent",
      speciality: contact.latestSpeciality?.speciality ?? null,
      status,
      targetVisits: target,
      visitsThisMonth,
    });
  }

  // ── Rep rollup (sums exactly to the company tiles by construction) ─────────────────────────────
  const repRows = new Map<string, DoctorCoverageRepRow>();
  for (const doctor of doctors) {
    let rep = repRows.get(doctor.repKey);
    if (!rep) {
      rep = {
        aDoctors: 0,
        agentHrId: doctor.repKey.startsWith("hr:") ? doctor.repKey.slice(3) : null,
        bDoctors: 0,
        cDoctors: 0,
        coveragePct: 0,
        green: 0,
        panelSize: 0,
        red: 0,
        repKey: doctor.repKey,
        repName: doctor.repName,
        yellow: 0,
      };
      repRows.set(doctor.repKey, rep);
    }
    rep.panelSize += 1;
    if (doctor.status === "green") rep.green += 1;
    else if (doctor.status === "yellow") rep.yellow += 1;
    else rep.red += 1;
    if (doctor.gradeTier === "A") rep.aDoctors += 1;
    else if (doctor.gradeTier === "B") rep.bDoctors += 1;
    else rep.cDoctors += 1;
  }
  for (const rep of repRows.values()) {
    rep.coveragePct = rep.panelSize > 0 ? Math.round((rep.green / rep.panelSize) * 100) : 0;
  }

  const totalsGreen = doctors.filter((doctor) => doctor.status === "green").length;
  const totalsYellow = doctors.filter((doctor) => doctor.status === "yellow").length;
  const totalsRed = doctors.filter((doctor) => doctor.status === "red").length;
  const activePanel = doctors.length;

  // ── Specialty mix & grade split (panel doctors only) ───────────────────────────────────────────
  const specialtyCounts = new Map<string, number>();
  for (const doctor of doctors) {
    const label = doctor.speciality ?? "Unspecified";
    specialtyCounts.set(label, (specialtyCounts.get(label) ?? 0) + 1);
  }
  const namedSpecialties = Array.from(specialtyCounts.entries())
    .filter(([label]) => label !== "Unspecified")
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const specialtyMix: Array<{ doctors: number; label: string }> = namedSpecialties
    .slice(0, SPECIALTY_MIX_TOP_N)
    .map(([label, count]) => ({ doctors: count, label }));
  const otherCount = namedSpecialties.slice(SPECIALTY_MIX_TOP_N).reduce((sum, [, count]) => sum + count, 0);
  if (otherCount > 0) specialtyMix.push({ doctors: otherCount, label: "Other" });
  const unspecifiedCount = specialtyCounts.get("Unspecified") ?? 0;
  if (unspecifiedCount > 0) specialtyMix.push({ doctors: unspecifiedCount, label: "Unspecified" });

  const gradeSplit = (["A", "B", "C"] as const).map((tier) => ({
    covered: doctors.filter((doctor) => doctor.gradeTier === tier && doctor.status === "green").length,
    doctors: doctors.filter((doctor) => doctor.gradeTier === tier).length,
    tier,
  }));

  const trend = windowMonths.map((month) => {
    const bucket = trendPanel.get(month) ?? { green: 0, panel: 0 };
    return {
      activePanel: bucket.panel,
      coveragePct: bucket.panel > 0 ? Math.round((bucket.green / bucket.panel) * 100) : 0,
      label: monthLabelOf(month),
      month,
    };
  });

  return {
    doctors: doctors.sort((a, b) => {
      const severity = (status: DoctorCoverageStatus) => (status === "red" ? 0 : status === "yellow" ? 1 : 2);
      return (
        severity(a.status) - severity(b.status) ||
        b.gradeTier.localeCompare(a.gradeTier) * -1 ||
        a.contactName.localeCompare(b.contactName)
      );
    }),
    gradeSplit,
    isCurrentMonth: selectedMonth === currentCairoMonth,
    month: selectedMonth,
    monthLabel: monthLabelOf(selectedMonth),
    reps: Array.from(repRows.values()).sort(
      (a, b) => a.coveragePct - b.coveragePct || a.repName.localeCompare(b.repName),
    ),
    specialtyMix,
    totals: {
      activePanel,
      coveragePct: activePanel > 0 ? Math.round((totalsGreen / activePanel) * 100) : 0,
      green: totalsGreen,
      red: totalsRed,
      ungradedContacts,
      visitsCounted: visitsCountedSelectedMonth,
      yellow: totalsYellow,
    },
    trend,
    windowFrom,
    windowTo,
  };
}

/** IO wrapper: single-source-door read + duplicate collapse, then the pure core. */
export async function getSfeDoctorCoverage(input?: { month?: string }): Promise<SfeDoctorCoverageBoard> {
  const month = resolveCoverageMonth(input?.month);
  const dateFrom = `${addMonthsToMonthKey(month, -DOCTOR_COVERAGE_MONTHS_BACK)}-01`;
  const dateTo = lastDayOfMonthKeyIso(month);
  const rows = await scanVisitsForRange<DoctorCoverageVisitInput>({ columns: VISIT_COLUMNS, dateFrom, dateTo });
  const collapsed = collapseDuplicateVisitSubmissions(rows);
  return buildDoctorCoverageBoard(collapsed, month);
}
