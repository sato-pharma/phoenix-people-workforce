"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CalendarDays, CheckCircle2, Clock4, MessageSquareWarning, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { DigestDetailView, DigestLineView, DigestSummaryView } from "@/lib/attendance/digest-read";

type Props = {
  initialDigests: DigestSummaryView[];
  initialError: string | null;
};

// A digest never actually reaches the employee's own list while it's 'draft'
// or 'pending_admin_review' (digest-read.ts filters both out server-side) —
// these two entries exist only so the Record type stays exhaustive.
const statusLabel: Record<DigestSummaryView["status"], string> = {
  auto_confirmed: "Auto-confirmed",
  draft: "Preparing",
  pending_admin_review: "Preparing",
  sent: "Awaiting you",
  settled: "Settled",
  void: "Void",
};

const statusTone: Record<DigestSummaryView["status"], "neutral" | "warning" | "success" | "danger"> = {
  auto_confirmed: "warning",
  draft: "neutral",
  pending_admin_review: "neutral",
  sent: "warning",
  settled: "success",
  void: "neutral",
};

const missingPunchStatusLabel: Record<Exclude<DigestLineView["missingPunchStatus"], null> | "awaiting_employee", string> = {
  awaiting_ceo: "Awaiting CEO",
  awaiting_employee: "Needs your reason",
  awaiting_hr: "Awaiting HR",
  awaiting_verifier: "Awaiting verifier",
  fully_verified: "Verified",
  rejected: "Rejected",
};

const lineStatusLabel: Record<DigestLineView["status"], string> = {
  late: "Late arrival",
  missing_punch: "Missing punch",
  short_hours: "Short hours",
};

function formatMoney(value: number, currency: string) {
  return `${value.toFixed(2)} ${currency}`;
}

function formatDate(iso: string) {
  const date = new Date(`${iso}T00:00:00`);
  return date.toLocaleDateString(undefined, { day: "2-digit", month: "short", weekday: "short" });
}

function countdownLabel(autoConfirmAt: string | null) {
  if (!autoConfirmAt) return null;
  const diffMs = new Date(autoConfirmAt).getTime() - Date.now();
  if (diffMs <= 0) return "Auto-confirming now";
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  const minutes = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000));
  return `${hours}h ${minutes}m left to confirm or dispute`;
}

export function WeeklyDigestPortal({ initialDigests, initialError }: Props) {
  const [digests, setDigests] = useState(initialDigests);
  const [selectedId, setSelectedId] = useState<number | null>(initialDigests[0]?.id ?? null);
  const [detail, setDetail] = useState<DigestDetailView | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busyLineId, setBusyLineId] = useState<number | null>(null);
  const [disputingLineId, setDisputingLineId] = useState<number | null>(null);
  const [missingPunchLineId, setMissingPunchLineId] = useState<number | null>(null);
  const [missingPunchReason, setMissingPunchReason] = useState("");
  const [missingPunchProof, setMissingPunchProof] = useState("");
  const [disputeReason, setDisputeReason] = useState("");
  const [disputeAttachment, setDisputeAttachment] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedSummary = useMemo(() => digests.find((digest) => digest.id === selectedId) ?? null, [digests, selectedId]);
  const pendingLines = useMemo(() => (detail?.lines ?? []).filter((line) => line.action === "pending" && line.deductionDays > 0), [detail]);
  const cycleTotal = useMemo(
    () => digests.filter((digest) => digest.cycleKey === selectedSummary?.cycleKey).reduce((sum, digest) => sum + digest.totalDeductionValue, 0),
    [digests, selectedSummary],
  );

  async function loadDetail(digestId: number) {
    setSelectedId(digestId);
    setDetail(null);
    setLoadingDetail(true);
    setError(null);
    try {
      const response = await fetch(`/api/attendance/digests/${digestId}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Digest failed to load.");
      setDetail(payload.digest as DigestDetailView);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Digest failed to load.");
    } finally {
      setLoadingDetail(false);
    }
  }

  function refreshDigestFromDetail(updated: DigestDetailView) {
    setDetail(updated);
    setDigests((current) =>
      current.map((digest) =>
        digest.id === updated.id
          ? { ...digest, status: updated.status, totalDeductionDays: updated.totalDeductionDays, totalDeductionValue: updated.totalDeductionValue }
          : digest,
      ),
    );
  }

  async function reloadDetail(digestId: number) {
    const response = await fetch(`/api/attendance/digests/${digestId}`, { cache: "no-store" });
    const payload = await response.json();
    if (response.ok) refreshDigestFromDetail(payload.digest as DigestDetailView);
  }

  async function confirmLines(digestId: number, lineIds: number[]) {
    if (lineIds.length === 0) return;
    setBusyLineId(lineIds.length === 1 ? lineIds[0] : -1);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/attendance/digests/${digestId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineIds }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Confirmation failed.");
      setNotice(lineIds.length === 1 ? "Day confirmed." : "Week confirmed.");
      await reloadDetail(digestId);
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "Confirmation failed.");
    } finally {
      setBusyLineId(null);
    }
  }

  function startDispute(lineId: number) {
    setDisputingLineId(lineId);
    setDisputeReason("");
    setDisputeAttachment("");
  }

  async function submitDispute(digestId: number) {
    if (!disputingLineId || !disputeReason.trim()) return;
    setBusyLineId(disputingLineId);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/attendance/digests/${digestId}/dispute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachmentUrl: disputeAttachment.trim() || null, lineId: disputingLineId, reason: disputeReason.trim() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Dispute failed to submit.");
      setNotice("Dispute submitted for review.");
      setDisputingLineId(null);
      await reloadDetail(digestId);
    } catch (disputeError) {
      setError(disputeError instanceof Error ? disputeError.message : "Dispute failed to submit.");
    } finally {
      setBusyLineId(null);
    }
  }

  function startMissingPunch(lineId: number) {
    setMissingPunchLineId(lineId);
    setMissingPunchReason("");
    setMissingPunchProof("");
  }

  async function submitMissingPunch(digestId: number) {
    if (!missingPunchLineId || !missingPunchReason.trim()) return;
    setBusyLineId(missingPunchLineId);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/attendance/digests/${digestId}/missing-punch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineId: missingPunchLineId, proofUrl: missingPunchProof.trim() || null, reason: missingPunchReason.trim() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Reason failed to submit.");
      setNotice("Reason submitted — the standing verifier will confirm next.");
      setMissingPunchLineId(null);
      await reloadDetail(digestId);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Reason failed to submit.");
    } finally {
      setBusyLineId(null);
    }
  }

  return (
    <div className="space-y-5">
      {error ? (
        <Card className="border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">{error}</Card>
      ) : null}
      {notice ? (
        <Card className="border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-700">{notice}</Card>
      ) : null}

      {digests.length === 0 ? (
        <Card className="p-6 text-sm font-semibold text-slate-500">
          No weekly digests yet. Your first one appears after your first settlement week closes.
        </Card>
      ) : (
        <div className="flex flex-wrap gap-2">
          {digests.map((digest) => (
            <button
              className={`rounded-xl border px-4 py-3 text-left transition ${
                digest.id === selectedId ? "border-orange-400 bg-orange-50" : "border-slate-200 bg-white hover:border-slate-300"
              }`}
              key={digest.id}
              type="button"
              onClick={() => loadDetail(digest.id)}
            >
              <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                Week {digest.weekIndex} &middot; {digest.cycleKey}
              </p>
              <p className="mt-1 text-sm font-black text-slate-900">{formatDate(digest.weekStart)} – {formatDate(digest.weekEnd)}</p>
              <div className="mt-2 flex items-center gap-2">
                <Badge variant={statusTone[digest.status]}>{statusLabel[digest.status]}</Badge>
                <span className="text-xs font-black text-slate-700">{formatMoney(digest.totalDeductionValue, digest.currency)}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {loadingDetail ? <Card className="p-6 text-sm font-semibold text-slate-500">Loading…</Card> : null}

      {detail && !loadingDetail ? (
        <Card className="space-y-5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="flex items-center gap-2 text-lg font-black text-slate-950">
                <CalendarDays className="h-5 w-5 text-orange-500" />
                Week {detail.weekIndex} — {formatDate(detail.weekStart)} to {formatDate(detail.weekEnd)}
              </p>
              <p className="mt-1 text-sm font-semibold text-slate-500">Cycle {detail.cycleKey}</p>
            </div>
            <div className="text-right">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">This week</p>
              <p className="text-xl font-black text-slate-950">{formatMoney(detail.totalDeductionValue, detail.currency)}</p>
              <p className="text-xs font-semibold text-slate-500">Cycle running total: {formatMoney(cycleTotal, detail.currency)}</p>
            </div>
          </div>

          {detail.status === "sent" && detail.autoConfirmAt ? (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-black text-amber-800">
              <Clock4 className="h-4 w-4" />
              {countdownLabel(detail.autoConfirmAt)} — silence auto-confirms to salary, no further reminder.
            </div>
          ) : null}

          {detail.lines.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-black text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />
              Clean week — nothing to settle.
            </div>
          ) : (
            <div className="space-y-3">
              {pendingLines.length > 1 ? (
                <div className="flex justify-end">
                  <Button
                    disabled={busyLineId !== null}
                    type="button"
                    onClick={() => confirmLines(detail.id, pendingLines.map((line) => line.id))}
                  >
                    {busyLineId === -1 ? "Confirming…" : `Confirm all ${pendingLines.length} pending days`}
                  </Button>
                </div>
              ) : null}

              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full min-w-[720px] border-separate border-spacing-0 text-left text-sm">
                  <thead className="bg-slate-900 text-[11px] font-black uppercase tracking-[0.14em] text-white">
                    <tr>
                      <th className="px-4 py-2.5">Date</th>
                      <th className="px-4 py-2.5">Situation</th>
                      <th className="px-4 py-2.5">Quantity</th>
                      <th className="px-4 py-2.5">Value</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => (
                      <tr className="border-t border-slate-100" key={line.id}>
                        <td className="px-4 py-3 font-semibold text-slate-800">{formatDate(line.workDate)}</td>
                        <td className="px-4 py-3 text-slate-700">
                          {lineStatusLabel[line.status]}
                          {line.lateMinutes > 0 ? ` — ${line.lateMinutes} min late` : ""}
                          {line.shortMinutes > 0 ? ` — ${line.shortMinutes} min short` : ""}
                          <p className="text-xs font-medium text-slate-400">{line.reason}</p>
                        </td>
                        <td className="px-4 py-3 font-black tabular-nums text-slate-800">{line.deductionDays || "—"}</td>
                        <td className="px-4 py-3 font-black tabular-nums text-slate-800">
                          {line.deductionValue > 0 ? formatMoney(line.deductionValue, detail.currency) : "—"}
                        </td>
                        <td className="px-4 py-3">
                          {line.status === "missing_punch" ? (
                            <Badge variant={line.missingPunchStatus === "fully_verified" ? "success" : line.missingPunchStatus === "rejected" ? "danger" : "warning"}>
                              {missingPunchStatusLabel[line.missingPunchStatus ?? "awaiting_employee"]}
                            </Badge>
                          ) : (
                            <Badge variant={line.action === "pending" ? "warning" : line.action === "disputed" ? "neutral" : "success"}>
                              {line.action === "pending" ? "Needs action" : line.action.replace("_", " ")}
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {line.status === "missing_punch" ? (
                            line.missingPunchStatus === null || line.missingPunchStatus === "rejected" ? (
                              <Button disabled={busyLineId !== null} type="button" variant="secondary" onClick={() => startMissingPunch(line.id)}>
                                {line.missingPunchStatus === "rejected" ? "Resubmit reason" : "Submit reason"}
                              </Button>
                            ) : (
                              <span className="text-xs font-bold text-slate-400">No action needed — verification in progress</span>
                            )
                          ) : line.action === "pending" && line.deductionDays > 0 ? (
                            <div className="flex gap-2">
                              <Button
                                disabled={busyLineId !== null}
                                type="button"
                                onClick={() => confirmLines(detail.id, [line.id])}
                              >
                                {busyLineId === line.id ? "…" : "Confirm"}
                              </Button>
                              <Button disabled={busyLineId !== null} type="button" variant="secondary" onClick={() => startDispute(line.id)}>
                                Dispute
                              </Button>
                            </div>
                          ) : line.action === "disputed" ? (
                            <span className="flex items-center gap-1 text-xs font-bold text-slate-500">
                              <MessageSquareWarning className="h-3.5 w-3.5" />
                              Under review
                            </span>
                          ) : (
                            <span className="text-xs font-bold text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {disputingLineId ? (
                <Card className="space-y-3 border-orange-200 bg-orange-50/50 p-4">
                  <p className="flex items-center gap-2 text-sm font-black text-slate-900">
                    <AlertTriangle className="h-4 w-4 text-orange-500" />
                    Dispute {formatDate(detail.lines.find((line) => line.id === disputingLineId)?.workDate ?? "")}
                  </p>
                  <label className="block space-y-1.5">
                    <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Reason (required)</span>
                    <textarea
                      className="h-24 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 shadow-inner outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                      value={disputeReason}
                      onChange={(event) => setDisputeReason(event.target.value)}
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Attachment URL (optional)</span>
                    <input
                      className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900 shadow-inner outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                      placeholder="https://…"
                      value={disputeAttachment}
                      onChange={(event) => setDisputeAttachment(event.target.value)}
                    />
                  </label>
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={() => setDisputingLineId(null)}>Cancel</Button>
                    <Button disabled={!disputeReason.trim() || busyLineId !== null} type="button" onClick={() => submitDispute(detail.id)}>
                      {busyLineId === disputingLineId ? "Submitting…" : "Submit Dispute"}
                    </Button>
                  </div>
                </Card>
              ) : null}

              {missingPunchLineId ? (
                <Card className="space-y-3 border-orange-200 bg-orange-50/50 p-4">
                  <p className="flex items-center gap-2 text-sm font-black text-slate-900">
                    <AlertTriangle className="h-4 w-4 text-orange-500" />
                    Missing punch — {formatDate(detail.lines.find((line) => line.id === missingPunchLineId)?.workDate ?? "")}
                  </p>
                  <p className="text-xs font-medium text-slate-500">
                    Explain why there&apos;s no punch that day. This is verified by the office coordinator, then HR, then the CEO — it never
                    creates a salary deduction.
                  </p>
                  <label className="block space-y-1.5">
                    <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Reason (required)</span>
                    <textarea
                      className="h-24 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 shadow-inner outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                      value={missingPunchReason}
                      onChange={(event) => setMissingPunchReason(event.target.value)}
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Proof URL (optional)</span>
                    <input
                      className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900 shadow-inner outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                      placeholder="https://…"
                      value={missingPunchProof}
                      onChange={(event) => setMissingPunchProof(event.target.value)}
                    />
                  </label>
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={() => setMissingPunchLineId(null)}>Cancel</Button>
                    <Button disabled={!missingPunchReason.trim() || busyLineId !== null} type="button" onClick={() => submitMissingPunch(detail.id)}>
                      {busyLineId === missingPunchLineId ? "Submitting…" : "Submit Reason"}
                    </Button>
                  </div>
                </Card>
              ) : null}
            </div>
          )}

          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-500">
            <Wallet className="h-4 w-4" />
            Confirmed and auto-confirmed deductions apply to salary (÷30 per day) via the audited payroll pipeline.
          </div>
        </Card>
      ) : null}
    </div>
  );
}
