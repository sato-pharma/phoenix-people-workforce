"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

/**
 * Market Awareness — the conversation on an activity, shared by both screens that need it.
 *
 * ONE component, deliberately. The decider opens a thread from the approvals inbox and the person
 * who raised the activity reads and answers it in the workspace — and the email the server sends
 * links to the workspace, so a thread that existed only in the inbox would email somebody a
 * question they had no way to answer. That was the state of this feature until 2026-09-06.
 *
 * THE SAME GOLDEN RULES AS ITS TWO HOSTS: no horizontal scroll at any width, square edges only (no
 * `rounded-*` class in this file), no ellipsis, human names never codes, Cairo time.
 */

const BTN_QUIET =
  "inline-flex items-center justify-center gap-2 border border-phx-line bg-phx-paper px-3 py-2 text-phx-2xs font-black uppercase tracking-[0.10em] text-phx-ink-soft transition hover:border-phx-line-strong hover:text-phx-ink";
const TEXTAREA =
  "min-h-20 w-full border border-phx-line bg-phx-paper px-3 py-2 text-phx-sm font-bold text-phx-ink outline-none transition focus:border-phx-accent focus:ring-2 focus:ring-phx-accent-soft";

/**
 * When a message was sent, in Cairo.
 *
 * Cairo and not UTC because `created_at` is an instant WE stamped (`now()` on a timestamptz), which
 * is the one of the three cases that belongs in local time — a date-only column would render as UTC
 * on purpose, to stop the calendar day shifting.
 *
 * With the TIME, unlike the date helpers the two host screens carry: several messages land on one
 * day and a thread that stamps them all "07 Sep 2026" cannot be read in order.
 */
function cairoStamp(value: string | null | undefined): string {
  if (!value) return "Not set";
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return String(value);
  return stableEnGbFormatter({
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(parsed);
}

// A three-line label, duplicated rather than imported from the inbox: importing it back would make
// the two files circular, since the inbox imports this component.
function MicroLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-phx-3xs font-bold uppercase tracking-[0.14em] text-phx-ink-faint">
      {children}
    </span>
  );
}

type Comment = {
  id: number;
  authorHrId: string;
  authorName: string | null;
  body: string;
  createdAt: string;
};

/**
 * The conversation on an activity.
 *
 * Posting here is not a decision — it is how a manager asks a question without returning the whole
 * thing. Who gets told is decided entirely server-side by the owner's 2026-09-03 rule (email the
 * submitter, CC the sender and every participant); nothing in this component addresses anybody.
 *
 * Loaded on demand, because most cards are approved without a word and fetching every thread up
 * front would be a request per row for nothing.
 */
export function Conversation({ activityId }: { activityId: string }) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/market-awareness/${activityId}/comment`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        throw new Error(
          payload?.message ?? `Could not load the conversation (HTTP ${response.status}).`,
        );
      }
      setComments(payload.comments ?? []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the conversation.");
      setComments([]);
    }
  }, [activityId]);

  useEffect(() => {
    void (async () => {
      if (!open) return;
      await load();
    })();
  }, [load, open]);

  const post = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/market-awareness/${activityId}/comment`, {
        body: JSON.stringify({ body: draft }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        throw new Error(
          payload?.message ?? `Could not post that comment (HTTP ${response.status}).`,
        );
      }
      setComments(payload.comments ?? []);
      setDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not post that comment.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className={BTN_QUIET} onClick={() => setOpen(true)} type="button">
        <MessageSquare aria-hidden="true" className="h-3 w-3 shrink-0" />
        <span>Open a conversation</span>
      </button>
    );
  }

  return (
    <div className="min-w-0 border border-phx-line bg-phx-paper-2 p-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-phx-line pb-2">
        <MicroLabel>Conversation</MicroLabel>
        <button className={BTN_QUIET} onClick={() => setOpen(false)} type="button">
          Hide
        </button>
      </div>

      {error ? (
        <p className="mt-2 break-words border border-phx-warn-line bg-phx-warn-bg px-2.5 py-2 text-phx-2xs font-bold text-phx-warn">
          {error}
        </p>
      ) : null}

      {comments === null ? (
        <p className="mt-2 text-phx-2xs font-bold text-phx-ink-faint">Loading the thread.</p>
      ) : comments.length === 0 ? (
        <p className="mt-2 break-words text-phx-2xs font-medium text-phx-ink-faint">
          Nothing said yet. Whatever you write is emailed to whoever raised this, copying everyone
          already involved.
        </p>
      ) : (
        <ol className="mt-2 flex min-w-0 flex-col gap-2.5">
          {comments.map((comment) => (
            <li className="min-w-0 border-l-2 border-phx-accent-line pl-2.5" key={comment.id}>
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="break-words text-phx-2xs font-black text-phx-ink">
                  {comment.authorName ?? comment.authorHrId}
                </span>
                <span className="text-phx-3xs font-medium text-phx-ink-faint">
                  {cairoStamp(comment.createdAt)}
                </span>
              </span>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-phx-2xs font-medium text-phx-ink-soft">
                {comment.body}
              </p>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-3 flex min-w-0 flex-col gap-2">
        <textarea
          className={TEXTAREA}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask a question. It is emailed to whoever raised this, copying everyone already involved."
          value={draft}
        />
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            className={BTN_QUIET}
            disabled={busy || draft.trim() === ""}
            onClick={() => void post()}
            type="button"
          >
            <MessageSquare aria-hidden="true" className="h-3 w-3 shrink-0" />
            <span>{busy ? "Sending" : "Send"}</span>
          </button>
          <span className="break-words text-phx-3xs font-medium text-phx-ink-faint">
            Sends without deciding anything — the activity stays where it is.
          </span>
        </span>
      </div>
    </div>
  );
}
