import type { FieldWorkforceValidationIssue } from "@/lib/field-workforce-compliance/types";

// The Excel-workbook preview builder (buildFieldWorkforceCompliancePreviewFromWorkbook) and its
// private employee/holiday loaders were removed with the FWC Excel import. The live path builds its
// preview from the CRM visits mirror via buildFieldWorkforceCompliancePreviewFromVisitsReport
// (ireports360-source.ts). Only this shared error type remains, still thrown by the live path.

export class FieldWorkforcePreviewError extends Error {
  code: string;
  errors: FieldWorkforceValidationIssue[];
  status: number;
  warnings: FieldWorkforceValidationIssue[];

  constructor(input: {
    code: string;
    errors?: FieldWorkforceValidationIssue[];
    message: string;
    status: number;
    warnings?: FieldWorkforceValidationIssue[];
  }) {
    super(input.message);
    this.name = "FieldWorkforcePreviewError";
    this.code = input.code;
    this.errors = input.errors ?? [];
    this.status = input.status;
    this.warnings = input.warnings ?? [];
  }
}
