"use client";

import { useEffect, useState } from "react";
import { MessageCircle, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { EmployeePlanComment } from "@/lib/weekly-planning/service";

type Props = {
  // Callers key this component by planId (key={planId}) so switching to a
  // different plan remounts a fresh instance instead of reusing stale state.
  planId: string;
};

// Shared plan-level conversation thread, rendered both in the submitter's plan
// editor (plans-workspace.tsx) and on the approver's Approvals Hub detail page
// (plan-request-detail.tsx). Same component, same API, same data — so every
// participant (submitter, manager, CEO, HR/Super Admin) sees the exact same
// conversation, regardless of which surface they're viewing it from.
export function PlanConversationThread({ planId }: Props) {
  const [comments, setComments] = useState<EmployeePlanComment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [schemaReady, setSchemaReady] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadComments() {
    try {
      const response = await fetch(`/api/weekly-plans/${planId}/comments`, { cache: "no-store" });
      const payload = await response.json();
      if (payload.success) {
        setComments(payload.data?.comments ?? []);
        setSchemaReady(payload.data?.schemaReady ?? true);
      }
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void loadComments();
    // Run once per mount — the parent keys this component by planId, so a
    // plan switch remounts fresh rather than re-triggering this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSend() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/api/weekly-plans/${planId}/comments`, {
        body: JSON.stringify({ body }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message ?? "Unable to post comment.");
      setDraft("");
      await loadComments();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Unable to post comment.");
    } finally {
      setSending(false);
    }
  }

  // Migration not applied yet in this environment — stay silent rather than show a broken box.
  if (loaded && !schemaReady) return null;

  return (
    <div className="border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-900 px-3 py-2">
        <MessageCircle className="h-3.5 w-3.5 text-orange-400" aria-hidden />
        <h4 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Conversation</h4>
      </div>
      <div className="max-h-72 space-y-2 overflow-y-auto p-3">
        {!loaded ? (
          <p className="text-xs font-semibold text-slate-400">Loading conversation…</p>
        ) : comments.length === 0 ? (
          <p className="text-xs font-semibold text-slate-400">No messages yet. Start the conversation below.</p>
        ) : (
          comments.map((comment) => (
            <div className="border border-slate-100 bg-slate-50 p-2.5" key={comment.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <p className="text-xs font-black text-slate-800">
                  {comment.authorName ?? comment.authorHrId}
                  {comment.authorRole ? (
                    <span className="ml-1 font-semibold text-slate-500">({comment.authorRole})</span>
                  ) : null}
                </p>
                <p className="shrink-0 whitespace-nowrap text-phx-2xs text-slate-400">
                  {new Date(comment.createdAt).toLocaleString("en-GB", {
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    month: "short",
                  })}
                </p>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-xs font-semibold text-slate-700">{comment.body}</p>
            </div>
          ))
        )}
      </div>
      <div className="space-y-2 border-t border-slate-200 p-3">
        <textarea
          className="min-h-16 w-full border border-slate-200 p-2 text-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-400/20"
          disabled={sending}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Reply in this conversation…"
          value={draft}
        />
        {error ? <p className="text-xs font-bold text-red-600">{error}</p> : null}
        <Button disabled={sending || !draft.trim()} onClick={handleSend} type="button">
          <Send className="mr-2 h-4 w-4" />
          Send
        </Button>
      </div>
    </div>
  );
}
