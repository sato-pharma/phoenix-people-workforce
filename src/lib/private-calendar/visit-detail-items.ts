// Private calendar: every Phoenix CRM visit in full, on the entry that already counts it.
//
// Owner, 2026-10-21: "make everyone's visits appear in details in the private calendar and the Phoenix CRM calendar
// exactly as Mina Farouk". Since 2026-10-20 a district manager's own single visits carry every visit in full —
// customer, type, half, clock, brick, area, address, who came along (`manager-own-visit-items.ts`). Everybody else's
// day still read as a count: a rep's entry said "AM 3 · PM 9" and a list of names, a double visit said "With X" and
// an area, and a team not yet started said "Visits: 12" and nothing more.
//
// This adds the detail and NOTHING ELSE. It never creates an entry and never removes one — the entries, their counts,
// their colours and what the no-activity engine reads off them are exactly what the loaders built. It only hangs each
// Phoenix CRM visit, as the same record Mina's day carries (`ManagerDayVisit`), on the ONE entry of that person's day
// that already counts it, so a visit is listed once however many entries the day has:
//
//   - a rep's own visit (`source: "rep"`) on his own single or double entry, matched by who went (single, double,
//     chain); for a team not yet started, on the "Phoenix CRM, logged before the team was started" entry;
//   - a visit a manager rode (`source: "ride_along"`) on his "performed" double or chain entry, or else beside his
//     own single visits.
//
// A visit with no entry to sit on is left off rather than given one of its own: an entry is coverage, and coverage
// is decided by the loaders, never by a detail read. Read-only, and best-effort like its siblings: a failed read
// leaves every entry exactly as it was.

import { hrIdLookupKeys } from "@/lib/hr-id";
import { managerVisitChipLine, managerVisitLine, sortManagerDayVisits, type ManagerDayVisit } from "@/lib/phoenix-crm/manager-visit-detail";
import { loadManagerRideAlongDetails, loadRepVisitDetails } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { privateCalendarItemKind, type PrivateCalendarVisitCompanion } from "@/lib/private-calendar/activity-kinds";
import type { PrivateCalendarItem } from "@/lib/private-calendar/logic";

function personKeyOf(value: string | null | undefined): string | null {
  const keys = hrIdLookupKeys(String(value ?? ""));
  return keys.length > 0 ? keys[0] : null;
}

/** Who went, as the calendar's colour key says it: a product manager's visit with a rep is a double. */
function companionOfVisit(visit: Pick<ManagerDayVisit, "kind">): PrivateCalendarVisitCompanion {
  if (visit.kind === "chain") return "chain";
  return visit.kind === "single" ? "single" : "double";
}

function companionOfItem(item: PrivateCalendarItem): PrivateCalendarVisitCompanion | null {
  const kind = privateCalendarItemKind(item);
  if (kind.startsWith("single_")) return "single";
  if (kind.startsWith("double_")) return "double";
  if (kind.startsWith("chain_")) return "chain";
  return null;
}

type Carrier = "door" | "received" | "performed" | "evidence" | "manager_own";

/** Which loader built an entry — read off its id, the one thing every loader stamps — or null when it carries no visits. */
function carrierOf(item: PrivateCalendarItem): Carrier | null {
  if (item.id.startsWith("field-visit-")) return companionOfItem(item) ? "door" : null;
  if (item.id.startsWith("phoenix-work-")) return privateCalendarItemKind(item) === "single_regular" ? "evidence" : null;
  if (item.id.startsWith("manager-own-visit-")) return "manager_own";
  if (item.source === "double_visit") return item.status === "performed" ? "performed" : item.status === "received" ? "received" : null;
  return null;
}

/** The entry a visit sits on: the first that matches, in the order a reader would look for it. */
function carrierFor(visit: ManagerDayVisit, candidates: ReadonlyArray<{ item: PrivateCalendarItem; carrier: Carrier }>): PrivateCalendarItem | null {
  const companion = companionOfVisit(visit);
  const order: Array<(entry: { item: PrivateCalendarItem; carrier: Carrier }) => boolean> =
    visit.source === "rep"
      ? [
          // FIRST, because its presence means the door does not carry these visits at all: the team is not started, so
          // a door entry on the same day is his iReports360 work, whose own customer list must stay as it is.
          (entry) => entry.carrier === "evidence",
          // A started team's day: Phoenix wins the day, so the door entry holds exactly his Phoenix visits.
          (entry) => (entry.carrier === "door" || entry.carrier === "received") && companionOfItem(entry.item) === companion,
          (entry) => entry.carrier === "door" || entry.carrier === "received",
        ]
      : [
          (entry) => entry.carrier === "performed" && companionOfItem(entry.item) === companion,
          (entry) => entry.carrier === "performed",
          (entry) => entry.carrier === "manager_own",
        ];
  for (const fits of order) {
    const found = candidates.find(fits);
    if (found) return found.item;
  }
  return null;
}

/**
 * The lines of an entry that are not one of its visits: a CRM door entry's customer list ("AM · Dr X · ENT") gives way
 * to the full record, and visits an entry already carries in full are re-listed with the new ones in time order.
 */
function headChipLines(item: PrivateCalendarItem, carrier: Carrier): string[] {
  const lines = item.chipLines ?? [item.title];
  if (carrier === "door") {
    // The door's chip is [kind, counts, "With …"?, …customers] (field-visits.ts).
    const head = lines.length > 2 && lines[2].startsWith("With ") ? 3 : 2;
    return lines.slice(0, Math.min(head, lines.length));
  }
  const carried = item.managerVisits?.length ?? 0;
  return carried > 0 && lines.length >= carried ? lines.slice(0, lines.length - carried) : lines;
}

function headDetailLines(item: PrivateCalendarItem, carrier: Carrier): string[] {
  const carried = new Set((item.managerVisits ?? []).map((visit) => managerVisitLine(visit)));
  return item.detailLines.filter((line) => !carried.has(line) && !(carrier === "door" && /^Customer \d+: /.test(line)));
}

/**
 * Pure: the same entries, with each Phoenix CRM visit hung on the one entry of its person's day that counts it. An
 * entry that gains no visit is returned untouched (the same object).
 */
export function attachVisitDetails(items: readonly PrivateCalendarItem[], visits: readonly ManagerDayVisit[]): PrivateCalendarItem[] {
  if (visits.length === 0) return [...items];
  const byDay = new Map<string, Array<{ item: PrivateCalendarItem; carrier: Carrier }>>();
  for (const item of items) {
    const carrier = carrierOf(item);
    const person = personKeyOf(item.employeeHrId);
    if (!carrier || !person) continue;
    const at = `${person}|${item.startDate}`;
    const list = byDay.get(at);
    if (list) list.push({ carrier, item });
    else byDay.set(at, [{ carrier, item }]);
  }

  const added = new Map<string, ManagerDayVisit[]>();
  const seen = new Set<string>();
  for (const visit of visits) {
    // A manager's own single visits are already on his own entry, in full.
    if (visit.source === "own" || seen.has(visit.id)) continue;
    seen.add(visit.id);
    const person = personKeyOf(visit.managerHrId);
    const candidates = person ? byDay.get(`${person}|${visit.date}`) : undefined;
    if (!candidates) continue;
    const carrier = carrierFor(visit, candidates);
    if (!carrier) continue;
    const list = added.get(carrier.id);
    if (list) list.push(visit);
    else added.set(carrier.id, [visit]);
  }
  if (added.size === 0) return [...items];

  return items.map((item) => {
    const extra = added.get(item.id);
    const carrier = extra ? carrierOf(item) : null;
    if (!extra || !carrier) return item;
    const all = sortManagerDayVisits([...(item.managerVisits ?? []), ...extra]);
    return {
      ...item,
      chipLines: [...headChipLines(item, carrier), ...all.map((visit) => managerVisitChipLine(visit))],
      detailLines: [...headDetailLines(item, carrier), ...all.map((visit) => managerVisitLine(visit))],
      managerVisits: all,
    };
  });
}

/**
 * The Phoenix CRM visits behind these people's days, in full: every visit each logged as a rep, and every visit each
 * rode as a manager or a product manager. Best-effort — a failed read returns none, and the calendar keeps its counts.
 */
export async function loadPrivateCalendarVisitDetails(employeeHrIds: string[], start: string, end: string): Promise<ManagerDayVisit[]> {
  if (employeeHrIds.length === 0) return [];
  try {
    const [reps, rides] = await Promise.all([
      loadRepVisitDetails({ end, repHrIds: employeeHrIds, start }),
      loadManagerRideAlongDetails({ end, managerHrIds: employeeHrIds, productManagerSlot: true, start }),
    ]);
    return [...reps, ...rides];
  } catch {
    return [];
  }
}
