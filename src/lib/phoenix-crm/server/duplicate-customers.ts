import { normalizeContactName } from "@/lib/crm/campaign-contact-match";
import { isLinkableName, specialityConflicts } from "@/lib/customer-identity/suggestions";
import type { IdentityCandidate, IdentityKind } from "@/lib/customer-identity/types";
import { parseListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { territoryName } from "@/lib/phoenix-crm/scope";
import { type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * One rep, one doctor, two rows on his own list — for the Super Admin and the SFE Manager.
 *
 * 🔴 IT IS HOUSEKEEPING, NOT AN ACCUSATION, AND THAT IS WHY IT IS NOT ON THE INTEGRITY BOARD. The
 * board exists because somebody may have been dishonest; this exists because somebody typed a name
 * twice. Filing a clerical double-entry beside a mock-location flag would put a rep under
 * suspicion for a typing mistake — and the owner's standing rule is that a false positive accuses
 * a real person, which is worse than a missed catch. Same two readers, deliberately separate page,
 * and the wording here never implies intent.
 *
 * 🔴 THE REP IS NEVER SHOWN IT (Golden Rule #1). It lives under `/admin`, which no rep can open at
 * all — the same structural reason the integrity board is a page rather than a CRM tab: the CRM
 * tabs are the component tree the field app renders, and one wrong role check there would put this
 * in front of the one person it is about. There is no tree here to get wrong.
 *
 * 🔴 NOTHING ON IT ACTS. Removing a duplicate is the existing two-step request — the district
 * manager, then SFE — and a list that could drop a customer would be a third path into a decision
 * the owner gave to those two seats. Reading it is the whole feature.
 *
 * WHY THE SAME SEAT AND NOT THE SAME LINE. Measured on production 2026-10-02 over the identity
 * engine's 624 Phoenix-CRM-to-Phoenix-CRM pairs: **594 straddle two lines** and are the owner's
 * treasure — one doctor worked by two lines is correct and must never be merged — **30 sit on one
 * line**, and **26 of those are one rep's own list holding the same doctor twice**. A list keyed on
 * the line would therefore be 96% wrong, and keyed on the company it would be worse. The seat is
 * the only grain where a second row is certainly a mistake: nobody is asked to visit one doctor
 * twice under two records.
 */

type Row = Record<string, unknown>;

const PAGE = 1000;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** `phoenix_crm_customers.list_type` as the identity engine's kind — AM, PM and Pharmacy never mix. */
function identityKindOf(listType: unknown): IdentityKind {
  const parsed = parseListType(listType);
  return parsed === "Pharmacy" ? "pharmacy" : parsed;
}

/** One row of a rep's list, as this report reads it. */
export type DuplicateCustomerEntry = {
  customerId: string;
  grade: string | null;
  listType: string | null;
  name: string;
  speciality: string | null;
};

export type DuplicateCustomerGroup = {
  /** The kind and the folded name the rows share — the key, never shown as a label. */
  nameKey: string;
  entries: DuplicateCustomerEntry[];
  repName: string | null;
  seatId: string;
  territoryName: string | null;
};

export type DuplicateCustomerView = {
  groups: DuplicateCustomerGroup[];
  /** How many rows are involved in total, which is always more than the number of groups. */
  rows: number;
};

/**
 * The pure rule: which of ONE seat's customers are the same doctor entered twice.
 *
 * 🔴 IT MATCHES ON `normalizeContactName`, NOT ON THE IDENTITY ENGINE'S `identityNameKey`, AND THE
 * DIFFERENCE IS 24 REAL PEOPLE. `identityNameKey` folds through `placeNameKey`, which is built for
 * PLACES — it treats emphatic consonants as interchangeable, which is right for a pharmacy's
 * signboard and catastrophic for a person: measured on production 2026-10-02 it collapses
 * **محمود اسماعيل into محمد اسماعيل**, **محمود هجرس into محمد هجرس** and **محمد سعيد into محمد
 * سعد** — different doctors, each of whom this page would have invited the SFE to delete. It
 * returned **52 groups over 106 rows** where only a handful were real.
 *
 * `normalizeContactName` returns **28 groups over 56 rows**, and it still catches the variant that
 * actually matters here — **احمد شلبى / احمد شلبي**, the ى-versus-ي ending that raw text misses
 * (23 groups). That is the bar: the same name spelled two ways, never two names that rhyme.
 *
 * 🔴 A ONE-WORD NAME IS NOT EVIDENCE, and that is the identity engine's rule rather than a new one
 * — `isLinkableName` is imported, not re-implemented. "محمد" on a rep's list twice is two doctors
 * named Mohamed far more often than it is one doctor typed twice, and a report that said otherwise
 * would send the SFE to drop a real customer.
 *
 * 🔴 A SPECIALITY CONFLICT ENDS IT, for the same reason it vetoes a pair in the engine: two rows
 * with one name and two specialities are two people, and on one rep's list that is ordinary — a
 * paediatrician and a dermatologist can share a name in one town. A missing speciality on either
 * side is not a conflict, because unknown is not disagreement.
 *
 * 🔴 ALL OF A GROUP MUST AGREE, not just one pair. Three rows where the third conflicts with the
 * other two is not one duplicate of three; it is a pair plus a stranger. Admitting the group whole
 * would name an innocent third row on a list that invites someone to remove it.
 */
export function groupSameRepDuplicates(
  candidates: readonly (IdentityCandidate & { sourceId: string })[],
): Map<string, (IdentityCandidate & { sourceId: string })[]> {
  const byName = new Map<string, (IdentityCandidate & { sourceId: string })[]>();
  for (const candidate of candidates) {
    if (!isLinkableName(candidate.name)) continue;
    const key = normalizeContactName(candidate.name);
    if (!key) continue;
    // 🔴 THE KIND IS PART OF THE KEY — PM, AM AND PHARMACY NEVER MIX (the identity engine's own rule,
    //    owner 2026-09-30). A doctor a rep sees in his clinic in the afternoon and in a hospital in
    //    the morning is two rows on purpose; so is a pharmacy that happens to be named after him. This
    //    page invites the SFE to have a row removed, so folding two kinds together would ask him to
    //    delete one half of a pair the owner himself ruled correct.
    const held = byName.get(`${candidate.kind}:${key}`) ?? [];
    held.push(candidate);
    byName.set(`${candidate.kind}:${key}`, held);
  }

  const out = new Map<string, (IdentityCandidate & { sourceId: string })[]>();
  for (const [key, group] of byName) {
    if (group.length < 2) continue;
    const clashes = group.some((left, i) => group.slice(i + 1).some((right) => specialityConflicts(left, right)));
    if (clashes) continue;
    out.set(key, group);
  }
  return out;
}

/**
 * Who reads this list: the Super Admin and the SFE Manager.
 *
 * 🔴 ITS OWN PREDICATE SINCE 2026-10-02, NOT THE INTEGRITY BOARD'S. It shared the board's two readers
 * through `canReadIntegrityBoard` until the owner split the board that day — the position cases are
 * now the Super Admin's alone — and a clerical double-entry must never inherit a rule written for
 * evidence of dishonesty, in either direction.
 */
export function canReadDuplicateCustomers(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin || viewer.isSfeManager;
}

/**
 * Every rep's own duplicates, across the whole company.
 *
 * The scope is deliberately not the viewer's territory: both readers are company-scope roles, and a
 * housekeeping list that showed one region's duplicates would hide the rest without saying so.
 */
export async function loadDuplicateCustomers(viewer: PhoenixCrmViewer): Promise<DuplicateCustomerView> {
  // The page asks the same predicate, so the screen can never be more generous than the service.
  if (!canReadDuplicateCustomers(viewer)) return { groups: [], rows: 0 };

  const admin = getSupabaseAdmin();
  const customers: Row[] = [];
  // Paged and ordered by id: production holds 8,234 of these, and an unbounded PostgREST read
  // stops at 1,000 with no error and no marker — which here would quietly hide most duplicates.
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("phoenix_crm_customers")
      .select("id, name, speciality, grade, list_type, seat_id")
      .eq("is_test", false)
      // 🔴 THE ARCHIVE IS LEFT OUT, OR THE LIST NEVER CLEARS. Removing a duplicate means dropping one
      //    row, and a dropped row is `dropped` — it stays in the database for ever, so a group that
      //    counted it reappeared the morning after the SFE had already dealt with it. The three
      //    statuses here are the rows a rep can actually be asked to visit: on his list, carried over
      //    and waiting to be validated, and met outside it and waiting to be added.
      .in("status", ["active", "pending", "outside"])
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`phoenix-crm: reading the customer lists failed — ${error.message}`);
    const rows = (data ?? []) as Row[];
    customers.push(...rows);
    if (rows.length < PAGE) break;
  }

  const bySeat = new Map<string, (IdentityCandidate & { sourceId: string })[]>();
  for (const row of customers) {
    const seatId = text(row.seat_id);
    const name = text(row.name);
    if (!seatId || !name) continue;
    const held = bySeat.get(seatId) ?? [];
    held.push({
      // The row's OWN kind, never a flat "PM". A pharmacy is not a contact and an AM contact is not a
      // PM one; `parseListType` is the single reader of that column, so a value nobody expected lands
      // as PM here exactly as it does everywhere else rather than inventing a fourth kind.
      kind: identityKindOf(row.list_type),
      name,
      source: "phoenix_crm",
      sourceId: text(row.id),
      speciality: text(row.speciality) || null,
    });
    bySeat.set(seatId, held);
  }

  // Seats come from the viewer's own org scope, which for these two company roles IS the company —
  // there is no seats table to read, and inventing one would be a second answer to "whose list is
  // this" beside the one every other report here uses.
  const seats = new Map<string, { rep: string | null; territory: string | null }>();
  for (const seat of viewer.scopeTerritories) {
    seats.set(seat.seatId, { rep: seat.occupantHrId ?? null, territory: territoryName(seat) });
  }
  const names = await loadPeopleNames([...seats.values()].map((seat) => seat.rep));

  const detail = new Map<string, Row>();
  for (const row of customers) detail.set(text(row.id), row);

  const groups: DuplicateCustomerGroup[] = [];
  let rows = 0;
  for (const [seatId, candidates] of bySeat) {
    for (const [nameKey, group] of groupSameRepDuplicates(candidates)) {
      const seat = seats.get(seatId);
      rows += group.length;
      groups.push({
        entries: group.map((one) => {
          const row = detail.get(one.sourceId);
          return {
            customerId: one.sourceId,
            grade: text(row?.grade) || null,
            listType: text(row?.list_type) || null,
            name: one.name,
            speciality: one.speciality ?? null,
          };
        }),
        nameKey,
        // 🔴 NULL FOR A VACANT SEAT, WHICH IS WHAT THE PAGE READS. `nameOf` answers "Unknown person"
        //    for an id it cannot resolve AND for no id at all, and the page prints "Seat vacant" only
        //    on null — so a territory with nobody in it was filed under a phrase that reads like a data
        //    fault. A vacant seat is a fact about the organogram, not a missing name.
        repName: seat?.rep ? nameOf(names, seat.rep) : null,
        seatId,
        territoryName: seat?.territory ?? null,
      });
    }
  }

  // The rep's name first, then the doctor's, so one rep's housekeeping reads together.
  groups.sort(
    (a, b) =>
      (a.repName ?? "").localeCompare(b.repName ?? "") ||
      (a.territoryName ?? "").localeCompare(b.territoryName ?? "") ||
      (a.entries[0]?.name ?? "").localeCompare(b.entries[0]?.name ?? ""),
  );
  return { groups, rows };
}
