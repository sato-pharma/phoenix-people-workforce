import { normalizeContactName } from "@/lib/crm/campaign-contact-match";
import { isLinkableName, specialityConflicts } from "@/lib/customer-identity/suggestions";
import type { IdentityCandidate, IdentityKind } from "@/lib/customer-identity/types";
import { mergeRefusalText, planMerge, type MergeCandidate } from "@/lib/phoenix-crm/duplicate-merge-rules";
import { parseListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { territoryName } from "@/lib/phoenix-crm/scope";
import { type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
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

/**
 * What the one-off merge (owner, 2026-10-08) would do with this group — a SENTENCE, never a button.
 * The board still acts on nothing; this only makes the backlog readable without running the script.
 */
export type DuplicateMergeVerdict = { kind: "keep"; keptName: string; why: string } | { kind: "refused"; why: string };

export type DuplicateCustomerGroup = {
  /** The kind and the folded name the rows share — the key, never shown as a label. */
  nameKey: string;
  /** The merge's verdict on this group, by the one keep rule the script uses (`planMerge`). */
  verdict: DuplicateMergeVerdict;
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

  // Seats come from the viewer's own org scope, which for these two company roles IS the company —
  // there is no seats table to read, and inventing one would be a second answer to "whose list is
  // this" beside the one every other report here uses.
  const seats = new Map<string, { rep: string | null; territory: string | null }>();
  for (const seat of viewer.scopeTerritories) {
    seats.set(seat.seatId, { rep: seat.occupantHrId ?? null, territory: territoryName(seat) });
  }
  // The reps' names need nothing from the lists, so they are read beside them rather than after
  // (Phoenix CRM performance audit, 2026-10-16).
  const [customers, names] = await Promise.all([
    readListedCustomers(),
    loadPeopleNames([...seats.values()].map((seat) => seat.rep)),
  ]);

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

  const detail = new Map<string, Row>();
  for (const row of customers) detail.set(text(row.id), row);

  const grouped = [...bySeat].flatMap(([seatId, candidates]) =>
    [...groupSameRepDuplicates(candidates)].map(([nameKey, group]) => ({ seatId, nameKey, group })),
  );
  const facts = await loadMergeFacts(grouped.flatMap((entry) => entry.group.map((one) => one.sourceId)));

  const groups: DuplicateCustomerGroup[] = [];
  let rows = 0;
  for (const { seatId, nameKey, group } of grouped) {
    const seat = seats.get(seatId);
    const plan = planMerge(group.map((one) => mergeCandidateOf(one.sourceId, one.name, detail.get(one.sourceId), facts)));
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
      verdict: plan.ok
        ? { kind: "keep", keptName: plan.keeper.name, why: plan.why }
        : { kind: "refused", why: mergeRefusalText(plan.refused) },
      // 🔴 NULL FOR A VACANT SEAT, WHICH IS WHAT THE PAGE READS. `nameOf` answers "Unknown person"
      //    for an id it cannot resolve AND for no id at all, and the page prints "Seat vacant" only
      //    on null — so a territory with nobody in it was filed under a phrase that reads like a data
      //    fault. A vacant seat is a fact about the organogram, not a missing name.
      repName: seat?.rep ? nameOf(names, seat.rep) : null,
      seatId,
      territoryName: seat?.territory ?? null,
    });
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

/**
 * The uuid space cut into sixteen slices by an id's first hex digit, in ascending order.
 *
 * Each slice stops exactly where the next begins — the first is open below, the last open above — so
 * every id falls in exactly one, and the slices' rows laid end to end ARE the whole table in `id`
 * order. Postgres orders a uuid by its bytes, which is the order of its lowercase hex text, so a cut
 * at `"10000000-0000-0000-0000-000000000000"` is a real boundary in that order and not an approximation.
 * Exported so the test can hold the cover to that promise; a gap here would hide a doctor's second row.
 */
export function customerIdSlices(): { from: string | null; below: string | null }[] {
  const cut = (digit: number): string => `${digit.toString(16)}0000000-0000-0000-0000-000000000000`;
  return Array.from({ length: 16 }, (_, digit) => ({
    from: digit === 0 ? null : cut(digit),
    below: digit === 15 ? null : cut(digit + 1),
  }));
}

/** How many of the sixteen slices are read at once — four, as everywhere else this module fans out. */
const SLICES_AT_ONCE = 4;

/**
 * Every customer a rep can be asked to visit, company-wide, in `id` order.
 *
 * Paged, because production holds more than 11,000 of these and an unbounded PostgREST read stops at
 * 1,000 with no error and no marker — which here would quietly hide most duplicates.
 *
 * 🔴 KEYSET, IN SIXTEEN SLICES READ FOUR AT A TIME, SINCE 2026-10-16. It was an offset walk, a dozen
 * pages one after another across the Atlantic (Phoenix CRM performance audit), and an offset walk over
 * a table the field app writes to while it reads can repeat a row or skip one at a page seam. Each
 * slice is keyset-paged on `id` (`fetchAllRowsKeyset`), and the slices come back in their own order,
 * so the rows reach the grouping below in exactly the order the single walk delivered them — the
 * groups, their entries and their order are unchanged. Any slice failing fails the read, loudly.
 */
async function readListedCustomers(): Promise<Row[]> {
  const admin = getSupabaseAdmin();
  const slices = await mapWithConcurrency(customerIdSlices(), SLICES_AT_ONCE, async (slice) => {
    try {
      return await fetchAllRowsKeyset<Row>(
        () => {
          let query = admin
            .from("phoenix_crm_customers")
            .select("id, name, speciality, grade, potential_grade, phone, primary_pharmacy_name, list_type, seat_id, validated_at, created_at")
            .eq("is_test", false)
            // 🔴 THE ARCHIVE IS LEFT OUT, OR THE LIST NEVER CLEARS. Removing a duplicate means dropping one
            //    row, and a dropped row is `dropped` — it stays in the database for ever, so a group that
            //    counted it reappeared the morning after the SFE had already dealt with it. The three
            //    statuses here are the rows a rep can actually be asked to visit: on his list, carried over
            //    and waiting to be validated, and met outside it and waiting to be added.
            .in("status", ["active", "pending", "outside"]);
          if (slice.from) query = query.gte("id", slice.from);
          if (slice.below) query = query.lt("id", slice.below);
          return query;
        },
        { cursorColumn: "id", cursorOf: (row) => text(row.id) || null, pageSize: PAGE },
      );
    } catch (error) {
      throw new Error(`phoenix-crm: reading the customer lists failed — ${messageOf(error)}`);
    }
  });
  return slices.flat();
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = error && typeof error === "object" ? (error as { message?: unknown }).message : null;
  return typeof message === "string" ? message : String(error);
}

type MergeFacts = { activePlaces: Map<string, number>; visits: Map<string, number>; moves: Map<string, number> };

/**
 * Per-customer counts the keep rule reads: active places, visits and moves.
 *
 * 🔴 COUNTED IN THE DATABASE SINCE 2026-10-16. This read every place, visit and move row of every
 * duplicate — a doctor with a year of visits is hundreds of rows — only to add them up here (Phoenix
 * CRM performance audit). `phoenix_crm_customer_merge_counts` counts the same rows — places with status
 * `active`, every visit, every move, no `is_test` narrowing on any, as before — and answers one jsonb
 * object, which PostgREST's silent 1,000-row cap cannot cut short. A customer absent from a count has
 * none, which `mergeCandidateOf` already reads as zero. A failure throws, as the row reads did: a keep
 * rule judged on missing counts would name the wrong keeper.
 */
async function loadMergeFacts(ids: readonly string[]): Promise<MergeFacts> {
  if (ids.length === 0) return { activePlaces: new Map(), visits: new Map(), moves: new Map() };
  let counted: Record<string, unknown> | null;
  try {
    counted = await callPhoenixCrm<Record<string, unknown> | null>("phoenix_crm_customer_merge_counts", {
      p_customer_ids: [...new Set(ids)],
    });
  } catch (error) {
    throw new Error(`phoenix-crm: reading the merge counts for the duplicates failed — ${messageOf(error)}`);
  }
  const countsOf = (key: string): Map<string, number> => {
    const counts = new Map<string, number>();
    const byCustomer = counted?.[key];
    if (!byCustomer || typeof byCustomer !== "object") return counts;
    for (const [customerId, value] of Object.entries(byCustomer as Record<string, unknown>)) {
      const count = Number(value);
      if (Number.isFinite(count)) counts.set(customerId, count);
    }
    return counts;
  };
  return { activePlaces: countsOf("active_places"), visits: countsOf("visits"), moves: countsOf("moves") };
}

function mergeCandidateOf(id: string, name: string, row: Row | undefined, facts: MergeFacts): MergeCandidate {
  return {
    customerId: id,
    name,
    listType: text(row?.list_type),
    activePlaces: facts.activePlaces.get(id) ?? 0,
    validatedAt: text(row?.validated_at) || null,
    visits: facts.visits.get(id) ?? 0,
    createdAt: text(row?.created_at),
    hasMoves: (facts.moves.get(id) ?? 0) > 0,
    grade: text(row?.grade) || null,
    potentialGrade: text(row?.potential_grade) || null,
    phone: text(row?.phone) || null,
    primaryPharmacyName: text(row?.primary_pharmacy_name) || null,
  };
}
