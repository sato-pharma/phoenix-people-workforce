import { AlertTriangle, Download, FileCheck2, Loader2, Upload } from "lucide-react";
import type { RefObject } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import type { PayrollPeriodConflict } from "@/lib/payroll/types";

import { payrollMonths } from "./shared";
import {
  type SalaryValidationResult,
  ValidationSummary,
} from "./validation-summary";
import { SearchableSelect } from "@/components/ui/searchable-select";


function SalaryUploadErrorBanner({
  message,
}: {
  message: string;
}) {
  return (
    <AdminCallout tone="danger">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
      <div>
        <p className="font-semibold">Payroll upload error</p>
        <p className="mt-1 leading-6">{message}</p>
      </div>
    </AdminCallout>
  );
}

function SalaryPeriodConflictWarning({
  conflict,
  fileName,
  onCancel,
  onReplace,
  replacing,
}: {
  conflict: PayrollPeriodConflict;
  fileName?: string;
  onCancel: () => void;
  onReplace: () => void;
  replacing: boolean;
}) {
  return (
    <AdminCallout tone={conflict.replaceable ? "warning" : "danger"}>
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">Payroll period already exists</p>
        <p className="mt-1 leading-6">
          {conflict.message}
          {fileName ? ` Selected file: ${fileName}.` : ""}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {conflict.replaceable ? (
            <Button disabled={replacing} onClick={onReplace}>
              {replacing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              Replace existing upload
            </Button>
          ) : null}
          <Button onClick={onCancel} variant="secondary">
            Cancel
          </Button>
        </div>
      </div>
    </AdminCallout>
  );
}

export function SalaryUploadActions({
  canConfirmSalaryUpload,
  confirmingSalary,
  hasPayrollPeriod,
  onConfirmSalaryUpload,
  onPayrollMonthChange,
  onPayrollYearChange,
  onReplaceFile,
  onRequestSalaryUpload,
  onSalaryTemplateUpload,
  payrollMonth,
  payrollYears,
  payrollYear,
  replaceFileInputRef,
  salaryFileInputRef,
  validatingSalary,
}: {
  canConfirmSalaryUpload: boolean;
  confirmingSalary: boolean;
  hasPayrollPeriod: boolean;
  onConfirmSalaryUpload: () => void;
  onPayrollMonthChange: (value: string) => void;
  onPayrollYearChange: (value: string) => void;
  onReplaceFile: (file: File | null) => void;
  onRequestSalaryUpload: () => void;
  onSalaryTemplateUpload: (file: File | null) => void;
  payrollMonth: string;
  payrollYears: string[];
  payrollYear: string;
  replaceFileInputRef: RefObject<HTMLInputElement | null>;
  salaryFileInputRef: RefObject<HTMLInputElement | null>;
  validatingSalary: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-2">
      <input
        accept=".xlsx"
        className="hidden"
        onChange={(event) => onSalaryTemplateUpload(event.target.files?.[0] ?? null)}
        ref={salaryFileInputRef}
        type="file"
      />
      <input
        accept=".xlsx"
        className="hidden"
        onChange={(event) => onReplaceFile(event.target.files?.[0] ?? null)}
        ref={replaceFileInputRef}
        type="file"
      />
      <SearchableSelect
        className="px-3 text-text"
        onChange={(event) => onPayrollMonthChange(event.target.value)}
        value={payrollMonth}
      >
        <option value="">Month</option>
        {payrollMonths.map((month) => (
          <option key={month.value} value={month.value}>
            {month.label}
          </option>
        ))}
      </SearchableSelect>
      <SearchableSelect
        className="px-3 text-text"
        onChange={(event) => onPayrollYearChange(event.target.value)}
        value={payrollYear}
      >
        <option value="">Year</option>
        {payrollYears.map((year) => (
          <option key={year} value={year}>
            {year}
          </option>
        ))}
      </SearchableSelect>
      {hasPayrollPeriod ? (
        <Button asChild variant="secondary">
          <a href={`/api/payroll/template?upload=1&month=${encodeURIComponent(payrollMonth)}&year=${encodeURIComponent(payrollYear)}`}>
            <Download className="mr-2 h-4 w-4" />
            Download Upload Template
          </a>
        </Button>
      ) : (
        <Button disabled variant="secondary">
          <Download className="mr-2 h-4 w-4" />
          Download Upload Template
        </Button>
      )}
      {hasPayrollPeriod ? (
        <Button asChild variant="secondary">
          <a href={`/api/payroll/template?ready=1&month=${encodeURIComponent(payrollMonth)}&year=${encodeURIComponent(payrollYear)}`}>
            <Download className="mr-2 h-4 w-4" />
            Download Ready Payroll
          </a>
        </Button>
      ) : (
        <Button disabled variant="secondary">
          <Download className="mr-2 h-4 w-4" />
          Download Ready Payroll
        </Button>
      )}
      <Button
        disabled={validatingSalary || !hasPayrollPeriod}
        onClick={onRequestSalaryUpload}
      >
        {validatingSalary ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Upload className="mr-2 h-4 w-4" />
        )}
        Upload & Validate
      </Button>
      <Button
        disabled={!canConfirmSalaryUpload || confirmingSalary}
        onClick={onConfirmSalaryUpload}
        variant={canConfirmSalaryUpload ? "default" : "secondary"}
      >
        {confirmingSalary ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <FileCheck2 className="mr-2 h-4 w-4" />
        )}
        Confirm Upload
      </Button>
    </div>
  );
}

export function SalaryUploadValidationSection({
  conflict,
  fileName,
  onCancelConflict,
  onReplaceConflict,
  replacingConflict,
  uploadError,
  validation,
}: {
  conflict: PayrollPeriodConflict | null;
  fileName?: string;
  onCancelConflict: () => void;
  onReplaceConflict: () => void;
  replacingConflict: boolean;
  uploadError: string | null;
  validation: SalaryValidationResult | null;
}) {
  return (
    <>
      {uploadError && (
        <SalaryUploadErrorBanner message={uploadError} />
      )}

      {conflict && (
        <SalaryPeriodConflictWarning
          conflict={conflict}
          fileName={fileName}
          onCancel={onCancelConflict}
          onReplace={onReplaceConflict}
          replacing={replacingConflict}
        />
      )}

      {validation && <ValidationSummary result={validation} />}
    </>
  );
}
