import { AlertTriangle, CheckCircle2, Inbox, ListOrdered, MessageSquareReply, SendHorizontal, XCircle } from "lucide-react";

import type { OutboundMessageRow, WhatsAppOutboundReport } from "@/lib/recruitment/inbound/whatsapp-outbound-report";
import { adminChipDepthClassName, adminRecessedDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  RecruitmentEmptyState,
  RecruitmentKpiStrip,
  RecruitmentPanel,
  RecruitmentPill,
} from "@/components/recruitment/recruitment-premium";

// A server component on purpose: there is nothing to click. The page is force-dynamic, so a browser
// reload is the refresh, and shipping no client bundle keeps a read-only record read-only.
//
// THE LOOK (owner, 2026-10-19, the full-module premium sweep): the four counts are the module's KPI
// strip, the record is one panel under the house dark band, and every reply is a row with its own
// status pill and the words in a recessed well — the exact words, in full, as before.

// Every moment this module shows a person is Cairo local time, never a raw UTC string. Written here,
// matching intake-health-view.tsx and recruitment-workspace.tsx, rather than imported across a
// domain boundary — the convention request-report-columns.ts states for its own copy.
function cairoDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";
  const date = value.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
  const time = value.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone: "Africa/Cairo",
  });
  return `${date}, ${time}`;
}

/**
 * A WhatsApp id is a phone number in international form. Shown with a leading + and NOT reformatted
 * beyond that: this is the string the message was addressed to, and a prettified version of it is
 * no longer the thing the record holds.
 */
function phoneLabel(waId: string): string {
  return waId.startsWith("+") ? waId : `+${waId}`;
}

/** The four reasons the table's CHECK constraint allows, in words rather than codes. */
function failureLabel(reason: string | null, detail: string | null): string {
  const base =
    reason === "disabled"
      ? "Not sent — the automatic reply is switched off"
      : reason === "window_closed"
        ? "Not sent — the 24-hour WhatsApp reply window had already closed"
        : reason === "invalid_menu"
          ? "Not sent — the menu could not be built"
          : reason === "failed"
            ? "Not sent — WhatsApp rejected it"
            : "Not sent";
  return detail ? `${base} (${detail})` : base;
}

/**
 * What the reply was answering, read back from the classifier's own verdict on the incoming
 * message. This is the line that says whether the person got the answer they asked for.
 */
function enquiryLabel(context: Record<string, unknown> | null): string | null {
  const enquiry = context?.enquiry;
  if (enquiry === "asked_about_the_job") return "They asked a question";
  if (enquiry === "plain") return "Opening message";
  return null;
}

/**
 * The message itself, one line at a time, each line deciding its own text direction.
 *
 * WHY PER LINE AND NOT PER MESSAGE. Every reply this line sends is bilingual: the Arabic first, then
 * the same thing again in English, separated by hard line breaks. Direction cannot be a property of
 * the block, because the block contains both.
 *
 *   - Leave it LTR (no dir at all, which is what this panel shipped with) and the Arabic is
 *     left-aligned with its punctuation and embedded Latin fragments ordered against the reader.
 *   - Put the automatic direction on the whole paragraph and it reads the FIRST strong character —
 *     Arabic — and makes the entire message RTL, which then renders the English half wrong: "Thanks
 *     for contacting Sato Pharma." comes out as ".Thanks for contacting Sato Pharma". That is the
 *     mirror-image of the first bug, and it was measured, not guessed.
 *
 * A line is the unit these messages are actually composed in, so it is the unit direction belongs
 * to — and per-line is what WhatsApp itself showed the recipient. This panel's one job is to show
 * the exact words that person received; rendering them in an order they never saw would fail it.
 */
function MessageBody({ body }: { body: string }) {
  return (
    <p
      className={`mt-3 border border-slate-200 bg-slate-50/80 px-3 py-2.5 text-sm leading-relaxed text-slate-800 ${adminRecessedDepthClassName}`}
    >
      {body.split("\n").map((line, index) => (
        <span
          className="block whitespace-pre-wrap break-words"
          dir="auto"
          // Position IS identity here: a sent message is immutable, this list never reorders, and
          // two identical lines within one message are genuinely interchangeable.
          key={index}
        >
          {/* An empty line still has to occupy one, or the gap the sender put between the Arabic
              and the English disappears. */}
          {line === "" ? " " : line}
        </span>
      ))}
    </p>
  );
}

/** A quiet meta chip under the number: what the reply was, never a status. */
function MetaChip({ children }: { children: string }) {
  return (
    <span
      className={`inline-flex items-center border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-slate-600 ${adminChipDepthClassName}`}
    >
      {children}
    </span>
  );
}

function MessageCard({ row }: { row: OutboundMessageRow }) {
  const enquiry = enquiryLabel(row.context);
  return (
    <li className="relative px-4 py-4 sm:px-5">
      {/* The side rail says the outcome before a word is read: green went out, rose did not. */}
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-[3px] ${row.ok ? "bg-emerald-400" : "bg-rose-500"}`}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-sm font-black tabular-nums tracking-[-0.01em] text-slate-900">{phoneLabel(row.toWaId)}</span>
        <span className="text-xs tabular-nums text-slate-500">{cairoDateTime(row.createdAt)}</span>
        {row.ok ? (
          <RecruitmentPill tone="emerald">
            <CheckCircle2 aria-hidden="true" className="h-3 w-3" />
            Sent
          </RecruitmentPill>
        ) : (
          <RecruitmentPill tone="rose">
            <XCircle aria-hidden="true" className="h-3 w-3" />
            Not sent
          </RecruitmentPill>
        )}
      </div>

      {enquiry || row.inboundWamid || row.messageType === "interactive" ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {enquiry ? <MetaChip>{enquiry}</MetaChip> : null}
          {row.inboundWamid ? <MetaChip>Reply to their message</MetaChip> : null}
          {row.messageType === "interactive" ? <MetaChip>Interactive menu</MetaChip> : null}
        </div>
      ) : null}

      {row.ok ? null : (
        <p className="mt-2 flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800">
          <AlertTriangle aria-hidden="true" className="mt-px h-3.5 w-3.5 flex-none" />
          <span className="min-w-0 break-words">{failureLabel(row.failureReason, row.failureDetail)}</span>
        </p>
      )}

      {/* The whole point of the panel. Shown in full, wrapped, never shortened — a reply you can
          only read half of answers nothing. whitespace-pre-wrap keeps the line breaks the recipient
          saw, and break-words stops a long unbroken string pushing the card sideways on a phone
          (measured: without it a 140-character unbroken token pushes the page 922px wide). */}
      {row.body ? (
        <MessageBody body={row.body} />
      ) : (
        <p className="mt-2 break-words text-sm text-slate-500">
          An interactive menu — its content is a structure rather than a paragraph, so it is kept in
          the record but has no single body to show here.
        </p>
      )}
    </li>
  );
}

export function WhatsAppRepliesView({ report }: { report: WhatsAppOutboundReport }) {
  const { failed, inboundInWindow, inboundSinceLogging, rows, total, windowDays } = report;
  /** Arrived in the window but before the log existed, so no row could ever exist for them. */
  const predatingLog = Math.max(0, inboundInWindow - inboundSinceLogging);

  return (
    <div className="space-y-5">
      <RecruitmentKpiStrip
        items={[
          {
            description: `last ${windowDays} days`,
            icon: <SendHorizontal aria-hidden="true" className="h-4 w-4" />,
            label: "Replies sent",
            tone: "emerald",
            value: <span className="tabular-nums">{String(total - failed)}</span>,
          },
          {
            description: failed > 0 ? "shown in red below" : "none",
            icon: <XCircle aria-hidden="true" className="h-4 w-4" />,
            label: "Failed to send",
            tone: "rose",
            value: <span className="tabular-nums">{String(failed)}</span>,
          },
          {
            description: `last ${windowDays} days`,
            icon: <Inbox aria-hidden="true" className="h-4 w-4" />,
            label: "Messages received",
            tone: "blue",
            value: <span className="tabular-nums">{String(inboundInWindow)}</span>,
          },
          {
            description: "newest first",
            icon: <ListOrdered aria-hidden="true" className="h-4 w-4" />,
            label: "Shown below",
            tone: "orange",
            value: <span className="tabular-nums">{String(rows.length)}</span>,
          },
        ]}
      />

      <RecruitmentPanel
        count={rows.length}
        description="Every WhatsApp message Phoenix sent from the recruitment line, newest first, with the exact words the person received. Sent means WhatsApp accepted the message — it is not a read receipt, and it does not prove the handset displayed it."
        icon={<MessageSquareReply aria-hidden="true" className="h-4 w-4" />}
        title="What went out"
      >
        {rows.length === 0 ? (
          // Zero replies means one of two opposite things, and rendering the reassuring one
          // unconditionally is a mistake this repository has already paid for: during the 2026-08-01
          // outage the intake-health page reported a perfect score right through a total outage,
          // because nothing had been enqueued and so nothing had failed. The inbound count is what
          // separates a quiet line from a broken one.
          //
          // But it must be the count of messages that arrived while the log was RECORDING. Comparing
          // against the full window raises an alarm out of the log's own youth — the first render of
          // this page did exactly that, holding four inbound messages from the preceding weeks against
          // a table a few hours old and announcing that Phoenix had answered none of them.
          inboundSinceLogging === 0 ? (
            <RecruitmentEmptyState
              icon={<Inbox aria-hidden="true" className="h-5 w-5" />}
              message={
                predatingLog > 0 ? (
                  // Saying "nothing arrived either" here would contradict the very next sentence, which
                  // is about to name the messages that did.
                  <>
                    <p>
                      Nothing sent since the record started on 30 Aug, and nothing has arrived since
                      then either. That is a quiet channel, not a fault.
                    </p>
                    <p className="mt-2">
                      {predatingLog} message{predatingLog === 1 ? "" : "s"} did arrive earlier in this{" "}
                      {windowDays}-day window, before the record existed. Whatever was replied to{" "}
                      {predatingLog === 1 ? "it" : "them"} was never written down, so there is nothing
                      here to show — a gap in the record, not a missed reply.
                    </p>
                  </>
                ) : (
                  <p>
                    Nothing sent in the last {windowDays} days, and nothing arrived either — nobody has
                    messaged the recruitment line. That is a quiet channel, not a fault.
                  </p>
                )
              }
              title="A quiet line"
            />
          ) : (
            <div className="p-4 sm:p-5">
              <div className={`flex items-start gap-3 border border-amber-300 bg-amber-50 px-4 py-3 ${adminSoftDepthClassName}`} role="alert">
                <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 flex-none text-amber-600" />
                <p className="min-w-0 break-words text-sm text-amber-900">
                  {inboundSinceLogging} message{inboundSinceLogging === 1 ? "" : "s"} arrived since the
                  record started and Phoenix replied to none of them. That is not a quiet line — either
                  the automatic reply is switched off, or replies are going out without being recorded.
                  Both are worth checking now.
                </p>
              </div>
            </div>
          )
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((row) => (
              <MessageCard key={row.id} row={row} />
            ))}
          </ul>
        )}
      </RecruitmentPanel>
    </div>
  );
}
