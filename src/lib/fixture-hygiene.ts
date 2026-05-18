export const DISPOSABLE_FIXTURE_YEAR_MIN = 2090;

export function isDisposableFixtureText(value: unknown) {
  return /^phase[\s._-]*(?:1[3-9]|[2-9]\d)/i.test(String(value ?? "").trim());
}

export function isDisposableFixtureYear(value: unknown) {
  const year = Number(value);
  return Number.isFinite(year) && year >= DISPOSABLE_FIXTURE_YEAR_MIN;
}

export function isDisposablePayrollBatchRow(row: Record<string, unknown>) {
  return (
    isDisposableFixtureYear(row.year) ||
    isDisposableFixtureText(row.file_name) ||
    isDisposableFixtureText(row.uploaded_by) ||
    isDisposableFixtureText(row.approved_by)
  );
}

export function isDisposableSalesBatchRow(row: Record<string, unknown>) {
  return (
    isDisposableFixtureYear(row.year) ||
    isDisposableFixtureText(row.file_name) ||
    isDisposableFixtureText(row.period) ||
    isDisposableFixtureText(row.uploaded_by) ||
    isDisposableFixtureText(row.approved_by) ||
    isDisposableFixtureText(row.rejected_by)
  );
}

export function isDisposableSalesRecordRow(row: Record<string, unknown>) {
  return (
    isDisposableFixtureYear(row.year) ||
    isDisposableFixtureText(row.employee_hr_id) ||
    isDisposableFixtureText(row.employee_lookup_key) ||
    isDisposableFixtureText(row.employee_name) ||
    isDisposableFixtureText(row.manager_hr_id) ||
    isDisposableFixtureText(row.territory) ||
    isDisposableFixtureText(row.product)
  );
}

export function isDisposableExpenseRow(row: Record<string, unknown>) {
  return (
    isDisposableFixtureYear(row.payout_year) ||
    isDisposableFixtureText(row.hr_id) ||
    isDisposableFixtureText(row.trip_id) ||
    isDisposableFixtureText(row.source_file_name) ||
    isDisposableFixtureText(row.specialist) ||
    isDisposableFixtureText(row.description)
  );
}

export function isDisposableExpenseReportRow(row: Record<string, unknown>) {
  return isDisposableFixtureText(row.file_name);
}
