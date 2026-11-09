"use client";

import { CheckCircle2, Info, ScanLine, TriangleAlert } from "lucide-react";

import {
  judgeTrainTicket,
  TICKET_SCAN_NEEDS,
  type TicketDateContext,
  type TicketScanRead,
  type TicketVerdict,
} from "@/lib/outstation/ticket-scan-rules";

/**
 * The phone's half of the train-ticket read (owner, 2026-11-07; ticket-scan-rules.ts) — ONE copy, shared
 * by the submit wizard and the card that attaches a ticket a claim arrived without.
 *
 * The file is prepared ONCE (prepareTicketAttachment) and those exact bytes are both read here and sent
 * with the claim, because the signed note the read returns is bound to them: a second canvas re-encode
 * could differ by a byte and the server would read the ticket again.
 */

export type PreparedTicket = { dataUrl: string; name: string };

/** A picked train ticket, prepared, with what the read found. `scanToken` is sent back with the file. */
export type ScannedTrainTicket = PreparedTicket & {
  scan: TicketScanRead;
  scanToken: string | null;
  /** The server's verdict against the dates it was sent — a claim's own photos for a late upload. */
  verdict: TicketVerdict | null;
};

/**
 * Reads one prepared ticket. With no signal, or when the read itself fails, the ticket comes back
 * "unavailable" with no note — kept, and read again on the server when the claim arrives.
 */
export async function scanTrainTicket(
  ticket: PreparedTicket,
  dates: { requestId: number } | { arrivalAt: string | null; tripEndDate: string; tripStartDate: string },
): Promise<ScannedTrainTicket> {
  try {
    const response = await fetch("/api/outstation/ticket-scan", {
      body: JSON.stringify({ ...dates, dataUrl: ticket.dataUrl, name: ticket.name }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const payload = (await response.json().catch(() => null)) as
      | { message?: string; scan?: TicketScanRead; token?: string | null; verdict?: TicketVerdict }
      | null;
    if (!response.ok) {
      // A refusal of the FILE itself (wrong type, too large, trip dates missing) is the employee's to fix.
      if (response.status === 400 && payload?.message) throw new TicketScanRequestError(payload.message);
      return { ...ticket, scan: { status: "unavailable" }, scanToken: null, verdict: null };
    }
    return {
      ...ticket,
      scan: payload?.scan ?? { status: "unavailable" },
      scanToken: payload?.token ?? null,
      verdict: payload?.verdict ?? null,
    };
  } catch (error) {
    if (error instanceof TicketScanRequestError) throw error;
    return { ...ticket, scan: { status: "unavailable" }, scanToken: null, verdict: null };
  }
}

export class TicketScanRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketScanRequestError";
  }
}

/** Splits scanned tickets by today's verdict — the dates can change after a ticket was read. */
export function judgeScannedTickets(tickets: readonly ScannedTrainTicket[], context: TicketDateContext) {
  const accepted: Array<{ ticket: ScannedTrainTicket; verdict: Extract<TicketVerdict, { accepted: true }> }> = [];
  const refused: Array<{ ticket: ScannedTrainTicket; verdict: Extract<TicketVerdict, { accepted: false }> }> = [];
  for (const ticket of tickets) {
    const verdict = judgeTrainTicket(ticket.scan, context);
    if (verdict.accepted) accepted.push({ ticket, verdict });
    else refused.push({ ticket, verdict });
  }
  return { accepted, refused };
}

/** "Reading the ticket" while the read runs. */
export function TicketScanReading({ count }: { count: number }) {
  return (
    <p className="flex items-start gap-2 text-phx-md leading-relaxed text-slate-600" role="status">
      <ScanLine aria-hidden className="mt-0.5 h-4 w-4 shrink-0 animate-pulse text-orange-600" />
      {count > 1 ? `Reading the ${count} tickets` : "Reading the ticket"} — checking its travel date against the trip.
    </p>
  );
}

/** What the read found for each ticket, and for a refused one: why, what to change, what is needed. */
export function TicketScanNotices({
  accepted,
  refused,
}: {
  accepted: ReadonlyArray<{ ticket: PreparedTicket; verdict: Extract<TicketVerdict, { accepted: true }> }>;
  refused: ReadonlyArray<{ ticket: PreparedTicket; verdict: Extract<TicketVerdict, { accepted: false }> }>;
}) {
  if (accepted.length === 0 && refused.length === 0) return null;
  const numbered = accepted.length + refused.length > 1;
  return (
    <div className="grid gap-2">
      {accepted.map(({ ticket, verdict }, index) => (
        <p
          className={
            verdict.matchedTo === "not_read"
              ? "flex items-start gap-2 border border-slate-200 bg-slate-50 px-3 py-2 text-phx-md leading-relaxed text-slate-700"
              : "flex items-start gap-2 border border-emerald-200 bg-emerald-50 px-3 py-2 text-phx-md leading-relaxed text-emerald-800"
          }
          key={`ok-${index}-${ticket.name}`}
        >
          {verdict.matchedTo === "not_read" ? (
            <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span className="min-w-0 break-words">
            {numbered ? <span className="font-bold">{ticket.name}: </span> : null}
            {verdict.line}
          </span>
        </p>
      ))}
      {refused.map(({ ticket, verdict }, index) => (
        <div className="border border-rose-200 bg-rose-50 px-3 py-3 text-phx-md leading-relaxed text-rose-900" key={`no-${index}-${ticket.name}`} role="alert">
          <p className="flex items-start gap-2 font-bold">
            <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">
              {numbered ? `${ticket.name}: ` : null}
              {verdict.reason}
            </span>
          </p>
          <p className="mt-2 text-phx-sm font-bold uppercase tracking-wider text-rose-700">Take the photo again</p>
          <ul className="mt-1 grid gap-1 pl-6">
            {verdict.guidance.map((line) => (
              <li className="list-disc" key={line}>
                {line}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-rose-800">{TICKET_SCAN_NEEDS}</p>
        </div>
      ))}
    </div>
  );
}
