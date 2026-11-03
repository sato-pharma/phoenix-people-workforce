// ─────────────────────────────────────────────────────────────────────────────────────────────────
// POLYCLINIC CAPS — one rep, his polyclinics, a switch and a number on each. The Super Admin's, and the SFE Manager's
// since 2026-11-03, when the page began opening on every exception that stands.
//
// Owner, 2026-11-02: "This module I filter by the medical rep. Then after I filter by the medical rep, all
// his polyclinics appear. Okay, I have the option to, for example, open or close the toggle. When I open the
// toggle, then no cap for this rep in this polyclinic. And also have the option to, for example, instead of
// making the cap 3, make it 5, make it 7. ... I can remove the cap for a rep in the chosen polyclinic, or I
// can increase the ceiling of the cap."
//
// THE SWITCH is a row on `phoenix_crm_offplan_exemptions` naming the venue, so it reaches exactly what the
// named-hospital rows reach: the venue's daily number for planned and unplanned visits, at the plan and at
// the door, and the out-of-plan limit there.
//
// THE NUMBER is `phoenix_crm_shared_places.daily_cap`. It moves the venue's daily number and nothing else, so
// the rep's out-of-plan limit still applies there, and the door holds the greater of it and the company's.
//
// 🔴 PER SEAT, like every exception before it: a venue belongs to the seat that captured it, so a rep who
// takes over the territory inherits what is set here. The page lists people because that is how he asks.
//
// The account, and what stays untouched: docs/phoenix-crm-offplan-exemptions.md.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import { sharedPlaceKindLabel } from "@/lib/phoenix-crm/shared-place-rules";

export const VENUE_CAPS_ADMIN_PATH = "/admin/field-crm/venue-caps";

/** The most one venue may hold in a day: the same bound as the company setting and the column's CHECK. */
export const VENUE_CAP_MAX = 20;

export const VENUE_CAP_OUT_OF_RANGE_TEXT = "Write a whole number above the company number, 20 at most.";

export const VENUE_CAP_ACTIONS = ["lift", "unlift", "end_partial", "raise", "standard"] as const;

export type VenueCapAction = (typeof VENUE_CAP_ACTIONS)[number];

export function parseVenueCapAction(value: unknown): VenueCapAction | null {
  const key = String(value ?? "").trim();
  return VENUE_CAP_ACTIONS.find((action) => action === key) ?? null;
}

/** The number the door holds: the greater of the two, so a raised venue never falls below the company's. */
export function effectiveVenueCap(companyCap: number, dailyCap: number | null): number {
  return Math.max(companyCap, dailyCap ?? 0);
}

/** A number the page may save, or the sentence that says why not. The database asks the same again. */
export function venueCapNumberProblem(raw: unknown, companyCap: number): string | null {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return VENUE_CAP_OUT_OF_RANGE_TEXT;
  const value = Number(text);
  if (value <= companyCap || value > VENUE_CAP_MAX) return VENUE_CAP_OUT_OF_RANGE_TEXT;
  return null;
}

export type VenueCapRepRow = {
  hrId: string;
  name: string;
  lineName: string;
  areaName: string;
};

export type VenueCapRow = {
  sharedPlaceId: string;
  seatId: string;
  name: string;
  kind: string;
  held: boolean;
  /** How many customers are seated here now. */
  seated: number;
  dailyCap: number | null;
  dailyCapSetByName: string | null;
  dailyCapSetAt: string | null;
  /** True when the door lets every visit through here: a row naming this venue, or a name key reaching it. */
  lifted: boolean;
  liftedByName: string | null;
  liftedAt: string | null;
  /** A row that frees unplanned visits here and leaves planned ones holding the number. */
  unplannedFree: boolean;
};

/** One venue holding anything but the company number: the first thing the page shows (owner, 2026-11-03). */
export type VenueExceptionRow = {
  sharedPlaceId: string;
  name: string;
  kind: string;
  held: boolean;
  /** Whoever holds the territory now: two on a shared seat, none on a vacant one. */
  reps: Array<{ hrId: string; name: string }>;
  lineName: string;
  areaName: string;
  lifted: boolean;
  dailyCap: number | null;
  unplannedFree: boolean;
  setByName: string | null;
  setAt: string | null;
};

export type VenueCapsAdminView = {
  companyCap: number;
  offPlanDailyCap: number;
  offPlanWeeklyCap: number;
  /** Every venue on any territory that holds an exception. The page opens on these, whichever rep is chosen. */
  exceptions: VenueExceptionRow[];
  reps: VenueCapRepRow[];
  selected: VenueCapRepRow | null;
  venues: VenueCapRow[];
};

/**
 * Whether a venue holds an exception. A stored number at or below the company's is not one, because the door holds the
 * greater of the two, so that venue is on the company number whatever the column says.
 */
export function venueHasException(row: Pick<VenueCapRow, "lifted" | "dailyCap" | "unplannedFree">, companyCap: number): boolean {
  return row.lifted || row.unplannedFree || effectiveVenueCap(companyCap, row.dailyCap) > companyCap;
}

/** Who answers for it, the strongest first: the switch, then the raised number, then the unplanned-only row. */
export function venueExceptionSetter(
  row: {
    lifted: boolean;
    liftedBy: string | null;
    liftedAt: string | null;
    dailyCap: number | null;
    dailyCapSetBy: string | null;
    dailyCapSetAt: string | null;
    unplannedBy: string | null;
    unplannedAt: string | null;
  },
  companyCap: number,
): { by: string | null; at: string | null } {
  if (row.lifted) return { by: row.liftedBy, at: row.liftedAt };
  if (effectiveVenueCap(companyCap, row.dailyCap) > companyCap) return { by: row.dailyCapSetBy, at: row.dailyCapSetAt };
  return { by: row.unplannedBy, at: row.unplannedAt };
}

/** The words for it in the list: "No cap", "5 visits a day", or the unplanned-only note. */
export function venueExceptionLabel(row: Pick<VenueCapRow, "lifted" | "dailyCap" | "unplannedFree">, companyCap: number): string {
  if (row.lifted) return "No cap";
  const parts: string[] = [];
  const number = effectiveVenueCap(companyCap, row.dailyCap);
  if (number > companyCap) parts.push(`${number} visits a day`);
  if (row.unplannedFree) parts.push("Unplanned visits carry no limit");
  return parts.join(" · ");
}

/** What the page's one note says: what each control moves, and what stays. */
export function venueCapsExplainer(view: Pick<VenueCapsAdminView, "companyCap" | "offPlanDailyCap" | "offPlanWeeklyCap">): string {
  return `The company number is ${view.companyCap} visits a day at one polyclinic or centre. Switching on No cap removes that number for this rep here, planned and unplanned, on the plan and when logging, and the rep's unplanned limit does not count here. A raised number moves the daily number only: the unplanned limit of ${view.offPlanDailyCap} a day and ${view.offPlanWeeklyCap} a week still applies. Approval, one visit per customer per day and the plan's AM and PM day limits stay as they are. Everything set here belongs to the territory, so a rep who takes it over keeps it.`;
}

export function venueKindLabel(kind: string): string {
  return sharedPlaceKindLabel(kind) ?? "Polyclinic or centre";
}

/** "No cap", or the number the door holds now and where it comes from. */
export function venueCapStateLabel(row: Pick<VenueCapRow, "lifted" | "dailyCap">, companyCap: number): string {
  if (row.lifted) return "No cap";
  const number = effectiveVenueCap(companyCap, row.dailyCap);
  return row.dailyCap !== null && number > companyCap ? `${number} visits a day, raised` : `${number} visits a day, the company number`;
}
