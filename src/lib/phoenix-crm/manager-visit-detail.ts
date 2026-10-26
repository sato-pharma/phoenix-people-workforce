import { cairoWallClock } from "@/lib/format/cairo-zone";
import { pharmacyNameKey, pharmacyNamesOnVisit, visitCountBucketForListType, type PhoenixListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { formatClockMinute } from "@/lib/phoenix-crm/timings";

/**
 * Phoenix CRM — one manager visit in full, as a screen prints it.
 *
 * Owner, 2026-10-20: *"when a district manager does visits the visit count only appears in phx calendar and
 * private calendar, no I want full details — name, address, brick, type, AM/PM, when, single, double, every
 * single detail."* A manager's calendar cell and his private-calendar entry used to say "3 own single
 * visits" and nothing else; this is the record behind that number.
 *
 * Two kinds of visit sit on a manager's day, and they are kept apart on purpose:
 *
 *   `own`        — a single visit HE logged alone (`phoenix_crm_manager_visits`). It counts in his own report
 *                  and in no KPI, coverage or target; "AM / PM" for it is the HALF of the day it was planned
 *                  in, or the Cairo half it was logged in.
 *   `ride_along` — a double or chain visit a rep logged naming him (`phoenix_crm_countable_visits`). "AM / PM"
 *                  for it is the customer's LIST, exactly as the rep's own row counts it, and a pharmacy is a
 *                  third list that is never added to either.
 *   `rep`        — a visit a REP logged himself, on his own day (owner, 2026-10-21: "make everyone's visits appear
 *                  in details in the private calendar and the Phoenix CRM calendar exactly as Mina Farouk"). The
 *                  same record, read from the same countable view, so a rep's day and a manager's are one shape;
 *                  "AM / PM" is the customer's list, as on a ride-along. `managerHrId` then holds the REP — the
 *                  person whose day it is — whatever the field is called.
 *
 * Pure: no I/O, no permissions. A client component may import it as freely as a server read.
 */

export type ManagerDayVisitSource = "own" | "ride_along" | "rep";

export type ManagerDayVisitKind = "single" | "double" | "chain" | "product_manager";

/** Where a visit's place came from, so the screen can say how far to trust the address. */
export type ManagerVisitPlaceSource =
  /** The customer's saved place (a rep captured it, or the manager's own list pinned it). */
  | "saved_place"
  /** Captured or typed on the visit itself (a vacant area's doctor, owner 2026-10-19). */
  | "on_the_visit"
  | "none";

export type ManagerDayVisit = {
  id: string;
  source: ManagerDayVisitSource;
  /** The manager the day belongs to, normalised the way every Phoenix CRM person key is. */
  managerHrId: string;
  /** The Cairo calendar day, `YYYY-MM-DD`. */
  date: string;
  /** The moment the visit was logged, ISO — null only for a row that never recorded one. A screen prints it in Cairo time. */
  loggedAt: string | null;
  kind: ManagerDayVisitKind;
  /** "Single visit, alone" · "Double visit" · "Chain visit" · "Product manager visit". */
  kindLabel: string;
  /** The half-day bucket the calendar cell counts this visit under: the planned half, or the customer's list. */
  bucket: PhoenixListType;
  /** The Cairo half of the day it was actually logged in. Can differ from `bucket` (a PM-list doctor seen at 11:00). */
  loggedHalf: "AM" | "PM" | null;
  planned: boolean;
  customerName: string;
  /**
   * Who the visit was to, as the plan keys a customer: `c:<id>` for a customer on a rep's list, `m:<id>` for one on
   * the manager's own list. What the plan-against-actual table matches a planned customer to the visit that answers
   * it by — never the name, which two customers can share. Null when the row carries neither.
   */
  customerKey?: string | null;
  speciality: string | null;
  grade: string | null;
  /** The customer's list for a ride-along; null for an own visit, whose customer sits on a list of his own. */
  listType: PhoenixListType | null;
  address: string | null;
  areaName: string | null;
  brickName: string | null;
  /** The territory the doctor belongs to, by name — null for a customer on his own list. */
  territoryName: string | null;
  /** The label of the place — a clinic or a hospital name — when it differs from the customer. */
  placeLabel: string | null;
  placeSource: ManagerVisitPlaceSource;
  /** A location was captured with the visit (a pin). Never a distance or a flag: those are the integrity board's. */
  hasPin: boolean;
  /**
   * The people on a ride-along beside the manager, by name and title, rep first. Empty for his own visit. `hrId` is
   * who they are — the private calendar's day tile dedupes on it, so one person is never printed under two spellings.
   */
  withPeople: Array<{ hrId?: string | null; name: string; role: string }>;
  products: string[];
  comment: string | null;
  pharmacyName: string | null;
  /** A ride-along whose customer is not validated yet counts in no figure, exactly as on the rep's own row. */
  awaitingValidation: boolean;
  /**
   * A visit that was not on the plan and is still waiting for its approvals (the manager, then the SFE): listed and
   * marked, and in no figure until approved. Only a rep's day reads these (`loadRepVisitDetails` with `includeWaiting`).
   */
  awaitingApproval?: boolean;
  inVacantTerritory: boolean;
  /**
   * His own visit was entered for him by the Super Admin — a record he missed (owner, 2026-10-24). Read from who
   * entered it (`isManagerVisitEnteredForHim`); absent on a ride-along, whose own mark is the rep visit's.
   */
  enteredByAdmin?: boolean;
};

export const MANAGER_VISIT_KIND_LABELS: Record<ManagerDayVisitKind, string> = {
  single: "Single visit, alone",
  double: "Double visit",
  chain: "Chain visit",
  product_manager: "Product manager visit",
};

export function managerVisitKind(value: unknown): ManagerDayVisitKind {
  return value === "double" || value === "chain" || value === "product_manager" ? value : "single";
}

/** "10:42 AM" in Cairo, from the offset table that ships with the code — the same clock the screens print. */
export function managerVisitClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "—";
  const wall = cairoWallClock(value);
  return formatClockMinute(wall.getUTCHours() * 60 + wall.getUTCMinutes());
}

/**
 * One visit as a single line of plain text, for a surface that prints lines rather than cards (the private
 * calendar's day list and its dispute view): "10:42 AM · AM half · Single visit, alone · Planned — Dr X ·
 * Cardiology · Grade A · 12 Mostafa St, Brick Nasr City 3, Area Cairo East".
 */
export function managerVisitLine(visit: ManagerDayVisit): string {
  const half = managerVisitHalfLabel(visit);
  const head = [managerVisitClock(visit.loggedAt), half, visit.kindLabel, visit.planned ? "Planned" : "Not on the plan"].join(" · ");
  const body = [visit.customerName, managerVisitCustomerType(visit), managerVisitWhereLines(visit).join(", ")].filter(Boolean).join(" · ");
  const withText = visit.withPeople.length > 0 ? ` · With ${visit.withPeople.map((person) => `${person.name} (${person.role})`).join(", ")}` : "";
  return `${head} — ${body}${withText}`;
}

/**
 * One visit as the line a cramped calendar chip prints, one per visit, listed under each other (owner, 2026-10-20:
 * the chip said "Name, Name, Name +4 more" and he wanted every visit under the last, in full): "10:42 AM · AM half ·
 * Dr X · ENT · Grade A · Brick Nasr City 3, Area Cairo East". The kind and the plan state stay with the day's cards;
 * the rest of the record is here.
 *
 * 🔴 NO STREET ADDRESS ON THE CALENDAR ITSELF — the brick and the area only (owner, 2026-10-20: "do not show the
 *    address in the private calendar itself, show area/brick, and in the details show the address"). The address
 *    is the detail's: the day's table and cards, and `managerVisitLine`, still print it.
 */
export function managerVisitChipLine(visit: ManagerDayVisit): string {
  return [managerVisitClock(visit.loggedAt), managerVisitHalfLabel(visit), visit.customerName, managerVisitCustomerType(visit), managerVisitAreaLines(visit).join(", ")].filter(Boolean).join(" · ");
}

/** The half a visit is counted in, in words: "AM half" (his own), "PM list" (a rep's list), "Pharmacy" (a pharmacy, counted apart). */
export function managerVisitHalfLabel(visit: Pick<ManagerDayVisit, "bucket" | "listType" | "source">): string {
  if (visit.listType === "Pharmacy" && visit.source !== "own") return "Pharmacy";
  return visit.source === "own" ? `${visit.bucket} half` : `${visit.bucket} list`;
}

/** Where a visit was, without the street: the brick, then the area — each once, none empty. What the calendar itself prints. */
export function managerVisitAreaLines(visit: Pick<ManagerDayVisit, "brickName" | "areaName">): string[] {
  return managerVisitWhereLines({ address: null, areaName: visit.areaName, brickName: visit.brickName, placeLabel: null });
}

/** The address line a reader sees in the details: the street, then the brick, then the area — each once, none empty. */
export function managerVisitWhereLines(visit: Pick<ManagerDayVisit, "address" | "brickName" | "areaName" | "placeLabel">): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [visit.address, visit.brickName ? `Brick ${visit.brickName}` : null, visit.areaName ? `Area ${visit.areaName}` : null]) {
    const text = (part ?? "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/** "Oral Care Clinic", "ENT · Grade A" — the customer's type in a few words. */
export function managerVisitCustomerType(visit: Pick<ManagerDayVisit, "speciality" | "grade" | "listType">): string {
  const parts: string[] = [];
  if (visit.listType === "Pharmacy") parts.push("Pharmacy");
  else if (visit.speciality) parts.push(visit.speciality);
  if (visit.grade) parts.push(`Grade ${visit.grade}`);
  return parts.join(" · ");
}

/** Earliest first: a day is read the way it was lived. A row with no moment goes last, in id order. */
export function sortManagerDayVisits<T extends Pick<ManagerDayVisit, "loggedAt" | "id">>(visits: readonly T[]): T[] {
  return [...visits].sort((left, right) => {
    if (left.loggedAt && right.loggedAt) return left.loggedAt.localeCompare(right.loggedAt) || left.id.localeCompare(right.id);
    if (left.loggedAt) return -1;
    if (right.loggedAt) return 1;
    return left.id.localeCompare(right.id);
  });
}

/** One manager's visits, keyed `<managerHrId>|<date>`. */
export function groupManagerDayVisits(visits: readonly ManagerDayVisit[]): Map<string, ManagerDayVisit[]> {
  const out = new Map<string, ManagerDayVisit[]>();
  for (const visit of visits) {
    const key = `${visit.managerHrId}|${visit.date}`;
    const list = out.get(key);
    if (list) list.push(visit);
    else out.set(key, [visit]);
  }
  for (const [key, list] of out) out.set(key, sortManagerDayVisits(list));
  return out;
}

export type ManagerDayFigures = {
  /** Single visits he logged alone — counted in his own report only. */
  ownSingle: number;
  /** A rep's own single visits (source `rep`, kind `single`) — his own calls, counted on his own row. */
  singles: number;
  doubles: number;
  chains: number;
  productManagerVisits: number;
  /**
   * The calendar cell's own figures, so the page the cell opens can never print a different number for the
   * same Tuesday. AM · PM · Pharmacies stay three figures apart (the golden rule); a ride-along whose customer
   * is not validated is held out of them and counted in `awaitingValidation`.
   */
  am: number;
  pm: number;
  pharmacies: number;
  awaitingValidation: number;
};

export function managerDayFigures(visits: readonly ManagerDayVisit[]): ManagerDayFigures {
  const figures: ManagerDayFigures = { am: 0, awaitingValidation: 0, chains: 0, doubles: 0, ownSingle: 0, pharmacies: 0, pm: 0, productManagerVisits: 0, singles: 0 };
  const pharmacyNames = new Set<string>();
  for (const visit of visits) {
    if (visit.source === "own") figures.ownSingle += 1;
    else if (visit.kind === "double") figures.doubles += 1;
    else if (visit.kind === "chain") figures.chains += 1;
    else if (visit.kind === "product_manager") figures.productManagerVisits += 1;
    else figures.singles += 1;

    if (visit.awaitingValidation) {
      figures.awaitingValidation += 1;
      continue;
    }
    // Every visit by the customer's list — through the golden rule's own helper, so a pharmacy is never filed among the
    // doctors. 🔴 HIS OWN VISIT TOO (owner, 2026-10-23: "if a manager himself added a visit to a pharmacy, it should be
    // count … separate"): only a customer of Manager's own list, which carries no list, falls back to the half.
    const bucket = visit.source === "own" && visit.listType === null ? visit.bucket : visitCountBucketForListType(visit.listType);
    if (bucket === "AM") figures.am += 1;
    else if (bucket === "PM") figures.pm += 1;
    for (const name of pharmacyNamesOnVisit(visit.listType, visit.pharmacyName ?? "")) {
      const key = pharmacyNameKey(name);
      if (key) pharmacyNames.add(key);
    }
  }
  figures.pharmacies = pharmacyNames.size;
  return figures;
}

/** "3 own single visits · 1 double visit" — the short line a chip or a cell tooltip carries. */
export function managerDaySummaryLine(figures: ManagerDayFigures): string {
  const parts: string[] = [];
  const add = (count: number, one: string, many: string) => {
    if (count > 0) parts.push(`${count} ${count === 1 ? one : many}`);
  };
  add(figures.ownSingle, "own single visit", "own single visits");
  add(figures.singles, "single visit", "single visits");
  add(figures.doubles, "double visit", "double visits");
  add(figures.chains, "chain visit", "chain visits");
  add(figures.productManagerVisits, "product manager visit", "product manager visits");
  return parts.join(" · ");
}
