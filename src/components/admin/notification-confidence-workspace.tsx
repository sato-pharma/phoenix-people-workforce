"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronUp, ShieldAlert, X } from "lucide-react";

export type AdminConfidenceCheck = {
  detail: string;
  name: string;
  passed: boolean | null;
};

export type AdminNotificationSendReview = {
  ccAddresses: string[];
  checks: AdminConfidenceCheck[];
  confidencePercent: number;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  employeeHrId: string | null;
  eventType: string | null;
  gateBypassed: boolean;
  id: string;
  module: string | null;
  recipientHrId: string | null;
  status: "approved" | "auto_sent" | "discarded" | "held";
  subject: string;
  templateKey: string | null;
  toAddresses: string[];
};

const CHECK_LABELS: Record<string, string> = {
  content_integrity: "Content integrity",
  fanout_anomaly: "Fan-out anomaly",
  gate_enabled: "Gate enabled",
  identity_resolved: "Identity resolved",
  recipient_validity: "Recipient validity",
};

function formatWhen(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" }).format(date);
}

function statusTone(status: AdminNotificationSendReview["status"]) {
  switch (status) {
    case "auto_sent": return "bg-emerald-100 text-emerald-700";
    case "held": return "bg-red-100 text-red-700";
    case "approved": return "bg-sky-100 text-sky-700";
    case "discarded": return "bg-slate-200 text-slate-600";
    default: return "bg-slate-100 text-slate-600";
  }
}

function confidenceTone(percent: number) {
  if (percent >= 90) return "text-emerald-700";
  if (percent >= 60) return "text-amber-600";
  return "text-red-700";
}

function CheckRow({ check }: { check: AdminConfidenceCheck }) {
  const label = CHECK_LABELS[check.name] ?? check.name;
  const icon = check.passed === null ? <span className="text-slate-400">—</span> : check.passed ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <X className="h-3.5 w-3.5 text-red-600" />;
  return (
    <div className="flex items-start gap-2 py-1 text-xs">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <span className="font-bold text-slate-700">{label}</span>
        <span className="text-slate-500"> — {check.detail}</span>
      </div>
    </div>
  );
}

function ReviewRow({ review, onDecided }: { review: AdminNotificationSendReview; onDecided: (id: string, status: "approved" | "discarded") => void }) {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState<"approve" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: "approve" | "discard") {
    setSubmitting(action);
    setError(null);
    try {
      const response = await fetch(`/api/admin/notification-confidence/${review.id}/${action}`, {
        body: JSON.stringify({ note }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || `Unable to ${action} this item.`);
      onDecided(review.id, action === "approve" ? "approved" : "discarded");
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : `Unable to ${action} this item.`);
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="border border-red-200 bg-red-50/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] ${confidenceTone(review.confidencePercent)}`}>
          {review.confidencePercent}% confidence
        </span>
        <span className="whitespace-nowrap rounded-sm bg-slate-100 px-2 py-0.5 text-phx-xs font-semibold text-slate-700">
          {review.module ?? "unknown"} / {review.eventType ?? "unknown"}
        </span>
        <span className="whitespace-nowrap font-mono text-phx-xs text-slate-500">{formatWhen(review.createdAt)}</span>
        <button className="ml-auto inline-flex items-center gap-1 text-phx-xs font-bold text-slate-500 hover:text-slate-800" onClick={() => setExpanded((value) => !value)} type="button">
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          Checks
        </button>
      </div>
      <p className="mt-2 text-sm font-bold text-slate-900">{review.subject}</p>
      <p className="text-xs text-slate-600">To: {review.toAddresses.join(", ") || "(none)"}</p>

      {expanded ? (
        <div className="mt-2 border-t border-red-200 pt-2">
          {review.checks.map((check, index) => (
            <CheckRow check={check} key={`${review.id}-${index}`} />
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="mt-2 flex items-center gap-2 text-xs font-semibold text-red-800">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          className="min-w-[220px] flex-1 rounded-sm border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-900 focus:border-orange-400 focus:outline-none"
          onChange={(event) => setNote(event.target.value)}
          placeholder="Optional note"
          value={note}
        />
        <button
          className="inline-flex items-center gap-1.5 rounded-sm bg-emerald-600 px-3 py-1.5 text-xs font-black text-white transition hover:bg-emerald-700 disabled:opacity-50"
          disabled={submitting !== null}
          onClick={() => decide("approve")}
          type="button"
        >
          <Check className="h-3.5 w-3.5" />
          Approve &amp; send
        </button>
        <button
          className="inline-flex items-center gap-1.5 rounded-sm bg-slate-600 px-3 py-1.5 text-xs font-black text-white transition hover:bg-slate-700 disabled:opacity-50"
          disabled={submitting !== null}
          onClick={() => decide("discard")}
          type="button"
        >
          <X className="h-3.5 w-3.5" />
          Discard
        </button>
      </div>
    </div>
  );
}

function RecentRow({ review }: { review: AdminNotificationSendReview }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] ${statusTone(review.status)}`}>
          {review.status.replace("_", " ")}
        </span>
        <span className={`text-phx-xs font-black ${confidenceTone(review.confidencePercent)}`}>{review.confidencePercent}%</span>
        <span className="whitespace-nowrap rounded-sm bg-slate-100 px-2 py-0.5 text-phx-xs font-semibold text-slate-700">
          {review.module ?? "unknown"} / {review.eventType ?? "unknown"}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-800">{review.subject}</span>
        <span className="whitespace-nowrap font-mono text-phx-xs text-slate-500">{formatWhen(review.createdAt)}</span>
        <button className="text-slate-400 hover:text-slate-700" onClick={() => setExpanded((value) => !value)} type="button">
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>
      {expanded ? (
        <div className="mt-2 border-t border-slate-100 pt-2">
          <p className="text-xs text-slate-600">To: {review.toAddresses.join(", ") || "(none)"}</p>
          {review.decisionNote ? <p className="text-xs italic text-slate-500">Note: {review.decisionNote}</p> : null}
          {review.checks.map((check, index) => (
            <CheckRow check={check} key={`${review.id}-${index}`} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function NotificationConfidenceWorkspace({
  initialError,
  initialPending,
  initialRecent,
}: {
  initialError: string | null;
  initialPending: AdminNotificationSendReview[];
  initialRecent: AdminNotificationSendReview[];
}) {
  const [pending, setPending] = useState(initialPending);
  const [recent, setRecent] = useState(initialRecent);
  const [error] = useState(initialError);

  function handleDecided(id: string, status: "approved" | "discarded") {
    const decided = pending.find((item) => item.id === id);
    setPending((current) => current.filter((item) => item.id !== id));
    if (decided) setRecent((current) => [{ ...decided, status }, ...current]);
  }

  const stats = useMemo(() => {
    const total = recent.length;
    const held = recent.filter((item) => item.status === "held").length;
    const avgConfidence = total === 0 ? 100 : Math.round(recent.reduce((sum, item) => sum + item.confidencePercent, 0) / total);
    return { avgConfidence, held, total };
  }, [recent]);

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="border border-slate-200 bg-white p-4">
          <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">Recorded sends</p>
          <p className="mt-1 text-2xl font-black text-slate-900">{stats.total}</p>
        </div>
        <div className="border border-slate-200 bg-white p-4">
          <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">Avg. confidence</p>
          <p className={`mt-1 text-2xl font-black ${confidenceTone(stats.avgConfidence)}`}>{stats.avgConfidence}%</p>
        </div>
        <div className="border border-slate-200 bg-white p-4">
          <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">Held (in this list)</p>
          <p className="mt-1 text-2xl font-black text-red-700">{stats.held}</p>
        </div>
      </div>

      {error ? (
        <div className="flex items-center gap-2 border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : null}

      <div className="border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-slate-100 bg-red-700 px-5 py-3">
          <ShieldAlert className="h-4 w-4 text-white" />
          <h2 className="text-xs font-black uppercase tracking-[0.14em] text-white">
            {pending.length} pending your review
          </h2>
        </div>
        {pending.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-bold text-slate-500">Nothing is being held right now.</p>
          </div>
        ) : (
          <div className="space-y-2 p-3">
            {pending.map((review) => (
              <ReviewRow key={review.id} onDecided={handleDecided} review={review} />
            ))}
          </div>
        )}
      </div>

      <div className="border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-900 px-5 py-3">
          <h2 className="text-xs font-black uppercase tracking-[0.14em] text-white">
            Recent automated sends
          </h2>
        </div>
        {recent.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-bold text-slate-500">No automated emails recorded yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {recent.map((review) => (
              <RecentRow key={review.id} review={review} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
