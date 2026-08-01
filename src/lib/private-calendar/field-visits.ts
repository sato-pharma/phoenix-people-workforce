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

import { scanVisitsForRange } from "@/lib/crm/reads.ts";
import { hrIdLookupKeys } from "@/lib/hr-id";
import type { PrivateCalendarItem } from "@/lib/private-calendar/logic";

type FieldVisitRow = {
  agent_crm_id: number | string | null;
  agent_hr_id: string | null;
  agent_name: string | null;
  customer_name: string | null;
  visit_date: string | null;
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

    const rows = await scanVisitsForRange<FieldVisitRow>({
      dateFrom: start,
      dateTo: end,
      columns: "visit_date,agent_hr_id,agent_name,agent_crm_id,customer_name",
    });

    // Group by (employee, day). Keyed on the rep's own hr_id — a visit where this
    // employee is the *visited* party (a double visit received) is the other
    // person's field work, not theirs, and is already handled by the double-visit
    // feed.
    const byKey = new Map<string, { hrId: string; name: string | null; date: string; customers: Set<string> }>();
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
      };
      const customer = String(row.customer_name ?? "").trim();
      if (customer) existing.customers.add(customer);
      byKey.set(key, existing);
    }

    const items: PrivateCalendarItem[] = [];
    for (const [key, group] of byKey) {
      const customerList = [...group.customers];
      const shown = customerList.slice(0, 3).join(", ");
      const more = customerList.length > 3 ? ` +${customerList.length - 3} more` : "";
      const label = customerList.length > 0 ? `${shown}${more}` : "Unnamed customers";
      items.push({
        approvalImpact:
          "CRM field-visit evidence is read-only activity context. It does not mutate attendance, leave, deductions, payroll, or compliance decisions.",
        chipLines: [`${customerList.length || "?"} field visit${customerList.length === 1 ? "" : "s"}`, label],
        description: `Logged CRM field visits from the live iReports360 visit mirror.`,
        detailLines: [`Customers: ${label}`],
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
        title: `Field visits: ${label}`,
      });
    }
    return { items, ready: true };
  } catch {
    return { items: [], ready: false };
  }
}
