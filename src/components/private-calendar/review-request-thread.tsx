"use client";

import { useState } from "react";
import { MessageSquare, Send } from "lucide-react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { LANDING_FOCUS, LANDING_INK } from "@/components/employee-portal/landing-kit";
import { phxButtonPrimaryClassName, phxTextareaClassName } from "@/components/ui/form-tokens";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { PrivateCalendarReviewMessage, PrivateCalendarReviewRequest } from "@/lib/private-calendar/logic";
import { cn } from "@/lib/utils";

// ONE thread component for both sides of a Private Calendar review request — the employee reads and
// replies to it on his own calendar, the Super Admin in the Calendar Disputes inbox. Shared
// rather than written twice because the two views must agree about who said what and in what order;
// two copies of that would be two different answers within a year.
//
// The request's own claim is rendered as the FIRST line of the conversation and is not stored among
// the replies, so there is exactly one copy of what the employee originally wrote.

/** One line of the conversation: who and when beside a 4px rail, the words below. The rail says whose side spoke. */
function ThreadLine({
  author,
  authorClassName = "text-slate-500",
  children,
  rail,
}: {
  author: React.ReactNode;
  authorClassName?: string;
  children: React.ReactNode;
  rail: string;
}) {
  return (
    <li className="flex min-w-0 gap-3 px-3 py-3 sm:px-4">
      <span aria-hidden="true" className={`w-1 shrink-0 self-stretch ${rail}`} />
      <div className="min-w-0 flex-1">
        <p className={`break-words text-phx-xs font-bold uppercase tracking-[0.1em] ${authorClassName}`}>{author}</p>
        {children}
      </div>
    </li>
  );
}

const THREAD_BODY_CLASS = `mt-1 text-phx-md font-semibold [overflow-wrap:anywhere] ${LANDING_INK}`;
const THREAD_TIME_CLASS = "mt-1 text-phx-xs font-semibold tabular-nums text-slate-500";

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
    <div className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2.5 sm:px-4">
        <MessageSquare aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400" />
        <span className={`text-phx-xs font-black uppercase tracking-[0.12em] ${LANDING_INK}`}>Conversation</span>
        <span className="text-phx-xs font-bold tabular-nums text-slate-500">
          {request.messages.length + 1} message{request.messages.length === 0 ? "" : "s"}
        </span>
      </div>

      <ul className="divide-y divide-slate-200">
        {/* The opening claim — the request itself, not a stored reply. */}
        <ThreadLine author={claimAuthorLabel} rail="bg-slate-300">
          <p className={THREAD_BODY_CLASS} dir="auto">{request.claimText}</p>
          <p className="mt-1 text-phx-xs font-semibold text-slate-500 [overflow-wrap:anywhere]" dir="auto">
            Where to verify: {request.claimSourceText}
          </p>
          <p className={THREAD_TIME_CLASS}>{cairoDateTime(request.createdAt)}</p>
        </ThreadLine>

        {request.messages.map((message) => {
          const viewerIsAuthor = Boolean(
            viewerHrIdKey && message.authorHrId.trim().toLowerCase() === viewerHrIdKey,
          );
          return (
            <ThreadLine
              author={authorLabel(message, viewerIsAuthor)}
              authorClassName={message.authorIsAdmin ? LANDING_INK : "text-slate-500"}
              key={message.id}
              rail={message.authorIsAdmin ? "bg-[#08111f]" : "bg-slate-300"}
            >
              <p className={THREAD_BODY_CLASS} dir="auto">{message.body}</p>
              <p className={THREAD_TIME_CLASS}>{cairoDateTime(message.createdAt)}</p>
            </ThreadLine>
          );
        })}

        {/* The decision closes the thread: it is the last word, and the reply box goes with it. */}
        {request.status !== "pending_review" ? (
          <ThreadLine
            author={request.status === "accepted" ? "Accepted · Super Admin" : "Declined · Super Admin"}
            authorClassName={request.status === "accepted" ? "text-emerald-700" : "text-rose-700"}
            rail={request.status === "accepted" ? "bg-emerald-600" : "bg-rose-600"}
          >
            {request.decisionNote ? (
              <p className={THREAD_BODY_CLASS} dir="auto">{request.decisionNote}</p>
            ) : null}
            {request.decidedAt ? (
              <p className={THREAD_TIME_CLASS}>{cairoDateTime(request.decidedAt)}</p>
            ) : null}
          </ThreadLine>
        ) : null}
      </ul>

      {canReply && request.status === "pending_review" ? (
        <div className="border-t border-slate-200 px-3 py-3 sm:px-4">
          <textarea
            aria-label="Reply"
            className={phxTextareaClassName}
            dir="auto"
            maxLength={2000}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Write a reply…"
            rows={2}
            value={draft}
          />
          {error ? <p className="mt-1 text-phx-sm font-bold text-rose-700">{error}</p> : null}
          <div className="mt-2 flex justify-end">
            <button
              className={cn(phxButtonPrimaryClassName, "min-h-10 gap-2 motion-reduce:transition-none", LANDING_FOCUS)}
              disabled={sending}
              onClick={() => { void send(); }}
              type="button"
            >
              <Send aria-hidden="true" className="h-4 w-4" />
              {sending ? "Sending…" : "Send reply"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
