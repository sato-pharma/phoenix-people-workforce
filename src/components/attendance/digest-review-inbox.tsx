"use client";

import { useState } from "react";
import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import type { PendingDigestReviewView } from "@/lib/attendance/digest-read";

type Props = {
  initialDigests: PendingDigestReviewView[];
  initialError: string | null;
};

type LineDraft = { deductionDays: string; deductionValue: string; reason: string };

function formatDate(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function formatClock(minutes: number | null): string {
  if (minutes === null) return "—";
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}h ${remainder}m`;
}

function initDrafts(digest: PendingDigestReviewView): Record<number, LineDraft> {
  const drafts: Record<number, LineDraft> = {};
  for (const line of digest.lines) {
    if (line.deductionDays <= 0) continue;
    drafts[line.id] = {
      deductionDays: String(line.deductionDays),
      deductionValue: String(line.deductionValue),
      reason: line.reason,
    };
  }
  return drafts;
}

export function DigestReviewInbox({ initialDigests, initialError }: Props) {
  const [digests, setDigests] = useState(initialDigests);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyDigestId, setBusyDigestId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, Record<number, LineDraft>>>(() =>
    Object.fromEntries(initialDigests.map((digest) => [digest.id, initDrafts(digest)])),
  );

  function updateDraft(digestId: number, lineId: number, patch: Partial<LineDraft>) {
    setDrafts((current) => ({
      ...current,
      [digestId]: { ...current[digestId], [lineId]: { ...current[digestId]?.[lineId], ...patch } as LineDraft },
    }));
  }

  async function approve(digest: PendingDigestReviewView) {
    setBusyDigestId(digest.id);
    setError(null);
    setNotice(null);
    try {
      const lineEdits = Object.entries(drafts[digest.id] ?? {}).map(([lineId, draft]) => ({
        deductionDays: Number(draft.deductionDays),
        deductionValue: Number(draft.deductionValue),
        lineId: Number(lineId),
        reason: draft.reason,
      }));
      const response = await fetch(`/api/attendance/digest-review/${digest.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineEdits }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Digest review approval failed.");
      setDigests((current) => current.filter((entry) => entry.id !== digest.id));
      setNotice(`Approved and sent to ${digest.employeeName}.`);
    } catch (approveError) {
      setError(approveError instanceof Error ? approveError.message : "Digest review approval failed.");
    } finally {
      setBusyDigestId(null);
    }
  }

  async function voidDigest(digest: PendingDigestReviewView) {
    const reason = window.prompt(`Why are you voiding ${digest.employeeName}'s digest? (the employee will never see it)`);
    if (!reason || !reason.trim()) return;
    setBusyDigestId(digest.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/attendance/digest-review/${digest.id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Digest void failed.");
      setDigests((current) => current.filter((entry) => entry.id !== digest.id));
      setNotice(`Voided ${digest.employeeName}'s digest — never sent.`);
    } catch (voidError) {
      setError(voidError instanceof Error ? voidError.message : "Digest void failed.");
    } finally {
      setBusyDigestId(null);
    }
  }

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={<AdminInsightChip tone="orange">{digests.length} awaiting review</AdminInsightChip>}
        description="Every digest with a real deduction stops here first — it never reaches the employee until you approve it (edits optional). A clean week skips this and sends automatically."
        eyebrow="Attendance"
        icon={<ShieldAlert className="h-3.5 w-3.5" />}
        title="Weekly Digest Review"
      />

      {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
      {notice ? <AdminCallout tone="neutral">{notice}</AdminCallout> : null}

      <AdminTableShell description="Either the HR Manager or the System Administrator may act — first to decide wins." title="Pending Review">
        {digests.length === 0 ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">Nothing waiting on review.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {digests.map((digest) => {
              const draftLines = drafts[digest.id] ?? {};
              return (
                <div className="space-y-3 p-4" key={digest.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-black text-slate-950">{digest.employeeName} ({digest.employeeHrId})</p>
                      <p className="text-xs font-semibold text-slate-500">
                        Week {digest.weekIndex} &middot; {digest.weekStart} to {digest.weekEnd} &middot; {digest.totalDeductionDays} day(s) &middot;{" "}
                        {digest.totalDeductionValue.toFixed(2)} EGP
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {digest.lines.filter((line) => line.deductionDays > 0).map((line) => {
                      const draft = draftLines[line.id];
                      if (!draft) return null;
                      return (
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3" key={line.id}>
                          <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">{formatDate(line.workDate)} &middot; {line.status.replace("_", " ")}</p>
                          <p className="mt-1 text-xs font-semibold text-slate-600">
                            Check-in {formatClock(line.checkInMinutes)} &middot; Check-out {formatClock(line.checkOutMinutes)} &middot; Worked {formatDuration(line.workedMinutes)}
                            {line.lateMinutes > 0 ? ` · ${line.lateMinutes} min late` : ""}
                            {line.shortMinutes > 0 ? ` · ${line.shortMinutes} min short` : ""}
                          </p>
                          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                            <label className="block space-y-1">
                              <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Days</span>
                              <input
                                className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                                type="number"
                                step="0.25"
                                min="0"
                                value={draft.deductionDays}
                                onChange={(event) => updateDraft(digest.id, line.id, { deductionDays: event.target.value })}
                              />
                            </label>
                            <label className="block space-y-1">
                              <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Value (EGP)</span>
                              <input
                                className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm font-semibold text-slate-900 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                                type="number"
                                step="0.01"
                                min="0"
                                value={draft.deductionValue}
                                onChange={(event) => updateDraft(digest.id, line.id, { deductionValue: event.target.value })}
                              />
                            </label>
                            <label className="block space-y-1 sm:col-span-1">
                              <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Reason</span>
                              <input
                                className="h-9 w-full rounded-lg border border-slate-200 px-2 text-sm font-medium text-slate-700 outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                                value={draft.reason}
                                onChange={(event) => updateDraft(digest.id, line.id, { reason: event.target.value })}
                              />
                            </label>
                          </div>
                        </div>
                      );
                    })}
                    {digest.lines.filter((line) => line.deductionDays <= 0).length > 0 ? (
                      <div className="space-y-1 rounded-lg border border-dashed border-slate-200 bg-white p-3">
                        <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-400">No deduction — for reference</p>
                        {digest.lines.filter((line) => line.deductionDays <= 0).map((line) => (
                          <p className="text-xs font-semibold text-slate-500" key={line.id}>
                            {formatDate(line.workDate)} &middot; {line.status.replace("_", " ")} &middot; Check-in {formatClock(line.checkInMinutes)} &middot; Check-out {formatClock(line.checkOutMinutes)}
                            {line.status === "missing_punch" ? " — only one punch, held for verification" : ` · Worked ${formatDuration(line.workedMinutes)}`}
                          </p>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex gap-2">
                    <Button disabled={busyDigestId !== null} type="button" onClick={() => approve(digest)}>
                      <CheckCircle2 className="h-4 w-4" />
                      {busyDigestId === digest.id ? "…" : "Approve & Send"}
                    </Button>
                    <Button disabled={busyDigestId !== null} type="button" variant="secondary" onClick={() => voidDigest(digest)}>
                      <XCircle className="h-4 w-4" />
                      Void
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </AdminTableShell>
    </div>
  );
}
