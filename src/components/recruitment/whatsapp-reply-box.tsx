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
import { MessageCircle } from "lucide-react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
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
    <div className="w-full border border-phx-line bg-white p-3 text-[12px]">
      {state.kind === "loading" ? <p className="text-phx-ink-soft">Checking WhatsApp…</p> : null}

      {state.kind === "none" ? (
        <p className="leading-snug text-phx-ink-soft">
          This candidate has never messaged us on WhatsApp, so there is no conversation to reply to.
        </p>
      ) : null}

      {state.kind === "closed" ? (
        <p className="leading-snug text-phx-ink-soft">
          WhatsApp only allows a written reply within 24 hours of their last message, and theirs came in on{" "}
          <span className="font-semibold text-phx-ink">{formatCairo(state.lastInboundAt)}</span>. Send an approved
          template instead.
        </p>
      ) : null}

      {state.kind === "error" ? <p className="leading-snug text-phx-danger">{state.message}</p> : null}

      {state.kind === "open" ? (
        <div className="flex w-full flex-col gap-2">
          <p className="leading-snug text-phx-ink-soft">
            Sending from{" "}
            <span className="font-semibold text-phx-ink">{state.lineNumber ?? "the line they messaged"}</span>.{" "}
            {formatRemaining(state.minutesLeft)} left to reply in your own words.
          </p>
          <textarea
            className="w-full resize-y border border-phx-line bg-white p-2 text-[13px] leading-relaxed text-phx-ink outline-none focus:border-phx-accent"
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
              {sending ? "Sending…" : "Send"}
            </Action>
            <Action disabled={sending} onClick={() => setState({ kind: "idle" })} tone="ghost">
              Close
            </Action>
          </div>
          {sendError ? <p className="leading-snug text-phx-danger">{sendError}</p> : null}
          {sent ? (
            <p className="leading-snug text-phx-ink-soft">
              Sent: <span className="font-semibold text-phx-ink">{sent}</span>
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
  );
}
