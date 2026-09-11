"use client";

// Recruitment / ATS — answering an applicant on WhatsApp without leaving Phoenix.
//
// Self-contained on purpose. CandidatePoolCard already takes 23 props, and a reply box needs three
// facts none of them carry: whether this person has ever written to us, which of the two company
// lines they wrote to, and whether WhatsApp still allows a written answer. Threading those down
// would widen every caller; fetching them here costs one request, and only when someone actually
// opens the box.
//
// ── Why the window is READ before the box is drawn ───────────────────────────
// WhatsApp allows free-form text only within 24 hours of the person's last message. Past that Meta
// refuses the send. Drawing the box first would mean a recruiter types a paragraph, presses send,
// and is told afterwards that it was never possible — so the state is fetched on open and the box
// is only offered when it can actually be used.
//
// Nothing here runs in an effect. State is set from handlers only, which is this repo's lint rule
// and also the honest shape: the window is checked when a human asks to reply, not on every render
// of every card in a list that may hold hundreds.

import { useCallback, useState } from "react";

import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { getJson, postJson } from "@/components/recruitment/recruitment-fetch";

type WindowState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "closed"; lastInboundAt: string | null }
  | { kind: "open"; lineNumber: string | null; minutesLeft: number }
  | { kind: "error"; message: string };

/** "23h 14m" — a duration, so no timezone applies. Minutes alone read badly at a full day. */
function formatRemaining(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) return `${rest}m`;
  return `${hours}h ${rest}m`;
}

function formatCairo(iso: string | null): string {
  if (!iso) return "unknown";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  // NOT toLocaleString. A short month name comes from the reader's own ICU build, and CLDR 42
  // changed en-GB September from "Sep" to "Sept" — server and browser then disagree and React
  // throws hydration error #418, visible only during September. stableEnGbFormatter pins the month
  // and leaves the zone alone; Cairo is the requirement, not the bug.
  return formatStableEnGb(parsed, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
  });
}

export function WhatsAppReplyBox({ candidateId }: { candidateId: string }) {
  const [state, setState] = useState<WindowState>({ kind: "idle" });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const open = useCallback(async () => {
    setState({ kind: "loading" });
    setSent(null);
    setSendError(null);
    try {
      const data = await getJson(`/api/recruitment/candidates/${candidateId}/whatsapp-reply`);
      if (data.canReply === true) {
        setState({
          kind: "open",
          lineNumber: typeof data.lineNumber === "string" ? data.lineNumber : null,
          minutesLeft: typeof data.minutesLeft === "number" ? data.minutesLeft : 0,
        });
        return;
      }
      if (data.reason === "window_closed") {
        setState({ kind: "closed", lastInboundAt: typeof data.lastInboundAt === "string" ? data.lastInboundAt : null });
        return;
      }
      setState({ kind: "none" });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "Could not check WhatsApp." });
    }
  }, [candidateId]);

  const send = useCallback(async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await postJson(`/api/recruitment/candidates/${candidateId}/whatsapp-reply`, { text: body });
      setSent(body);
      setText("");
      // The window keeps running from THEIR last message, not ours, so sending does not extend it.
      // Re-read rather than assume, so a box left open for an hour does not lie about the time left.
      await open();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "The reply was not sent.");
    } finally {
      setSending(false);
    }
  }, [candidateId, open, sending, text]);

  if (state.kind === "idle") {
    return (
      <button
        className="border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-900 hover:bg-slate-50"
        onClick={() => void open()}
        type="button"
      >
        Reply on WhatsApp
      </button>
    );
  }

  return (
    <div className="w-full border border-slate-300 bg-white p-3 text-xs">
      {state.kind === "loading" ? <p className="text-slate-500">Checking WhatsApp…</p> : null}

      {state.kind === "none" ? (
        <p className="text-slate-500">
          This candidate has never messaged us on WhatsApp, so there is no conversation to reply to.
        </p>
      ) : null}

      {state.kind === "closed" ? (
        <p className="text-slate-500">
          WhatsApp only allows a written reply within 24 hours of their last message, and theirs came in on{" "}
          <span className="text-slate-900">{formatCairo(state.lastInboundAt)}</span>. Send an approved template instead.
        </p>
      ) : null}

      {state.kind === "error" ? <p className="text-red-600">{state.message}</p> : null}

      {state.kind === "open" ? (
        <div className="flex w-full flex-col gap-2">
          <p className="text-slate-500">
            Sending from <span className="text-slate-900">{state.lineNumber ?? "the line they messaged"}</span>.{" "}
            {formatRemaining(state.minutesLeft)} left to reply in your own words.
          </p>
          <textarea
            className="w-full border border-slate-300 bg-white p-2 text-xs text-slate-900 focus:border-orange-400 focus:outline-none"
            disabled={sending}
            onChange={(event) => setText(event.target.value)}
            placeholder="Write your reply…"
            rows={3}
            value={text}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="border border-slate-900 bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              disabled={sending || text.trim().length === 0}
              onClick={() => void send()}
              type="button"
            >
              {sending ? "Sending…" : "Send"}
            </button>
            <button
              className="border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
              disabled={sending}
              onClick={() => setState({ kind: "idle" })}
              type="button"
            >
              Close
            </button>
          </div>
          {sendError ? <p className="text-red-600">{sendError}</p> : null}
          {sent ? <p className="text-slate-500">Sent: <span className="text-slate-900">{sent}</span></p> : null}
        </div>
      ) : null}

      {state.kind !== "open" && state.kind !== "loading" ? (
        <button
          className="mt-2 border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
          onClick={() => setState({ kind: "idle" })}
          type="button"
        >
          Close
        </button>
      ) : null}
    </div>
  );
}
