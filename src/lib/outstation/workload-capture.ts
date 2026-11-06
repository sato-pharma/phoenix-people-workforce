/**
 * Capture the AM · PM · Pharmacies workload for one outstation trip — the third and last
 * checkpoint before a request may reach payroll (see expense-gate.ts).
 *
 * Three pieces, deliberately separate so the RULE can be tested without a CRM:
 *   - who counts               → workload-rollup.ts   (pure, tested)
 *   - who was out with whom    → crm/visit-partners.ts (one query per hop)
 *   - how much each worked     → crm/visit-workload.ts (existing, untouched)
 *
 * This module is only the wiring between them.
 *
 * It never throws. A failure returns a captured:false result carrying the reason, which the
 * caller stores on `workload_last_attempt_error` so a Super Admin sees WHY the grab failed before
 * deciding to enter the numbers by hand. A workload that cannot be read must leave the request
 * waiting, never silently record zero — a zero here reads as "he did no work", which is a
 * rejection reason, not a missing measurement.
 */

import { getRepTripVisitWorkload } from "@/lib/crm/visit-workload";
import { getTripVisitPartnersByDate } from "@/lib/crm/visit-partners";
import {
  rollUpManagerTripWorkload,
  rollupHopsForRole,
  type RolledUpWorkloadDay,
  type WorkloadByPerson,
} from "@/lib/outstation/workload-rollup";

export type OutstationWorkloadCapture =
  | {
      amWorkload: number;
      captured: true;
      days: RolledUpWorkloadDay[];
      /** The employee's OWN recorded meetings, by date — not visits, but the day's work (owner,
       * 2026-11-07, trip-day-meetings.ts). A partner's meeting is never counted here. */
      meetingDates?: string[];
      /** Everyone whose visits contributed, across the whole trip. For the evidence snapshot. */
      contributingHrIds: string[];
      hops: number;
      /** The third figure — pharmacy visits, never inside AM or PM (the golden rule). */
      pharmacyWorkload: number;
      pmWorkload: number;
      sourceLabel: string;
    }
  | { captured: false; reason: string };

/** Every date from start to end inclusive (YYYY-MM-DD), capped. */
function tripDates(startIso: string, endIso: string): string[] {
  const start = String(startIso ?? "").slice(0, 10);
  const end = String(endIso ?? "").slice(0, 10) || start;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
    return /^\d{4}-\d{2}-\d{2}$/.test(start) ? [start] : [];
  }
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  for (let guard = 0; cursor <= last && guard < 400; guard += 1) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export async function captureOutstationTripWorkload(input: {
  employeeHrId: string;
  employeeRole: string | null | undefined;
  tripEndDate: string;
  tripStartDate: string;
}): Promise<OutstationWorkloadCapture> {
  const employeeHrId = String(input.employeeHrId ?? "").trim();
  if (!employeeHrId) {
    return { captured: false, reason: "The request has no employee HR ID, so no CRM visits can be matched to it." };
  }

  const dates = tripDates(input.tripStartDate, input.tripEndDate);
  if (dates.length === 0) {
    return { captured: false, reason: "The trip has no usable start/end dates, so there are no days to measure." };
  }

  const hops = rollupHopsForRole(input.employeeRole);

  try {
    // Who the employee (and, one ring out, his people) were in the field with each day. Empty for
    // a 0-hop seat — a rep or a DM needs no expansion, so this costs nothing for most requests.
    const partnersByPersonDate = await getTripVisitPartnersByDate({
      hops,
      rootHrIds: [employeeHrId],
      tripEndDate: input.tripEndDate,
      tripStartDate: input.tripStartDate,
    });

    // Everyone the rollup could possibly count: the employee plus anyone reachable through the
    // partner map. Reading a person the rollup then ignores is wasted work, but reading too FEW
    // silently under-counts, so the set is deliberately the generous one.
    const people = new Set<string>([employeeHrId]);
    for (const [person, byDate] of Object.entries(partnersByPersonDate)) {
      people.add(person);
      for (const list of Object.values(byDate)) for (const partner of list) people.add(partner);
    }

    const meetingDates = new Set<string>();
    const workloadByPerson: WorkloadByPerson = Object.fromEntries(
      await Promise.all(
        Array.from(people).map(async (hrId) => {
          const workload = await getRepTripVisitWorkload({
            hrId,
            tripEndDate: input.tripEndDate,
            tripStartDate: input.tripStartDate,
          });
          if (hrId === employeeHrId) {
            for (const day of workload.dateBreakdown) if ((day.meetings ?? 0) > 0) meetingDates.add(day.date);
          }
          return [
            hrId,
            workload.dateBreakdown.map((day) => ({ am: day.am, date: day.date, pharmacies: day.pharmacies, pm: day.pm })),
          ] as const;
        }),
      ),
    );

    const rolled = rollUpManagerTripWorkload({
      dates,
      hops,
      partnersByPersonDate,
      rootHrId: employeeHrId,
      workloadByPerson,
    });

    const contributingHrIds = Array.from(
      new Set(rolled.days.flatMap((day) => day.countedHrIds)),
    ).sort();

    return {
      amWorkload: rolled.amWorkload,
      captured: true,
      contributingHrIds,
      days: rolled.days.map((day) => (meetingDates.has(day.date) ? { ...day, meeting: true } : day)),
      hops,
      meetingDates: [...meetingDates].sort(),
      pharmacyWorkload: rolled.pharmacyWorkload,
      pmWorkload: rolled.pmWorkload,
      sourceLabel:
        hops === 0
          ? "Live iReports360 visits for this employee (their own visits, and the ones where they are the double-visit partner)."
          : `Live iReports360 visits, rolled up ${hops} level(s): their own, plus the visits of the people they were actually in the field with on each day.`,
    };
  } catch (error) {
    return {
      captured: false,
      reason: error instanceof Error ? error.message : "The CRM visit read failed for an unknown reason.",
    };
  }
}
