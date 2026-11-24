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

import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { UNPLANNED_REASON_MIN } from "@/lib/phoenix-crm/unplanned-rules";

// ── What the person reads on the held row. Nothing names a check, a clock or a review of them (Golden Rule #1). ──

export const VISIT_FILED_PILL = "Sent for approval";
export const VISIT_FILED_LINE = "This visit reached Phoenix after its day closed, so it counts once it is approved.";
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
  products: string[];
  comment: string | null;
  status: LateVisitStatus;
  decidedByName: string | null;
  decidedAtText: string | null;
};

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

function hrKey(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return text || null;
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
  const rep = hrKey(repHrId);
  const companions = Array.isArray(body.companions) ? body.companions.map((entry) => hrKey((entry as { hrId?: unknown } | null)?.hrId)) : [];
  const ordered = [hrKey(senderHrId), hrKey(body.managerHrId), hrKey(body.seniorHrId), ...companions, hrKey(body.productManagerHrId)];
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
  };
}
