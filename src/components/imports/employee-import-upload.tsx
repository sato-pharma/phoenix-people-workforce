"use client";

import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  FolderUp,
} from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type { EmployeeImportValidationResult } from "@/lib/imports/employee-import-types";

import {
  AdminCallout,
} from "@/components/admin/admin-design-system";

type DryRunResult = Pick<
  EmployeeImportValidationResult,
  | "totalRows"
  | "validRows"
  | "warningRows"
  | "failedRows"
  | "detectedColumns"
  | "missingRequiredColumns"
  | "duplicateHrIds"
  | "organizationEntitiesToCreate"
  | "organizationEntityCounts"
  | "orgMappingWarnings"
  | "sampleOrgMappings"
  | "rowsToInsert"
  | "rowsToUpdate"
  | "validationErrors"
  | "validationWarnings"
>;

type ConfirmImportResult = {
  importedEmployees: number;
  updatedEmployees: number;
  recordedVacancies: number;
  skippedVacantRows: number;
  createdDepartments: number;
  createdLines: number;
  createdAreas: number;
  createdPositions: number;
  createdVacancies?: number;
  updatedVacancies?: number;
  warnings: DryRunResult["validationWarnings"];
};

const confirmErrorMessages: Record<string, string> = {
  database_schema_not_ready:
    "Supabase schema is not ready. Run supabase/phoenix-schema.sql in the Supabase SQL editor.",
  supabase_env_missing:
    "Supabase environment variables are missing. Check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
  employee_import_confirm_failed:
    "Confirm import failed. Please review the server logs and try again.",
  employee_import_validation_failed:
    "Import validation failed. Fix the blocking errors and run the dry-run again.",
};

const entityLabels = {
  departments: "Departments",
  lines: "Lines",
  areas: "Areas",
  positions: "Positions",
  teams: "Teams",
};

const panelClassName =
  "rounded-3xl border border-[#D8E0EA] bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]";

function SummaryCard({
  label,
  value,
  variant = "neutral",
}: {
  label: string;
  value: number;
  variant?: "neutral" | "success" | "warning" | "danger";
}) {
  return (
    <Card className={`${panelClassName} relative overflow-hidden p-5 transition hover:-translate-y-0.5 hover:border-[#FDBA74] hover:bg-white hover:shadow-[0_22px_48px_rgba(15,23,42,0.10)]`}>
      <div className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full bg-orange-200/20 blur-2xl" />
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.22em] text-[#64748B]">
            {label}
          </p>
          <p className="mt-3 text-4xl font-black tracking-[-0.04em] text-[#0F172A]">
            {value}
          </p>
        </div>
        <Badge variant={variant}>Dry run</Badge>
      </div>
    </Card>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-6 text-[#64748B]">{children}</p>;
}

function StatusBanner({
  title,
  message,
  tone,
}: {
  title: string;
  message: string;
  tone: "danger" | "success";
}) {
  const isSuccess = tone === "success";

  return (
    <div
      className={`flex items-start gap-3 rounded-2xl border px-4 py-4 text-sm ${
        isSuccess
          ? "border-[#86EFAC] bg-[#F0FDF4] text-[#166534]"
          : "border-[#FCA5A5] bg-[#FEF2F2] text-[#B91C1C]"
      }`}
    >
      {isSuccess ? (
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
      ) : (
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
      )}
      <div>
        <p className="font-semibold">{title}</p>
        <p className="mt-1 leading-6">{message}</p>
      </div>
    </div>
  );
}

function IssueList({
  title,
  items,
  variant,
}: {
  title: string;
  items: DryRunResult["validationErrors"];
  variant: "warning" | "danger";
}) {
  return (
    <Card className={`${panelClassName} p-5`}>
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-bold text-[#0F172A]">{title}</h2>
        <Badge variant={variant}>{items.length}</Badge>
      </div>
      <div className="mt-5 space-y-3">
        {items.length === 0 ? (
          <EmptyState>No {title.toLowerCase()} found.</EmptyState>
        ) : (
          items.slice(0, 12).map((item, index) => (
            <div
              className="rounded-2xl border border-[#E2E8F0] bg-[#FCFDFE] p-4"
              key={`${item.code}-${item.rowNumber ?? "global"}-${index}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={variant}>{item.code}</Badge>
                {item.rowNumber ? (
                  <span className="text-xs font-medium text-[#64748B]">
                    Row {item.rowNumber}
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-sm leading-6 text-[#0F172A]">{item.message}</p>
            </div>
          ))
        )}
        {items.length > 12 ? (
          <p className="text-sm text-[#64748B]">Showing 12 of {items.length} items.</p>
        ) : null}
      </div>
    </Card>
  );
}

function OrganizationEntities({ result }: { result: DryRunResult }) {
  const totalEntities = Object.values(result.organizationEntitiesToCreate).reduce(
    (total, entities) => total + entities.length,
    0,
  );

  return (
    <Card className={`${panelClassName} p-5`}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-[#0F172A]">Organization entities to create</h2>
          <p className="mt-1 text-sm text-[#64748B]">
            New structure records inferred from the uploaded organogram.
          </p>
        </div>
        <Badge>{totalEntities}</Badge>
      </div>
      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {Object.entries(entityLabels).map(([type, label]) => {
          const entities =
            result.organizationEntitiesToCreate[
              type as keyof DryRunResult["organizationEntitiesToCreate"]
            ];

          return (
            <div
              className="rounded-2xl border border-[#E2E8F0] bg-[#FCFDFE] p-4"
              key={type}
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-[#0F172A]">{label}</p>
                <Badge>{entities.length}</Badge>
              </div>
              <div className="mt-4 space-y-2">
                {entities.length === 0 ? (
                  <EmptyState>None detected.</EmptyState>
                ) : (
                  entities.slice(0, 6).map((entity) => (
                    <div key={entity.code}>
                      <p className="truncate text-sm font-semibold text-[#0F172A]">
                        {entity.name}
                      </p>
                      <p className="truncate text-xs text-[#64748B]">{entity.code}</p>
                    </div>
                  ))
                )}
                {entities.length > 6 ? (
                  <p className="text-xs font-medium text-[#64748B]">
                    +{entities.length - 6} more
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function EmployeeImportUpload() {
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);
  const [result, setResult] = React.useState<DryRunResult | null>(null);
  const [confirmResult, setConfirmResult] =
    React.useState<ConfirmImportResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmError, setConfirmError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isConfirming, setIsConfirming] = React.useState(false);

  const hasImportBlockers = Boolean(
    result &&
      (result.failedRows > 0 ||
        result.missingRequiredColumns.length > 0 ||
        result.duplicateHrIds.length > 0),
  );
  const canConfirm =
    Boolean(selectedFile && result) &&
    !hasImportBlockers &&
    !isLoading &&
    !isConfirming;

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;

    setSelectedFile(file);
    setResult(null);
    setConfirmResult(null);
    setError(null);
    setConfirmError(null);

    if (!file) {
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    setIsLoading(true);

    try {
      const response = await fetch("/api/imports/employees/dry-run", {
        body: formData,
        method: "POST",
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "employee_import_dry_run_failed");
        return;
      }

      setResult(payload);
    } catch {
      setError("employee_import_dry_run_failed");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleConfirmImport() {
    if (!selectedFile || !result || hasImportBlockers) {
      return;
    }

    const formData = new FormData();
    formData.append("file", selectedFile);

    setIsConfirming(true);
    setConfirmError(null);
    setConfirmResult(null);

    try {
      const response = await fetch("/api/imports/employees/confirm", {
        body: formData,
        method: "POST",
      });
      const payload = await response.json();

      if (!response.ok) {
        const errorCode = payload.error ?? "employee_import_confirm_failed";
        setConfirmError(confirmErrorMessages[errorCode] ?? errorCode);
        return;
      }

      setConfirmResult(payload);
    } catch {
      setConfirmError("employee_import_confirm_failed");
    } finally {
      setIsConfirming(false);
    }
  }

  const previewStatusLabel = isLoading
    ? "Running dry run"
    : result
      ? "Preview ready"
      : error
        ? "Preview failed"
        : "Waiting for workbook";

  const previewStatusTone = isLoading
    ? "warning"
    : result
      ? "success"
      : error
        ? "danger"
        : "neutral";

  const importActionLabel = isConfirming ? "Importing..." : "Confirm import";

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-[#E2E8F0] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
      <Card className="relative overflow-hidden rounded-3xl border border-[#D8E0EA] bg-white/95 p-0 shadow-[0_20px_54px_rgba(15,23,42,0.09)]">
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-orange-200/35 blur-3xl" />
        <div className="pointer-events-none absolute bottom-0 left-12 h-28 w-28 rounded-full bg-slate-200/45 blur-2xl" />
        <div className="relative flex flex-col gap-5 p-7 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
              <span className="text-[11px] font-black uppercase tracking-[0.18em] text-orange-600">Bulk workforce import</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#0B0B0B] text-orange-400 shadow-[0_14px_30px_rgba(15,23,42,0.22)]">
                <FolderUp className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-3xl font-black tracking-tight text-slate-950">Employee Import</h1>
                <p className="mt-1 max-w-3xl text-sm text-slate-500">
                  Upload an HR workbook, validate it in dry-run, then confirm only when checks pass.
                </p>
              </div>
            </div>
          </div>
          <div className="grid w-full grid-cols-1 gap-2 sm:w-auto sm:min-w-[430px] sm:grid-cols-2">
              <Button
                className="h-10 gap-2 rounded-xl bg-[#0B0B0B] px-3 text-xs font-black text-white shadow-[0_12px_26px_rgba(15,23,42,0.18)] transition hover:bg-[#F97316]"
                disabled={!canConfirm}
                onClick={handleConfirmImport}
              >
                {isConfirming ? (
                  <>
                    <LoadingSpinner className="text-white" />
                    {importActionLabel}
                  </>
                ) : (
                  <>
                    {importActionLabel}
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
              <AdminCallout tone={hasImportBlockers ? "danger" : "success"}>
                <span className="text-xs">
                  {hasImportBlockers
                    ? "Resolve blocking issues before confirming"
                    : "No blocking issues. Ready to confirm."}
                </span>
              </AdminCallout>
            </div>
        </div>
        <div className="relative flex flex-wrap items-center gap-3 border-t border-[#E2E8F0] px-7 pb-5 pt-4 text-xs text-[#64748B]">
          <Badge variant={previewStatusTone}>{previewStatusLabel}</Badge>
          <span>{selectedFile?.name ?? "No file selected"}</span>
        </div>
      </Card>

      {error ? (
        <StatusBanner
          message={error}
          title="Dry-run error"
          tone="danger"
        />
      ) : null}

      {confirmError ? (
        <StatusBanner
          message={confirmError}
          title="Confirm import error"
          tone="danger"
        />
      ) : null}

      {confirmResult ? (
        <StatusBanner
          message={`${confirmResult.importedEmployees} imported, ${confirmResult.updatedEmployees} updated, ${confirmResult.recordedVacancies} vacancies recorded.`}
          title="Import completed"
          tone="success"
        />
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card className={`${panelClassName} p-0`}>
          <div className="grid gap-5 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-center">
            <label className="flex min-h-[300px] cursor-pointer flex-col items-center justify-center rounded-[28px] border border-dashed border-[#CBD5E1] bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] px-6 py-10 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition hover:border-[#FDBA74] hover:bg-[#FFF7ED]/50">
              <div className="rounded-3xl border border-[#FED7AA] bg-[#FFF7ED] p-5 text-[#F97316] shadow-[0_14px_30px_rgba(249,115,22,0.12)]">
                <FolderUp className="h-8 w-8" />
              </div>
              <span className="mt-5 text-2xl font-black tracking-[-0.04em] text-[#0F172A]">
                Upload employee Excel file
              </span>
              <span className="mt-2 max-w-md text-sm leading-6 text-[#64748B]">
                Supported formats: <span className="font-semibold text-[#0F172A]">.xlsx</span> and{" "}
                <span className="font-semibold text-[#0F172A]">.xls</span>. Selecting a new file resets the previous
                preview and confirm state.
              </span>
              <div className="mt-5 inline-flex items-center rounded-full border border-[#E2E8F0] bg-white px-4 py-2 text-sm font-black text-[#0F172A] shadow-sm">
                Choose workbook
              </div>
              <Input
                accept=".xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                onChange={handleFileChange}
                type="file"
              />
            </label>

            <div className="space-y-4 rounded-[24px] border border-[#E2E8F0] bg-[#FCFDFE] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#64748B]">Selected file</p>
                <p className="mt-2 break-words text-base font-semibold text-[#0F172A]">
                  {selectedFile?.name ?? "No file selected"}
                </p>
              </div>
              <div className="rounded-2xl border border-[#E2E8F0] bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2 text-sm font-semibold text-[#0F172A]">
                  {isLoading ? (
                    <>
                      <LoadingSpinner />
                      Running dry run...
                    </>
                  ) : result ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-[#16A34A]" />
                      Preview ready
                    </>
                  ) : error ? (
                    <>
                      <AlertCircle className="h-4 w-4 text-[#DC2626]" />
                      Preview failed
                    </>
                  ) : (
                    <>
                      <FolderUp className="h-4 w-4 text-[#F97316]" />
                      Waiting for upload
                    </>
                  )}
                </div>
                <p className="mt-2 text-sm leading-6 text-[#64748B]">
                  {result
                    ? "Review the generated summary below before confirming any database write."
                    : "The system will inspect detected columns, duplicates, warnings, and planned inserts or updates."}
                </p>
              </div>
              <div className="rounded-2xl border border-[#E2E8F0] bg-white p-4 shadow-sm">
                <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#64748B]">Import policy</p>
                <p className="mt-2 text-sm leading-6 text-[#64748B]">
                  Valid rows can be written only after a clean dry run. Rows without HR_ID are treated as vacancy
                  records for reporting.
                </p>
              </div>
            </div>
          </div>
        </Card>

        <Card className={`${panelClassName} h-fit p-5`}>
          <h2 className="flex items-center gap-2 text-base font-black text-[#0F172A]">
            <span className="h-2 w-2 rounded-full bg-[#F97316]" />
            What the dry run checks
          </h2>
          <div className="mt-4 space-y-4">
            <div className="rounded-2xl border border-[#E2E8F0] bg-[#FCFDFE] p-4">
              <p className="text-sm font-semibold text-[#0F172A]">Workbook structure</p>
              <p className="mt-1 text-sm leading-6 text-[#64748B]">
                Detects mapped columns and flags missing required fields before import.
              </p>
            </div>
            <div className="rounded-2xl border border-[#E2E8F0] bg-[#FCFDFE] p-4">
              <p className="text-sm font-semibold text-[#0F172A]">Identity hygiene</p>
              <p className="mt-1 text-sm leading-6 text-[#64748B]">
                Surfaces duplicate HR_ID values and row-level validation failures.
              </p>
            </div>
            <div className="rounded-2xl border border-[#E2E8F0] bg-[#FCFDFE] p-4">
              <p className="text-sm font-semibold text-[#0F172A]">Org structure impact</p>
              <p className="mt-1 text-sm leading-6 text-[#64748B]">
                Shows which departments, lines, areas, positions, and teams would be created.
              </p>
            </div>
          </div>
        </Card>
      </div>

      {result ? (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <SummaryCard label="Total rows" value={result.totalRows} />
            <SummaryCard label="Valid rows" value={result.validRows} variant="success" />
            <SummaryCard label="Warning rows" value={result.warningRows} variant="warning" />
            <SummaryCard label="Failed rows" value={result.failedRows} variant="danger" />
          </section>

          <section className="grid gap-5 lg:grid-cols-2">
            <Card className={`${panelClassName} p-5`}>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-bold text-[#0F172A]">Detected columns</h2>
                  <p className="mt-1 text-sm text-[#64748B]">
                    Columns recognized from the uploaded spreadsheet.
                  </p>
                </div>
                <Badge>{result.detectedColumns.length}</Badge>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                {result.detectedColumns.length === 0 ? (
                  <EmptyState>No known columns detected.</EmptyState>
                ) : (
                  result.detectedColumns.map((column) => (
                    <Badge key={column.field}>{column.sourceHeader}</Badge>
                  ))
                )}
              </div>
            </Card>

            <Card className={`${panelClassName} p-5`}>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-bold text-[#0F172A]">Missing required columns</h2>
                  <p className="mt-1 text-sm text-[#64748B]">
                    These columns must exist before the import can be confirmed.
                  </p>
                </div>
                <Badge
                  variant={result.missingRequiredColumns.length > 0 ? "danger" : "success"}
                >
                  {result.missingRequiredColumns.length}
                </Badge>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                {result.missingRequiredColumns.length === 0 ? (
                  <Badge variant="success">All required columns found</Badge>
                ) : (
                  result.missingRequiredColumns.map((column) => (
                    <Badge key={column} variant="danger">
                      {column}
                    </Badge>
                  ))
                )}
              </div>
            </Card>
          </section>

          <Card className={`${panelClassName} p-5`}>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-base font-bold text-[#0F172A]">Row action summary</h2>
                <p className="mt-1 text-sm leading-6 text-[#64748B]">
                  The dry run estimates how many employee records would be inserted or updated.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-[#E2E8F0] bg-[#FCFDFE] px-4 py-3">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#64748B]">To insert</p>
                  <p className="mt-2 text-2xl font-black text-[#0F172A]">{result.rowsToInsert.length}</p>
                </div>
                <div className="rounded-2xl border border-[#E2E8F0] bg-[#FCFDFE] px-4 py-3">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#64748B]">To update</p>
                  <p className="mt-2 text-2xl font-black text-[#0F172A]">{result.rowsToUpdate.length}</p>
                </div>
                <div className="rounded-2xl border border-[#E2E8F0] bg-[#FCFDFE] px-4 py-3">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#64748B]">Duplicates</p>
                  <p className="mt-2 text-2xl font-black text-[#0F172A]">{result.duplicateHrIds.length}</p>
                </div>
              </div>
            </div>
          </Card>

          <Card className={`${panelClassName} p-5`}>
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-[#0F172A]">Duplicate HR_IDs</h2>
                <p className="mt-1 text-sm text-[#64748B]">
                  Duplicate employee identities block confirmation until resolved.
                </p>
              </div>
              <Badge variant={result.duplicateHrIds.length > 0 ? "danger" : "success"}>
                {result.duplicateHrIds.length}
              </Badge>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              {result.duplicateHrIds.length === 0 ? (
                <Badge variant="success">No duplicates detected</Badge>
              ) : (
                result.duplicateHrIds.map((hrId) => (
                  <Badge key={hrId} variant="danger">
                    {hrId}
                  </Badge>
                ))
              )}
            </div>
          </Card>

          <OrganizationEntities result={result} />

          <section className="grid gap-5 lg:grid-cols-2">
            <IssueList items={result.validationErrors} title="Validation errors" variant="danger" />
            <IssueList items={result.validationWarnings} title="Validation warnings" variant="warning" />
          </section>

          <div className="grid gap-2 lg:grid-cols-2">
            <Card className={`${panelClassName} p-4`}>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-[#64748B]">Import execution notes</p>
              <p className="mt-2 text-sm leading-6 text-[#64748B]">
                Confirm writes validated employee master data and records rows without HR_ID as vacancies.
              </p>
            </Card>
            <AdminCallout tone={hasImportBlockers ? "danger" : "success"}>
              <span>
                {hasImportBlockers
                  ? "Blocking issues found. Fix and rerun dry-run."
                  : "Dry run passed. You can confirm this workbook."}
              </span>
            </AdminCallout>
          </div>
        </>
      ) : null}
      </div>
    </div>
  );
}
