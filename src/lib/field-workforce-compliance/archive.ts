// Field Workforce Compliance month-key helper.
//
// The Excel-upload archive path (field_workforce_compliance_imports / _days / _monthly_summary
// tables, the workbook parser→rows→detail round-trip, and the archive readers) was removed when
// the FWC Excel import was retired — the CRM visits mirror is now the only source (see
// live-snapshots.ts). All that remains here is the pure month-key formatter still shared by the
// live path (live-snapshots.ts, digest.ts) and the deductions connector.

export function fieldWorkforceMonthKey(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}`;
}
