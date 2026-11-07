/**
 * Reading a train ticket — the server half of ticket-scan-rules.ts (owner, 2026-11-07).
 *
 *  - `readTrainTicket` asks the one AI door for the travel date, the stations and the train number, and for
 *    what is wrong with the photo when the date cannot be read. No key, a failed call or a reply that is not
 *    JSON is `unavailable` — the ticket is kept, never refused for the system's own outage.
 *  - The read is done ONCE, when the employee picks the file (POST /api/outstation/ticket-scan). It comes
 *    back with a signed note of what was read, bound to the file's own bytes and to the employee, so the
 *    submit and the missing-ticket upload re-judge the date from the note instead of paying for a second
 *    read — and a file with no note, or with a note for other bytes, is read again on the server. The phone
 *    is never trusted to say a ticket was accepted.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { createOpenAiResponseText, hasAiApiKey, OPENAI_ROUTE_BUDGET_MS } from "@/lib/ai/openai-client";
import { parseAiJson } from "@/lib/ai/parse-ai-json";
import { canonicalHrIdKey } from "@/lib/hr-id";
import type { OutstationTicketAttachmentUploadInput } from "@/lib/outstation/car-evidence-storage";
import {
  judgeTrainTicket,
  normalizeTicketScan,
  TICKET_SCAN_PROBLEMS,
  ticketRefusalMessage,
  type OutstationTicketScanRecord,
  type TicketDateContext,
  type TicketScanRead,
  type TicketVerdict,
} from "@/lib/outstation/ticket-scan-rules";

const INSTRUCTIONS = [
  "You read Egyptian travel tickets — train tickets (Egyptian National Railways and similar) and bus tickets (Go Bus, Blue Bus, Super Jet and similar) — from a photo or a PDF.",
  "The ticket may be in Arabic, English or both, with Arabic or Western digits.",
  "Booking-app tickets, e-tickets, payment receipts for a train or bus seat (OPay, Fawry and similar) and screenshots of a booking count as tickets.",
  "Return the TRAVEL date — the day the train or bus runs — as YYYY-MM-DD. Never the purchase, issue, booking or print date when a separate travel date is shown:",
  "on Egyptian National Railways tickets the bottom line and the 'Issued' (صادر) line are when it was sold; on booking apps 'تاريخ إصدار الحجز' and 'التاريخ' are the booking date, while 'رحلة ذهاب', 'رحلة السفر', 'رحلة العودة' and 'وقت المغادرة' give the travel day.",
  "Egyptian National Railways tickets print the travel date twice: in English as DD/MM/YYYY beside the departure time, and in Arabic digits as YYYY/MM/DD with the time at the top right.",
  "Read whichever copy is clear. When one copy is blurred, smudged, crossed by a pen line or cut off and the other copy shows every digit, the date IS readable — return it and leave problems empty.",
  "When the ticket prints the travel day and month but no year (for example الاثنين ٢٧ يوليو, Monday 27 July), return that day and month with the year 2000 and set year_printed to false. Otherwise year_printed is true.",
  "A date written by hand on the ticket is not a printed travel date.",
  "Return null for travel_date unless you can read every digit of it with certainty in at least one printed copy. Never guess a digit.",
  "from_station and to_station as printed; train_number as the train or bus trip number printed; null when not readable.",
  "is_train_ticket is false when the image is not a train or bus ticket at all.",
  "problems: when the date is not readable, list every photo problem that stopped you, from:",
  "too_far (the ticket is small in the frame), too_close (part of the ticket is outside the frame because the camera is too near),",
  "cut_off (an edge or the date is outside the frame), blurry, dark, glare, rotated, date_hidden (covered or folded), not_a_ticket.",
  "When the date is read, problems is an empty list.",
].join(" ");

const TEXT_FORMAT = {
  format: {
    name: "phoenix_train_ticket",
    schema: {
      additionalProperties: false,
      properties: {
        from_station: { type: ["string", "null"] as const },
        is_train_ticket: { type: "boolean" as const },
        problems: { items: { enum: [...TICKET_SCAN_PROBLEMS], type: "string" as const }, type: "array" as const },
        to_station: { type: ["string", "null"] as const },
        train_number: { type: ["string", "null"] as const },
        travel_date: { type: ["string", "null"] as const },
        year_printed: { type: "boolean" as const },
      },
      required: ["is_train_ticket", "travel_date", "year_printed", "from_station", "to_station", "train_number", "problems"],
      type: "object" as const,
    },
    strict: true as const,
    type: "json_schema" as const,
  },
};

/** Reads one ticket file (a JPEG/PNG photo or a PDF). Never throws. */
export async function readTrainTicket(ticket: Pick<OutstationTicketAttachmentUploadInput, "bytes" | "contentType">): Promise<TicketScanRead> {
  if (!hasAiApiKey()) return { status: "unavailable" };
  const dataUrl = `data:${ticket.contentType};base64,${ticket.bytes.toString("base64")}`;
  const file =
    ticket.contentType === "application/pdf"
      ? { file_data: dataUrl, filename: "ticket.pdf", type: "input_file" as const }
      : { detail: "high" as const, image_url: dataUrl, type: "input_image" as const };
  try {
    const response = await createOpenAiResponseText({
      input: [{ content: [{ text: "Read this ticket.", type: "input_text" as const }, file], role: "user" as const }],
      instructions: INSTRUCTIONS,
      maxOutputTokens: 1_000,
      purpose: "outstation-train-ticket-scan",
      reasoning: { effort: "low" },
      text: TEXT_FORMAT,
      timeoutMs: OPENAI_ROUTE_BUDGET_MS,
    });
    return normalizeTicketScan(parseAiJson(response.outputText));
  } catch {
    return { status: "unavailable" };
  }
}

// ── The signed note ──────────────────────────────────────────────────────────────────────────────────

const TOKEN_PREFIX = "ts1";
const KEY_LABEL = "phoenix-train-ticket-scan-v1";
/** A read is good for the day it was made — long enough to finish a claim, short enough to never linger. */
const TOKEN_TTL_SECONDS = 24 * 60 * 60;

type TokenPayload = { exp: number; hash: string; hr: string; scan: TicketScanRead };

function signingKey(): Buffer | null {
  const secret = process.env.PHOENIX_AUTH_SECRET?.trim();
  if (!secret) return null;
  return createHmac("sha256", secret).update(KEY_LABEL).digest();
}

export function ticketBytesHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function signTicketScan(input: { bytes: Buffer; hrId: string; scan: TicketScanRead; nowSeconds?: number }): string | null {
  const key = signingKey();
  if (!key) return null;
  const payload: TokenPayload = {
    exp: (input.nowSeconds ?? Math.floor(Date.now() / 1000)) + TOKEN_TTL_SECONDS,
    hash: ticketBytesHash(input.bytes),
    hr: canonicalHrIdKey(input.hrId) ?? input.hrId,
    scan: input.scan,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", key).update(`${TOKEN_PREFIX}.${body}`).digest("base64url");
  return `${TOKEN_PREFIX}.${body}.${signature}`;
}

/** The read a note carries — only for these exact bytes, this employee, and before it expires. */
export function readSignedTicketScan(
  token: unknown,
  input: { bytes: Buffer; hrId: string; nowSeconds?: number },
): TicketScanRead | null {
  const key = signingKey();
  if (!key || typeof token !== "string") return null;
  const [prefix, body, signature] = token.split(".");
  if (prefix !== TOKEN_PREFIX || !body || !signature) return null;
  const expected = createHmac("sha256", key).update(`${prefix}.${body}`).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return null;
  }
  if ((input.nowSeconds ?? Math.floor(Date.now() / 1000)) > payload.exp) return null;
  if (payload.hash !== ticketBytesHash(input.bytes)) return null;
  if (payload.hr !== (canonicalHrIdKey(input.hrId) ?? input.hrId)) return null;
  return payload.scan;
}

/**
 * The server's own check of the train tickets on a submit or a late upload: each is judged from its signed
 * note, or read again when it has none. A refused one stops the upload with the reason and what to do.
 */
export async function checkTrainTicketsOnServer(input: {
  tickets: ReadonlyArray<OutstationTicketAttachmentUploadInput & { scanToken?: unknown }>;
  hrId: string;
  context: TicketDateContext;
}): Promise<OutstationTicketScanRecord[]> {
  const records: OutstationTicketScanRecord[] = [];
  for (const [index, ticket] of input.tickets.entries()) {
    const scan = readSignedTicketScan(ticket.scanToken, { bytes: ticket.bytes, hrId: input.hrId }) ?? (await readTrainTicket(ticket));
    const verdict: TicketVerdict = judgeTrainTicket(scan, input.context);
    if (!verdict.accepted) {
      const which = input.tickets.length > 1 ? `Ticket ${index + 1}: ` : "";
      throw new TrainTicketRefusedError(`${which}${ticketRefusalMessage(verdict)}`);
    }
    records.push({
      fromStation: scan.status === "read" ? scan.fromStation : null,
      line: verdict.line,
      matchedTo: verdict.matchedTo,
      toStation: scan.status === "read" ? scan.toStation : null,
      trainNumber: scan.status === "read" ? scan.trainNumber : null,
      travelDate: verdict.travelDate,
    });
  }
  return records;
}

/** A refused train ticket — a 400 the employee can act on, never a server fault. */
export class TrainTicketRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrainTicketRefusedError";
  }
}
