/**
 * The words for `outstation_expense_requests.workload_source`, wherever a person reads it (the approver's
 * request card and the review PDF). Pure, so a client component can use it.
 *
 * 'ireports360' is the stamp the system's own read wrote until iReports360 was retired on 6 Nov 2026, and
 * 'phoenix_crm' the one it writes since (workload-stamp.ts). A value this does not know prints as its own
 * words, never blank.
 */
const WORKLOAD_SOURCE_LABELS: Readonly<Record<string, string>> = {
  double_visit_import: "Double visit import",
  ireports360: "iReports360 (before Phoenix CRM)",
  manual: "Manual",
  override: "Entered by an administrator",
  phoenix_crm: "Phoenix CRM",
};

export function outstationWorkloadSourceLabel(value: string | null | undefined): string {
  const key = String(value ?? "").trim() || "manual";
  return WORKLOAD_SOURCE_LABELS[key] ?? key.replace(/_/g, " ");
}
