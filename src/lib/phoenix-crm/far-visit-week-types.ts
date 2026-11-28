/**
 * The Far-visit week's shapes (owner, 28 Nov 2026), kept outside `server/` so the screen can name them: the report is
 * read by `server/far-visit-week-report.ts` and the screen only draws it. Types only — nothing here runs.
 */
import type { CaseMap } from "@/lib/crm-integrity/integrity-case-map";
import type {
  FarVisitWeek,
  FarVisitWeekCellCounts,
  FarVisitWeekFilter,
  FarVisitWeekKind,
  FarVisitWeekStanding,
} from "@/lib/phoenix-crm/far-visit-week-rules";

type Point = { lat: number; lon: number };

export type FarVisitWeekCell = FarVisitWeekCellCounts & { date: string; standing: FarVisitWeekStanding };

export type FarVisitWeekRow = {
  seatId: string;
  repName: string;
  territory: string;
  regionName: string | null;
  /** The territory's line, for the line filter. */
  lineName: string | null;
  /** The district manager's seat above this territory (the `dm` filter's value), or the no-district value. */
  districtSeatId: string;
  /** "Sahar El Gallad (Delta (2) · CNS)", "Vacant district (…)" or "No district manager". */
  districtLabel: string;
  cells: FarVisitWeekCell[];
  totals: FarVisitWeekCellCounts;
  cleanDays: number;
};

export type FarVisitWeekItem = {
  kind: FarVisitWeekKind;
  seatId: string;
  date: string;
  /** When it happened (ISO): the last refused try, or when the visit was held. */
  at: string | null;
  repName: string;
  territory: string;
  customerId: string;
  customerName: string;
  /** Metres from the customer's place, as the check measured it. */
  distanceMeters: number | null;
  /** The far line it was measured against. */
  farMeters: number | null;
  /** How many times save was pressed (a door refusal), or the stuck rep's tries (a hold). */
  tries: number;
  /** A door refusal whose customer the rep then visited from the right place the same day (an accepted visit apart). */
  loggedLater: boolean;
  spot: Point | null;
  visitId: string | null;
  placeId: string | null;
};

export type FarVisitWeekOption = { value: string; label: string };

export type FarVisitWeekReport = {
  week: FarVisitWeek;
  rows: FarVisitWeekRow[];
  items: FarVisitWeekItem[];
  totals: FarVisitWeekCellCounts & { reps: number; repsWithRejections: number };
  /** What the reader filtered by, as read from the address. */
  filter: FarVisitWeekFilter;
  /** "District manager: … · Line: …", or null when nothing narrows the week (printed on the Excel file). */
  filterLabel: string | null;
  /**
   * The choices in each filter. District managers and lines come from the whole scope; the reps from the rows the
   * district-manager and line filters leave, so picking a district first shortens the rep list.
   */
  options: { districts: FarVisitWeekOption[]; lines: string[]; reps: FarVisitWeekOption[] };
};

/**
 * Several weeks read together (owner, 28 Nov 2026: "multi select multi weeks"): each week exactly as it reads alone,
 * newest first, and one set of totals across them. The reps are the same rows in every week (the scope does not
 * change with the date), so `reps` is one week's count and `repsWithRejections` counts a rep once however many of
 * the weeks held a rejection.
 */
export type FarVisitWeeksReport = {
  weeks: FarVisitWeekReport[];
  totals: FarVisitWeekReport["totals"];
  filter: FarVisitWeekFilter;
  filterLabel: string | null;
  options: FarVisitWeekReport["options"];
};

export type FarVisitWeekDayItem = FarVisitWeekItem & { map: CaseMap | null; points: Array<{ index: number; label: string; lat: number; lon: number }> };
