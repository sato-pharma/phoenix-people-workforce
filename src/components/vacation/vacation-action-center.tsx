"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { vacationRequestDisplayId, vacationTypeLabel } from "@/lib/vacation/calculations";
import type {
  VacationActionAvailability,
  VacationActionCenterData,
  VacationActionCenterRow,
} from "@/lib/vacation/types";

type Props = {
  initialData: VacationActionCenterData | null;
  initialError: string | null;
  initialRequestId?: string | null;
};

type ActionMode = "approve" | "reject" | "acknowledge" | "assign" | null;

function statusBadgeClass(status: string): string {
  if (status === "approved") return "bg-emerald-100 text-emerald-800 border-emerald-300";
  if (status === "rejected") return "bg-rose-100 text-rose-800 border-rose-300";
  if (status === "needs_assignment") return "bg-amber-100 text-amber-900 border-amber-300";
  if (status === "pending_hr") return "bg-sky-100 text-sky-800 border-sky-300";
  return "bg-slate-100 text-slate-700 border-slate-300"; // pending_manager
}

function formatRange(start: string, end: string): string {
  return start === end ? start : `${start} → ${end}`;
}

export function VacationActionCenter({ initialData, initialError, initialRequestId }: Props) {
  const router = useRouter();
  const rows = useMemo(() => initialData?.rows ?? [], [initialData]);
  const canAssign = initialData?.canAssign ?? false;

  const [selectedId, setSelectedId] = useState<string | null>(
    (initialRequestId && rows.some((row) => row.id === initialRequestId) ? initialRequestId : rows[0]?.id) ?? null,
  );
  const [mode, setMode] = useState<ActionMode>(null);
  const [reason, setReason] = useState("");
  const [approverHrId, setApproverHrId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selected = useMemo(() => rows.find((row) => row.id === selectedId) ?? null, [rows, selectedId]);

  function resetAction() {
    setMode(null);
    setReason("");
    setApproverHrId("");
    setError(null);
  }

  async function postJson(url: string, body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(typeof data?.message === "string" ? data.message : "Action failed.");
      }
      resetAction();
      setNotice("Done. The request has been updated.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  function submitDecision(decision: "approve" | "reject") {
    if (!selected) return;
    if (decision === "reject" && !reason.trim()) {
      setError("A rejection reason is required.");
      return;
    }
    void postJson(`/api/vacations/requests/${selected.id}/decision`, {
      decision,
      decisionComment: reason.trim() || null,
    });
  }

  function submitAssign() {
    if (!selected || !approverHrId.trim()) {
      setError("Enter the approver's HR ID.");
      return;
    }
    void postJson(`/api/vacations/requests/${selected.id}/assign`, { approverHrId: approverHrId.trim() });
  }

  if (initialError) {
    return (
      <main className="p-4 sm:p-6">
        <h1 className="text-xl font-black text-slate-900">Vacation Action Center</h1>
        <p className="mt-3 border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800">{initialError}</p>
      </main>
    );
  }

  return (
    <main className="space-y-4 p-4 sm:p-6">
      <header>
        <p className="text-[11px] font-black uppercase tracking-[0.2em] text-orange-600">Phoenix Workforce</p>
        <h1 className="text-xl font-black text-slate-900">Vacation Action Center</h1>
        <p className="mt-1 text-sm text-slate-600">
          Vacation requests waiting for your approval, HR acknowledgement, or assignment.
        </p>
      </header>

      {notice ? (
        <p className="border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-800">{notice}</p>
      ) : null}

      {rows.length === 0 ? (
        <p className="border border-slate-200 bg-slate-50 px-3 py-6 text-center text-sm font-semibold text-slate-500">
          You have no vacation requests that require action right now.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          {/* List */}
          <section className="border border-slate-200">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-900 text-left text-[11px] font-black uppercase tracking-wide text-white">
                    <th className="px-3 py-2">Request</th>
                    <th className="px-3 py-2">Employee</th>
                    <th className="px-3 py-2 hidden sm:table-cell">Stage</th>
                    <th className="px-3 py-2 hidden md:table-cell">SLA</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const active = row.id === selectedId;
                    return (
                      <tr
                        key={row.id}
                        onClick={() => {
                          setSelectedId(row.id);
                          resetAction();
                          setNotice(null);
                        }}
                        className={`cursor-pointer border-t border-orange-100 ${active ? "bg-orange-50" : "hover:bg-slate-50"}`}
                      >
                        <td className="px-3 py-2">
                          <div className="font-bold text-slate-900">{vacationRequestDisplayId(row.id)}</div>
                          <div className="text-[11px] text-slate-500">
                            {vacationTypeLabel(row.vacationType)} · {formatRange(row.startDate, row.endDate)}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-slate-700">{row.employeeName}</td>
                        <td className="px-3 py-2 hidden sm:table-cell text-slate-700">{row.stageLabel ?? "—"}</td>
                        <td className="px-3 py-2 hidden md:table-cell text-slate-600">{row.slaAgeDays}d</td>
                        <td className="px-3 py-2">
                          <span className={`inline-block border px-2 py-0.5 text-[11px] font-bold ${statusBadgeClass(row.status)}`}>
                            {row.stageLabel ?? row.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Detail */}
          {selected ? (
            <RequestDetail
              row={selected}
              canAssign={canAssign}
              mode={mode}
              reason={reason}
              approverHrId={approverHrId}
              busy={busy}
              error={error}
              onMode={setMode}
              onReason={setReason}
              onApprover={setApproverHrId}
              onApprove={() => submitDecision("approve")}
              onReject={() => submitDecision("reject")}
              onAssign={submitAssign}
              onCancel={resetAction}
            />
          ) : (
            <section className="border border-slate-200 p-4 text-sm text-slate-500">Select a request to review.</section>
          )}
        </div>
      )}
    </main>
  );
}

function actionButton(
  label: string,
  availability: VacationActionAvailability[keyof VacationActionAvailability],
  onClick: () => void,
  tone: "primary" | "danger" | "neutral",
) {
  const base = "px-3 py-2 text-sm font-bold border transition disabled:cursor-not-allowed disabled:opacity-50";
  const tones = {
    primary: "border-slate-900 bg-slate-900 text-white hover:bg-slate-800",
    danger: "border-rose-600 bg-rose-600 text-white hover:bg-rose-700",
    neutral: "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
  } as const;
  return (
    <button
      type="button"
      disabled={!availability.enabled}
      title={availability.enabled ? undefined : availability.disabledReason ?? undefined}
      onClick={onClick}
      className={`${base} ${tones[tone]}`}
    >
      {label}
      {!availability.enabled && availability.disabledReason ? (
        <span className="ml-1 block text-[10px] font-semibold opacity-80">{availability.disabledReason}</span>
      ) : null}
    </button>
  );
}

function RequestDetail(props: {
  row: VacationActionCenterRow;
  canAssign: boolean;
  mode: ActionMode;
  reason: string;
  approverHrId: string;
  busy: boolean;
  error: string | null;
  onMode: (mode: ActionMode) => void;
  onReason: (value: string) => void;
  onApprover: (value: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onAssign: () => void;
  onCancel: () => void;
}) {
  const { row, mode, busy } = props;
  const a = row.actionAvailability;

  return (
    <section className="border border-slate-200">
      <div className="bg-slate-900 px-4 py-3 text-white">
        <div className="text-xs font-bold uppercase tracking-wide text-orange-300">{vacationRequestDisplayId(row.id)}</div>
        <div className="text-base font-black">{row.employeeName}</div>
        <div className="text-[12px] text-slate-300">{row.stageLabel ?? row.status}</div>
      </div>

      <div className="space-y-3 p-4">
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <Field label="Type" value={vacationTypeLabel(row.vacationType)} />
          <Field label="Dates" value={formatRange(row.startDate, row.endDate)} />
          <Field label="Days" value={String(row.durationDays)} />
          <Field label="Payment" value={row.paymentStatus} />
          <Field label="Department" value={row.departmentName ?? "—"} />
          <Field label="Pending" value={`${row.slaAgeDays} business day(s)`} />
        </dl>

        <ApprovalImpactPreview
          employeeName={row.employeeName}
          range={formatRange(row.startDate, row.endDate)}
          status={row.status}
          type={vacationTypeLabel(row.vacationType)}
        />

        {/* Timeline of approval steps */}
        <div>
          <h3 className="text-[11px] font-black uppercase tracking-wide text-slate-500">Approval timeline</h3>
          <ol className="mt-2 space-y-2">
            {row.approvalSteps.map((step) => (
              <li key={`${step.stepKey}-${step.order}`} className="border-l-2 border-orange-200 pl-3">
                <div className="text-sm font-bold text-slate-900">
                  {step.stepKey === "hr" ? "HR Acknowledgement" : `${step.approverTitle ?? "Manager"} Approval`}
                  <span className="ml-2 text-[11px] font-semibold text-slate-500">({step.genericStep})</span>
                </div>
                <div className="text-[12px] text-slate-600">
                  {step.approverName ?? step.approverHrId} ·{" "}
                  <span
                    className={
                      step.status === "approved"
                        ? "text-emerald-700"
                        : step.status === "rejected"
                          ? "text-rose-700"
                          : "text-slate-500"
                    }
                  >
                    {step.status}
                  </span>
                  {step.decidedAt ? ` · ${new Date(step.decidedAt).toLocaleString()}` : ""}
                </div>
                {step.decisionComment ? (
                  <div className="mt-0.5 text-[12px] italic text-slate-600">Reason: {step.decisionComment}</div>
                ) : null}
              </li>
            ))}
          </ol>
        </div>

        {props.error ? (
          <p className="border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800">{props.error}</p>
        ) : null}

        {/* Action area */}
        {mode === "reject" ? (
          <div className="space-y-2 border border-rose-200 bg-rose-50 p-3">
            <label className="block text-[11px] font-black uppercase tracking-wide text-rose-800">
              Rejection reason (required)
            </label>
            <textarea
              value={props.reason}
              onChange={(event) => props.onReason(event.target.value)}
              rows={3}
              className="w-full border border-rose-300 px-2 py-1 text-sm"
              placeholder="Explain why this request is rejected…"
            />
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={props.onReject} className="border border-rose-600 bg-rose-600 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">
                Confirm rejection
              </button>
              <button type="button" disabled={busy} onClick={props.onCancel} className="border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700">
                Cancel
              </button>
            </div>
          </div>
        ) : mode === "assign" ? (
          <div className="space-y-2 border border-amber-200 bg-amber-50 p-3">
            <label className="block text-[11px] font-black uppercase tracking-wide text-amber-900">
              Assign first management approver (HR ID)
            </label>
            <input
              value={props.approverHrId}
              onChange={(event) => props.onApprover(event.target.value)}
              className="w-full border border-amber-300 px-2 py-1 text-sm"
              placeholder="e.g. B-10"
            />
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={props.onAssign} className="border border-slate-900 bg-slate-900 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">
                Assign &amp; resume
              </button>
              <button type="button" disabled={busy} onClick={props.onCancel} className="border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {row.status === "needs_assignment" && props.canAssign
              ? actionButton("Assign approver", a.assign, () => props.onMode("assign"), "primary")
              : null}
            {row.viewerStepKind === "hr" && row.status !== "needs_assignment"
              ? actionButton("Acknowledge / Record by HR", a.acknowledge, props.onApprove, "primary")
              : null}
            {row.viewerStepKind === "management"
              ? actionButton("Approve", a.approve, props.onApprove, "primary")
              : null}
            {row.viewerStepKind !== "none"
              ? actionButton("Reject with reason", a.reject, () => props.onMode("reject"), "danger")
              : null}
          </div>
        )}
      </div>
    </section>
  );
}

function ApprovalImpactPreview({ employeeName, range, status, type }: { employeeName: string; range: string; status: string; type: string }) {
  const hrAcknowledgement = status === "pending_hr";
  return (
    <div className="border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold leading-5 text-emerald-900">
      <p className="font-black uppercase tracking-[0.12em] text-emerald-700">Approval impact preview</p>
      <p>
        {hrAcknowledgement ? "HR acknowledgement" : "Approval"} will place this {type.toLowerCase()} vacation on the private calendar for {employeeName} covering {range}.
      </p>
      <p className="text-emerald-700">The entry will be visible to the employee, direct manager, HR/global viewers, and CEO according to private-calendar access rules.</p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] font-black uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="text-sm font-semibold text-slate-800">{value}</dd>
    </div>
  );
}
