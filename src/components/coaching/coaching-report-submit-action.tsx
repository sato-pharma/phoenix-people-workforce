"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";

type ApiResponse<T> = {
  data?: T;
  error?: string;
  message?: string;
};

async function parseApiResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as ApiResponse<T>;
  if (!response.ok) {
    throw new Error(payload.message || payload.error || "Failed to submit coaching report.");
  }
  if (!payload.data) {
    throw new Error("Coaching API returned no data.");
  }
  return payload.data;
}

export function CoachingReportSubmitAction({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/coaching/reports/${reportId}/submit`, {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      await parseApiResponse(response);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to submit coaching report.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        className="inline-flex items-center justify-center gap-2 rounded-full bg-[#F97316] px-5 py-2.5 text-sm font-black text-white shadow-[0_18px_42px_rgba(249,115,22,0.22)] transition hover:bg-[#EA580C] disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isSubmitting}
        onClick={() => void handleSubmit()}
        type="button"
      >
        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        Submit Report
      </button>
      {error ? <p className="max-w-xs text-right text-xs font-bold text-rose-600">{error}</p> : null}
    </div>
  );
}
