"use client";

import { AlertTriangle, CheckCircle2, RefreshCw, UserMinus, X } from "lucide-react";
import * as React from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
} from "@/components/admin/admin-design-system";
import { adminPanelClassName } from "@/components/admin/admin-design-tokens";
import { PortalMetricCard } from "@/components/employee-portal/portal-primitives";
import { Button } from "@/components/ui/button";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { ResignationCreateForm } from "@/components/resignations/resignation-create-form";
import { ResignationFilters } from "@/components/resignations/resignation-filters";
import {
  ResignationOverduePanel,
  type OverdueCloseProgress,
  type OverdueCloseResult,
} from "@/components/resignations/resignation-overdue-panel";
import { ResignationRejectDialog } from "@/components/resignations/resignation-reject-dialog";
import { ResignationWorkflowQueue } from "@/components/resignations/resignation-workflow-queue";
import type { ResignationDateEdit } from "@/components/resignations/resignation-workflow-actions";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import {
  buildResignationExportRows,
  buildResignationQueueRows,
  defaultResignationFilters,
  filterPayrollCandidates,
  filterResignationRecords,
  payrollCandidatesVisible,
  resignationExportColumns,
  resignationLineOptions,
  selectOverdueResignations,
  type ResignationFilters as ResignationFilterState,
} from "@/lib/resignations/view-model";
import type {
  CreateResignationInput,
  ResignationDashboardData,
  ResignationRecord,
  ResignationWorkflowAction,
} from "@/lib/resignations/types";

type Props = {
  initialData: ResignationDashboardData | null;
  initialError: string | null;
  /**
   * Which shell this workspace is mounted in. Two pages render it: the admin route, which owns
   * its own hero and panel frame, and the Talent Acquisition portal tab, whose
   * EmployeePortalPageShell already supplies a header — so "portal" suppresses both and uses the
   * portal's own metric cards.
   */
  surface?: "admin" | "portal";
};

const emptySummary = {
  active: 0,
  approved: 0,
  completed: 0,
  payrollCandidates: 0,
  pending: 0,
  total: 0,
};

/**
 * Page frame. Matches the sibling Contract Renewal workspace: the shared admin panel token, not a
 * bespoke gradient. The admin shell owns corners, table headers and cell hairlines globally
 * (see the LOCKED rules in app/globals.css), so nothing here restates them.
 */
function ResignationsPageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      <div className={adminPanelClassName}>
        <div className="relative space-y-4 p-4 sm:p-5">{children}</div>
      </div>
    </div>
  );
}

function emptyForm(): CreateResignationInput {
  return {
    effectiveDate: "",
    employeeHrId: "",
    reason: "",
    // Cairo, never the UTC slice — between midnight and ~2am Cairo the two disagree and the form
    // would silently default to yesterday.
    submittedDate: currentCairoDateOnlyIso(),
    workflowNotes: "",
  };
}

export function ResignationsWorkspace({ initialData, initialError, surface = "admin" }: Props) {
  const [data, setData] = React.useState<ResignationDashboardData | null>(initialData);
  const [error, setError] = React.useState<string | null>(initialError);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [filters, setFilters] = React.useState<ResignationFilterState>(defaultResignationFilters);
  const [form, setForm] = React.useState<CreateResignationInput>(emptyForm);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [editingDates, setEditingDates] = React.useState<ResignationDateEdit | null>(null);
  const [rejectTarget, setRejectTarget] = React.useState<ResignationRecord | null>(null);
  const [overdueBusy, setOverdueBusy] = React.useState(false);
  const [overdueProgress, setOverdueProgress] = React.useState<OverdueCloseProgress | null>(null);
  const [overdueResult, setOverdueResult] = React.useState<OverdueCloseResult | null>(null);

  const records = React.useMemo(() => data?.records ?? [], [data]);
  const payrollCandidates = React.useMemo(() => data?.payrollCandidates ?? [], [data]);
  const employees = React.useMemo(() => data?.employees ?? [], [data]);
  const summary = data?.summary ?? emptySummary;

  const lineOptions = React.useMemo(
    () => resignationLineOptions(records, payrollCandidates),
    [payrollCandidates, records],
  );
  const filteredRecords = React.useMemo(
    () => filterResignationRecords(records, filters),
    [filters, records],
  );
  const filteredCandidates = React.useMemo(
    () => filterPayrollCandidates(payrollCandidates, filters),
    [filters, payrollCandidates],
  );
  const queueRows = React.useMemo(
    () => buildResignationQueueRows(filteredRecords, filteredCandidates, filters),
    [filteredCandidates, filteredRecords, filters],
  );
  // Open records whose effective date has already passed. Replaces the old "Approved" tile, which
  // was mathematically identical to "Active" whenever nothing was pending — on production both
  // read 13. This number is the one that actually needs a human.
  const overdueRecords = React.useMemo(() => selectOverdueResignations(records), [records]);
  const overdueCount = overdueRecords.length;
  const exportRows = React.useMemo(
    () =>
      buildResignationExportRows(
        filteredRecords,
        payrollCandidatesVisible(filters) ? filteredCandidates : [],
      ),
    [filteredCandidates, filteredRecords, filters],
  );

  async function loadDashboard() {
    setIsRefreshing(true);
    setError(null);
    try {
      const response = await fetch("/api/resignations", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "resignations_load_failed");
        return;
      }
      setData(payload);
      setNotice(null);
    } catch {
      setError("Unable to load resignations.");
    } finally {
      setIsRefreshing(false);
    }
  }

  async function submitResignation() {
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/resignations", {
        body: JSON.stringify({ resignation: form }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "resignation_create_failed");
        return;
      }
      setData(payload);
      setForm(emptyForm());
      setNotice("Resignation workflow created.");
    } catch {
      setError("Unable to create resignation workflow.");
    } finally {
      setIsSaving(false);
    }
  }

  async function runAction(
    record: ResignationRecord,
    action: ResignationWorkflowAction,
    options?: { note?: string; rejectedReason?: string },
  ) {
    setBusyAction(`${record.id}:${action}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/resignations/${encodeURIComponent(record.id)}/workflow`, {
        body: JSON.stringify({
          action,
          note: options?.note,
          rejectedReason: options?.rejectedReason,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "workflow action failed");
        return;
      }
      setData(payload.dashboard);
      setNotice(`Resignation moved to ${payload.data.status.replace(/_/g, " ")}.`);
    } catch {
      setError("Unable to update resignation workflow.");
    } finally {
      setBusyAction(null);
    }
  }

  /**
   * Runs Complete over the chosen overdue records ONE AT A TIME against the existing per-record
   * workflow endpoint. Sequential on purpose: every call re-reads the row and writes under the
   * optimistic-concurrency CAS on updated_at, so firing them in parallel would make them race each
   * other and report spurious "updated by another user" failures. A failure on one record is
   * recorded and the run continues — a half-finished batch must still tell you exactly which ones
   * landed.
   */
  async function closeOverdueResignations(targets: ResignationRecord[]) {
    if (targets.length === 0) return;

    setOverdueBusy(true);
    setOverdueResult(null);
    setError(null);
    setNotice(null);

    const failures: Array<{ name: string; reason: string }> = [];
    let closed = 0;
    let latestDashboard: ResignationDashboardData | null = null;

    for (const [index, record] of targets.entries()) {
      setOverdueProgress({ done: index, label: record.employeeName, total: targets.length });
      try {
        const response = await fetch(
          `/api/resignations/${encodeURIComponent(record.id)}/workflow`,
          {
            body: JSON.stringify({
              action: "complete",
              note: "Closed from the overdue reconciliation list.",
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        const payload = await response.json();
        if (!response.ok) {
          failures.push({
            name: record.employeeName,
            reason: payload.error ?? `HTTP ${response.status}`,
          });
          continue;
        }
        closed += 1;
        latestDashboard = payload.dashboard ?? latestDashboard;
      } catch {
        failures.push({ name: record.employeeName, reason: "request failed" });
      }
    }

    setOverdueProgress(null);
    setOverdueBusy(false);
    setOverdueResult({ closed, failures });

    if (latestDashboard) setData(latestDashboard);
    else await loadDashboard();
  }

  function startDateEdit(record: ResignationRecord) {
    setEditingDates({
      effectiveDate: record.effectiveDate,
      recordId: record.id,
      submittedDate: record.submittedDate,
    });
    setError(null);
    setNotice(null);
  }

  function updateEditingDate(key: "effectiveDate" | "submittedDate", value: string) {
    setEditingDates((current) => (current ? { ...current, [key]: value } : current));
  }

  async function saveDateEdit(record: ResignationRecord) {
    if (!editingDates || editingDates.recordId !== record.id) return;
    if (!editingDates.submittedDate || !editingDates.effectiveDate) {
      setError("Both resignation dates are required.");
      return;
    }

    setBusyAction(`${record.id}:dates`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/resignations/${encodeURIComponent(record.id)}/dates`, {
        body: JSON.stringify({
          dates: {
            effectiveDate: editingDates.effectiveDate,
            submittedDate: editingDates.submittedDate,
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "resignation_dates_update_failed");
        return;
      }
      setData(payload.dashboard);
      setEditingDates(null);
      setNotice("Resignation dates updated.");
    } catch {
      setError("Unable to update resignation dates.");
    } finally {
      setBusyAction(null);
    }
  }

  const actionHandlers = {
    busyAction,
    editingDates,
    onCancelDateEdit: () => setEditingDates(null),
    onRequestReject: (record: ResignationRecord) => setRejectTarget(record),
    onRunAction: runAction,
    onSaveDateEdit: saveDateEdit,
    onStartDateEdit: startDateEdit,
    onUpdateEditingDate: updateEditingDate,
  };

  const headerActions = (
    <div className="flex flex-wrap gap-2">
      <ExportXlsxButton
        columns={resignationExportColumns}
        rows={exportRows}
        sheetName="Resignations"
        subtitle="Resignation workflows and payroll upload candidates"
        title="Resignations Report"
      />
      <Button
        className="h-9 gap-2"
        disabled={isRefreshing}
        onClick={() => void loadDashboard()}
        variant="secondary"
      >
        <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
        Refresh
      </Button>
    </div>
  );

  const headerChips = (
    <div className="flex flex-wrap gap-2">
      <AdminInsightChip surface={surface === "portal" ? "light" : undefined}>
        Total {summary.total}
      </AdminInsightChip>
      <AdminInsightChip surface={surface === "portal" ? "light" : undefined} tone="orange">
        {summary.pending} pending
      </AdminInsightChip>
      <AdminInsightChip surface={surface === "portal" ? "light" : undefined} tone="slate">
        {summary.payrollCandidates} payroll candidates
      </AdminInsightChip>
      <AdminInsightChip surface={surface === "portal" ? "light" : undefined} tone="slate">
        {summary.active} active
      </AdminInsightChip>
      {overdueCount > 0 ? (
        <AdminInsightChip surface={surface === "portal" ? "light" : undefined} tone="orange">
          {overdueCount} overdue
        </AdminInsightChip>
      ) : null}
      <AdminInsightChip surface={surface === "portal" ? "light" : undefined}>
        {summary.completed} completed
      </AdminInsightChip>
    </div>
  );

  // The portal gets portal metric cards; the admin shell gets admin stat cards. Same six numbers,
  // each surface's own primitive.
  const statTiles =
    surface === "portal" ? (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <PortalMetricCard icon={UserMinus} label="Total" note="All records" value={summary.total} />
        <PortalMetricCard
          accent="amber"
          icon={RefreshCw}
          label="Pending"
          note="Awaiting action"
          value={summary.pending}
        />
        <PortalMetricCard
          accent="sky"
          icon={AlertTriangle}
          label="Active"
          note="Open workflows"
          value={summary.active}
        />
        <PortalMetricCard
          accent="rose"
          icon={AlertTriangle}
          label="Overdue"
          note="Left, never completed"
          value={overdueCount}
        />
        <PortalMetricCard
          accent="slate"
          icon={AlertTriangle}
          label="Payroll Candidates"
          note="Missing from directory"
          value={summary.payrollCandidates}
        />
        <PortalMetricCard
          accent="emerald"
          icon={CheckCircle2}
          label="Completed"
          note="Closed"
          value={summary.completed}
        />
      </div>
    ) : (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <AdminStatCard
          description="All resignation records in dashboard"
          icon={<UserMinus className="h-5 w-5" />}
          label="Total"
          value={summary.total}
        />
        <AdminStatCard
          description="Awaiting review or action"
          icon={<RefreshCw className="h-5 w-5" />}
          label="Pending"
          value={summary.pending}
        />
        <AdminStatCard
          description="Submitted, under review, or approved"
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Active"
          value={summary.active}
        />
        <AdminStatCard
          description="Left already, but nobody ran Complete"
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Overdue"
          tone="rose"
          value={overdueCount}
        />
        <AdminStatCard
          description="Payroll rows missing from employee directory"
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Payroll Candidates"
          value={summary.payrollCandidates}
        />
        <AdminStatCard
          description="Closed after finalization"
          icon={<X className="h-5 w-5" />}
          label="Completed"
          value={summary.completed}
        />
      </div>
    );

  const body = (
    <>
      {error ? (
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-[#B91C1C]" />
          <div>
            <h2 className="text-sm font-bold text-[#B91C1C]">Resignations unavailable</h2>
            <p className="mt-1 text-sm text-[#991B1B]">{error}</p>
          </div>
        </AdminCallout>
      ) : null}

      {notice ? (
        <AdminCallout tone="success">
          <CheckCircle2 className="mt-0.5 h-5 w-5 text-[#166534]" />
          <div>
            <h2 className="text-sm font-bold text-[#166534]">Workflow update</h2>
            <p className="mt-1 text-sm text-[#166534]">{notice}</p>
          </div>
        </AdminCallout>
      ) : null}

      {statTiles}

      <ResignationOverduePanel
        busy={overdueBusy}
        onCloseOverdue={closeOverdueResignations}
        progress={overdueProgress}
        records={overdueRecords}
        result={overdueResult}
      />

      <ResignationCreateForm
        employees={employees}
        form={form}
        isSaving={isSaving}
        onChange={(key, value) => setForm((current) => ({ ...current, [key]: value }))}
        onSubmit={() => void submitResignation()}
      />

      <ResignationFilters
        filters={filters}
        lineOptions={lineOptions}
        onChange={setFilters}
        onClear={() => setFilters(defaultResignationFilters)}
      />

      <ResignationWorkflowQueue rows={queueRows} {...actionHandlers} />

      {rejectTarget ? (
        <ResignationRejectDialog
          busy={Boolean(busyAction?.startsWith(`${rejectTarget.id}:`))}
          onCancel={() => setRejectTarget(null)}
          onConfirm={(rejectedReason) => {
            const target = rejectTarget;
            setRejectTarget(null);
            void runAction(target, "reject", { rejectedReason });
          }}
          record={rejectTarget}
        />
      ) : null}
    </>
  );

  // The portal page already renders its own dark hero (title, badge, description) via
  // EmployeePortalPageShell, so the admin hero and the admin panel frame would stack a second
  // header on top of it — which is exactly what the old shared component did.
  if (surface === "portal") {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {headerChips}
          {headerActions}
        </div>
        {body}
      </div>
    );
  }

  return (
    <ResignationsPageShell>
      <AdminPageHero
        actions={headerActions}
        badges={headerChips}
        description="Track submitted resignations, review workflow progress, and close cases through controlled admin actions."
        eyebrow="People Operations"
        icon={<UserMinus className="h-3.5 w-3.5" />}
        title="Resignations Report"
      />
      {body}
    </ResignationsPageShell>
  );
}
