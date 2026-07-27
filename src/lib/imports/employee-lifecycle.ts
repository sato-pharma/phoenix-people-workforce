// Lifecycle classification for the employee master import.
//
// Kept deliberately free of any Supabase / data-access imports so it is trivially
// unit-testable and safe to reuse from both the existing-state loader and any future
// consumer. This is the single source of truth for "is this employee active for import
// purposes?" — get it right here, once.

export const activeImportEmployeeStatuses = new Set(["active", "on_leave"]);

export function normalizeEmploymentStatus(value: unknown) {
  return String(value ?? "active").trim().toLowerCase() || "active";
}

// "Active for import purposes" means the employee is NOT in a terminal lifecycle state
// (resigned / terminated / historical_payroll_record / system_placeholder). It deliberately
// keys on employment_status ONLY.
//
// It must NOT consider payroll_eligible or organogram_visible: those are orthogonal flags that
// fully-active employees legitimately carry. The CEO and other executives/advisors are
// payroll_eligible=false but very much active — they must stay updatable by the master import,
// count as valid managers, and hold their org seat. Some active employees are also
// organogram_visible=false (intentionally hidden nodes) yet are not terminated. Folding those
// flags into this predicate is the bug that repeatedly blocked active executives with
// "belongs to an inactive, hidden, resigned, or payroll-ineligible employee and cannot be
// reactivated by import" — a false positive, because none of them are actually terminal.
export function isActiveImportEmployee(row: { employment_status?: string | null }) {
  return activeImportEmployeeStatuses.has(normalizeEmploymentStatus(row.employment_status));
}
