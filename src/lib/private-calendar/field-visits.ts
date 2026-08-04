// Private calendar: a rep's OWN CRM field visits as a coverage source.
//
// Why this exists: derivePrivateCalendarExceptions treats a CRM Double Visit as
// self-proving attendance ("no fingerprint needed"), but only the double-visit
// feed was ever wired in. A solo visit proves the same thing — the rep was out
// doing field work — and field reps are not enrolled on fingerprint devices at
// all (see attendance-cross-check.ts), so CRM is their ONLY possible proof.
//
// Measured on July 2026 production data before this existed: of 1,992 rep-days
// carrying real logged visits, 1,709 were solo-only, and 1,700 of those had no
// punch, no approved leave and no double visit — 15,429 genuine customer visits
// across 101 employees, every one reading as "No Activity Recorded".
//
// Read-only. Never mutates CRM, attendance or deduction data.

import { collapseDuplicateVisitSubmissions, scanVisitsForRange } from "@/lib/crm/reads.ts";
import { hrIdLookupKeys } from "@/lib/hr-id";
import type { PrivateCalendarItem } from "@/lib/private-calendar/logic";

// `contact_name`, never `customer_name`: the mirror leaves customer_name empty on 100% of rows
// (0 of 75,682 populated over the last 120 days in production), which is what made every chip read
// "Unnamed customers". contact_name is populated on 55,610 of the 55,630 regular visits (type 0) and
// is blank by construction on every other type, where the contact id is a shared vendor sentinel and
// the real identity only exists in free-text `comment` — parsing that would repeat the mistake the
// duplicate-collapse comment rule already cost us (see crm/reads.ts), so unnamed days show a count.
type FieldVisitRow = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  agent_name: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  crm_save_date: string | null;
  crm_visit_id: number | null;
  double_crm_id: number | null;
  visit_date: string | null;
  visit_type: number | null;
};

function normalizedKey(value: string | null | undefined): string | null {
  const keys = hrIdLookupKeys(String(value ?? ""));
  return keys.length > 0 ? keys[0] : null;
}

/**
 * One item per (employee, day) that the employee logged at least one CRM visit
 * on. Grouped rather than one-per-visit so a 12-visit day is a single calendar
 * chip, matching how the double-visit loader presents its days.
 *
 * Best-effort by design, mirroring loadDoubleVisitPrivateCalendarItems: if the
 * CRM read fails this returns nothing rather than throwing, because a CRM outage
 * must not take the whole private calendar down with it. Note the direction of
 * that failure — losing coverage can only ever ADD a "No Activity Recorded"
 * flag, never remove one, so a degraded run over-reports rather than silently
 * excusing a real gap.
 */
export async function loadFieldVisitPrivateCalendarItems(
  employeeHrIds: string[],
  start: string,
  end: string,
): Promise<{ items: PrivateCalendarItem[]; ready: boolean }> {
  try {
    const selected = new Set(
      employeeHrIds.map((value) => normalizedKey(value)).filter((value): value is string => Boolean(value)),
    );
    if (selected.size === 0) return { items: [], ready: true };

    // scanVisitsForRange does not collapse on its own, so the chip's count runs through the same
    // canonical read-time collapse DV Analytics and FWC use — otherwise a rep re-saving one stop
    // reads as an extra visit here while every other surface counts it once. The extra columns are
    // the collapse's fingerprint; the aggregation below ignores them.
    const rows = collapseDuplicateVisitSubmissions(
      await scanVisitsForRange<FieldVisitRow>({
        dateFrom: start,
        dateTo: end,
        columns:
          "visit_date,agent_hr_id,agent_name,agent_crm_id,contact_name,contact_crm_id,crm_visit_id,crm_save_date,double_crm_id,visit_type",
      }),
    );

    // Group by (employee, day). Keyed on the rep's own hr_id — a visit where this
    // employee is the *visited* party (a double visit received) is the other
    // person's field work, not theirs, and is already handled by the double-visit
    // feed.
    const byKey = new Map<string, { hrId: string; name: string | null; date: string; customers: Set<string>; visits: number }>();
    for (const row of rows) {
      const hrKey = normalizedKey(row.agent_hr_id);
      if (!hrKey || !selected.has(hrKey)) continue;
      const date = String(row.visit_date ?? "").slice(0, 10);
      if (!date) continue;
      const key = `${hrKey}|${date}`;
      const existing = byKey.get(key) ?? {
        hrId: String(row.agent_hr_id ?? ""),
        name: row.agent_name ?? null,
        date,
        customers: new Set<string>(),
        visits: 0,
      };
      const customer = String(row.contact_name ?? "").trim();
      if (customer) existing.customers.add(customer);
      existing.visits += 1;
      byKey.set(key, existing);
    }

    const items: PrivateCalendarItem[] = [];
    for (const [key, group] of byKey) {
      const customerList = [...group.customers];
      const shown = customerList.slice(0, 3).join(", ");
      const more = customerList.length > 3 ? ` +${customerList.length - 3} more` : "";
      // Null, never a placeholder word: an unnamed day is a day whose visits the CRM does not name,
      // and the count alone is the honest chip. Counting VISITS (not distinct names) also matters —
      // reading the number off the name set showed "? field visits" on every day once customer_name
      // turned out to be empty everywhere.
      const label = customerList.length > 0 ? `${shown}${more}` : null;
      const visitCountLine = `${group.visits} field visit${group.visits === 1 ? "" : "s"}`;
      items.push({
        approvalImpact:
          "CRM field-visit evidence is read-only activity context. It does not mutate attendance, leave, deductions, payroll, or compliance decisions.",
        chipLines: label ? [visitCountLine, label] : [visitCountLine],
        description: `Logged CRM field visits from the live iReports360 visit mirror.`,
        detailLines: label ? [visitCountLine, `Customers: ${label}`] : [visitCountLine],
        employeeDepartmentName: null,
        employeeHrId: group.hrId,
        employeeJobTitle: null,
        employeeLineName: null,
        employeeName: group.name,
        endDate: group.date,
        exceptionFlags: [],
        id: `field-visit-${key}`,
        managerName: null,
        severity: "success",
        source: "field_visit",
        sourceLabel: "Live iReports360 visit mirror",
        sourceRecordId: `field-visit-${key}`,
        sourceSystem: "CRM Field Visits",
        sourceTable: "ireports360_visits",
        startDate: group.date,
        status: "performed",
        time: "Full day",
        title: label ? `Field visits: ${label}` : `Field visits (${group.visits})`,
      });
    }
    return { items, ready: true };
  } catch {
    return { items: [], ready: false };
  }
}
