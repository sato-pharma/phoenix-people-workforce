import type { OutboundMessageRow, WhatsAppOutboundReport } from "@/lib/recruitment/inbound/whatsapp-outbound-report";

// A server component on purpose: there is nothing to click. The page is force-dynamic, so a browser
// reload is the refresh, and shipping no client bundle keeps a read-only record read-only.

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-2xl font-semibold text-slate-900">{value}</div>
      <div className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      {hint ? <div className="mt-1 text-xs text-slate-400">{hint}</div> : null}
    </div>
  );
}

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
 *   - Put dir="auto" on the whole paragraph and it reads the FIRST strong character — Arabic — and
 *     makes the entire message RTL, which then renders the English half wrong: "Thanks for
 *     contacting Sato Pharma." comes out as ".Thanks for contacting Sato Pharma". That is the
 *     mirror-image of the first bug, and it was measured, not guessed.
 *
 * A line is the unit these messages are actually composed in, so it is the unit direction belongs
 * to — and per-line is what WhatsApp itself showed the recipient. This panel's one job is to show
 * the exact words that person received; rendering them in an order they never saw would fail it.
 */
function MessageBody({ body }: { body: string }) {
  return (
    <p className="mt-2 text-sm leading-relaxed text-slate-800">
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

function MessageCard({ row }: { row: OutboundMessageRow }) {
  const enquiry = enquiryLabel(row.context);
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-slate-800">{phoneLabel(row.toWaId)}</span>
        <span className="text-xs text-slate-500">{cairoDateTime(row.createdAt)}</span>
        {row.ok ? (
          <span className="rounded bg-emerald-50 px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide text-emerald-700">
            Sent
          </span>
        ) : (
          <span className="rounded bg-rose-50 px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide text-rose-700">
            Not sent
          </span>
        )}
      </div>

      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
        {enquiry ? <span>{enquiry}</span> : null}
        {row.inboundWamid ? <span>Reply to their message</span> : null}
        {row.messageType === "interactive" ? <span>Interactive menu</span> : null}
      </div>

      {row.ok ? null : (
        <p className="mt-2 rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {failureLabel(row.failureReason, row.failureDetail)}
        </p>
      )}

      {/* The whole point of the panel. Shown in full, wrapped, never shortened — a reply you can
          only read half of answers nothing. whitespace-pre-wrap keeps the line breaks the recipient
          saw, and break-words stops a long unbroken string pushing the card sideways on a phone
          (measured: without it a 140-character unbroken token pushes the page 922px wide). */}
      {row.body ? (
        <MessageBody body={row.body} />
      ) : (
        <p className="mt-2 text-sm text-slate-500">
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
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile hint={`last ${windowDays} days`} label="Replies sent" value={String(total - failed)} />
        <StatTile hint={failed > 0 ? "shown in red below" : "none"} label="Failed to send" value={String(failed)} />
        <StatTile hint={`last ${windowDays} days`} label="Messages received" value={String(inboundInWindow)} />
        <StatTile hint="newest first" label="Shown below" value={String(rows.length)} />
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-semibold text-slate-900">What went out</h2>
        <p className="text-xs text-slate-500">
          Every WhatsApp message Phoenix sent from the recruitment line, newest first, with the exact
          words the person received. Sent means WhatsApp accepted the message — it is not a read
          receipt, and it does not prove the handset displayed it.
        </p>
      </div>

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
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            {predatingLog > 0 ? (
              // Saying "nothing arrived either" here would contradict the very next sentence, which
              // is about to name the messages that did.
              <>
                <p className="text-sm text-slate-600">
                  Nothing sent since the record started on 30 Aug, and nothing has arrived since
                  then either. That is a quiet channel, not a fault.
                </p>
                <p className="mt-2 text-sm text-slate-500">
                  {predatingLog} message{predatingLog === 1 ? "" : "s"} did arrive earlier in this{" "}
                  {windowDays}-day window, before the record existed. Whatever was replied to{" "}
                  {predatingLog === 1 ? "it" : "them"} was never written down, so there is nothing
                  here to show — a gap in the record, not a missed reply.
                </p>
              </>
            ) : (
              <p className="text-sm text-slate-600">
                Nothing sent in the last {windowDays} days, and nothing arrived either — nobody has
                messaged the recruitment line. That is a quiet channel, not a fault.
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm text-amber-800">
              {inboundSinceLogging} message{inboundSinceLogging === 1 ? "" : "s"} arrived since the
              record started and Phoenix replied to none of them. That is not a quiet line — either
              the automatic reply is switched off, or replies are going out without being recorded.
              Both are worth checking now.
            </p>
          </div>
        )
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <MessageCard key={row.id} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}
