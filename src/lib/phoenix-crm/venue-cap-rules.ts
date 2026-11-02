// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE SUPER ADMIN'S POLYCLINIC CAPS — one rep, his polyclinics, a switch and a number on each.
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

export type VenueCapsAdminView = {
  companyCap: number;
  offPlanDailyCap: number;
  offPlanWeeklyCap: number;
  reps: VenueCapRepRow[];
  selected: VenueCapRepRow | null;
  venues: VenueCapRow[];
};

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
