"use client";

import {
  ArrowRight,
  Check,
  CheckCircle2,
  Inbox,
  Loader2,
  MapPin,
  RotateCcw,
  Search,
  Undo2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TripAttachments } from "@/components/outstation/trip-attachments";
import { TripWorkloadEvidencePanel } from "@/components/outstation/trip-workload-evidence";
import { formatCurrencyValue, formatDateValue, formatNumberValue } from "@/lib/i18n/format";
import {
  APPROVED_STATUS,
  REJECTED_STATUS,
  expenseApprovalState,
  isRejectedStatus,
} from "@/lib/outstation/approval-state";
import type { ExpenseTripRecord } from "@/lib/payroll/types";
import { cn } from "@/lib/utils";

type LoadedRecord = ExpenseTripRecord & {
  approvedAmount?: number | null;
  hrApproved?: boolean;
  hrComment?: string;
  reportId?: string | null;
  sourceFileName?: string;
};

type Decision = { approvedAmount: number; hrApproved: boolean; hrComment: string; status: string };

function savedDecision(record: LoadedRecord): Decision {
  return {
    approvedAmount: typeof record.approvedAmount === "number" ? record.approvedAmount : record.total,
    hrApproved: Boolean(record.hrApproved),
    hrComment: record.hrComment ?? "",
    status: record.status ?? "",
  };
}

function egp(value: number) {
  return formatCurrencyValue(Number.isFinite(value) ? value : 0);
}

export function ExpenseApprovalsWorkspace() {
  const [records, setRecords] = useState<LoadedRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"pending" | "approved" | "rejected">("pending");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // No setState before the first `await`, so this stays safe to call straight from an effect
  // (loading starts true on mount; the retry handler re-arms it).
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/outstation/expenses", { headers: { accept: "application/json" } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message || "Unable to load expenses.");
      setRecords(Array.isArray(payload.expenses) ? (payload.expenses as LoadedRecord[]) : []);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load expenses.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      await Promise.resolve();
      if (!cancelled) await load();
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const decisionFor = useCallback(
    (record: LoadedRecord): Decision => decisions[record.tripId] ?? savedDecision(record),
    [decisions],
  );

  const setDecision = useCallback((record: LoadedRecord, patch: Partial<Decision>) => {
    setSaveMessage(null);
    setDecisions((current) => {
      const base = current[record.tripId] ?? savedDecision(record);
      return { ...current, [record.tripId]: { ...base, ...patch } };
    });
  }, []);

  const dirtyCount = useMemo(() => {
    return records.reduce((count, record) => {
      const local = decisions[record.tripId];
      if (!local) return count;
      const saved = savedDecision(record);
      const changed =
        local.hrApproved !== saved.hrApproved ||
        Math.abs(local.approvedAmount - saved.approvedAmount) > 0.5 ||
        local.hrComment.trim() !== saved.hrComment.trim() ||
        // A rejection changes ONLY the status, so without this the Save button stays
        // disabled and the decision is silently discarded.
        isRejectedStatus(local.status) !== isRejectedStatus(saved.status);
      return changed ? count + 1 : count;
    }, 0);
  }, [records, decisions]);

  const { pending, approved, rejected } = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matches = (record: LoadedRecord) =>
      !query ||
      [record.specialist, record.hrId ?? "", record.tripId, record.location, record.to]
        .join(" ")
        .toLowerCase()
        .includes(query);
    const visible = records.filter(matches);
    const byValue = (a: LoadedRecord, b: LoadedRecord) => b.total - a.total;
    // One shared rule decides the queue (see approval-state.ts), so a trip lands in exactly one.
    // Pending excludes rejections — otherwise rejecting a trip would leave it sitting in the
    // inbox forever and the button would look like it did nothing.
    const inState = (state: ReturnType<typeof expenseApprovalState>) =>
      visible.filter((record) => expenseApprovalState(decisionFor(record)) === state).sort(byValue);
    return {
      approved: inState("approved"),
      pending: inState("pending"),
      rejected: inState("rejected"),
    };
  }, [records, search, decisionFor]);

  const activeList = tab === "pending" ? pending : tab === "approved" ? approved : rejected;
  // Derive (don't store) the effective selection so it stays valid as tabs/filters change,
  // without a setState-in-effect. An explicit click still wins via `selectedId`.
  const effectiveSelectedId =
    selectedId && activeList.some((record) => record.tripId === selectedId)
      ? selectedId
      : (activeList[0]?.tripId ?? null);
  const selected = useMemo(
    () => records.find((record) => record.tripId === effectiveSelectedId) ?? null,
    [records, effectiveSelectedId],
  );

  const selectNextPending = useCallback(
    (fromTripId: string) => {
      const index = pending.findIndex((record) => record.tripId === fromTripId);
      const next = pending[index + 1] ?? pending.find((record) => record.tripId !== fromTripId) ?? null;
      setSelectedId(next?.tripId ?? null);
    },
    [pending],
  );

  async function save() {
    setSaving(true);
    setSaveMessage(null);
    try {
      const changedReportIds = new Set<string | null>();
      for (const record of records) {
        const local = decisions[record.tripId];
        if (!local) continue;
        const saved = savedDecision(record);
        const changed =
          local.hrApproved !== saved.hrApproved ||
          Math.abs(local.approvedAmount - saved.approvedAmount) > 0.5 ||
          local.hrComment.trim() !== saved.hrComment.trim();
        if (changed) changedReportIds.add(record.reportId ?? null);
      }

      // Save one report at a time with its FULL record set so the report's row/approval totals
      // recompute correctly (the API upserts by trip_id and re-stamps report_id/source_file_name).
      for (const reportId of changedReportIds) {
        const reportRecords = records.filter((record) => (record.reportId ?? null) === reportId);
        const fileName = reportRecords.find((record) => record.sourceFileName)?.sourceFileName || "outstation-expenses";
        const body = {
          fileName,
          records: reportRecords.map((record) => {
            const decision = decisionFor(record);
            return {
              ...record,
              approvedAmount: decision.approvedAmount,
              hrApproved: decision.hrApproved,
              hrComment: decision.hrComment,
              // Rejection is carried by `status`; without this the server re-writes the row's
              // ORIGINAL status and the rejection never persists.
              status: decision.status,
            };
          }),
          reportId,
        };
        const response = await fetch("/api/admin/outstation/expenses", {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.message || "Unable to save approvals.");
      }

      setDecisions({});
      await load();
      setSaveMessage("Approvals saved.");
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : "Unable to save approvals.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-orange-600">Outstation expenses</p>
          <h1 className="mt-1 text-2xl font-black tracking-tight text-slate-900">Expense Approvals</h1>
          <p className="mt-1 text-sm text-slate-500">
            Review each trip against its real CRM field activity, adjust the payable amount if needed, and approve.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirtyCount > 0 ? (
            <span className="text-xs font-bold text-slate-500">
              {formatNumberValue(dirtyCount)} unsaved
            </span>
          ) : null}
          <Button
            className="bg-orange-500 text-white hover:bg-orange-600"
            disabled={saving || dirtyCount === 0}
            onClick={() => void save()}
          >
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
            Save {dirtyCount > 0 ? `(${formatNumberValue(dirtyCount)})` : ""}
          </Button>
        </div>
      </div>

      {saveMessage ? (
        <div className="border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-800">
          {saveMessage}
        </div>
      ) : null}

      <div className="flex gap-1 border-b border-[#e4e9ec]">
        {([
          { key: "pending", label: "Pending", count: pending.length, icon: Inbox },
          { key: "approved", label: "Approved", count: approved.length, icon: CheckCircle2 },
          { key: "rejected", label: "Rejected", count: rejected.length, icon: XCircle },
        ] as const).map(({ key, label, count, icon: Icon }) => (
          <button
            className={cn(
              "flex items-center gap-2 whitespace-nowrap px-4 pb-2.5 pt-1 text-sm font-bold transition-colors",
              tab === key
                ? "border-b-2 border-orange-500 text-slate-900"
                : "border-b-2 border-transparent text-slate-400 hover:text-slate-600",
            )}
            key={key}
            onClick={() => setTab(key)}
            type="button"
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
            <span
              className={cn(
                "inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-black leading-none",
                tab === key ? "bg-orange-500 text-white" : "bg-slate-200/80 text-slate-500",
              )}
            >
              {formatNumberValue(count)}
            </span>
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(300px,360px)_1fr]">
        {/* Left: scannable list */}
        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="h-10 w-full border border-[#e4e9ec] bg-white pl-9 pr-3 text-sm text-slate-900 focus:border-orange-400 focus:outline-none"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search employee, HR ID, trip, destination…"
              value={search}
            />
          </div>

          {loading ? (
            <p className="flex items-center gap-2 border border-[#e4e9ec] bg-white px-4 py-8 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading trips…
            </p>
          ) : loadError ? (
            <div className="border border-rose-200 bg-rose-50 px-4 py-6 text-sm text-rose-700">
              {loadError}
              <button
                className="ml-2 font-bold underline"
                onClick={() => {
                  setLoading(true);
                  setLoadError(null);
                  void load();
                }}
                type="button"
              >
                Retry
              </button>
            </div>
          ) : activeList.length === 0 ? (
            <p className="border border-[#e4e9ec] bg-white px-4 py-8 text-center text-sm text-slate-500">
              {tab === "pending" ? "Nothing waiting for approval." : "No approved trips yet."}
            </p>
          ) : (
            <div className="max-h-[70vh] space-y-2 overflow-y-auto pr-1">
              {activeList.map((record) => {
                const decision = decisionFor(record);
                const adjusted = Math.abs(decision.approvedAmount - record.total) > 0.5;
                const isSelected = record.tripId === selectedId;
                return (
                  <button
                    className={cn(
                      "flex w-full items-center justify-between gap-3 border bg-white px-4 py-3 text-left transition-colors",
                      isSelected
                        ? "border-orange-400 bg-orange-50/50 ring-1 ring-inset ring-orange-200"
                        : "border-[#e4e9ec] hover:border-orange-300 hover:bg-orange-50/30",
                    )}
                    key={record.tripId}
                    onClick={() => setSelectedId(record.tripId)}
                    type="button"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-slate-900">{record.specialist || "Unassigned"}</p>
                      <p className="truncate text-xs text-slate-500">
                        {record.tripId} · {record.location || record.to || "—"}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-400">{formatDateValue(record.date)}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-mono text-sm font-bold text-slate-900">{egp(decision.approvedAmount)}</p>
                      {adjusted ? (
                        <p className="font-mono text-[10px] text-orange-600 line-through">{egp(record.total)}</p>
                      ) : null}
                      {decision.hrApproved ? (
                        <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-bold text-emerald-600">
                          <CheckCircle2 className="h-3 w-3" /> Approved
                        </span>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: focused decision panel */}
        <div className="min-h-[300px] border border-[#e4e9ec] bg-white">
          {!selected ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center text-slate-400">
              <Inbox className="h-8 w-8" />
              <p className="text-sm font-medium">Select a trip to review and approve.</p>
            </div>
          ) : (
            <ExpenseDecisionPanel
              key={selected.tripId}
              decision={decisionFor(selected)}
              onApprove={() => {
                // Also clears a stale "Rejected" status, so a row can never be approved AND
                // rejected at once.
                setDecision(selected, { hrApproved: true, status: APPROVED_STATUS });
                selectNextPending(selected.tripId);
              }}
              onChangeAmount={(value) => setDecision(selected, { approvedAmount: value })}
              onChangeReason={(value) => setDecision(selected, { hrComment: value })}
              onReject={() => {
                setDecision(selected, { hrApproved: false, status: REJECTED_STATUS });
                selectNextPending(selected.tripId);
              }}
              onUnapprove={() => setDecision(selected, { hrApproved: false, status: "" })}
              onUnreject={() => setDecision(selected, { hrApproved: false, status: "" })}
              record={selected}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{label}</p>
      <p className="mt-0.5 whitespace-nowrap text-sm font-semibold text-slate-900">{value || "—"}</p>
    </div>
  );
}

function ExpenseDecisionPanel({
  record,
  decision,
  onApprove,
  onReject,
  onUnapprove,
  onUnreject,
  onChangeAmount,
  onChangeReason,
}: {
  decision: Decision;
  onApprove: () => void;
  onChangeAmount: (value: number) => void;
  onChangeReason: (value: string) => void;
  onReject: () => void;
  onUnapprove: () => void;
  onUnreject: () => void;
  record: LoadedRecord;
}) {
  const adjusted = Math.abs(decision.approvedAmount - record.total) > 0.5;
  const reasonMissing = adjusted && !decision.hrComment.trim();
  const isRejected = isRejectedStatus(decision.status);
  // A rejection the employee cannot be given a reason for is not defensible, so it is gated the
  // same way a changed amount is.
  const rejectReasonMissing = !decision.hrComment.trim();

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[#e4e9ec] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-black tracking-tight text-slate-900">{record.specialist || "Unassigned"}</h2>
            <p className="mt-0.5 font-mono text-xs text-slate-500">
              {record.hrId ? record.hrId : "HR ID not mapped"} · {record.tripId}
            </p>
          </div>
          {decision.hrApproved ? (
            <Badge variant="success">Approved</Badge>
          ) : (
            <Badge variant="warning">Pending</Badge>
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Fact label="Expense type" value={record.requestType} />
          <Fact label="Trip" value={record.tripType} />
          <Fact label="Start" value={formatDateValue(record.date)} />
          <Fact label="End" value={formatDateValue(record.toDate)} />
          <Fact label="Transport" value={record.transportationType} />
          <Fact label="Distance" value={record.km ? `${formatNumberValue(record.km)} km` : "—"} />
          <div className="col-span-2 sm:col-span-2">
            <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">Route</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="whitespace-nowrap">{record.from || "—"}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="whitespace-nowrap">{record.location || record.to || "—"}</span>
            </p>
          </div>
          <div className="col-span-2 border-t border-[#e4e9ec] pt-3 sm:col-span-4">
            <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">Cost breakdown</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-sm text-slate-700">
              <span>Travel <b className="text-slate-900">{egp(record.travelCost)}</b></span>
              <span>Meeting <b className="text-slate-900">{egp(record.meetingAmount)}</b></span>
              <span>Allowance <b className="text-slate-900">{egp(record.allowance)}</b></span>
              {record.other ? (
                <span>Other <b className="text-slate-900">{egp(record.other)}</b></span>
              ) : null}
              <span className="text-slate-400">=</span>
              <span>Total <b className="text-slate-900">{egp(record.total)}</b></span>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-5 px-5 py-4">
        {/* Verified workload */}
        <TripWorkloadEvidencePanel
          declaredAm={record.amWorkload}
          declaredPm={record.pmWorkload}
          hrId={record.hrId ?? null}
          tripEndDate={record.toDate || record.date}
          tripStartDate={record.date}
        />

        {/* Attachments (Phoenix-submitted trips carry the ticket/receipt picture or PDF) */}
        <div>
          <p className="mb-2 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Attachment</p>
          <TripAttachments tripId={record.tripId} />
        </div>

        {/* Amount + reason */}
        <div className="border border-[#e4e9ec] bg-slate-50/60 p-4">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">Claimed</p>
              <p className="mt-1 font-mono text-lg font-bold text-slate-900">{egp(record.total)}</p>
            </div>
            <ArrowRight className="mb-1 h-4 w-4 text-slate-300" />
            <div>
              <label className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400" htmlFor={`amt-${record.tripId}`}>
                Approved amount
              </label>
              <input
                className={cn(
                  "mt-1 h-10 w-36 border bg-white px-3 text-right font-mono text-sm font-bold text-slate-900 focus:outline-none",
                  adjusted ? "border-orange-400" : "border-[#e4e9ec] focus:border-orange-400",
                )}
                id={`amt-${record.tripId}`}
                inputMode="decimal"
                min={0}
                onChange={(event) => onChangeAmount(Number(event.target.value) || 0)}
                type="number"
                value={String(decision.approvedAmount)}
              />
            </div>
            {adjusted ? (
              <Badge variant="warning">Adjusted from {egp(record.total)}</Badge>
            ) : null}
          </div>
          <div className="mt-3">
            <label className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400" htmlFor={`reason-${record.tripId}`}>
              Reason / comment{" "}
              {adjusted ? (
                <span className="text-rose-500">(required for a changed amount)</span>
              ) : (
                <span className="text-slate-400">(required to reject)</span>
              )}
            </label>
            <input
              className={cn(
                "mt-1 h-10 w-full border bg-white px-3 text-sm text-slate-900 focus:outline-none",
                reasonMissing ? "border-rose-400" : "border-[#e4e9ec] focus:border-orange-400",
              )}
              id={`reason-${record.tripId}`}
              onChange={(event) => onChangeReason(event.target.value)}
              placeholder={
                adjusted ? "Why is the approved amount different?" : "Optional to approve · required to reject"
              }
              value={decision.hrComment}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {decision.hrApproved ? (
            <Button onClick={onUnapprove} variant="secondary">
              <Undo2 className="mr-2 h-4 w-4" /> Unapprove
            </Button>
          ) : isRejected ? (
            <>
              <Badge variant="danger">Rejected</Badge>
              <Button onClick={onUnreject} variant="secondary">
                <Undo2 className="mr-2 h-4 w-4" /> Undo rejection
              </Button>
            </>
          ) : (
            <>
              <Button
                className="bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
                disabled={reasonMissing}
                onClick={onApprove}
              >
                <Check className="mr-2 h-4 w-4" /> Approve
              </Button>
              <Button
                className="bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-60"
                disabled={rejectReasonMissing}
                onClick={onReject}
              >
                <XCircle className="mr-2 h-4 w-4" /> Reject
              </Button>
            </>
          )}
          {adjusted ? (
            <Button onClick={() => onChangeAmount(record.total)} variant="secondary">
              <RotateCcw className="mr-2 h-4 w-4" /> Reset amount
            </Button>
          ) : null}
          {reasonMissing ? (
            <span className="text-xs font-semibold text-rose-600">Add a reason to approve a changed amount.</span>
          ) : !decision.hrApproved && !isRejected && rejectReasonMissing ? (
            <span className="text-xs font-semibold text-slate-500">Add a reason to reject this trip.</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
