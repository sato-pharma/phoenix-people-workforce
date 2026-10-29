"use client";

import { useState, useTransition } from "react";
import { CalendarCheck, Check, Plus, RefreshCw, ShieldCheck, X } from "lucide-react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import {
  PortalStackingCell,
  portalStackingBodyClassName,
  portalStackingHeadClassName,
  portalStackingRowClassName,
  portalStackingTableClassName,
} from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AttendanceException, AttendanceExceptionStatus } from "@/lib/attendance/exceptions";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";


type EmployeeOption = { fullName: string; hrId: string };

type Props = {
  canReview: boolean;
  employees: EmployeeOption[];
  initialData: AttendanceException[];
  initialError: string | null;
};

type StatusFilter = "all" | AttendanceExceptionStatus;

type ExceptionForm = {
  employeeHrId: string;
  exceptionDate: string;
  notes: string;
  reason: string;
  status: AttendanceExceptionStatus;
};

function blankForm(): ExceptionForm {
  return {
    employeeHrId: "",
    exceptionDate: new Date().toISOString().slice(0, 10),
    notes: "",
    reason: "",
    status: "approved",
  };
}

function statusBadge(status: AttendanceExceptionStatus) {
  if (status === "approved") return <Badge variant="success">Approved</Badge>;
  if (status === "rejected") return <Badge variant="danger">Rejected</Badge>;
  return <Badge variant="warning">Pending</Badge>;
}

function formatDate(iso: string) {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

export function AttendanceExceptionsManager({ canReview, employees, initialData, initialError }: Props) {
  const [exceptions, setExceptions] = useState<AttendanceException[]>(initialData);
  const [error, setError] = useState<string | null>(initialError);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ExceptionForm>(blankForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<number, string>>({});
  const [isPending, startTransition] = useTransition();

  const filtered = exceptions.filter((e) => statusFilter === "all" || e.status === statusFilter);
  const pendingCount = exceptions.filter((e) => e.status === "pending").length;

  function refresh() {
    startTransition(async () => {
      try {
        const res = await fetch("/api/attendance/exceptions?status=all");
        if (!res.ok) throw new Error(await res.text());
        setExceptions(await res.json());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to refresh.");
      }
    });
  }

  function handleFormChange(field: keyof ExceptionForm, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function submitForm() {
    if (!form.employeeHrId) { setFormError("Employee is required."); return; }
    if (!form.exceptionDate) { setFormError("Date is required."); return; }
    if (!form.reason.trim()) { setFormError("Reason is required."); return; }
    setFormError(null);

    startTransition(async () => {
      try {
        const res = await fetch("/api/attendance/exceptions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            employeeHrId: form.employeeHrId,
            exceptionDate: form.exceptionDate,
            notes: form.notes || null,
            reason: form.reason,
            status: form.status,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message ?? "Failed to save exception.");
        }
        const saved: AttendanceException = await res.json();
        setExceptions((prev) => {
          const idx = prev.findIndex((e) => e.employeeHrId === saved.employeeHrId && e.exceptionDate === saved.exceptionDate);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = saved;
            return next;
          }
          return [saved, ...prev];
        });
        setShowForm(false);
        setForm(blankForm());
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "Failed to save.");
      }
    });
  }

  function review(id: number, decision: "approved" | "rejected") {
    startTransition(async () => {
      try {
        // An untouched review box means "I have nothing to add", not "erase what the requester
        // wrote" — the row renders their note directly above this box. Send no notes key at all
        // so the server leaves the cell alone.
        const reviewNote = reviewNotes[id]?.trim();
        const res = await fetch(`/api/attendance/exceptions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reviewNote ? { decision, notes: reviewNote } : { decision }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message ?? "Review failed.");
        }
        const updated: AttendanceException = await res.json();
        setExceptions((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Review failed.");
      }
    });
  }

  const filterLabels: Record<StatusFilter, string> = {
    all: "All",
    approved: "Approved",
    pending: "Pending",
    rejected: "Rejected",
  };

  return (
    <div className="space-y-6">
      <AdminPageHero
        title="Attendance Exceptions"
        eyebrow="Attendance"
        description="Approve employee-disputed records or proactively mark approved absences so they are excluded from deduction calculations."
        icon={<ShieldCheck className="h-3.5 w-3.5" />}
      />

      <div className="flex flex-wrap items-center gap-3">
        <AdminInsightChip tone="orange">{pendingCount} pending</AdminInsightChip>
        <AdminInsightChip>{exceptions.length} total</AdminInsightChip>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={refresh} disabled={isPending}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Refresh
          </Button>
          {canReview && (
            <Button size="sm" onClick={() => setShowForm((v) => !v)} disabled={isPending}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add Exception
            </Button>
          )}
        </div>
      </div>

      {error && <AdminCallout tone="danger">{error}</AdminCallout>}

      {showForm && canReview && (
        <div className="border border-border bg-card p-5 space-y-4">
          <p className="text-sm font-semibold">New Exception</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Employee</label>
              <SearchableSelect
                className="w-full px-3 py-2"
                value={form.employeeHrId}
                onChange={(e) => handleFormChange("employeeHrId", e.target.value)}
              >
                <option value="">— select —</option>
                {employees.map((emp) => (
                  <option key={emp.hrId} value={emp.hrId}>
                    {emp.fullName}
                  </option>
                ))}
              </SearchableSelect>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Date</label>
              <input
                type="date"
                className={phxFieldClassName}
                value={form.exceptionDate}
                onChange={(e) => handleFormChange("exceptionDate", e.target.value)}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs font-medium text-muted-foreground">Reason</label>
              <input
                type="text"
                placeholder="e.g. Official field visit, approved by manager"
                className={phxFieldClassName}
                value={form.reason}
                onChange={(e) => handleFormChange("reason", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Notes (optional)</label>
              <input
                type="text"
                className={phxFieldClassName}
                value={form.notes}
                onChange={(e) => handleFormChange("notes", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Status</label>
              <SearchableSelect
                className="w-full px-3 py-2"
                value={form.status}
                onChange={(e) => handleFormChange("status", e.target.value)}
              >
                <option value="approved">Approved (suppress deduction immediately)</option>
                <option value="pending">Pending (requires HR review)</option>
              </SearchableSelect>
            </div>
          </div>
          {formError && <p className="text-xs text-red-600">{formError}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={submitForm} disabled={isPending}>Save</Button>
            <Button size="sm" variant="outline" onClick={() => { setShowForm(false); setForm(blankForm()); setFormError(null); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {(["pending", "approved", "rejected", "all"] as StatusFilter[]).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`border px-3 py-1 text-xs font-medium transition-colors ${
              statusFilter === s
                ? "border-orange-500 bg-orange-50 text-orange-700"
                : "border-border bg-background text-muted-foreground hover:border-orange-300"
            }`}
          >
            {filterLabels[s]}
            {s === "pending" && pendingCount > 0 && (
              <span className="ml-1.5 bg-phx-warn px-1.5 py-0.5 text-phx-2xs text-white">
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <AdminCallout tone="neutral">
          {statusFilter === "pending"
            ? "No pending exceptions — all caught up."
            : `No ${statusFilter === "all" ? "" : statusFilter} exceptions found.`}
        </AdminCallout>
      ) : (
        <AdminTableShell title="Exceptions" description="Review and manage attendance exception requests.">
          <table className={`${portalStackingTableClassName} md:w-full md:table-fixed text-sm`}>
            <colgroup>
              <col className="w-[18%]" />
              <col className="w-[12%]" />
              <col className="w-[24%]" />
              <col className="w-[12%]" />
              <col className="w-[10%]" />
              {canReview ? <col className="w-[24%]" /> : null}
            </colgroup>
            <thead className={portalStackingHeadClassName}>
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide">Employee</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide">Date</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide">Reason</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide">Requested By</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide">Status</th>
                {canReview && <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide">Actions</th>}
              </tr>
            </thead>
            <tbody className={`${portalStackingBodyClassName} divide-y divide-border`}>
              {filtered.map((exc) => (
                <tr key={exc.id} className={`${portalStackingRowClassName} hover:bg-muted/40`}>
                  <PortalStackingCell className="break-words" label="Employee">
                    <div className="font-medium">{exc.employeeName ?? "—"}</div>
                  </PortalStackingCell>
                  <PortalStackingCell className="font-mono text-xs" label="Date">
                    <span className="flex items-center gap-1.5">
                      <CalendarCheck className="h-3.5 w-3.5 text-muted-foreground" />
                      {formatDate(exc.exceptionDate)}
                    </span>
                  </PortalStackingCell>
                  <PortalStackingCell className="break-words" label="Reason">
                    <div>{exc.reason}</div>
                    {exc.notes && <div className="text-xs text-muted-foreground">{exc.notes}</div>}
                  </PortalStackingCell>
                  <PortalStackingCell className="break-words text-xs text-muted-foreground" label="Requested By">{exc.requestedBy}</PortalStackingCell>
                  <PortalStackingCell label="Status">{statusBadge(exc.status)}</PortalStackingCell>
                  {canReview && (
                    <PortalStackingCell className="min-w-0" label="Actions">
                      {exc.status === "pending" ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="text"
                            placeholder="Notes (optional)"
                            className={cn(phxFieldClassName, "w-full")}
                            value={reviewNotes[exc.id] ?? ""}
                            onChange={(e) => setReviewNotes((prev) => ({ ...prev, [exc.id]: e.target.value }))}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 border-green-400 text-green-700 hover:bg-green-50"
                            onClick={() => review(exc.id, "approved")}
                            disabled={isPending}
                          >
                            <Check className="mr-1 h-3 w-3" /> Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 border-red-400 text-red-700 hover:bg-red-50"
                            onClick={() => review(exc.id, "rejected")}
                            disabled={isPending}
                          >
                            <X className="mr-1 h-3 w-3" /> Reject
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {exc.reviewedBy ? `Reviewed by ${exc.reviewedBy}` : "—"}
                        </span>
                      )}
                    </PortalStackingCell>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </AdminTableShell>
      )}
    </div>
  );
}
