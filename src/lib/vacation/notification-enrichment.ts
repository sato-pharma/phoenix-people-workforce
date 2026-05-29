import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeVacationType, vacationTypeLabel } from "@/lib/vacation/calculations";
import type { NotificationEnrichmentRecord } from "@/lib/communication/metrics";

/**
 * Read-only notification enrichment for vacation requests.
 *
 * Old vacation notifications only stored `requestId` + `status` in metadata, so
 * the bell cannot show the employee name, vacation type or period without
 * resolving the request record. This module performs a single, batched,
 * READ-ONLY lookup of the small set of NON-SENSITIVE fields the bell needs.
 *
 * Privacy: it selects ONLY name / HR_ID / type / dates / status — never salary,
 * balance, bank, national id, attachments, notes or any other sensitive column.
 * It never writes. It is intentionally fail-soft: any error yields an empty map
 * so the notification bell still renders (falling back to stored content).
 *
 * It deliberately does NOT import `@/lib/notifications/in-app` (which imports the
 * vacation service) to avoid a circular import.
 */

const vacationRequestsTable = "v2_vacation_requests";

type VacationEnrichmentDbRow = {
  employee_hr_id?: unknown;
  employee_name?: unknown;
  end_date?: unknown;
  id?: unknown;
  start_date?: unknown;
  status?: unknown;
  vacation_type?: unknown;
};

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * Resolve a map of `requestId -> non-sensitive vacation fields` for the given
 * notification request ids. Best-effort and read-only.
 */
export async function fetchVacationNotificationEnrichments(
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, NotificationEnrichmentRecord>> {
  const result = new Map<string, NotificationEnrichmentRecord>();

  const uniqueIds = Array.from(
    new Set(ids.map((value) => cleanString(value)).filter((value) => value.length > 0)),
  );
  if (uniqueIds.length === 0) return result;

  try {
    const { data, error } = await getSupabaseAdmin()
      .from(vacationRequestsTable)
      // NON-SENSITIVE columns only — no salary/balance/bank/national id/notes.
      .select("id,employee_name,employee_hr_id,vacation_type,start_date,end_date,status")
      .in("id", uniqueIds);

    if (error || !Array.isArray(data)) return result;

    for (const raw of data as VacationEnrichmentDbRow[]) {
      const id = cleanString(raw.id);
      if (!id) continue;
      result.set(id, {
        employeeHrId: cleanString(raw.employee_hr_id),
        employeeName: cleanString(raw.employee_name),
        endDate: cleanString(raw.end_date),
        startDate: cleanString(raw.start_date),
        status: cleanString(raw.status),
        typeLabel: vacationTypeLabel(normalizeVacationType(raw.vacation_type)),
      });
    }
  } catch {
    // Fail-soft: never let an enrichment lookup break the notification bell.
    return result;
  }

  return result;
}
