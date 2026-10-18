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

// ── IT LIVES ON TWO SCREENS NOW, AND IT IS PAINTED IN THE PRODUCT’S OWN INK ──────────────────
//
// Until 2026-09-12 the only way to answer an applicant in your own words was the candidate drawer in
// the pool. The screening workstation — the screen a recruiter actually spends the morning on — had
// the templated send dialog and nothing else, so "reply to what they just wrote" meant leaving the
// CV, finding them in the pool, and opening a drawer. It renders in both places now, off the same
// route and the same 24-hour check.
//
// It was also painted entirely in Tailwind’s `slate` with a bare `orange-400`, which is nobody’s
// palette here. Sitting inside a header built from `--phx-*` that reads as a pasted-in widget, so
// every class names a token and the buttons come from the screening page’s own Action kit.

import { useCallback, useState } from "react";
import { CheckCheck, Clock, Info, Loader2, MessageCircle } from "lucide-react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { getJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
import { adminPanelClassName } from "@/components/admin/admin-design-tokens";

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
      <Action
        onClick={() => void open()}
        title="Answer this applicant in your own words, if WhatsApp still allows it"
        tone="quiet"
      >
        <MessageCircle aria-hidden className="h-3.5 w-3.5" />
        Reply on WhatsApp
      </Action>
    );
  }

  return (
    <div className={`${adminPanelClassName} w-full text-[12px]`}>
      {/* A titled strip, so the open box reads as one object on a busy header rather than loose lines:
          the mark, what it is, and — once WhatsApp has said yes — how long is left, as a chip that
          turns to the warning ink in the last hour. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-phx-line bg-phx-paper px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-phx-ink">
          <MessageCircle aria-hidden className="h-3.5 w-3.5 text-phx-accent" />
          Reply on WhatsApp
        </span>
        {state.kind === "open" ? (
          <span
            className={
              state.minutesLeft < 60
                ? "inline-flex items-center gap-1 border border-phx-warn-line bg-phx-warn-bg px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-phx-warn"
                : "inline-flex items-center gap-1 border border-phx-ok-line bg-phx-ok-bg px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-phx-ok"
            }
          >
            <Clock aria-hidden className="h-3 w-3" />
            {formatRemaining(state.minutesLeft)} left
          </span>
        ) : null}
      </div>

      <div className="p-3">
        {state.kind === "loading" ? (
          <p className="inline-flex items-center gap-1.5 text-phx-ink-soft" role="status">
            <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin text-phx-accent" />
            Checking WhatsApp…
          </p>
        ) : null}

        {state.kind === "none" ? (
          <p className="flex items-start gap-1.5 border border-phx-info-line bg-phx-info-bg px-2.5 py-2 leading-snug text-phx-ink-2">
            <Info aria-hidden className="mt-px h-3.5 w-3.5 flex-none text-phx-info" />
            <span className="min-w-0 break-words">
              This candidate has never messaged us on WhatsApp, so there is no conversation to reply to.
            </span>
          </p>
        ) : null}

        {state.kind === "closed" ? (
          <p className="flex items-start gap-1.5 border border-phx-warn-line bg-phx-warn-bg px-2.5 py-2 leading-snug text-phx-ink-2">
            <Clock aria-hidden className="mt-px h-3.5 w-3.5 flex-none text-phx-warn" />
            <span className="min-w-0 break-words">
              WhatsApp only allows a written reply within 24 hours of their last message, and theirs came in on{" "}
              <span className="font-semibold text-phx-ink">{formatCairo(state.lastInboundAt)}</span>. Send an approved
              template instead.
            </span>
          </p>
        ) : null}

        {state.kind === "error" ? (
          <p className="break-words border border-phx-danger-line bg-phx-danger-bg px-2.5 py-2 leading-snug text-phx-danger" role="alert">
            {state.message}
          </p>
        ) : null}

        {state.kind === "open" ? (
          <div className="flex w-full flex-col gap-2">
            <p className="leading-snug text-phx-ink-soft">
              Sending from{" "}
              <span className="font-semibold text-phx-ink">{state.lineNumber ?? "the line they messaged"}</span>.{" "}
              {formatRemaining(state.minutesLeft)} left to reply in your own words.
            </p>
            <textarea
              className={`${phxTextareaClassName} leading-relaxed`}
              disabled={sending}
              onChange={(event) => setText(event.target.value)}
              placeholder="Write your reply…"
              rows={3}
              value={text}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {/* The one loud control here, and it is loud for the reason the kit reserves that volume:
                  this message leaves the building the moment it is pressed and cannot be recalled. */}
              <Action disabled={sending || text.trim().length === 0} onClick={() => void send()} tone="primary">
                {sending ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : null}
                {sending ? "Sending…" : "Send"}
              </Action>
              <Action disabled={sending} onClick={() => setState({ kind: "idle" })} tone="ghost">
                Close
              </Action>
            </div>
            {sendError ? (
              <p className="break-words border border-phx-danger-line bg-phx-danger-bg px-2.5 py-2 leading-snug text-phx-danger" role="alert">
                {sendError}
              </p>
            ) : null}
            {sent ? (
              <p className="flex items-start gap-1.5 border border-phx-ok-line bg-phx-ok-bg px-2.5 py-2 leading-snug text-phx-ink-2">
                <CheckCheck aria-hidden className="mt-px h-3.5 w-3.5 flex-none text-phx-ok" />
                <span className="min-w-0 whitespace-pre-wrap break-words">
                  Sent: <span className="font-semibold text-phx-ink">{sent}</span>
                </span>
              </p>
            ) : null}
          </div>
        ) : null}

        {state.kind !== "open" && state.kind !== "loading" ? (
          <Action className="mt-2" onClick={() => setState({ kind: "idle" })} tone="ghost">
            Close
          </Action>
        ) : null}
      </div>
    </div>
  );
}
