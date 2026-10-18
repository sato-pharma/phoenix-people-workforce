/**
 * Phoenix CRM — what leaves the server for a viewer who may not read a measurement.
 *
 * Two owner rulings decide it, and both are enforced HERE, on the server, never only by a screen:
 *
 *   - GOLDEN RULE #1 (2026-09-26, absolute since 2026-09-29): the rep reading his own territory receives
 *     no distance, no flag and no check of any kind.
 *   - THE DISTANCE ONLY (2026-10-02): every other reader below the Super Admin and the SFE Manager — the
 *     district manager, the acting one, the RSM, the NSM, the CEO — reads the distance and the far /
 *     at-the-place wording, and nothing about the reading behind it: no accuracy, no weak-signal verdict,
 *     no phone-clock warning, no raw readings, no point source.
 *
 * WHY THE SERVER. A JSON field a browser RECEIVES counts as shown even when React draws nothing from it:
 * it is one network tab away, and one careless render away from the screen. `team.ts` cleared
 * `locationFlag` on the server for exactly this reason on 2026-10-02, and the Phoenix CRM audit of the
 * same day found three more answers that carried a check to the rep, each hidden only by its screen —
 * the Visits report's far counts, the List's place measurements and the visit form's thresholds.
 *
 * Each shaper here is the LAST step of its loader, so the loader's whole answer passes through it. The
 * place shaper is an ALLOW-LIST: a measurement added to `ListPlace` later is withheld until somebody
 * decides who may have it, rather than reaching everyone by default.
 *
 * ABSENT, NEVER ZERO. `farVisits: 0` on the rep's own seat would still name the check — and would be a
 * false figure besides.
 *
 * What everyone KEEPS is the work and where the customers are: the place's name, address, brick, area,
 * region, hours, photo, and its point — which the rep's own board needs for the pin each address opens
 * and for gathering neighbours (`rowPoint`, list-row-facts.ts). A point is a location, never a
 * judgement; the readings, accuracies and verdicts around it are the judgement.
 */

import { locationSight, readsLocationDetail, readsSeatLocations, type LocationSight, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import type { ByList, RepVisitGroup, VisitCounts } from "@/lib/phoenix-crm/report-rules";
import type { OrgSeat } from "@/lib/phoenix-crm/scope";
import type { ListPlace, TerritoryListView } from "@/lib/phoenix-crm/server/list";
import type { VisitFormView } from "@/lib/phoenix-crm/server/visits";

// ── The Visits report ───────────────────────────────────────────────────────────────────────────

function withoutFarVisits(counts: VisitCounts): VisitCounts {
  const shaped = { ...counts };
  delete shaped.farVisits;
  return shaped;
}

function farVisitsOf(rows: ReadonlyArray<RepVisitGroup>, list: "am" | "pm"): number {
  return rows.reduce((sum, row) => sum + (row[list].farVisits ?? 0), 0);
}

/**
 * The Visits report with every far-visit count taken off the seats this viewer may not measure
 * (`readsSeatLocations`).
 *
 * A medical rep reads his own territory here (the tab is open to him), so for him the field leaves
 * every row, every day and both totals. So it does for the CEO and a regional manager, who read this
 * tab but not the place-vs-actual report (owner, 2026-10-02) — the far count is that report's figure.
 * An ACTING District Manager who still holds a rep seat keeps his team's counts and loses his own: the
 * totals are then the measured rows' alone, so his own cannot be had by subtracting the team from them.
 */
export function blindVisitsReport<Row extends RepVisitGroup, View extends { rows: Row[]; totals: ByList<VisitCounts> }>(
  viewer: PhoenixCrmViewer,
  view: View,
  seats: ReadonlyArray<OrgSeat>,
): View {
  const measured = new Set(seats.filter((seat) => readsSeatLocations(viewer, seat)).map((seat) => seat.seatId));
  if (seats.length > 0 && measured.size === seats.length && view.rows.every((row) => measured.has(row.seatId))) return view;

  const rows = view.rows.map((row) =>
    measured.has(row.seatId)
      ? row
      : {
          ...row,
          am: withoutFarVisits(row.am),
          pm: withoutFarVisits(row.pm),
          days: row.days.map((day) => ({ ...day, am: withoutFarVisits(day.am), pm: withoutFarVisits(day.pm) })),
        },
  );
  const measuredRows = view.rows.filter((row) => measured.has(row.seatId));
  const totals: ByList<VisitCounts> =
    measured.size === 0
      ? { AM: withoutFarVisits(view.totals.AM), PM: withoutFarVisits(view.totals.PM) }
      : {
          AM: { ...view.totals.AM, farVisits: farVisitsOf(measuredRows, "am") },
          PM: { ...view.totals.PM, farVisits: farVisitsOf(measuredRows, "pm") },
        };
  return { ...view, rows, totals };
}

// ── The List ────────────────────────────────────────────────────────────────────────────────────

/**
 * A place without its measurements — an ALLOW-LIST of what every reader below the Super Admin and the
 * SFE Manager may have.
 *
 * Withheld: `clockOff` (the phone-clock verdict), `accuracyMeters`, `pinReading`, `photoReading`,
 * `pointSource`, `moved` (with the SFE's or the Super Admin's written reason), `brickDistanceKm` and
 * `brickLookup` (2026-10-08 — whether anybody looked for the brick, which explains `brickDistanceKm`).
 *
 * NOT withheld, deliberately, because they are on the CUSTOMER and are his own: `reopenedAt` and
 * `validateAgainReason` — the one sentence about his photo is the thing he must read to fix it.
 *
 * `sharedPlaceId` is NOT withheld either, and it is not an oversight (2026-10-09): it says WHICH
 * polyclinic or centre this customer is seated in, the rep chose that venue himself at its door, and
 * his own list and his plan both have to say which building a call is in — the cap is three visits a
 * day inside one of them. It measures nothing about him. `pointSource` stays withheld as before, so
 * the fact that a seated point was copied rather than captured is still only the Super Admin's and
 * the SFE Manager's to see.
 */
export function placeWithoutMeasurements(place: ListPlace): ListPlace {
  return {
    placeId: place.placeId,
    label: place.label,
    address: place.address,
    brickId: place.brickId,
    brickName: place.brickName,
    areaCode: place.areaCode,
    areaName: place.areaName,
    regionCode: place.regionCode,
    regionName: place.regionName,
    zone: place.zone,
    lat: place.lat,
    lon: place.lon,
    timings: place.timings,
    photoPath: place.photoPath,
    capturedAt: place.capturedAt,
    sharedPlaceId: place.sharedPlaceId ?? null,
    // Which session he receives in at that building: his own choice at the door, measuring nothing.
    session: place.session ?? null,
    ...(place.venueTimetableOnFile === undefined ? {} : { venueTimetableOnFile: place.venueTimetableOnFile }),
    ...(place.venueHeld === undefined ? {} : { venueHeld: place.venueHeld }),
    // "New signboard photo needed": the sentence he must read to fix his photo, measuring nothing.
    signboardRetake: place.signboardRetake ?? null,
  };
}

/** The List as the viewer may receive it: whole for the Super Admin and the SFE Manager only. */
export function blindTerritoryList(viewer: PhoenixCrmViewer, view: TerritoryListView): TerritoryListView {
  if (readsLocationDetail(viewer)) return view;
  return {
    ...view,
    customers: view.customers.map((customer) => ({ ...customer, places: customer.places.map(placeWithoutMeasurements) })),
    // The weak-signal threshold is how a reading is judged; how many clinics a customer may hold is a
    // plain limit of the list, and the add-a-clinic button needs it.
    rules: { placesMax: view.rules.placesMax },
  };
}

// ── The visit form ──────────────────────────────────────────────────────────────────────────────

/**
 * The visit form's thresholds as this viewer may receive them: none for the territory's own rep, how
 * far is far for a manager entering his own visit, and the weak-signal threshold for the Super Admin
 * and the SFE Manager alone. Nothing on the form draws either; the rule is about what leaves.
 */
export function blindVisitForm(viewer: PhoenixCrmViewer, seat: OrgSeat, view: VisitFormView): VisitFormView {
  const sight = locationSight(viewer, seat);
  if (sight === "full" || !view.rules) return view;
  const shaped = { ...view };
  if (sight === "none") delete shaped.rules;
  else shaped.rules = { visitFarMeters: view.rules.visitFarMeters };
  return shaped;
}

// ── The off-plan approval cards ─────────────────────────────────────────────────────────────────

/**
 * An off-plan visit's stored location flag, as a reader of the approval card may receive it: nothing
 * for the rep on his own visits (cleared on the server, 2026-10-02), the distance only for a manager —
 * a weak signal is never far (far beats weak, geo.ts), so it reads as a visit at the place and the card
 * draws no line — and the flag itself for the Super Admin and the SFE Manager.
 */
export function offPlanLocationFlag(sight: LocationSight, flag: string | null): string | null {
  if (sight === "none") return null;
  if (sight === "distance" && flag === "weak_gps") return "ok";
  return flag;
}
