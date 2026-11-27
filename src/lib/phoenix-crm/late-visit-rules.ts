/**
 * Phoenix CRM — a held visit that missed its window, filed whole for the Super Admin to decide.
 *
 * WHY THIS EXISTS. A visit the phone held for want of signal is sent by itself for two hours and never across 02:00
 * (`visit-resend-rules.ts`), because the server dates a browser's save at ARRIVAL and past either line it would land
 * on the wrong day. Until 24 Nov 2026 such a visit stayed on the phone as "Not sent in time" until the person logged
 * it again, and a person who never did lost it. Owner, 24 Nov 2026: "never any visit to be lost from either a rep or
 * from the manager", then, on that visit: "SUPER ADMIN APPROVE IT ONLY SUPER ADMIN". So the phone files it here,
 * the very body the press would have sent, and it counts in nothing until he approves it onto the day it was pressed
 * through the door that already enters a missed record (`server/missed-records.ts`, `server/manager-missed-records.ts`).
 *
 * Pure, so every branch is provable with no database: `tests/phoenix-crm-late-visits.test.ts`.
 */

import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { UNPLANNED_REASON_MIN } from "@/lib/phoenix-crm/unplanned-rules";

// ── What the person reads on the held row. Nothing names a check, a clock or a review of them (Golden Rule #1). ──

export const VISIT_FILED_PILL = "Sent for approval";
export const VISIT_FILED_LINE = "This visit reached Phoenix after its day closed, so it counts once it is approved.";
/** The same row, for a visit the phone kept at the press: nothing about why, only that it is kept and what happens next. */
export const VISIT_KEPT_LINE = "This visit is kept, and it counts once it is approved.";

/**
 * 🔴 A VISIT PRESSED WHILE THE PHONE GAVE NO READING IS FILED, NEVER LOST (owner, 24 Nov 2026: "build the three
 * follow-ups"; "never any visit to be lost"). Location was allowed and still nothing came, indoors or with GPS lost,
 * so the press could only be refused, and a rep who walked on lost it. The phone now files it whole for the Super
 * Admin, who decides with the row marked "No location". A territory visit only: a manager's own single visit reads no
 * location. Location SWITCHED OFF is still refused at the press, with the server's own sentence to switch it on.
 */
export function pressedWithNoLocation(kind: "territory" | "manager_single" | undefined, body: Record<string, unknown>): boolean {
  if (kind === "manager_single") return false;
  return !(typeof body.lat === "number" && Number.isFinite(body.lat) && typeof body.lon === "number" && Number.isFinite(body.lon));
}
export const VISIT_FILED_DISMISS = "OK";

export type LateVisitKind = "territory" | "manager_single";

/** The Super Admin's page for them, under the field CRM admin. */
export const LATE_VISITS_ADMIN_PATH = "/admin/field-crm/late-visits";

// ── What the Super Admin's list shows. Shared with the screen, so the browser never imports the server file. ──

export type LateVisitStatus = "pending" | "approved" | "rejected";

export type LateVisitItem = {
  id: string;
  kind: LateVisitKind;
  senderName: string;
  territoryName: string;
  customerName: string;
  pressedDay: string;
  /** The press on the phone's own clock, in Cairo time, or null when the phone sent none. */
  pressedAtText: string | null;
  arrivedAtText: string;
  /** "Planned", "Off plan" or "Own single visit" — what the press said it was. */
  visitLabel: string;
  /** The phone gave no reading at the press, so the visit was filed there (`pressedWithNoLocation`). */
  withoutLocation: boolean;
  products: string[];
  comment: string | null;
  status: LateVisitStatus;
  decidedByName: string | null;
  decidedAtText: string | null;
  /** Why Phoenix closed it by itself (`duplicateClosingReason`), or null on a decision the Super Admin made. */
  decisionReason: string | null;
};

// ── A filed visit the person already logged again ─────────────────────────────────────────────────

/**
 * 🔴 A COPY OF A VISIT ALREADY COUNTED IS CLOSED BY PHOENIX, SHOWN, AND NEVER COUNTED (owner, 27 Nov 2026, on three
 * "No location" visits whose reps logged the same doctor again with location minutes later: show it happened, show
 * it rejected and why, and never count it). The match is the missed-record door's own "already visited" rule — the
 * same seat, customer and day for a territory visit, the same manager, customer and day for his own single visit — so
 * a row closed here is exactly one the Approve button could only have been refused on.
 */
export type LateVisitCandidate = {
  kind: LateVisitKind;
  seatId: string;
  senderHrId: string;
  customerId: string;
  /** A manager's single visit may name a customer of his own list instead (`body.managerCustomerId`). */
  managerCustomerId: string | null;
  pressedDay: string;
};

export type CountedVisit = {
  kind: LateVisitKind;
  seatId: string | null;
  managerHrId: string | null;
  customerId: string | null;
  managerCustomerId: string | null;
  visitDate: string;
  /** When it was logged, as the phone stamped it, or the save when the phone sent none. */
  loggedAt: string | null;
  withLocation: boolean;
};

export function countedCopyOf(candidate: LateVisitCandidate, visits: readonly CountedVisit[]): CountedVisit | null {
  const sender = personOf(candidate.senderHrId);
  const matches = visits.filter((visit) => {
    if (visit.kind !== candidate.kind || visit.visitDate !== candidate.pressedDay) return false;
    if (candidate.kind === "territory") return visit.seatId === candidate.seatId && visit.customerId === candidate.customerId;
    if (!sender || personOf(visit.managerHrId) !== sender) return false;
    return (
      (visit.customerId !== null && visit.customerId === candidate.customerId) ||
      (candidate.managerCustomerId !== null && visit.managerCustomerId === candidate.managerCustomerId)
    );
  });
  // The earliest counted one is the one named, whichever order the read returned them in.
  return [...matches].sort((left, right) => String(left.loggedAt ?? "").localeCompare(String(right.loggedAt ?? "")))[0] ?? null;
}

/** What the Decided tab says on a row Phoenix closed. `loggedAtText` is the counted visit's time in Cairo, or null. */
export function duplicateClosingReason(counted: Pick<CountedVisit, "withLocation">, loggedAtText: string | null): string {
  const when = loggedAtText ? ` at ${loggedAtText}` : " the same day";
  const where = counted.withLocation ? " with its location" : "";
  return `Already counted: the same visit was logged again${when}${where}, and that one is counted. This copy was closed automatically and is not counted.`;
}

/** Who decided, on a row Phoenix closed by itself. */
export const CLOSED_AUTOMATICALLY_BY = "Phoenix, automatically";

export type LateVisitsBoard = { pending: LateVisitItem[]; decided: LateVisitItem[] };

/** The most a filed body may hold. A real press is about 2 KB; this only stops a body nobody's phone could make. */
export const LATE_VISIT_BODY_MAX_CHARS = 20_000;

export type LateVisitFiling = {
  id: string;
  kind: LateVisitKind;
  seatId: string;
  customerId: string;
  customerName: string;
  pressedDay: string;
  pressedAtDevice: string | null;
  body: Record<string, unknown>;
};

type Parse<T> = { ok: true; value: T } | { ok: false; error: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What a phone may file. The person is never read from here: the route takes it from the session. The id must be the
 * body's own (`id` on a territory visit, `clientRef` on a manager's single visit), so a filing can never carry a
 * visit under an id it does not hold.
 */
export function parseLateVisitFiling(raw: unknown): Parse<LateVisitFiling> {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = input.kind === "territory" || input.kind === "manager_single" ? input.kind : null;
  if (!kind) return { ok: false, error: "Unknown visit." };
  if (!isUuid(input.id) || !isUuid(input.customerId)) return { ok: false, error: "Unknown visit." };
  const id = String(input.id).toLowerCase();
  const body = input.body && typeof input.body === "object" && !Array.isArray(input.body) ? (input.body as Record<string, unknown>) : null;
  if (!body) return { ok: false, error: "Unknown visit." };
  if (JSON.stringify(body).length > LATE_VISIT_BODY_MAX_CHARS) return { ok: false, error: "This visit is too large to keep." };
  const ownId = kind === "territory" ? body.id : body.clientRef;
  if (!isUuid(ownId) || String(ownId).toLowerCase() !== id) return { ok: false, error: "Unknown visit." };
  const seatId = typeof input.seatId === "string" ? input.seatId.trim().slice(0, 80) : "";
  if (!seatId) return { ok: false, error: "Unknown visit." };
  if (typeof input.pressedDay !== "string" || !DAY.test(input.pressedDay)) return { ok: false, error: "Unknown visit." };
  const pressed = typeof input.pressedAtDevice === "string" ? Date.parse(input.pressedAtDevice) : NaN;
  const customerName = (typeof input.customerName === "string" ? input.customerName.trim() : "").slice(0, 200) || "Customer";
  return {
    ok: true,
    value: {
      id,
      kind,
      seatId,
      customerId: String(input.customerId).toLowerCase(),
      customerName,
      pressedDay: input.pressedDay,
      pressedAtDevice: Number.isNaN(pressed) ? null : new Date(pressed).toISOString(),
      body,
    },
  };
}

/**
 * The Cairo wall-clock time of the press, as the missed-record door takes it ("14:30"), or null.
 *
 * 🔴 THE PHONE'S CLOCK IS BELIEVED ONLY WHEN IT AGREES WITH THE PHONE'S OWN DAY. A press read as falling on another
 * visit day is a clock nobody can trust, and the door's own rule for no time is used instead — never a made-up one.
 */
export function cairoPressTime(pressedAtDevice: string | null, pressedDay: string): string | null {
  if (!pressedAtDevice) return null;
  const at = new Date(pressedAtDevice);
  if (Number.isNaN(at.getTime()) || cairoBusinessDay(at) !== pressedDay) return null;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  return hour && minute ? `${hour}:${minute}` : null;
}

// The upper-case stored form, through the one HR id door (tests/hrid-normalizer-ratchet.test.ts).
function personOf(value: unknown): string | null {
  return typeof value === "string" ? canonicalHrIdForDisplay(value) : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];
}

/** Written when the person gave no reason of their own: the door wants one for a visit off the plan. */
export const LATE_VISIT_DEFAULT_REASON = "Logged on the day and sent once the phone had signal.";

/**
 * Everyone on a territory visit but the rep, nearest first, each once — the "picked" list the missed-record door
 * takes. The sender is on it when the sender is not the rep: a manager who logged a visit on a rep's territory was there.
 */
export function pickedOnTerritoryVisit(body: Record<string, unknown>, senderHrId: string, repHrId: string): string[] {
  const rep = personOf(repHrId);
  const companions = Array.isArray(body.companions) ? body.companions.map((entry) => personOf((entry as { hrId?: unknown } | null)?.hrId)) : [];
  const ordered = [personOf(senderHrId), personOf(body.managerHrId), personOf(body.seniorHrId), ...companions, personOf(body.productManagerHrId)];
  const picked: string[] = [];
  for (const hrId of ordered) if (hrId && hrId !== rep && !picked.includes(hrId)) picked.push(hrId);
  return picked;
}

/** What `enterMissedVisit` receives when a filed territory visit is approved. */
export function territoryApprovalBody(input: {
  id: string;
  seatId: string;
  customerId: string;
  pressedDay: string;
  pressedAtDevice: string | null;
  senderHrId: string;
  repHrId: string;
  body: Record<string, unknown>;
}): Record<string, unknown> {
  const picked = pickedOnTerritoryVisit(input.body, input.senderHrId, input.repHrId);
  const planned = input.body.visitType !== "out_of_plan" && input.body.visitType !== "out_of_list";
  const own = typeof input.body.unplannedReason === "string" ? input.body.unplannedReason.trim().replace(/\s+/g, " ") : "";
  return {
    record: "visit",
    id: input.id,
    seatId: input.seatId,
    customerId: input.customerId,
    visitDate: input.pressedDay,
    visitTime: cairoPressTime(input.pressedAtDevice, input.pressedDay),
    planned,
    reason: planned ? null : own.length >= UNPLANNED_REASON_MIN ? own : LATE_VISIT_DEFAULT_REASON,
    kind: picked.length === 0 ? "single" : picked.length === 1 ? "double" : "chain",
    picked,
    products: strings(input.body.products),
    comment: typeof input.body.comment === "string" ? input.body.comment : null,
  };
}

/** What `enterManagerMissedVisit` receives when a filed single visit of a manager's own is approved. */
export function managerApprovalBody(input: {
  id: string;
  managerKey: string;
  pressedDay: string;
  pressedAtDevice: string | null;
  body: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    record: "manager-visit",
    manager: input.managerKey,
    id: input.id,
    customerId: isUuid(input.body.customerId) ? input.body.customerId : null,
    managerCustomerId: isUuid(input.body.managerCustomerId) ? input.body.managerCustomerId : null,
    visitDate: input.pressedDay,
    visitTime: cairoPressTime(input.pressedAtDevice, input.pressedDay),
    products: strings(input.body.products),
    comment: typeof input.body.comment === "string" ? input.body.comment : null,
    address: typeof input.body.address === "string" ? input.body.address : null,
    // Who went with him, as his phone ticked them; the door checks each against his own offers (24 Nov 2026).
    companionHrIds: strings(input.body.companionHrIds),
  };
}
