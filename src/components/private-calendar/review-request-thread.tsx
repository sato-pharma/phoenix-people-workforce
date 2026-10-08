"use client";

import { useState } from "react";
import { MessageSquare, Send } from "lucide-react";

import { phxButtonPrimaryClassName, phxTextareaClassName } from "@/components/ui/form-tokens";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { PrivateCalendarReviewMessage, PrivateCalendarReviewRequest } from "@/lib/private-calendar/logic";

// ONE thread component for both sides of a Private Calendar review request — the employee reads and
// replies to it on his own calendar, the Super Admin in the Calendar Disputes inbox. Shared
// rather than written twice because the two views must agree about who said what and in what order;
// two copies of that would be two different answers within a year.
//
// The request's own claim is rendered as the FIRST line of the conversation and is not stored among
// the replies, so there is exactly one copy of what the employee originally wrote.

function authorLabel(message: PrivateCalendarReviewMessage, viewerIsAuthor: boolean) {
  if (viewerIsAuthor) return "You";
  const name = message.authorName?.trim();
  if (name) return message.authorIsAdmin ? `${name} · Super Admin` : name;
  return message.authorIsAdmin ? "Super Admin" : "Employee";
}

export function PrivateCalendarReviewRequestThread({
  canReply,
  claimAuthorLabel,
  onPosted,
  request,
  viewerHrIdKey,
}: {
  /** False once the request is decided, or when the viewer is only looking at somebody else's day. */
  canReply: boolean;
  /** How the opening claim is signed — "You" on the employee's own calendar, his name in the hub. */
  claimAuthorLabel: string;
  onPosted?: () => void | Promise<void>;
  request: PrivateCalendarReviewRequest;
  /** The viewer's HR id, already lower-cased, so a line of his own reads "You". */
  viewerHrIdKey: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const body = draft.trim();
    if (!body) {
      setError("Write something before sending.");
      return;
    }
    setError(null);
    setSending(true);
    try {
      const response = await fetch(`/api/private-calendar/disputes/${request.id}/messages`, {
        body: JSON.stringify({ body }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Unable to send this reply.");
      setDraft("");
      await onPosted?.();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Unable to send this reply.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5">
        <MessageSquare className="h-4 w-4 shrink-0 text-slate-400" />
        <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Conversation</span>
        <span className="text-phx-xs font-bold text-slate-400">
          {request.messages.length + 1} message{request.messages.length === 0 ? "" : "s"}
        </span>
      </div>

      <div className="space-y-2 px-4 py-3">
        {/* The opening claim — the request itself, not a stored reply. */}
        <div className="border border-slate-200 bg-slate-50 p-3">
          <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">{claimAuthorLabel}</p>
          <p className="mt-1 text-sm font-semibold text-slate-800 [overflow-wrap:anywhere]">{request.claimText}</p>
          <p className="mt-1 text-phx-xs font-semibold text-slate-500 [overflow-wrap:anywhere]">
            Where to verify: {request.claimSourceText}
          </p>
          <p className="mt-1 text-phx-xs font-semibold text-slate-400">{cairoDateTime(request.createdAt)}</p>
        </div>

        {request.messages.map((message) => {
          const viewerIsAuthor = Boolean(
            viewerHrIdKey && message.authorHrId.trim().toLowerCase() === viewerHrIdKey,
          );
          return (
            <div
              className={[
                "border p-3",
                message.authorIsAdmin ? "border-orange-200 bg-orange-50" : "border-slate-200 bg-slate-50",
              ].join(" ")}
              key={message.id}
            >
              <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
                {authorLabel(message, viewerIsAuthor)}
              </p>
              <p className="mt-1 text-sm font-semibold text-slate-800 [overflow-wrap:anywhere]">{message.body}</p>
              <p className="mt-1 text-phx-xs font-semibold text-slate-400">{cairoDateTime(message.createdAt)}</p>
            </div>
          );
        })}

        {/* The decision closes the thread: it is the last word, and the reply box goes with it. */}
        {request.status !== "pending_review" ? (
          <div className="border border-slate-300 bg-white p-3">
            <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
              {request.status === "accepted" ? "Accepted · Super Admin" : "Declined · Super Admin"}
            </p>
            {request.decisionNote ? (
              <p className="mt-1 text-sm font-semibold text-slate-800 [overflow-wrap:anywhere]">{request.decisionNote}</p>
            ) : null}
            {request.decidedAt ? (
              <p className="mt-1 text-phx-xs font-semibold text-slate-400">{cairoDateTime(request.decidedAt)}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {canReply && request.status === "pending_review" ? (
        <div className="border-t border-slate-100 px-4 py-3">
          <textarea
            className={phxTextareaClassName}
            maxLength={2000}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Write a reply…"
            rows={2}
            value={draft}
          />
          {error ? <p className="mt-1 text-xs font-bold text-rose-700">{error}</p> : null}
          <div className="mt-2 flex justify-end">
            <button
              className={`${phxButtonPrimaryClassName} gap-2`}
              disabled={sending}
              onClick={() => { void send(); }}
              type="button"
            >
              <Send className="h-4 w-4" />
              {sending ? "Sending…" : "Send reply"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
