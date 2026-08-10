"use client";

import { AlertTriangle } from "lucide-react";
import * as React from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ResignationDialog } from "@/components/resignations/resignation-dialog";
import { formatResignationDate, resignationDaysState } from "@/lib/resignations/view-model";
import type { ResignationRecord } from "@/lib/resignations/types";
import { formatEmployeeDisplayName } from "@/lib/utils";

export type OverdueCloseProgress = { done: number; label: string; total: number };
export type OverdueCloseResult = { failures: Array<{ name: string; reason: string }>; closed: number };

/**
 * Reconciliation list for resignations whose effective date has passed while the workflow is
 * still open — the person left, but nobody ran Complete, so this record never fired the
 * lifecycle / AU-seat / vacancy steps. Production had 12 of these, the oldest 63 days old.
 *
 * Closing runs the SAME per-record workflow endpoint the row buttons use, one at a time, so every
 * server-side guard (permission, per-record scope check, the optimistic-concurrency CAS on
 * updated_at, the completion side effects, the notification) applies unchanged. There is
 * deliberately no bulk server route: a new one would be a second, unhardened path into payroll-
 * affecting writes.
 */
export function ResignationOverduePanel({
  busy,
  onCloseOverdue,
  progress,
  records,
  result,
}: {
  busy: boolean;
  onCloseOverdue: (records: ResignationRecord[]) => Promise<void>;
  progress: OverdueCloseProgress | null;
  records: readonly ResignationRecord[];
  result: OverdueCloseResult | null;
}) {
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = React.useState(false);

  if (records.length === 0 && !result) return null;

  // Derived, not synced: a record that has just been closed drops out of `records`, so filtering
  // here is what prunes it from the selection. Doing this in an effect instead would be a lint
  // error in this repo (react-hooks/set-state-in-effect) and a wasted extra render.
  const chosen = records.filter((record) => selected.has(record.id));
  const allSelected = records.length > 0 && chosen.length === records.length;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      <AdminTableShell
        action={
          <Button
            className="h-11 gap-2"
            disabled={busy || chosen.length === 0}
            onClick={() => setConfirming(true)}
            variant="destructive"
          >
            <AlertTriangle className="h-4 w-4" />
            Close {chosen.length > 0 ? `${chosen.length} selected` : "selected"}
          </Button>
        }
        description="These people have already left — their effective date has passed — but the resignation was never completed, so the seat, portal access and replacement vacancy were never reconciled from this workflow. Review and close them."
        title="Overdue — left but never completed"
      >
        <div className="p-4">
          {progress ? (
            <p className="mb-3 border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
              Closing {progress.done} of {progress.total} — {progress.label}
            </p>
          ) : null}

          {result ? (
            <p
              className={`mb-3 border px-3 py-2 text-xs font-semibold ${
                result.failures.length > 0
                  ? "border-rose-200 bg-rose-50 text-rose-800"
                  : "border-emerald-200 bg-emerald-50 text-emerald-800"
              }`}
            >
              Closed {result.closed}
              {result.failures.length > 0
                ? ` · ${result.failures.length} failed: ${result.failures
                    .map((failure) => `${failure.name} (${failure.reason})`)
                    .join("; ")}`
                : " · all selected records completed."}
            </p>
          ) : null}

          {records.length > 0 ? (
            <>
              <label className="mb-2 flex items-center gap-2 text-xs font-bold text-[#0F172A]">
                <input
                  checked={allSelected}
                  className="h-4 w-4 accent-[#F97316]"
                  disabled={busy}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(records.map((r) => r.id)))
                  }
                  type="checkbox"
                />
                Select all {records.length}
              </label>

              <ul className="divide-y divide-slate-100 border border-slate-200">
                {records.map((record) => {
                  const state = resignationDaysState(record);
                  return (
                    <li className="flex items-center gap-3 px-3 py-2" key={record.id}>
                      <input
                        checked={selected.has(record.id)}
                        className="h-4 w-4 shrink-0 accent-[#F97316]"
                        disabled={busy}
                        onChange={() => toggle(record.id)}
                        type="checkbox"
                      />
                      <span className="min-w-0 flex-1 whitespace-nowrap text-sm font-semibold text-[#0F172A]">
                        {formatEmployeeDisplayName(record.employeeName)}
                        <span className="ml-2 font-mono text-xs font-normal text-[#64748B]">
                          {record.employeeHrId}
                        </span>
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-xs text-[#64748B]">
                        effective {formatResignationDate(record.effectiveDate)}
                      </span>
                      <Badge variant="danger">{state.text}</Badge>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </div>
      </AdminTableShell>

      {confirming ? (
        <ResignationDialog
          ariaLabel="Confirm closing overdue resignations"
          footer={
            <>
              <Button
                className="h-9 px-4 text-xs"
                disabled={busy}
                onClick={() => setConfirming(false)}
                variant="secondary"
              >
                Cancel
              </Button>
              <Button
                className="h-9 px-4 text-xs"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  void onCloseOverdue(chosen);
                }}
                variant="destructive"
              >
                Complete {chosen.length} {chosen.length === 1 ? "record" : "records"}
              </Button>
            </>
          }
          onClose={() => setConfirming(false)}
          subtitle="This writes to live records. Read what it does before confirming."
          title={`Close ${chosen.length} overdue ${chosen.length === 1 ? "resignation" : "resignations"}`}
        >
          <p className="text-sm leading-6 text-slate-700">
            Each selected record runs the normal <strong>Complete</strong> action, one at a time.
            For every one of them this will:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-slate-700">
            <li>mark the employee resigned and deactivate their portal access</li>
            <li>vacate their organogram seat and reconcile the replacement vacancy</li>
            <li>
              send a <strong>Resignation Completed</strong> notification to Super Admin and Talent
              Acquisition — {chosen.length} separate {chosen.length === 1 ? "message" : "messages"}
            </li>
          </ul>
          <p className="mt-3 text-sm leading-6 text-slate-700">
            Everyone in this list is already <code>resigned</code> in the employee directory, so the
            lifecycle steps re-assert what is already true rather than changing anyone&apos;s state.
            The notifications, however, are new and will actually be sent.
          </p>
          <ul className="mt-3 space-y-1 text-sm font-semibold text-slate-900">
            {chosen.map((record) => (
              <li className="whitespace-nowrap" key={record.id}>
                {formatEmployeeDisplayName(record.employeeName)} · {record.employeeHrId}
              </li>
            ))}
          </ul>
        </ResignationDialog>
      ) : null}
    </>
  );
}
