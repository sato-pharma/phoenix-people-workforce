"use client";

import { AlertCircle, CheckCircle2, FileSpreadsheet, Loader2 } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { EmployeeImportValidationResult } from "@/lib/imports/employee-import-types";

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
  | "rowsToInsert"
  | "rowsToUpdate"
  | "validationErrors"
  | "validationWarnings"
>;

const entityLabels = {
  department: "Departments",
  line: "Lines",
  area: "Areas",
  team: "Teams",
  position: "Positions",
};

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
    <Card>
      <p className="text-sm font-medium text-text-secondary">{label}</p>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-text">
        {value}
      </p>
      <Badge className="mt-4" variant={variant}>
        Dry run
      </Badge>
    </Card>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-text-secondary">{children}</p>;
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
    <Card>
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-text">{title}</h2>
        <Badge variant={variant}>{items.length}</Badge>
      </div>
      <div className="mt-5 space-y-3">
        {items.length === 0 ? (
          <EmptyState>No {title.toLowerCase()} found.</EmptyState>
        ) : (
          items.slice(0, 12).map((item, index) => (
            <div
              className="rounded-lg border border-border bg-bg-soft p-3"
              key={`${item.code}-${item.rowNumber ?? "global"}-${index}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={variant}>{item.code}</Badge>
                {item.rowNumber ? (
                  <span className="text-xs text-text-secondary">
                    Row {item.rowNumber}
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-sm text-text">{item.message}</p>
            </div>
          ))
        )}
        {items.length > 12 ? (
          <p className="text-sm text-text-secondary">
            Showing 12 of {items.length} items.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function OrganizationEntities({ result }: { result: DryRunResult }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-text">
          Organization Entities To Create
        </h2>
        <Badge>{result.organizationEntitiesToCreate.length}</Badge>
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-5">
        {Object.entries(entityLabels).map(([type, label]) => {
          const entities = result.organizationEntitiesToCreate.filter(
            (entity) => entity.type === type,
          );

          return (
            <div
              className="rounded-lg border border-border bg-bg-soft p-4"
              key={type}
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-text">{label}</p>
                <Badge>{entities.length}</Badge>
              </div>
              <div className="mt-4 space-y-2">
                {entities.length === 0 ? (
                  <EmptyState>None detected.</EmptyState>
                ) : (
                  entities.slice(0, 6).map((entity) => (
                    <div key={entity.code}>
                      <p className="truncate text-sm font-medium text-text">
                        {entity.name}
                      </p>
                      <p className="truncate text-xs text-text-secondary">
                        {entity.code}
                      </p>
                    </div>
                  ))
                )}
                {entities.length > 6 ? (
                  <p className="text-xs text-text-secondary">
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
  const [error, setError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;

    setSelectedFile(file);
    setResult(null);
    setError(null);

    if (!file) {
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    setIsLoading(true);

    try {
      const response = await fetch("/api/imports/employees/dry-run", {
        method: "POST",
        body: formData,
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-primary">
            Phoenix Workforce
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-text">
            Employee Master Data Import
          </h1>
          <p className="mt-2 max-w-2xl text-base text-text-secondary">
            Upload an Excel HR organogram to preview validation, detected
            columns, and organization entities before any database import.
          </p>
        </div>
        <Button disabled>Confirm Import</Button>
      </div>

      <Card>
        <div className="grid gap-5 lg:grid-cols-[1fr_280px] lg:items-center">
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-border bg-bg-soft px-6 py-10 text-center transition hover:border-primary/50">
            <FileSpreadsheet className="h-10 w-10 text-primary" />
            <span className="mt-4 text-base font-semibold text-text">
              Upload employee Excel file
            </span>
            <span className="mt-2 text-sm text-text-secondary">
              Supported formats: .xlsx and .xls
            </span>
            <Input
              accept=".xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              onChange={handleFileChange}
              type="file"
            />
          </label>
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-sm font-medium text-text">Selected file</p>
            <p className="mt-2 truncate text-sm text-text-secondary">
              {selectedFile?.name ?? "No file selected"}
            </p>
            <div className="mt-4 flex items-center gap-2 text-sm text-text-secondary">
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  Running dry-run...
                </>
              ) : result ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-success" />
                  Preview ready
                </>
              ) : error ? (
                <>
                  <AlertCircle className="h-4 w-4 text-danger" />
                  Preview failed
                </>
              ) : (
                "Waiting for upload"
              )}
            </div>
          </div>
        </div>
      </Card>

      {error ? (
        <Card className="border-danger/30">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-danger" />
            <div>
              <h2 className="text-base font-semibold text-text">
                Dry-run error
              </h2>
              <p className="mt-1 text-sm text-text-secondary">{error}</p>
            </div>
          </div>
        </Card>
      ) : null}

      {result ? (
        <>
          <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            <SummaryCard label="Total Rows" value={result.totalRows} />
            <SummaryCard
              label="Valid Rows"
              value={result.validRows}
              variant="success"
            />
            <SummaryCard
              label="Warning Rows"
              value={result.warningRows}
              variant="warning"
            />
            <SummaryCard
              label="Failed Rows"
              value={result.failedRows}
              variant="danger"
            />
          </section>

          <section className="grid gap-5 lg:grid-cols-2">
            <Card>
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-base font-semibold text-text">
                  Detected Columns
                </h2>
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

            <Card>
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-base font-semibold text-text">
                  Missing Required Columns
                </h2>
                <Badge
                  variant={
                    result.missingRequiredColumns.length > 0
                      ? "danger"
                      : "success"
                  }
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

          <Card>
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-base font-semibold text-text">
                Duplicate HR_IDs
              </h2>
              <Badge
                variant={result.duplicateHrIds.length > 0 ? "danger" : "success"}
              >
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
            <IssueList
              items={result.validationErrors}
              title="Validation Errors"
              variant="danger"
            />
            <IssueList
              items={result.validationWarnings}
              title="Validation Warnings"
              variant="warning"
            />
          </section>

          <Card>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-base font-semibold text-text">
                  Import Action
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  Database insertion is intentionally disabled until the import
                  workflow is approved.
                </p>
              </div>
              <Button disabled>Confirm Import</Button>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
