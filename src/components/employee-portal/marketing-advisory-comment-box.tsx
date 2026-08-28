"use client";

import { useCallback, useState } from "react";
import { CheckCircle2, Send } from "lucide-react";

import { LoadingSpinner } from "@/components/ui/loading-state";

/**
 * Non-blocking advisory comment for a CC reviewer (e.g. the line Product Manager on an Anti Inf
 * request). Posts to the marketing comment endpoint; it never approves, rejects, or advances the
 * request. Shared by the approval inbox and the request-tracking detail view.
 */
export function MarketingAdvisoryCommentBox({
  onPosted,
  requestId,
}: {
  onPosted?: () => void;
  requestId: string;
}) {
  const [comment, setComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPosted, setIsPosted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!comment.trim()) {
      setError("Please write a comment before posting.");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/marketing-requests/${encodeURIComponent(requestId)}/comment`, {
        body: JSON.stringify({ comment }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) {
        setError(payload.message || "Unable to post your comment.");
        return;
      }
      setIsPosted(true);
      onPosted?.();
    } catch {
      setError("Unable to post your comment.");
    } finally {
      setIsSubmitting(false);
    }
  }, [comment, onPosted, requestId]);

  if (isPosted) {
    return (
      <p className="flex items-center gap-1.5 text-phx-sm font-bold text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Comment shared with the reviewer.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-phx-xs font-medium text-slate-500">
        Your comment is shared with the reviewer and does not affect the approval — it cannot approve or reject the request.
      </p>
      <textarea
        className="min-h-[72px] w-full rounded-sm border border-slate-200 bg-white px-3 py-2 text-phx-md text-slate-800 shadow-sm outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
        dir="auto"
        onChange={(event) => setComment(event.target.value)}
        placeholder="Add a comment for the reviewer…"
        value={comment}
      />
      {error ? <p className="text-phx-xs font-semibold text-rose-600">{error}</p> : null}
      <button
        className="inline-flex min-h-9 items-center gap-1.5 rounded-sm bg-sky-600 px-4 text-phx-sm font-bold text-white shadow-sm transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isSubmitting}
        onClick={() => void submit()}
        type="button"
      >
        {isSubmitting ? <LoadingSpinner /> : <Send className="h-3.5 w-3.5" />}
        {isSubmitting ? "Sending…" : "Post comment"}
      </button>
    </div>
  );
}
