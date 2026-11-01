"use client";

import { useEffect, useState } from "react";
import { MessageCircle, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { RecordConversationComment } from "@/lib/conversations/comments";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

/**
 * The record-level conversation thread — mounted on direct-order and marketing-request detail
 * surfaces, for both the requester and the approvers.
 *
 * Owner rule, 2026-09-22: the conversation is open at ANY status, even after the record is rejected,
 * so a requester can ask why it was turned down and a reviewer can answer. Every message is emailed
 * to the requester, cc's everyone else on the record, and pings them in-app / Telegram / push —
 * that fan-out is the server's job (conversations/notify.ts); this component only reads and posts.
 *
 * Same component, same API, same data on every surface — so every participant sees the identical
 * conversation regardless of which screen they opened it from. Modelled on PlanConversationThread.
 */
export function RecordConversationThread({
  base,
  note = "Anyone on this request can post here at any status. Every message reaches the requester and the approvers by email, in-app and Telegram.",
  startClosed = false,
  title = "Conversation",
}: {
  /** The GET/POST endpoint, e.g. `/api/direct-orders/<id>/conversation`. Callers key the component
   *  by the record id so switching records remounts fresh rather than reusing stale state. */
  base: string;
  /** Who can read it and who is told, in this record's own words. */
  note?: string;
  /** Show one "Open conversation" bar, with its message count, until it is pressed. */
  startClosed?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(!startClosed);
  const [comments, setComments] = useState<RecordConversationComment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [schemaReady, setSchemaReady] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadComments() {
    try {
      const response = await fetch(base, { cache: "no-store" });
      const payload = (await response.json().catch(() => ({}))) as {
        data?: { comments?: RecordConversationComment[]; schemaReady?: boolean };
        success?: boolean;
      };
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
    // Run once per mount — the parent keys this component by record id, so switching records
    // remounts fresh rather than re-triggering this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  async function handleSend() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(base, {
        body: JSON.stringify({ body }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const result = (await response.json().catch(() => ({}))) as { message?: string; success?: boolean };
      if (!response.ok || !result.success) throw new Error(result.message ?? "Unable to post your message.");
      setDraft("");
      await loadComments();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Unable to post your message.");
    } finally {
      setSending(false);
    }
  }

  // Migration not applied yet in this environment — stay silent rather than show a broken box.
  if (loaded && !schemaReady) return null;

  if (!open) {
    return (
      <button
        aria-expanded={false}
        className="flex min-h-11 w-full flex-wrap items-center gap-x-2 gap-y-0.5 bg-slate-900 px-3 py-2 text-left hover:bg-slate-800"
        onClick={() => setOpen(true)}
        type="button"
      >
        <MessageCircle className="h-3.5 w-3.5 text-orange-400" aria-hidden />
        <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Open conversation</span>
        {loaded ? (
          <span className="ml-auto text-phx-2xs font-bold text-slate-300">
            {comments.length === 0 ? "No messages yet" : comments.length === 1 ? "1 message" : `${comments.length} messages`}
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <div className="border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-900 px-3 py-2">
        <MessageCircle className="h-3.5 w-3.5 text-orange-400" aria-hidden />
        <h4 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{title}</h4>
        {startClosed ? (
          <button aria-expanded className="ml-auto text-phx-2xs font-bold text-slate-300 hover:text-white" onClick={() => setOpen(false)} type="button">
            Close
          </button>
        ) : null}
      </div>
      <p className="border-b border-slate-100 px-3 py-2 text-phx-2xs font-semibold text-slate-500">{note}</p>
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
                  {comment.authorName ?? comment.authorHrId ?? "Unnamed author"}
                  {comment.authorRole ? (
                    <span className="ml-1 font-semibold text-slate-500">({comment.authorRole})</span>
                  ) : null}
                </p>
                <p className="shrink-0 whitespace-nowrap text-phx-2xs text-slate-400">
                  {cairoDateTime(comment.createdAt)}
                </p>
              </div>
              {/* dir="auto" per line: single-language free text, the case where block-level auto is
                  correct and already house style here. */}
              <p className="mt-1 whitespace-pre-wrap break-words text-xs font-semibold text-slate-700" dir="auto">
                {comment.body}
              </p>
            </div>
          ))
        )}
      </div>
      <div className="space-y-2 border-t border-slate-200 p-3">
        <textarea
          className={cn(phxTextareaClassName, "min-h-16")}
          dir="auto"
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
