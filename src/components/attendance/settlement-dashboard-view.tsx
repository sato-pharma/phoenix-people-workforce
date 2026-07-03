"use client";

import { useState } from "react";
import { BellRing, Gauge } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import type { ExportRow } from "@/lib/export/table-workbook";
import type { SettlementDashboard } from "@/lib/attendance/settlement-dashboard";
import type { SettlementLedgerEntry } from "@/lib/attendance/settlement-ledger";

const LEDGER_ACTION_LABELS: Record<SettlementLedgerEntry["action"], string> = {
  auto_confirmed: "Auto-confirmed (no response)",
  confirmed: "Confirmed by employee",
  dispute_rejected: "Dispute rejected (deducted)",
  dispute_upheld: "Dispute upheld (no deduction)",
};

function defaultLedgerDateFrom() {
  const date = new Date();
  date.setDate(date.getDate() - 90);
  return date.toISOString().slice(0, 10);
}

function defaultLedgerDateTo() {
  return new Date().toISOString().slice(0, 10);
}

type Props = {
  initialDashboard: SettlementDashboard | null;
  initialError: string | null;
  canRemind: boolean;
};

const STATUS_LABELS: Record<keyof SettlementDashboard["byStatus"], string> = {
  auto_confirmed: "Auto-confirmed",
  draft: "Draft",
  pending_admin_review: "Awaiting admin review",
  sent: "Awaiting response",
  settled: "Settled",
  void: "Void",
};

function formatDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function SettlementDashboardView({ initialDashboard, initialError, canRemind }: Props) {
  const [dashboard, setDashboard] = useState(initialDashboard);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [reminding, setReminding] = useState(false);

  const [ledgerDateFrom, setLedgerDateFrom] = useState(defaultLedgerDateFrom);
  const [ledgerDateTo, setLedgerDateTo] = useState(defaultLedgerDateTo);
  const [ledgerEntries, setLedgerEntries] = useState<SettlementLedgerEntry[] | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

  async function loadLedger() {
    setLedgerLoading(true);
    setLedgerError(null);
    try {
      const params = new URLSearchParams({ dateFrom: ledgerDateFrom, dateTo: ledgerDateTo });
      const response = await fetch(`/api/attendance/settlement-ledger?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Settlement ledger failed to load.");
      setLedgerEntries(payload.entries as SettlementLedgerEntry[]);
    } catch (loadError) {
      setLedgerError(loadError instanceof Error ? loadError.message : "Settlement ledger failed to load.");
    } finally {
      setLedgerLoading(false);
    }
  }

  const ledgerExportRows: ExportRow[] = (ledgerEntries ?? []).map((entry) => ({
    action: LEDGER_ACTION_LABELS[entry.action],
    actorHrId: entry.actorHrId ?? "System (auto-confirm)",
    actorRole: entry.actorRole ?? "—",
    deductionDays: entry.deductionDays,
    deductionValue: entry.deductionValue,
    decidedAt: entry.decidedAt,
    employeeHrId: entry.employeeHrId,
    employeeName: entry.employeeName,
    lineStatus: entry.lineStatus,
    reason: entry.reason ?? "—",
    reviewerHrId: entry.reviewerHrId ?? "—",
    workDate: entry.workDate,
  }));

  async function refresh() {
    setError(null);
    try {
      const response = await fetch("/api/attendance/settlement-dashboard");
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Settlement dashboard failed to load.");
      setDashboard(payload);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Settlement dashboard failed to load.");
    }
  }

  async function remindAll() {
    if (!dashboard) return;
    setReminding(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/attendance/settlement-dashboard/remind-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cycleKey: dashboard.cycleKey }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Remind-all failed.");
      setNotice(`Reminded ${payload.reminded} employee(s)${payload.failed > 0 ? `, ${payload.failed} failed to send` : ""}.`);
      await refresh();
    } catch (remindError) {
      setError(remindError instanceof Error ? remindError.message : "Remind-all failed.");
    } finally {
      setReminding(false);
    }
  }

  if (!dashboard) {
    return (
      <div className="space-y-5">
        <AdminPageHero
          description="Real-time counts and pending actions across every employee's weekly attendance digests."
          eyebrow="Attendance"
          icon={<Gauge className="h-3.5 w-3.5" />}
          title="Settlement Dashboard"
        />
        {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
      </div>
    );
  }

  const statusEntries = Object.entries(dashboard.byStatus) as Array<[keyof SettlementDashboard["byStatus"], SettlementDashboard["byStatus"][keyof SettlementDashboard["byStatus"]]]>;

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={
          <>
            <AdminInsightChip tone="orange">{dashboard.pendingDigests.length} awaiting response</AdminInsightChip>
            {dashboard.openDisputeCount > 0 ? <AdminInsightChip tone="orange">{dashboard.openDisputeCount} open dispute(s)</AdminInsightChip> : null}
          </>
        }
        description={`Cycle ${dashboard.cycleKey}. Live counts across every employee's weekly attendance digests.`}
        eyebrow="Attendance"
        icon={<Gauge className="h-3.5 w-3.5" />}
        title="Settlement Dashboard"
      />

      {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
      {notice ? <AdminCallout tone="neutral">{notice}</AdminCallout> : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {statusEntries.map(([status, counts]) => (
          <div className="rounded-lg border border-slate-200 bg-white p-3" key={status}>
            <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">{STATUS_LABELS[status]}</p>
            <p className="mt-1 text-2xl font-black text-slate-950">{counts.count}</p>
            <p className="text-xs font-semibold text-slate-500">{counts.totalDeductionValue.toFixed(2)} EGP</p>
          </div>
        ))}
      </div>

      <AdminTableShell
        action={
          canRemind && dashboard.pendingDigests.length > 0 ? (
            <Button disabled={reminding} type="button" onClick={remindAll}>
              <BellRing className="h-4 w-4" />
              {reminding ? "Reminding…" : "Remind All"}
            </Button>
          ) : null
        }
        description="Digests sent to employees, awaiting confirmation or dispute before the 48-hour auto-confirm."
        title="Pending Digests"
      >
        {dashboard.pendingDigests.length === 0 ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">No pending digests.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {dashboard.pendingDigests.map((digest) => (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4" key={digest.id}>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-black text-slate-950">{digest.employeeName} ({digest.employeeHrId})</p>
                    {digest.hasBeenRead === true ? (
                      <AdminInsightChip surface="light" tone="emerald">Seen {formatDateTime(digest.firstReadAt)}</AdminInsightChip>
                    ) : digest.hasBeenRead === false ? (
                      <AdminInsightChip surface="light" tone="orange">Not yet seen</AdminInsightChip>
                    ) : null}
                  </div>
                  <p className="text-xs font-semibold text-slate-500">
                    Week {digest.weekIndex} &middot; {digest.weekStart} to {digest.weekEnd} &middot; {digest.totalDeductionDays} day(s) &middot;{" "}
                    {digest.totalDeductionValue.toFixed(2)} EGP
                  </p>
                </div>
                <div className="text-right text-xs font-semibold text-slate-500">
                  <p>Sent {formatDateTime(digest.sentAt)}</p>
                  <p>Auto-confirms {formatDateTime(digest.autoConfirmAt)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </AdminTableShell>

      <AdminTableShell
        action={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
              From
              <input
                className="h-9 rounded-lg border border-slate-200 px-2 text-xs font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                type="date"
                value={ledgerDateFrom}
                onChange={(event) => setLedgerDateFrom(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
              To
              <input
                className="h-9 rounded-lg border border-slate-200 px-2 text-xs font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                type="date"
                value={ledgerDateTo}
                onChange={(event) => setLedgerDateTo(event.target.value)}
              />
            </label>
            <Button disabled={ledgerLoading} type="button" variant="secondary" onClick={loadLedger}>
              {ledgerLoading ? "Loading…" : "Load"}
            </Button>
            {ledgerEntries ? (
              <ExportXlsxButton
                columns={[
                  { key: "employeeName", label: "Employee" },
                  { key: "employeeHrId", label: "HR ID" },
                  { key: "workDate", label: "Work Date" },
                  { key: "lineStatus", label: "Type" },
                  { key: "action", label: "Outcome" },
                  { key: "deductionDays", label: "Days", numeric: true },
                  { key: "deductionValue", label: "Value (EGP)", numeric: true },
                  { key: "actorHrId", label: "Actor" },
                  { key: "actorRole", label: "Actor Role" },
                  { key: "reviewerHrId", label: "Reviewer" },
                  { key: "reason", label: "Reason" },
                  { key: "decidedAt", label: "Decided At" },
                ]}
                rows={ledgerExportRows}
                sheetName="Settlement Ledger"
                subtitle={`${ledgerDateFrom} to ${ledgerDateTo}`}
                title="Attendance Settlement Audit Ledger"
              />
            ) : null}
          </div>
        }
        description="Immutable, per-day audit trail of every attendance settlement decision — confirm, auto-confirm, and dispute review outcomes."
        title="Exportable Audit Ledger"
      >
        {ledgerError ? <div className="p-4"><AdminCallout tone="danger">{ledgerError}</AdminCallout></div> : null}
        {!ledgerEntries ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">Pick a date range and load the ledger.</div>
        ) : ledgerEntries.length === 0 ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">No settlements in this range.</div>
        ) : (
          <>
            <div className="divide-y divide-slate-100">
              {ledgerEntries.slice(0, 100).map((entry) => (
                <div className="flex flex-wrap items-center justify-between gap-3 p-4" key={entry.id}>
                  <div>
                    <p className="text-sm font-black text-slate-950">{entry.employeeName} ({entry.employeeHrId}) — {entry.workDate}</p>
                    <p className="text-xs font-semibold text-slate-500">
                      {LEDGER_ACTION_LABELS[entry.action]} &middot; {entry.lineStatus} &middot; {entry.deductionDays} day(s) &middot; {entry.deductionValue.toFixed(2)} EGP
                      {entry.reviewerHrId ? ` · reviewed by ${entry.reviewerHrId}` : ""}
                    </p>
                  </div>
                  <p className="text-xs font-semibold text-slate-500">{formatDateTime(entry.decidedAt)}</p>
                </div>
              ))}
            </div>
            {ledgerEntries.length > 100 ? (
              <div className="p-4 text-center text-xs font-semibold text-slate-500">
                Showing first 100 of {ledgerEntries.length} — export includes all rows.
              </div>
            ) : null}
          </>
        )}
      </AdminTableShell>
    </div>
  );
}
