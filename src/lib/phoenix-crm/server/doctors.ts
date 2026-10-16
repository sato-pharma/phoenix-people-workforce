/**
 * Phoenix CRM — the Doctors directory: every validated customer the viewer may see, across territories.
 *
 * Owner, 2026-09-22: "BUILD the cross-territory validated-doctors list". The Team tab already reaches
 * one customer's page through his rep's territory; this is the second door, for the people who look
 * across many reps at once — type a name, land on the same page, without first knowing whose
 * territory the doctor sits in.
 *
 * Two rules decide what comes back, and both are settled here on the server, never in a component:
 *
 *  - **Validated only.** A customer carried over from iReports360 and not validated yet belongs to
 *    his own rep's list, not to a company directory. He appears the moment his rep validates him.
 *  - **Downward only.** The seats are the viewer's own `scopeTerritories`, which `territoriesInScope`
 *    resolves downward — never a sibling, never your own manager. The four directory roles below read
 *    every territory instead; everyone else reads their own subtree.
 *
 * **The Training Manager sees this directory and nothing behind it — the owner's ruling, 2026-09-22,
 * not a gap.** He reads every validated doctor here by name, grade, list type and territory, but
 * `territoryForRead` (access.ts) refuses him every territory: he is not in `COMPANY_ROLES` and holds
 * no sales seat, so "Open the list" never appears for him and he never reaches a customer's page, its
 * validation photo or its coordinates. That was put to the owner directly, with a read-only customer
 * page offered as the fix, and he answered: "The list is enough for him." **Do not add a read-only
 * page, a new endpoint, or place columns on `DoctorDirectoryRow` to close it, and do not re-raise it.**
 */

import type { PhoenixRole } from "@/lib/auth/permissions";
import type { OrgSeat } from "@/lib/phoenix-crm/scope";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { chunk } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { describeTerritory, territoryPeople } from "@/lib/phoenix-crm/server/territory";
import type { PhoenixCrmGrade, PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { doctorListType } from "@/lib/phoenix-crm/pharmacy-call-rules";

type Row = Record<string, unknown>;

/**
 * The roles that read every territory's validated customers.
 *
 * Owner, 2026-09-22: "give SFE and Training Manager the full company list too". Deliberately its own
 * set rather than Phoenix CRM's `COMPANY_ROLES` (access.ts): widening that one would hand the Training
 * Manager every territory's visits, list, plan and reports as well, which is not what he asked for.
 * This set governs the directory and nothing else. It matches `doctorListBasisForRole`'s `company`
 * roles on the Reps List, so the two surfaces agree about who looks at the whole field.
 */
const DIRECTORY_COMPANY_ROLES = new Set<string>(["Super Admin", "CEO", "SFE Manager", "Training Manager"]);

/** Does this role read every territory's validated customers, rather than its own subtree? */
export function isDirectoryCompanyRole(role: PhoenixRole | string): boolean {
  return DIRECTORY_COMPANY_ROLES.has(role);
}

/** One validated customer, with the territory that holds him so the row can open his page. */
export type DoctorDirectoryRow = {
  customerId: string;
  name: string;
  listType: PhoenixCrmListType;
  speciality: string | null;
  grade: PhoenixCrmGrade | null;
  validatedAt: string;
  validatedByName: string | null;
  /** How many places are on record; the captured location and photo live on the customer's own page. */
  placeCount: number;
  /** The territory this customer is listed in: the seat whose list the row opens. */
  seatId: string;
  territoryName: string;
  areaName: string | null;
  regionName: string | null;
  lineName: string | null;
  repName: string | null;
};

export type DoctorDirectoryView = {
  rows: DoctorDirectoryRow[];
  /** How the viewer's reach was decided, so the screen can say it in one sentence. */
  scope: "company" | "territories";
  territoryCount: number;
};

/**
 * The territories whose validated customers this viewer reads.
 *
 * A directory role reads every territory in an open line — the same "open lines only" rule
 * `resolvePhoenixCrmViewer` applies to `scopeTerritories`, so the directory never shows a line the
 * module has not opened. The Super Admin reads the lot (his own entries are always test entries, and
 * in test mode the directory follows him onto any territory).
 */
export function directorySeats(viewer: PhoenixCrmViewer): OrgSeat[] {
  if (!isDirectoryCompanyRole(viewer.role)) return viewer.scopeTerritories;
  if (viewer.isSuperAdmin) return viewer.org.territories;
  return viewer.org.territories.filter((seat) => Boolean(seat.lineCode && viewer.openLines.has(seat.lineCode)));
}

/**
 * How many seat chunks are read at once. A company role's directory spans every territory in the
 * company — several hundred seats, so several chunks — and each chunk is its own keyset walk; four at a
 * time is the module's usual allowance for a database fan-out, enough to stop the walks queueing one
 * behind another without opening a connection per seat.
 */
const SEAT_CHUNKS_AT_ONCE = 4;

/**
 * Active places per customer, over many seats at once.
 *
 * The rows are still read one per place rather than counted in the database, deliberately: PostgREST's
 * embedded `count` has never been used against this project, a plan item and a visit each carry both a
 * customer and a place (so PostgREST can see more than one way to embed the one in the other), and a
 * read that fails here takes the whole directory down with it. A per-customer aggregate would return
 * about as many rows anyway, because nearly every validated customer has exactly one place. So the
 * read stays as it was and only its chunks run side by side.
 */
async function loadPlaceCounts(seatIds: string[], isTest: boolean): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const parts = await mapWithConcurrency(chunk(seatIds, 100), SEAT_CHUNKS_AT_ONCE, (part) =>
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_places")
          .select("id, customer_id")
          .in("seat_id", part)
          .eq("is_test", isTest)
          .eq("status", "active"),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  );
  for (const rows of parts) {
    for (const row of rows) {
      const customerId = String(row.customer_id);
      counts.set(customerId, (counts.get(customerId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The validated customers on these seats, in the order the chunks were cut — each chunk's rows in id
 * order, exactly as when the chunks were read one after another, so a tie in the final sort lands
 * where it always did.
 */
async function loadValidatedCustomers(seatIds: string[], isTest: boolean): Promise<Row[]> {
  const parts = await mapWithConcurrency(chunk(seatIds, 100), SEAT_CHUNKS_AT_ONCE, (part) =>
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_customers")
          .select("id, seat_id, list_type, name, speciality, grade, validated_at, validated_by_hr_id")
          .in("seat_id", part)
          .eq("is_test", isTest)
          .eq("status", "active")
          .not("validated_at", "is", null),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  );
  return parts.flat();
}

/**
 * Every validated customer in the viewer's reach, newest validation first.
 *
 * `status = 'active'` IS "validated" — the `phoenix_crm_customers_active_is_validated` check makes the
 * two one statement — but the query asks for `validated_at not null` as well, so the rule reads here
 * exactly as it reads in every report function.
 */
export async function loadDoctorDirectory(viewer: PhoenixCrmViewer, isTest: boolean): Promise<DoctorDirectoryView> {
  const seats = directorySeats(viewer);
  const scope: DoctorDirectoryView["scope"] = isDirectoryCompanyRole(viewer.role) ? "company" : "territories";
  const seatIds = seats.map((seat) => seat.seatId);
  if (seatIds.length === 0) return { rows: [], scope, territoryCount: 0 };

  // 🔴 ONE WAVE, NOT THREE READS IN A ROW (Phoenix CRM performance audit, 2026-10-16). The customers,
  // their place counts and the names were read strictly one after another, although only the names
  // need the customers (the validators are named on them) and the place counts need nothing but the
  // seats. So the counts run beside the customers, and the names start the moment the customers land.
  const customersRead = loadValidatedCustomers(seatIds, isTest);
  // Handled at once: if the customers fail, the wave below rejects with that same error, and the
  // names' own chain must never be left holding an unhandled rejection of it.
  const namesRead = customersRead.then((customers) =>
    loadPeopleNames([
      ...territoryPeople(viewer.org, seats),
      ...customers.map((row) => (typeof row.validated_by_hr_id === "string" ? row.validated_by_hr_id : null)),
    ]),
  );
  namesRead.catch(() => undefined);
  const [customers, placeCounts, names] = await Promise.all([customersRead, loadPlaceCounts(seatIds, isTest), namesRead]);
  const territoryById = new Map(seats.map((seat) => [seat.seatId, describeTerritory(viewer.org, seat, names)]));

  const rows: DoctorDirectoryRow[] = [];
  for (const row of customers) {
    const territory = territoryById.get(String(row.seat_id));
    if (!territory) continue;
    const validatedBy = typeof row.validated_by_hr_id === "string" ? row.validated_by_hr_id : null;
    // The doctor list is doctors and accounts. A pharmacy sits on the rep's list too, but it is
    // not a doctor and carries no grade or target, so it is left out of this one entirely.
    const listType = doctorListType(row.list_type);
    if (listType === null) continue;
    rows.push({
      customerId: String(row.id),
      name: String(row.name),
      listType,
      speciality: typeof row.speciality === "string" ? row.speciality : null,
      grade: typeof row.grade === "string" ? (row.grade as PhoenixCrmGrade) : null,
      validatedAt: String(row.validated_at),
      validatedByName: validatedBy ? nameOf(names, validatedBy) : null,
      placeCount: placeCounts.get(String(row.id)) ?? 0,
      seatId: territory.seatId,
      territoryName: territory.name,
      areaName: territory.areaName,
      regionName: territory.regionName,
      lineName: territory.lineName,
      repName: territory.repName,
    });
  }
  // Newest validation first: the doctors the field has just proved are the ones being looked for.
  rows.sort((left, right) => right.validatedAt.localeCompare(left.validatedAt) || left.name.localeCompare(right.name));
  return { rows, scope, territoryCount: seatIds.length };
}
