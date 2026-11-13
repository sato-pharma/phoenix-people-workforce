"use client";

import { CheckCircle, FileCheck2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { buildExpenseAnalysis, ExpenseReport } from "@/components/outstation/expense-report";
import { payrollMonths } from "@/components/payroll/dashboard/shared";
import { formatCurrencyValue } from "@/lib/i18n/format";
import { hardNavigate } from "@/lib/navigation/browser-navigation";
import type {
  ExpenseAnalysisResult,
  ExpenseTripRecord,
  PayrollExpenseReport,
} from "@/lib/payroll/types";

function ExpensesReviewShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate min-h-[calc(100vh-8rem)] overflow-hidden rounded-[34px] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_32%),linear-gradient(135deg,#FFF9F3_0%,#FFFFFF_44%,#F7FAFC_100%)] p-4 shadow-[0_24px_70px_rgba(15,23,42,0.1)] sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-phx-accent/12 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-10 left-1/3 h-64 w-64 rounded-full bg-phx-ink/6 blur-3xl"
      />
      <div className="relative z-10 space-y-6">{children}</div>
    </div>
  );
}

async function readExpensesApiPayload(response: Response) {
  const text = await response.text();
  if (!text.trim()) return {};

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? parsed
      : { message: String(parsed ?? "") };
  } catch {
    const status = `${response.status} ${response.statusText}`.trim();
    const compactBody = text
      .replace(/<script[\s\S]*?<\/script[^>]*>/gi, " ")
      .replace(/<style[\s\S]*?<\/style[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 260);
    const redirectedMessage = response.redirected
      ? " The request was redirected, so your session may need a refresh."
      : "";

    return {
      error: "non_json_response",
      message: compactBody
        ? `Outstation expenses API returned a non-JSON response (${status}).${redirectedMessage} ${compactBody}`
        : `Outstation expenses API returned an empty or unreadable response (${status}).${redirectedMessage}`,
    };
  }
}

function expensesPayloadMessage(payload: { error?: unknown; message?: unknown }, fallback: string) {
  if (typeof payload.message === "string" && payload.message.trim()) return payload.message;
  if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
  return fallback;
}

function expensesRequestErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return `${fallback} ${error.message}`;
  }

  return fallback;
}

function formatEGP(value: number) {
  return formatCurrencyValue(Number.isFinite(value) ? value : 0);
}

export function ExpensesReviewWorkspace() {
  const currentYear = new Date().getFullYear();
  const payrollYears = Array.from({ length: 7 }, (_, index) =>
    String(currentYear - 3 + index),
  );

  const [expenseAnalysis, setExpenseAnalysis] = useState<ExpenseAnalysisResult | null>(null);
  const [expenseAnalysisError, setExpenseAnalysisError] = useState<string | null>(null);
  const [expenseReports, setExpenseReports] = useState<PayrollExpenseReport[]>([]);
  const [selectedExpenseReportId, setSelectedExpenseReportId] = useState<string | null>(null);
  const [expenseAnalyzing, setExpenseAnalyzing] = useState(false);
  const [expenseApprovalsSaving, setExpenseApprovalsSaving] = useState(false);
  const [deletingExpenseReportId, setDeletingExpenseReportId] = useState<string | null>(null);
  const [expenseImportingToPayroll, setExpenseImportingToPayroll] = useState(false);
  const [replacingExpenseReportId, setReplacingExpenseReportId] = useState<string | null>(null);
  const [expenseApprovalMessage, setExpenseApprovalMessage] = useState<string | null>(null);
  const expenseFileInputRef = useRef<HTMLInputElement | null>(null);

  const loadSavedExpenseReport = useCallback(async (reportId?: string) => {
    const query = reportId ? `?reportId=${encodeURIComponent(reportId)}` : "";
    const response = await fetch(`/api/admin/outstation/expenses${query}`);
    const payload = await readExpensesApiPayload(response);

    if (!response.ok) return;

    const reports = Array.isArray(payload.reports)
      ? (payload.reports as PayrollExpenseReport[])
      : [];
    const targetReportId = reportId ?? null;
    const savedRecords = Array.isArray(payload.expenses)
      ? (payload.expenses as ExpenseTripRecord[])
      : [];

    setExpenseReports(reports);
    setSelectedExpenseReportId(targetReportId);

    if (savedRecords.length > 0) {
      const reportName =
        reports.find((report) => report.id === targetReportId)?.fileName ??
        "Unified outstation expenses";
      setExpenseAnalysis(buildExpenseAnalysis(reportName, savedRecords));
    } else if (targetReportId) {
      setExpenseAnalysis(buildExpenseAnalysis("Saved outstation expenses", []));
    }
  }, []);

  useEffect(() => {
    if (expenseAnalysis || expenseAnalyzing) return;

    async function loadSavedExpenses() {
      try {
        await loadSavedExpenseReport();
      } catch {
        // Keep the upload flow usable if saved expenses cannot be loaded.
      }
    }

    void loadSavedExpenses();
  }, [expenseAnalysis, expenseAnalyzing, loadSavedExpenseReport]);

  async function handleDeleteExpenseReport(reportId: string) {
    const report = expenseReports.find((item) => item.id === reportId);
    const confirmed = window.confirm(
      `Delete historical outstation upload "${report?.fileName ?? reportId}"? This removes the saved report and all expense rows inside it.`,
    );

    if (!confirmed) return;

    setDeletingExpenseReportId(reportId);
    setExpenseAnalysisError(null);
    setExpenseApprovalMessage(null);

    try {
      const response = await fetch(`/api/admin/outstation/expenses/reports/${reportId}`, {
        method: "DELETE",
      });
      const payload = await readExpensesApiPayload(response);

      if (!response.ok || !payload.success) {
        setExpenseAnalysisError(expensesPayloadMessage(payload, "Unable to delete expense report."));
        return;
      }

      if (selectedExpenseReportId === reportId) {
        setExpenseAnalysis(null);
        setSelectedExpenseReportId(null);
      }

      setExpenseApprovalMessage("Historical outstation upload deleted.");
      await loadSavedExpenseReport(
        selectedExpenseReportId === reportId ? undefined : selectedExpenseReportId ?? undefined,
      );
    } catch (error) {
      setExpenseAnalysisError(expensesRequestErrorMessage(error, "Unable to delete expense report."));
    } finally {
      setDeletingExpenseReportId(null);
    }
  }

  async function handleReplaceExpenseReport(reportId: string, file: File | null) {
    if (!reportId || !file) return;

    const report = expenseReports.find((item) => item.id === reportId);
    const confirmed = window.confirm(
      `Replace historical outstation upload "${report?.fileName ?? reportId}" with this file? Existing rows in this report will be removed.`,
    );

    if (!confirmed) return;

    setReplacingExpenseReportId(reportId);
    setExpenseAnalysisError(null);
    setExpenseApprovalMessage(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`/api/admin/outstation/expenses/reports/${reportId}`, {
        body: formData,
        method: "PUT",
      });
      const payload = await readExpensesApiPayload(response);

      if (!response.ok) {
        if (Array.isArray(payload.records) && payload.validation) {
          setExpenseAnalysis(payload as ExpenseAnalysisResult);
        }
        setExpenseAnalysisError(expensesPayloadMessage(payload, "Unable to replace expense report."));
        return;
      }

      setExpenseApprovalMessage(
        `${payload.saved ?? 0} outstation expense rows replaced and saved to the report.`,
      );
      await loadSavedExpenseReport(reportId);
    } catch (error) {
      setExpenseAnalysisError(expensesRequestErrorMessage(error, "Unable to replace expense report."));
    } finally {
      setReplacingExpenseReportId(null);
    }
  }

  async function handleExpenseUpload(file: File | null) {
    if (!file) return;

    setExpenseAnalyzing(true);
    setExpenseAnalysisError(null);
    setExpenseApprovalMessage(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/admin/outstation/expenses/analyze", {
        body: formData,
        method: "POST",
      });
      const payload = await readExpensesApiPayload(response);

      if (!response.ok) {
        if (Array.isArray(payload.records) && payload.validation) {
          setExpenseAnalysis(payload as ExpenseAnalysisResult);
        }
        setExpenseAnalysisError(
          payload.error === "payroll_expenses_schema_not_ready"
            ? "Outstation expenses table is not ready. Run supabase/scripts/phoenix-payroll-expenses.sql first."
            : expensesPayloadMessage(payload, "Outstation expenses upload failed."),
        );
        return;
      }

      setExpenseAnalysis(payload as ExpenseAnalysisResult);
      const uploadedReportId = Array.isArray(payload.records)
        ? (payload.records.find((record: { reportId?: string | null }) => record.reportId)?.reportId ?? null)
        : null;
      if (uploadedReportId) {
        await loadSavedExpenseReport(uploadedReportId);
      }
      setExpenseApprovalMessage(
        `${payload.saved ?? (payload.records?.length ?? 0)} historical outstation expense rows uploaded and saved to the system. Review HR approvals, then import approved expenses to payroll.`,
      );
    } catch (error) {
      setExpenseAnalysisError(expensesRequestErrorMessage(error, "Unable to upload outstation expenses file."));
    } finally {
      setExpenseAnalyzing(false);
      if (expenseFileInputRef.current) expenseFileInputRef.current.value = "";
    }
  }

  async function handleSaveExpenseApprovals(
    recordsToSave: Array<
      ExpenseTripRecord & { approvedAmount: number; hrApproved: boolean; hrComment: string }
    >,
  ) {
    // A refused upload's rows stay on screen so HR can read what to fix, but they were never
    // imported and are never saved from here: this route would mint them a new report, and any app
    // trip among them would be re-decided with the sheet's defaults (owner, 2026-09-21: the WHOLE
    // sheet is refused).
    if (!expenseAnalysis || expenseAnalysis.validation?.status === "failed") return;

    setExpenseApprovalsSaving(true);
    setExpenseAnalysisError(null);
    setExpenseApprovalMessage(null);

    try {
      const response = await fetch("/api/admin/outstation/expenses", {
        body: JSON.stringify({
          fileName: expenseAnalysis.fileName,
          records: recordsToSave,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await readExpensesApiPayload(response);

      if (!response.ok) {
        setExpenseAnalysisError(
          payload.error === "payroll_expenses_schema_not_ready"
            ? "Outstation expenses table is not ready. Run supabase/scripts/phoenix-payroll-expenses.sql first."
            : expensesPayloadMessage(payload, "Unable to save outstation expense approvals."),
        );
        return;
      }

      const approvedTotal = recordsToSave
        .filter((record) => record.hrApproved)
        .reduce((sum, record) => sum + record.total, 0);

      setExpenseApprovalMessage(
        `${payload.saved ?? recordsToSave.length} outstation expense rows saved. Approved total ${formatEGP(approvedTotal)} is ready for payroll import after manual HR/admin approval is saved.`,
      );
    } catch (error) {
      setExpenseAnalysisError(expensesRequestErrorMessage(error, "Unable to save outstation expense approvals."));
    } finally {
      setExpenseApprovalsSaving(false);
    }
  }

  async function handleImportExpensesToPayroll(month: number, year: number) {
    if (!expenseAnalysis) return;

    setExpenseImportingToPayroll(true);
    setExpenseAnalysisError(null);
    setExpenseApprovalMessage(null);

    try {
      const response = await fetch("/api/admin/outstation/expenses/import", {
        body: JSON.stringify({
          fileName: expenseAnalysis.fileName,
          month,
          year,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await readExpensesApiPayload(response);

      if (!response.ok) {
        setExpenseAnalysisError(
          payload.error === "payroll_expenses_schema_not_ready"
            ? "Outstation expenses table is not ready. Run supabase/scripts/phoenix-payroll-expenses.sql first."
            : expensesPayloadMessage(payload, "Unable to import outstation expenses to payroll."),
        );
        return;
      }

      if (!payload.targetBatch) {
        setExpenseAnalysisError(`No payroll sheet found for ${month}/${year}. Upload that payroll first, then import outstation expenses.`);
        return;
      }

      // The carried-forward and stranded figures are named separately rather than folded into the
      // one total. An expense approved in an earlier month is paid here because its own month can
      // no longer be reopened — but it is not this month's spend, and anyone reconciling payroll
      // needs to see which is which. Stranded money is money that still could not be paid at all.
      const carriedForward = payload.carriedForwardTotal ?? 0;
      const stranded = payload.strandedTotal ?? 0;
      setExpenseApprovalMessage(
        [
          `${payload.importedEmployees ?? 0} employees updated in payroll ${month}/${year}.`,
          `Imported approved outstation expenses ${formatEGP(payload.importedTotal ?? 0)}.`,
          carriedForward > 0
            ? `Of that, ${formatEGP(carriedForward)} was carried forward from earlier months (${payload.carriedForwardRows ?? 0} claims).`
            : "",
          stranded > 0
            ? `${formatEGP(stranded)} still could not be paid — ${payload.strandedEmployees ?? 0} employees are not in this payroll.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      window.setTimeout(() => {
        hardNavigate(`/payroll?batchId=${payload.targetBatch.id}`);
      }, 700);
    } catch (error) {
      setExpenseAnalysisError(expensesRequestErrorMessage(error, "Unable to import outstation expenses to payroll."));
    } finally {
      setExpenseImportingToPayroll(false);
    }
  }

  return (
    <ExpensesReviewShell>
      <AdminPageHero
        description="Review approved outstation expense rows, confirm HR approvals, and import selected rows into the selected payroll period."
        eyebrow="Outstation expenses"
        icon={<FileCheck2 className="h-3.5 w-3.5" />}
        title="Outstation expenses operations"
      />

      {expenseApprovalMessage && (
        <AdminCallout tone="success">
          <CheckCircle className="mt-0.5 h-4 w-4 text-success" />
          <p className="text-sm text-[#166534]">{expenseApprovalMessage}</p>
        </AdminCallout>
      )}

      <ExpenseReport
        analysis={expenseAnalysis}
        analyzing={expenseAnalyzing}
        deletingReportId={deletingExpenseReportId}
        error={expenseAnalysisError}
        importingToPayroll={expenseImportingToPayroll}
        inputRef={expenseFileInputRef}
        onDeleteReport={(reportId) => void handleDeleteExpenseReport(reportId)}
        onImportToPayroll={(month, year) => void handleImportExpensesToPayroll(month, year)}
        onReplaceReport={(reportId, file) => void handleReplaceExpenseReport(reportId, file)}
        onSelectReport={(reportId) => {
          void loadSavedExpenseReport(reportId);
        }}
        onSaveApprovals={(recordsToSave) => void handleSaveExpenseApprovals(recordsToSave)}
        onUpload={(file) => void handleExpenseUpload(file)}
        payrollMonthsForImport={payrollMonths}
        payrollYearsForImport={payrollYears}
        replacingReportId={replacingExpenseReportId}
        reports={expenseReports}
        selectedReportId={selectedExpenseReportId}
        savingApprovals={expenseApprovalsSaving}
      />
    </ExpensesReviewShell>
  );
}
