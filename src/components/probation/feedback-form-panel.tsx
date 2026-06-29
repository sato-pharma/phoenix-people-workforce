"use client";

import { useEffect, useState } from "react";
import { CheckCircle, MessageSquare, Send, ChevronDown } from "lucide-react";

import type {
  FeedbackEligibility,
  FeedbackRecommendation,
  FeedbackSubmission,
} from "@/lib/probation/feedback-service";

type Props = {
  employeeHrId: string;
  employeeName: string;
  onClose?: () => void;
};

const RECOMMENDATION_LABELS: Record<FeedbackRecommendation, string> = {
  recommend_pass: "Recommend Pass",
  recommend_dismissal: "Recommend Dismissal",
  not_sure_yet: "Not Sure Yet",
};

const RECOMMENDATION_COLORS: Record<FeedbackRecommendation, string> = {
  recommend_pass: "text-emerald-700 bg-emerald-50 border-emerald-200",
  recommend_dismissal: "text-rose-700 bg-rose-50 border-rose-200",
  not_sure_yet: "text-amber-700 bg-amber-50 border-amber-200",
};

const ROLE_LABELS: Record<string, string> = {
  dm: "District Manager",
  nsm: "National Sales Manager",
  tm: "Training Manager",
  pm_gpm: "PM / GPM",
};

export function FeedbackFormPanel({ employeeHrId, employeeName, onClose }: Props) {
  const [eligibility, setEligibility] = useState<FeedbackEligibility | null>(null);
  const [submissions, setSubmissions] = useState<FeedbackSubmission[]>([]);
  const [loading, setLoading] = useState(true);

  const [feedbackText, setFeedbackText] = useState("");
  const [recommendation, setRecommendation] = useState<FeedbackRecommendation | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  const [commentText, setCommentText] = useState<Record<string, string>>({});
  const [addingComment, setAddingComment] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/probation/feedback/employee/${encodeURIComponent(employeeHrId)}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        setEligibility(data.eligibility ?? null);
        setSubmissions(data.submissions ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [employeeHrId, submitSuccess]);

  async function handleSubmit() {
    if (!feedbackText.trim() || !recommendation) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/probation/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeHrId, feedbackText, recommendation }),
      });
      if (res.ok) {
        setSubmitSuccess(prev => !prev);
        setFeedbackText("");
        setRecommendation("");
      } else {
        const data = await res.json();
        setSubmitError(data.error ?? "Failed to submit feedback.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleComment(submissionId: string) {
    const text = commentText[submissionId]?.trim();
    if (!text) return;
    setAddingComment(prev => ({ ...prev, [submissionId]: true }));
    try {
      const res = await fetch(`/api/probation/feedback/${submissionId}/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commentText: text }),
      });
      if (res.ok) {
        setCommentText(prev => ({ ...prev, [submissionId]: "" }));
        setSubmitSuccess(prev => !prev);
      }
    } finally {
      setAddingComment(prev => ({ ...prev, [submissionId]: false }));
    }
  }

  if (loading) {
    return (
      <div className="p-6 text-sm text-slate-500">Loading feedback data…</div>
    );
  }

  const cycleLabel = eligibility
    ? `Cycle ${eligibility.currentCycleNumber} of 3`
    : null;

  const canSubmit = eligibility?.eligible && !eligibility.alreadySubmittedForCycle &&
    !(eligibility.isOnceOnly && eligibility.alreadySubmittedOnce);

  const recommendations: FeedbackRecommendation[] = ["recommend_pass", "recommend_dismissal", "not_sure_yet"];

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{employeeName}</h3>
          {cycleLabel && (
            <p className="mt-0.5 text-xs text-slate-500">{cycleLabel}</p>
          )}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="text-xs text-slate-400 hover:text-slate-700 whitespace-nowrap"
          >
            Close
          </button>
        )}
      </div>

      {/* Submission form */}
      {canSubmit && (
        <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-medium text-slate-700 uppercase tracking-wide">
            Your assessment
          </p>
          <textarea
            value={feedbackText}
            onChange={e => setFeedbackText(e.target.value)}
            placeholder="Write your observations on this employee's performance and conduct during probation… (min 10 characters)"
            rows={4}
            className="w-full rounded border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-orange-400 resize-none"
          />
          <div className="relative">
            <select
              value={recommendation}
              onChange={e => setRecommendation(e.target.value as FeedbackRecommendation)}
              className="w-full appearance-none rounded border border-slate-200 bg-white px-3 py-2 pr-8 text-sm text-slate-900 focus:outline-none focus:ring-1 focus:ring-orange-400"
            >
              <option value="">Select recommendation…</option>
              {recommendations.map(r => (
                <option key={r} value={r}>{RECOMMENDATION_LABELS[r]}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-slate-400" />
          </div>
          {submitError && (
            <p className="text-xs text-rose-600">{submitError}</p>
          )}
          <button
            disabled={submitting || feedbackText.trim().length < 10 || !recommendation}
            onClick={handleSubmit}
            className="flex items-center gap-2 self-end rounded bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
          >
            <Send className="size-4" />
            {submitting ? "Submitting…" : "Submit feedback"}
          </button>
        </div>
      )}

      {/* Already-submitted notice */}
      {eligibility && !canSubmit && eligibility.eligible === false && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
          <CheckCircle className="size-4 shrink-0" />
          {eligibility.isOnceOnly
            ? "You have already submitted your feedback for this probation period."
            : "You have already submitted feedback for this cycle."}
        </div>
      )}

      {/* Not eligible notice */}
      {eligibility && !eligibility.submitterRole && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          You are not currently eligible to submit probation feedback for this employee.
        </div>
      )}

      {/* Existing submissions */}
      {submissions.length > 0 && (
        <div className="flex flex-col gap-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Submitted feedback
          </p>
          {submissions.map(sub => (
            <div key={sub.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-2 mb-2">
                <span className="text-xs font-medium text-slate-700">
                  {ROLE_LABELS[sub.submitterRole] ?? sub.submitterRole} — Cycle {sub.cycleNumber}
                </span>
                <span
                  className={`rounded border px-2 py-0.5 text-xs font-medium ${RECOMMENDATION_COLORS[sub.recommendation]}`}
                >
                  {RECOMMENDATION_LABELS[sub.recommendation]}
                </span>
              </div>
              <p className="text-sm text-slate-800 whitespace-pre-wrap">{sub.feedbackText}</p>
              <p className="mt-1 text-xs text-slate-400">
                {new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(sub.submittedAt))}
              </p>

              {/* Comments thread */}
              {sub.comments.length > 0 && (
                <div className="mt-3 flex flex-col gap-2 border-t border-slate-100 pt-3">
                  {sub.comments.map(c => (
                    <div key={c.id} className="text-xs">
                      <span className="font-medium text-slate-700">{c.commenterName ?? c.commenterHrId}: </span>
                      <span className="text-slate-600">{c.commentText}</span>
                      <span className="ml-2 text-slate-400">
                        {new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "short" }).format(new Date(c.createdAt))}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Add comment */}
              <div className="mt-3 flex gap-2">
                <input
                  value={commentText[sub.id] ?? ""}
                  onChange={e => setCommentText(prev => ({ ...prev, [sub.id]: e.target.value }))}
                  placeholder="Add a follow-up comment…"
                  className="flex-1 rounded border border-slate-200 px-2 py-1 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-orange-400"
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) handleComment(sub.id); }}
                />
                <button
                  disabled={!commentText[sub.id]?.trim() || addingComment[sub.id]}
                  onClick={() => handleComment(sub.id)}
                  className="flex items-center gap-1 rounded bg-slate-100 px-2 py-1 text-xs text-slate-600 hover:bg-slate-200 disabled:opacity-50"
                >
                  <MessageSquare className="size-3" />
                  {addingComment[sub.id] ? "…" : "Send"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
