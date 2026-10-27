/**
 * Phoenix CRM — the Visit report generator's reader (owner, 2026-10-15).
 *
 * The owner picks a rep or a district and a period, chooses fields from the catalogue
 * (`visit-report-fields.ts`), and this answers with the visits, a dashboard and — through the same
 * answer — the workbook. It is a READER: it writes nothing, and every figure is a fact the rep's own
 * entries already hold.
 *
 * 🔴 A MANAGER IS A TARGET TOO (owner, 2026-10-20: "when filter by manager u find no manager"). The picker offers
 * every manager the viewer reads (`managersInScope`, never upward) who stands above one of his territories, and
 * the lines' product managers where he is given them (`loadScopeProductManagers`). A manager's report holds every
 * visit a rep logged naming him — as the double or chain visit's manager or senior, or as the product manager, or
 * anywhere in its list of companions (`phoenix_crm_visit_companions`, owner 2026-10-27) — on the territories the viewer reads, PLUS the single visits he logged alone, as rows under his own name (owner,
 * 2026-10-20, multiple choice: "Show, keep out of reps"). Those come through `manager-plan-readers.ts`, the one
 * door out of his own visits' table, are marked `ownVisit`, sit on no rep's row and in no dashboard figure, and
 * are never asked for a location or a photo.
 *
 * 🔴 WHO READS IT: the Super Admin and the SFE Manager across the company and the district manager across his
 * own team (`canReadVisitReport`; the team is `readableSeats`), refused with a 404 so the
 * report's existence is not confirmed to anybody else. The SFE Manager reads every field except the
 * mock-location evidence: that is shaped where the evidence is READ (`loadVisitReportEvidence` never
 * queries a position case for him) and again by `resolveVisitReportSelection`, which drops a field above
 * his sight before anything is read. Absent, never blank.
 *
 * 🔴 ONLY WHAT WAS CHOSEN IS READ. A side table is queried only when a field that comes from it was
 * chosen, so a report of dates and customer names never touches the integrity table or HR's leave. The
 * head every row carries (who, where, which customer, planned or not) reads the visit, its customer and
 * its place and nothing else.
 *
 * 🔴 A SAVE TIME IS NOT A POSITION IN TIME. The order, the gap and the speed are computed in
 * `visit-report-compute.ts` under that rule and are never flagged here.
 *
 * 🔴 EVERY READ IS PAGED. PostgREST stops at 1,000 rows with no error, so each table is walked by keyset
 * (`fetchAllRowsKeyset`) or by id chunks (`selectByIds`); a report that read one page would print a
 * short, confident answer.
 */

import { hrIdLookupKeys } from "@/lib/hr-id";
import { notFoundError, validationError } from "@/lib/http/api-errors";
import { isPlanDaySent } from "@/lib/phoenix-crm/plan-rules";
import { canReadVisitReport, isLocationBlind, readsLocationDetail, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { dedupeIds, IN_ID_CHUNK, selectByIds, seatScoped, textOrNull } from "@/lib/phoenix-crm/server/db";
import { readDoubleVisitPlansForReport } from "@/lib/phoenix-crm/server/double-visit-plans";
import { loadManagerOwnVisitRows, readManagerWithRepSlotsForReport } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { loadScopeProductManagers } from "@/lib/phoenix-crm/server/scope-product-managers";
import { seatTierTitle } from "@/lib/phoenix-crm/server/territory";
import { managerOwnVisitReportRow } from "@/lib/phoenix-crm/visit-report-own-visits";
import { loadPlanDayFacts, PLAN_DAY_COLUMNS, PLAN_STATUSES_WITH_SENT_DAYS } from "@/lib/phoenix-crm/server/plan-day-status";
import { loadSeatLeaveDays } from "@/lib/phoenix-crm/server/leave-days";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { loadVisitReportEvidence, type VisitReportEvidence } from "@/lib/phoenix-crm/server/integrity-board";
import { buildVisitReportValues, visitLocationFlagLabel, type Row, type VisitReportContext } from "@/lib/phoenix-crm/server/visit-report-values";
import { personOnTheVisit } from "@/lib/phoenix-crm/location-integrity";
import type { ManagerDayVisit } from "@/lib/phoenix-crm/manager-visit-detail";
import { leaveDayKey } from "@/lib/phoenix-crm/plan-leave";
import { heldManagerSeats, managerChain, managersInScope, personKey, territoriesBelow, TERRITORY_TIER, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { VISIT_ASK_KIND_LABELS } from "@/lib/phoenix-crm/visit-ask-rules";
import { phoenixVisitKindLabel } from "@/lib/phoenix-crm/visit-kind-labels";
import { addDays, computeVisitSequence, firstDayOfPreviousMonth, monthKey, type SequenceInput } from "@/lib/phoenix-crm/visit-report-compute";
import { buildVisitReportDashboard, countVisitReportFilled, visitReportDays } from "@/lib/phoenix-crm/visit-report-dashboard";
import {
  resolveVisitReportPeriod,
  resolveVisitReportSelection,
  type VisitReportField,
  type VisitReportReaderTier,
  type VisitReportRow,
  type VisitReportScopeDistrict,
  type VisitReportScopeManager,
  type VisitReportScopeRep,
  type VisitReportScopeView,
  type VisitReportTarget,
  type VisitReportTargetKind,
  type VisitReportValue,
  type VisitReportView,
} from "@/lib/phoenix-crm/visit-report-fields";
import { isUnplannedKind, isUnplannedVisitStatus, kpiHoldBackOf, type KpiHoldBack } from "@/lib/phoenix-crm/unplanned-rules";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** More visits than this and the answer is refused with a sentence: nobody reads 6,000 rows on a screen. */
export const VISIT_REPORT_MAX_ROWS = 6000;

const DISTRICT_TIERS = new Set(["DM", "ACTING_DM"]);

function assertReader(viewer: PhoenixCrmViewer): void {
  // A 404, never a 403: a message naming the report tells the asker where the evidence is kept.
  if (!canReadVisitReport(viewer)) throw notFoundError("Not found.");
}

/** What this viewer is, for the catalogue's sight: the Super Admin, the SFE Manager, or a district manager. */
export function visitReportTierOf(viewer: PhoenixCrmViewer): VisitReportReaderTier {
  if (viewer.isSuperAdmin) return "superAdmin";
  return viewer.isSfeManager ? "sfe" : "manager";
}

/** The district seat above a territory — the nearest DM or acting DM on its path, occupied or not. */
function districtSeatOf(viewer: PhoenixCrmViewer, seat: OrgSeat): OrgSeat | null {
  for (const ancestorId of [...seat.path].reverse()) {
    if (ancestorId === seat.seatId) continue;
    const ancestor = viewer.org.seats.get(ancestorId);
    if (ancestor && DISTRICT_TIERS.has(ancestor.tier)) return ancestor;
  }
  return null;
}

/**
 * The territories this viewer may report on: his scope, less a seat he is blind on. For a district manager
 * the scope IS his team — and an ACTING district manager's own rep seat drops out here, because his own
 * captures are not evidence he reads about himself (`isLocationBlind`). Every later step — the picker, a
 * rep, a district — chooses from this list and from nothing wider.
 */
function readableSeats(viewer: PhoenixCrmViewer): OrgSeat[] {
  return viewer.scopeTerritories.filter(
    (seat) => seat.tier === TERRITORY_TIER && !districtSeatOf(viewer, seat)?.isOtherPseudoDm && !isLocationBlind(viewer, seat),
  );
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** A manager the picker offers, before he is named: the person, and his title and line. */
type ScopeManagerEntry = { hrId: string; title: string };

/**
 * The managers this viewer may report on (owner, 2026-10-20: "when filter by manager u find no manager"): every
 * manager he reads (`managersInScope` — never one above him) who holds a seat above one of his readable
 * territories, then the lines' product managers where he is given them (`loadScopeProductManagers`). The person is
 * the key: a product manager holds no seat, and a manager on two seats is offered once, at the nearer.
 */
async function scopeManagers(viewer: PhoenixCrmViewer, seats: ReadonlyArray<OrgSeat>): Promise<ScopeManagerEntry[]> {
  const readable = new Set(seats.map((seat) => seat.seatId));
  const out: ScopeManagerEntry[] = [];
  const seen = new Set<string>();
  for (const member of managersInScope(viewer.org, viewer.hrId, viewer.basis)) {
    if (member.seat.isOtherPseudoDm || seen.has(member.hrId)) continue;
    const held = heldManagerSeats(viewer.org, member.hrId)
      .filter((seat) => !seat.isOtherPseudoDm)
      .map((seat) => seat.seatId);
    if (!territoriesBelow(viewer.org, held).some((seat) => readable.has(seat.seatId))) continue;
    seen.add(member.hrId);
    out.push({ hrId: member.hrId, title: [seatTierTitle(member.seat.tier), member.seat.lineName].filter(Boolean).join(" · ") });
  }
  for (const manager of await loadScopeProductManagers(viewer, seats)) {
    if (seen.has(manager.hrId)) continue;
    seen.add(manager.hrId);
    out.push({ hrId: manager.hrId, title: [manager.role, manager.lineNames.join(" + ")].filter(Boolean).join(" · ") });
  }
  return out;
}

/** Who and which districts and managers the picker offers, and the default period. */
export async function loadVisitReportScope(viewer: PhoenixCrmViewer): Promise<VisitReportScopeView> {
  assertReader(viewer);
  const seats = readableSeats(viewer);
  const managerEntries = await scopeManagers(viewer, seats);
  const names = await loadPeopleNames([...seats.map((seat) => seat.occupantHrId), ...managerEntries.map((entry) => entry.hrId)]);

  const reps: VisitReportScopeRep[] = [];
  const districts = new Map<string, VisitReportScopeDistrict>();
  for (const seat of seats) {
    const district = districtSeatOf(viewer, seat);
    const districtName = seat.regionName ?? district?.regionName ?? null;
    if (seat.occupantHrId) {
      const repName = nameOf(names, seat.occupantHrId, "Unnamed rep");
      reps.push({
        districtName,
        id: seat.seatId,
        label: [repName, seat.lineName, districtName].filter(Boolean).join(" · "),
        lineName: seat.lineName,
        repName,
      });
    }
    if (district) {
      const existing = districts.get(district.seatId);
      if (existing) {
        if (seat.occupantHrId) existing.repCount += 1;
      } else {
        districts.set(district.seatId, {
          id: district.seatId,
          label: [district.regionName ?? "District", district.lineName].filter(Boolean).join(" · "),
          lineName: district.lineName,
          repCount: seat.occupantHrId ? 1 : 0,
        });
      }
    }
  }
  reps.sort((left, right) => left.label.localeCompare(right.label));
  // Every district, an all-vacant one too (owner, 2026-10-20): its visits — a manager's double visit on a vacant
  // seat, a rep entered for later — are still somebody's work, and hiding the district hid them.
  const districtList = [...districts.values()].sort((left, right) => left.label.localeCompare(right.label));
  const managers: VisitReportScopeManager[] = managerEntries
    .map((entry) => {
      const name = nameOf(names, entry.hrId, "Unnamed manager");
      return { id: entry.hrId, label: [name, entry.title].filter(Boolean).join(" · "), name, title: entry.title };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
  return {
    cairoToday: viewer.cairoToday,
    defaults: { from: monthStart(viewer.cairoToday), to: viewer.cairoToday },
    districts: districtList,
    managers,
    sight: visitReportTierOf(viewer),
    reps,
  };
}

/**
 * Who the report is about. `personHrId` is set for a manager only: his visits are read by HIM, never by a seat, and
 * the day's order is worked out along his own day.
 */
type Resolved = { kind: VisitReportTargetKind; name: string; seats: OrgSeat[]; personHrId: string | null };

function resolveTarget(viewer: PhoenixCrmViewer, target: VisitReportTarget, names: PeopleNames): Resolved {
  const readable = new Map(readableSeats(viewer).map((seat) => [seat.seatId, seat]));
  if (target.kind === "rep") {
    const seat = readable.get(String(target.id));
    if (!seat) throw notFoundError("This rep is not in the organogram. Reload the page.");
    return { kind: "rep", name: nameOf(names, seat.occupantHrId, "Vacant seat"), personHrId: null, seats: [seat] };
  }
  const dm = viewer.org.seats.get(String(target.id));
  // One sentence for "no such district" and "not yours", so a district manager asking for another
  // district learns nothing about whether it exists.
  const missing = "This district is not in the organogram. Reload the page.";
  if (!dm || !DISTRICT_TIERS.has(dm.tier) || dm.isOtherPseudoDm) throw notFoundError(missing);
  const seats = territoriesBelow(viewer.org, [dm.seatId]).filter((seat) => readable.has(seat.seatId));
  if (seats.length === 0) throw notFoundError(viewer.isSuperAdmin || viewer.isSfeManager ? "This district has no territories to report on." : missing);
  return { kind: "district", name: [dm.regionName ?? "District", dm.lineName].filter(Boolean).join(" · "), personHrId: null, seats };
}

/**
 * A manager the picker would offer this viewer, or a 404 — one sentence for "no such manager" and "not yours", so a
 * viewer asking for a manager outside his reach learns nothing about whether that person exists.
 */
async function resolveManager(viewer: PhoenixCrmViewer, id: string): Promise<ScopeManagerEntry> {
  const key = personKey(id);
  const found = key ? (await scopeManagers(viewer, readableSeats(viewer))).find((entry) => entry.hrId === key) : undefined;
  if (!found) throw notFoundError("This manager is not in the organogram. Reload the page.");
  return found;
}

// ── Paged reads ──────────────────────────────────────────────────────────────────────────────────

const VISIT_COLUMNS = [
  "id, seat_id, customer_id, list_type, visit_date, captured_at, kind, rep_hr_id, manager_hr_id, senior_hr_id, entered_by_hr_id",
  "product_manager_hr_id, products, comment, photo_path, lat, lon, accuracy_meters, place_id, distance_meters, location_flag",
  "device_skew_minutes, pharmacy_name, product_availability, voice_note_path, voice_note_seconds, is_unplanned, next_step",
  "next_step_on, objection, objection_note, samples_given, dwell_seconds, form_open_seconds, capture_source, offline_seconds",
  "synced_at, photo_lat, photo_lon, photo_accuracy_meters, photo_captured_at, unplanned_kind",
  // The rep's own write-up, added after the door, and when he last changed it (owner, 2026-10-15).
  "detail_comment, detail_edited_at",
].join(", ");

/** Every row of `table` for these seats between two dates, keyset-paged on `cursorColumn`. */
async function readSeatRange(
  table: string,
  columns: string,
  cursorColumn: string,
  seatIds: readonly string[],
  window: { column: string; from: string; to: string },
  includeTest: boolean,
): Promise<Row[]> {
  // A manager with no visit a rep logged on a readable territory has no seats to ask about — nothing to read.
  if (seatIds.length === 0) return [];
  return fetchAllRowsKeyset<Row>(
    () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query: any = getSupabaseAdmin().from(table).select(columns);
      query = seatScoped(query, seatIds).gte(window.column, window.from).lte(window.column, window.to);
      if (!includeTest) query = query.eq("is_test", false);
      return query;
    },
    { cursorColumn, cursorOf: (row) => (row[cursorColumn] == null ? null : String(row[cursorColumn])) },
  );
}

/** The person columns a rep's visit names a manager in — the double or chain visit's two, and the product manager's. */
const MANAGER_VISIT_COLUMNS = ["manager_hr_id", "senior_hr_id", "product_manager_hr_id"] as const;

/**
 * Every visit a rep logged naming this manager between two dates, on the territories this viewer reads — read by
 * the PERSON, never by a seat, because a regional, national or product manager rides on territories no single seat
 * holds. Each column is read in full and the answers are joined by id, so a chain visit naming him twice is one row.
 * A visit listing him past its three fixed places (owner, 2026-10-27) is found through `phoenix_crm_visit_companions`
 * — stored upper-cased — and read by its id.
 */
async function readManagerVisitRange(
  hrId: string,
  readable: ReadonlySet<string>,
  window: { from: string; to: string },
  includeTest: boolean,
): Promise<Row[]> {
  const keys = hrIdLookupKeys(hrId);
  const answers = await Promise.all(
    MANAGER_VISIT_COLUMNS.map((column) =>
      fetchAllRowsKeyset<Row>(
        () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let query: any = getSupabaseAdmin()
            .from("phoenix_crm_visits")
            .select(VISIT_COLUMNS)
            .in(column, keys)
            .gte("visit_date", window.from)
            .lte("visit_date", window.to);
          if (!includeTest) query = query.eq("is_test", false);
          return query;
        },
        { cursorColumn: "id", cursorOf: (row) => (row.id == null ? null : String(row.id)) },
      ),
    ),
  );
  const listed = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_visit_companions")
        .select("id, visit_id")
        .in("hr_id", dedupeIds(keys.map((key) => key.toUpperCase())))
        .not("visit_id", "is", null),
    { cursorColumn: "id", cursorOf: (row) => (row.id == null ? null : String(row.id)) },
  );
  const asCompanion = await selectByIds<Row>(
    "phoenix_crm_visits",
    VISIT_COLUMNS,
    "id",
    listed.map((row) => idOf(row.visit_id)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (query: any) => tuneByIds(includeTest)(query.gte("visit_date", window.from).lte("visit_date", window.to)),
  );
  const byId = new Map<string, Row>();
  for (const rows of [...answers, asCompanion]) {
    for (const row of rows) {
      if (readable.has(String(row.seat_id))) byId.set(String(row.id), row);
    }
  }
  return [...byId.values()];
}

/**
 * Everyone on each rep visit besides the rep, with the side each went as (`phoenix_crm_visit_companions`, owner
 * 2026-10-27), in the order the visit lists them. `loadVisitCompanionIds` answers the ids alone; this report names
 * the manager side and the product side in two columns, so it reads the side too. A visit with no rows is absent.
 */
async function loadVisitCompanionSides(visitIds: readonly string[]): Promise<Map<string, Array<{ hrId: string; side: string }>>> {
  const rows = await selectByIds<Row>("phoenix_crm_visit_companions", "id, visit_id, hr_id, side, position", "visit_id", visitIds);
  const out = new Map<string, Array<{ hrId: string; side: string; position: number }>>();
  for (const row of rows) {
    const visitId = idOf(row.visit_id);
    const hrId = idOf(row.hr_id);
    if (!visitId || !hrId) continue;
    const list = out.get(visitId) ?? [];
    list.push({ hrId, position: Number(row.position ?? 0), side: String(row.side ?? "") });
    out.set(visitId, list);
  }
  return new Map([...out].map(([visitId, list]) => [visitId, list.sort((left, right) => left.position - right.position).map(({ hrId, side }) => ({ hrId, side }))]));
}

function tuneByIds(includeTest: boolean) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (query: any) => (includeTest ? query : query.eq("is_test", false));
}

function groupBy<T extends Row>(rows: ReadonlyArray<T>, key: (row: T) => string | null): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    if (id === null) continue;
    grouped.set(id, [...(grouped.get(id) ?? []), row]);
  }
  return grouped;
}

const idOf = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** Why a visit is in no KPI — the two halves of `visitCountsInKpi`, read off the rows this report already holds. */
function visitReportHoldBack(visit: Row, customer: Row | null, approval: Row | null): KpiHoldBack | null {
  const isUnplanned = visit.is_unplanned === true;
  const unplannedKind = isUnplanned ? (isUnplannedKind(visit.unplanned_kind) ? visit.unplanned_kind : "out_of_plan") : null;
  const status = approval?.status;
  return kpiHoldBackOf({
    customerValidated: typeof customer?.validated_at === "string",
    isUnplanned,
    unplannedKind,
    unplannedStatus: unplannedKind === "out_of_plan" && isUnplannedVisitStatus(status) ? status : null,
  });
}

/**
 * Whose visit it is: the rep, or the manager on his own visit with no rep on it — the integrity board's
 * own rule (`personOnTheVisit`), never the seat's occupant. 🔴 Falling back to the occupant printed a
 * district manager's own call under the rep whose territory it was on (13 visits on production,
 * 2026-10-16) and as "Unknown rep" on a vacant seat (12 more), and slotted it into that rep's day.
 */
function whoseVisit(visit: Row): string | null {
  return personOnTheVisit({ managerHrId: textOrNull(visit.manager_hr_id), repHrId: textOrNull(visit.rep_hr_id) });
}

/**
 * Everyone on the visit, by name — the person it is credited to first, then the rep, the manager, the senior manager
 * and the product manager, then anyone else its list of companions holds (owner, 2026-10-27), each once (owner,
 * 2026-10-20: "when filter by manager u find no manager"). "Who visited" offers and matches any of them; `repName`
 * still says whose visit it is.
 */
function visitParticipantNames(visit: Row, creditedHrId: string | null, names: PeopleNames): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const companions = Array.isArray(visit.companion_hr_ids) ? visit.companion_hr_ids : [];
  for (const hrId of [creditedHrId, visit.rep_hr_id, visit.manager_hr_id, visit.senior_hr_id, visit.product_manager_hr_id, ...companions]) {
    const key = personKey(textOrNull(hrId));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(nameOf(names, key, "Unknown person"));
  }
  return out;
}

/** Sort rows by a timestamp column: `newest` first, or `oldest` first so a thread reads in the order it was written. */
const byTime =
  (column: string, order: "newest" | "oldest") =>
  (left: Row, right: Row): number =>
    order === "newest"
      ? String(right[column] ?? "").localeCompare(String(left[column] ?? ""))
      : String(left[column] ?? "").localeCompare(String(right[column] ?? ""));

// ── The report ───────────────────────────────────────────────────────────────────────────────────

export type LoadVisitReportInput = {
  kind: unknown;
  id: unknown;
  from: unknown;
  to: unknown;
  fields: unknown;
};

export async function loadVisitReport(viewer: PhoenixCrmViewer, input: LoadVisitReportInput): Promise<VisitReportView> {
  assertReader(viewer);
  const kind: VisitReportTargetKind | null =
    input.kind === "district" ? "district" : input.kind === "rep" ? "rep" : input.kind === "manager" ? "manager" : null;
  if (!kind || typeof input.id !== "string") throw validationError("Choose a rep, a manager or a district.");

  const fields = resolveVisitReportSelection(Array.isArray(input.fields) ? input.fields : [], visitReportTierOf(viewer));
  if (fields.length === 0) throw validationError("Choose at least one field to report.");

  const period = resolveVisitReportPeriod({ cairoToday: viewer.cairoToday, from: input.from, kind, to: input.to });
  if (!period.ok) throw validationError(period.error);

  const includeTest = viewer.isTestPersona;
  const chosen = new Set(fields.map((field) => field.key));
  const has = (...keys: string[]) => keys.some((key) => chosen.has(key));
  const categories = new Set(fields.map((field) => field.category));

  // ── The visits: the period, plus the month before it only when a repeat-visit field was chosen ──
  const wantsHistory = has("customerVisitsThisMonth", "daysSinceCustomerVisit");
  const readFrom = wantsHistory ? firstDayOfPreviousMonth(period.from) : period.from;

  let target: Resolved;
  let everyVisit: Row[];
  let ownVisits: ManagerDayVisit[] = [];
  if (kind === "manager") {
    // A manager is read by HIMSELF: every visit a rep logged naming him on a territory this viewer reads, and the
    // single visits he logged alone — through the one door out of their table, as display rows under his name.
    const manager = await resolveManager(viewer, input.id);
    const readable = new Set(readableSeats(viewer).map((seat) => seat.seatId));
    const [named, own, managerNames] = await Promise.all([
      readManagerVisitRange(manager.hrId, readable, { from: readFrom, to: period.to }, includeTest),
      loadManagerOwnVisitRows({ end: period.to, isTest: includeTest, managerHrIds: [manager.hrId], start: period.from }),
      loadPeopleNames([manager.hrId]),
    ]);
    const seatsOfHis = dedupeIds(named.map((visit) => idOf(visit.seat_id)))
      .map((seatId) => viewer.org.seats.get(seatId))
      .filter((seat): seat is OrgSeat => Boolean(seat));
    if (seatsOfHis.length > IN_ID_CHUNK) {
      throw validationError(
        `This manager was on visits in ${seatsOfHis.length} territories in the period, more than ${IN_ID_CHUNK}. Choose fewer days.`,
        "visit_report_too_large",
      );
    }
    target = {
      kind: "manager",
      name: [nameOf(managerNames, manager.hrId, "Unnamed manager"), manager.title].filter(Boolean).join(" · "),
      personHrId: manager.hrId,
      seats: seatsOfHis,
    };
    everyVisit = named;
    ownVisits = own;
  } else {
    const scopeNames = await loadPeopleNames(readableSeats(viewer).map((seat) => seat.occupantHrId));
    target = resolveTarget(viewer, { id: input.id, kind }, scopeNames);
    everyVisit = await readSeatRange(
      "phoenix_crm_visits",
      VISIT_COLUMNS,
      "id",
      target.seats.map((seat) => seat.seatId),
      { column: "visit_date", from: readFrom, to: period.to },
      includeTest,
    );
  }
  // Everyone on each visit past its three fixed places (owner, 2026-10-27), read once and carried on the row under
  // the door's own name, so the values and the names read it like any other column. Null on a visit saved before.
  // The product side rides beside it, so a Training Manager prints as a product person, never as a manager.
  const companionsOf = await loadVisitCompanionSides(everyVisit.map((visit) => String(visit.id)));
  for (const visit of everyVisit) {
    const companions = companionsOf.get(String(visit.id));
    visit.companion_hr_ids = companions ? companions.map((companion) => companion.hrId) : null;
    visit.companion_product_hr_ids = companions ? companions.filter((companion) => companion.side === "product").map((companion) => companion.hrId) : null;
  }
  const seatIds = target.seats.map((seat) => seat.seatId);
  const seatById = new Map(target.seats.map((seat) => [seat.seatId, seat]));
  const visits = everyVisit
    .filter((visit) => String(visit.visit_date) >= period.from)
    .sort(
      (left, right) =>
        String(left.visit_date).localeCompare(String(right.visit_date)) ||
        String(left.captured_at).localeCompare(String(right.captured_at)) ||
        String(left.id).localeCompare(String(right.id)),
    );
  const rowCount = visits.length + ownVisits.length;
  if (rowCount > VISIT_REPORT_MAX_ROWS) {
    throw validationError(
      `This choice holds ${rowCount.toLocaleString("en-US")} visits, more than ${VISIT_REPORT_MAX_ROWS.toLocaleString("en-US")}. Narrow the period or choose one rep.`,
      "visit_report_too_large",
    );
  }

  const visitIds = visits.map((visit) => String(visit.id));
  const customerIds = dedupeIds(visits.map((visit) => idOf(visit.customer_id)));
  const placeIds = dedupeIds(visits.map((visit) => idOf(visit.place_id)));
  const byIds = tuneByIds(includeTest);

  // ── Always: the customer and the place (the head needs both) ──
  const [customers, places] = await Promise.all([
    selectByIds<Row>(
      "phoenix_crm_customers",
      "id, name, list_type, speciality, grade, potential_grade, origin, status, validated_at, validated_by_hr_id, phone, primary_pharmacy_name, pharmacy_pin_governorate",
      "id",
      customerIds,
    ),
    selectByIds<Row>(
      "phoenix_crm_places",
      "id, label, address, brick_name, zone, lat, lon, accuracy_meters, status, session, point_source, timings, signboard_check, schedule_check, shared_place_id",
      "id",
      placeIds,
    ),
  ]);
  const customerById = new Map(customers.map((row) => [String(row.id), row]));
  const placeById = new Map(places.map((row) => [String(row.id), row]));

  // ── Only what was chosen ──
  const needsShared = has("sharedPlace");
  const needsNotes = has("placeNotes");
  const needsRecs = has("managerRecommendation");
  const needsReview = categories.has("validation");
  // Read when its category was chosen, and whenever an off-plan visit is in the choice: the tiles count only what
  // the KPIs count, and an off-plan visit counts only once it is approved (re-audit, 2026-10-22).
  const needsUnplanned = categories.has("approval") || visits.some((visit) => visit.is_unplanned === true);
  const needsProvenance = has("fixAgeSeconds", "deviceInstall", "appRevision", "browser") || has("speedKmh");
  const needsEvidence = has("integrityDetectors", "integrityStrength", "mockDevice", "caseSettled");
  const needsEdits = has("editedBySuperAdmin");
  const needsDay = categories.has("day");
  const needsSequence = categories.has("computed");
  const needsBehaviour = has("repMonthFlags");
  const range = { column: "visit_date", from: period.from, to: period.to };

  const sharedIds = dedupeIds(places.map((place) => idOf(place.shared_place_id)));
  const placeFilterIds = placeIds;

  const [sharedPlaces, notes, recommendations, reviews, unplannedRows, provenanceRows, editRows, askRows] = await Promise.all([
    needsShared ? selectByIds<Row>("phoenix_crm_shared_places", "id, name", "id", sharedIds, byIds) : Promise.resolve<Row[]>([]),
    needsNotes
      ? selectByIds<Row>("phoenix_crm_place_notes", "id, place_id, body, created_at", "place_id", placeFilterIds, byIds)
      : Promise.resolve<Row[]>([]),
    needsRecs
      ? selectByIds<Row>("phoenix_crm_place_recommendations", "id, place_id, recommendation, created_at", "place_id", placeFilterIds, byIds)
      : Promise.resolve<Row[]>([]),
    needsReview
      ? selectByIds<Row>(
          "phoenix_crm_validation_reviews",
          "id, place_id, status, google, decided_by_hr_id, decided_at, decision_note, refusal_reason, created_at",
          "place_id",
          placeFilterIds,
          byIds,
        )
      : Promise.resolve<Row[]>([]),
    needsUnplanned
      ? readSeatRange(
          "phoenix_crm_unplanned_visits",
          "visit_id, clarification, status, manager_decided_by_hr_id, manager_decided_at, manager_note, sfe_decided_by_hr_id, sfe_decided_at, sfe_note, admin_decided_by_hr_id, admin_decided_at, admin_note",
          "visit_id",
          seatIds,
          range,
          includeTest,
        )
      : Promise.resolve<Row[]>([]),
    needsProvenance
      ? readSeatRange(
          "phoenix_crm_visit_capture_provenance",
          "visit_id, fix_taken_at, fix_age_seconds, device_install_id, app_revision, user_agent",
          "visit_id",
          seatIds,
          range,
          includeTest,
        )
      : Promise.resolve<Row[]>([]),
    needsEdits
      ? selectByIds<Row>("phoenix_crm_visit_edits", "id, visit_id, edited_at", "visit_id", visitIds, byIds)
      : Promise.resolve<Row[]>([]),
    needsDay ? selectByIds<Row>("phoenix_crm_visit_asks", "id, visit_id, kind, status", "visit_id", visitIds, byIds) : Promise.resolve<Row[]>([]),
  ]);

  // ── The day around the visit ──
  let planItems: Row[] = [];
  let dayStarts: Row[] = [];
  let dayActivities: Row[] = [];
  let doublePlans: Row[] = [];
  let leave: { days: ReadonlySet<string>; unread: boolean } = { days: new Set<string>(), unread: true };
  // A manager with no visit a rep logged on a readable territory has no seat whose day there is to read.
  if (needsDay && seatIds.length > 0) {
    const plans = await fetchAllRowsKeyset<Row>(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let query: any = getSupabaseAdmin().from("phoenix_crm_plans").select(`id, seat_id, week_start, ${PLAN_DAY_COLUMNS}`);
        query = seatScoped(query, seatIds)
          .gte("week_start", addDays(period.from, -6))
          .lte("week_start", period.to)
          .in("status", [...PLAN_STATUSES_WITH_SENT_DAYS]);
        if (!includeTest) query = query.eq("is_test", false);
        return query;
      },
      { cursorColumn: "id", cursorOf: (row) => (row.id == null ? null : String(row.id)) },
    );
    const planSeat = new Map(plans.map((plan) => [String(plan.id), String(plan.seat_id)]));
    const items = await selectByIds<Row>(
      "phoenix_crm_plan_items",
      "id, plan_id, plan_date, customer_id, start_minute, exception_type, exception_note, receives",
      "plan_id",
      [...planSeat.keys()],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (query: any) => query.gte("plan_date", period.from).lte("plan_date", period.to),
    );
    // "On the plan" is the module's one rule: a day on a sent plan, asked day by day (`isPlanDaySent`), so a
    // week returned for one day still stands on its other days.
    const facts = await loadPlanDayFacts(plans, includeTest);
    planItems = items
      .filter((item) => {
        const plan = facts.get(String(item.plan_id));
        const day = textOrNull(item.plan_date)?.slice(0, 10);
        return Boolean(plan && day && isPlanDaySent({ ...plan, date: day }));
      })
      .map((item) => ({ ...item, seat_id: planSeat.get(String(item.plan_id)) ?? null }));
    [dayStarts, dayActivities, doublePlans] = await Promise.all([
      readSeatRange("phoenix_crm_day_starts", "id, seat_id, started_on, started_at", "id", seatIds, { column: "started_on", from: period.from, to: period.to }, includeTest),
      readSeatRange("phoenix_crm_day_activities", "id, seat_id, activity_date, activity_type, half_day, note", "id", seatIds, { column: "activity_date", from: period.from, to: period.to }, includeTest),
      // The old double-visit planner's rows, and the half-days "with a rep" of the district manager's
      // weekly plan that replaced it (2026-10-16) — the same row shape, read side by side.
      Promise.all([
        readDoubleVisitPlansForReport(seatIds, { from: period.from, to: period.to }, includeTest),
        readManagerWithRepSlotsForReport(seatIds, { from: period.from, to: period.to }, includeTest),
      ]).then(([legacy, weekly]) => [...legacy, ...weekly]),
    ]);
    if (has("onLeave")) {
      const read = await loadSeatLeaveDays(target.seats, { from: period.from, to: period.to });
      leave = { days: read.days, unread: read.unread };
    }
  }

  // ── Evidence (behind the integrity board's own audience check) ──
  let evidence: VisitReportEvidence = { behaviourByMonth: new Map(), byVisit: new Map() };
  if (needsEvidence || needsBehaviour) {
    const months = [...new Set(visits.map((visit) => monthKey(String(visit.visit_date))))];
    evidence = await loadVisitReportEvidence(viewer, {
      months,
      seatIds,
      visitIds: needsEvidence ? visitIds : [],
      wantsBehaviour: needsBehaviour,
    });
  }

  // ── The sequence facts ──
  // Whose day a visit is ordered in: the rep's (or the manager on his own call) — or, on a manager's report, the
  // MANAGER's own day, since he moves from one rep to the next and the order, the gap and the distance are his.
  const sequencePerson = (visit: Row): string | null => target.personHrId ?? whoseVisit(visit);
  const provenanceByVisit = new Map(provenanceRows.map((row) => [String(row.visit_id), row]));
  const sequence = needsSequence
    ? computeVisitSequence(
        everyVisit.map(
          (visit): SequenceInput => {
            const fix = textOrNull(provenanceByVisit.get(String(visit.id))?.fix_taken_at);
            return {
              customerId: idOf(visit.customer_id),
              fixAtMs: fix ? Date.parse(fix) : null,
              lat: typeof visit.lat === "number" ? visit.lat : null,
              lon: typeof visit.lon === "number" ? visit.lon : null,
              // Nobody named at all (none on production) keeps the seat, so it is still a day of its own.
              person: sequencePerson(visit) ?? `seat:${String(visit.seat_id)}`,
              savedAtMs: Date.parse(String(visit.captured_at)),
              visitDate: String(visit.visit_date),
              visitId: String(visit.id),
            };
          },
        ),
      )
    : null;

  // ── Lookups ──
  const sharedById = new Map(sharedPlaces.map((row) => [String(row.id), row]));
  const notesByPlace = groupBy(notes.sort(byTime("created_at", "oldest")), (row) => idOf(row.place_id));
  const recsByPlace = groupBy(recommendations.sort(byTime("created_at", "oldest")), (row) => idOf(row.place_id));
  const reviewByPlace = new Map<string, Row>();
  for (const review of reviews.sort(byTime("created_at", "newest"))) {
    const placeId = idOf(review.place_id);
    if (placeId && !reviewByPlace.has(placeId)) reviewByPlace.set(placeId, review);
  }
  const unplannedByVisit = new Map(unplannedRows.map((row) => [String(row.visit_id), row]));
  const editedByVisit = new Map<string, string>();
  for (const edit of editRows) {
    const visitId = idOf(edit.visit_id);
    const at = idOf(edit.edited_at);
    if (visitId && at && (editedByVisit.get(visitId) ?? "") < at) editedByVisit.set(visitId, at);
  }
  const askByVisit = new Map(
    askRows.map((row) => [
      String(row.visit_id),
      `${VISIT_ASK_KIND_LABELS[row.kind as keyof typeof VISIT_ASK_KIND_LABELS] ?? "Request"} · ${String(row.status ?? "").replace(/_/g, " ")}`,
    ]),
  );
  const planItemByKey = new Map<string, Row>();
  for (const item of planItems) {
    if (item.receives === false) continue;
    planItemByKey.set(`${String(item.seat_id)}|${String(item.plan_date)}|${String(item.customer_id)}`, item);
  }
  const dayStartByKey = new Map(dayStarts.map((row) => [`${String(row.seat_id)}|${String(row.started_on)}`, String(row.started_at)]));
  const activitiesByKey = groupBy(dayActivities, (row) => `${String(row.seat_id)}|${String(row.activity_date)}`);
  const doublesByKey = groupBy(doublePlans, (row) => `${String(row.seat_id)}|${String(row.plan_date)}`);

  // ── Names: one read for everybody the rows mention ──
  const chainBySeat = new Map(target.seats.map((seat) => [seat.seatId, managerChain(viewer.org, seat.seatId)]));
  const people = await loadPeopleNames([
    ...target.seats.map((seat) => seat.occupantHrId),
    ...[...chainBySeat.values()].flatMap((chain) => chain.map((member) => member.hrId)),
    ...visits.flatMap((visit) => [visit.rep_hr_id, visit.manager_hr_id, visit.senior_hr_id, visit.entered_by_hr_id, visit.product_manager_hr_id]),
    ...visits.flatMap((visit) => (Array.isArray(visit.companion_hr_ids) ? visit.companion_hr_ids : [])),
    ...customers.map((customer) => customer.validated_by_hr_id),
    ...unplannedRows.flatMap((row) => [row.manager_decided_by_hr_id, row.sfe_decided_by_hr_id, row.admin_decided_by_hr_id]),
    ...reviews.map((review) => review.decided_by_hr_id),
    ...doublePlans.map((row) => row.manager_hr_id),
    target.personHrId,
  ].map((value) => (typeof value === "string" ? value : null)));

  // The districts under the same regional manager, as "Alex-BHR + Delta (1) + Delta (2)".
  const regionBySeat = new Map<string, string | null>();
  const regionOf = (seat: OrgSeat): string | null => {
    const regional = [...seat.path].reverse().map((id) => viewer.org.seats.get(id)).find((entry) => entry?.tier === "RSM");
    if (!regional) return null;
    const cached = regionBySeat.get(regional.seatId);
    if (cached !== undefined) return cached;
    const districts = [...viewer.org.seats.values()].filter(
      (entry) => DISTRICT_TIERS.has(entry.tier) && !entry.isOtherPseudoDm && entry.regionName && entry.path.includes(regional.seatId),
    );
    const region = [...new Set(districts.map((entry) => entry.regionName as string))].sort().join(" + ") || null;
    regionBySeat.set(regional.seatId, region);
    return region;
  };

  // ── The rows ──
  // 🔴 A district manager reads the distance only (owner, 2026-10-02): a weak reading reads as at the place.
  const detail = readsLocationDetail(viewer);
  const rows: VisitReportRow[] = visits.map((visit) => {
    const seat = seatById.get(String(visit.seat_id)) ?? null;
    const visitId = String(visit.id);
    const visitDate = String(visit.visit_date);
    const customerId = idOf(visit.customer_id);
    const placeId = idOf(visit.place_id);
    const customer = customerId ? customerById.get(customerId) ?? null : null;
    const place = placeId ? placeById.get(placeId) ?? null : null;
    const dayKey = `${String(visit.seat_id)}|${visitDate}`;
    const personHrId = whoseVisit(visit);
    const chain = chainBySeat.get(String(visit.seat_id)) ?? [];
    const activities = activitiesByKey.get(dayKey) ?? [];
    const doubles = (doublesByKey.get(dayKey) ?? []).map((plan) => {
      const manager = nameOf(people, typeof plan.manager_hr_id === "string" ? plan.manager_hr_id : null, "") || null;
      return [String(plan.half ?? "").toUpperCase(), manager ? `with ${manager}` : null].filter(Boolean).join(" ");
    });

    const context: VisitReportContext = {
      activities,
      ask: askByVisit.get(visitId) ?? null,
      behaviourFlags: evidence.behaviourByMonth.get(`${String(visit.seat_id)}|${monthKey(visitDate)}`) ?? null,
      customer,
      dayStartedAt: dayStartByKey.get(dayKey) ?? null,
      districtManagerHrId: chain.find((member) => DISTRICT_TIERS.has(member.seat.tier))?.hrId ?? null,
      doubles,
      editedAt: editedByVisit.get(visitId) ?? null,
      evidence: evidence.byVisit.get(visitId) ?? null,
      names: people,
      personHrId,
      readsLocationDetail: detail,
      onLeave: needsDay && has("onLeave") && !leave.unread ? leave.days.has(leaveDayKey(String(visit.seat_id), visitDate)) : null,
      place,
      placeNotes: (placeId ? notesByPlace.get(placeId) ?? [] : []).map((row) => String(row.body ?? "").trim()).filter(Boolean),
      planItem: customerId ? planItemByKey.get(`${dayKey}|${customerId}`) ?? null : null,
      provenance: provenanceByVisit.get(visitId) ?? null,
      recommendations: (placeId ? recsByPlace.get(placeId) ?? [] : []).map((row) => String(row.recommendation ?? "").trim()).filter(Boolean),
      region: seat ? regionOf(seat) : null,
      regionalManagerHrId: chain.find((member) => member.seat.tier === "RSM")?.hrId ?? null,
      review: placeId ? reviewByPlace.get(placeId) ?? null : null,
      seat,
      sequence: sequence?.get(visitId) ?? null,
      sharedPlace: place && idOf(place.shared_place_id) ? sharedById.get(String(place.shared_place_id)) ?? null : null,
      unplanned: unplannedByVisit.get(visitId) ?? null,
      visit,
    };
    const all = buildVisitReportValues(context);
    const values: Record<string, VisitReportValue> = {};
    for (const field of fields) values[field.key] = all[field.key] ?? null;

    return {
      customerName: String(customer?.name ?? "").trim() || "Unknown customer",
      distanceMeters: typeof visit.distance_meters === "number" ? visit.distance_meters : null,
      listType: String(visit.list_type ?? ""),
      locationFlag: visitLocationFlagLabel(visit, detail),
      placeLabel: textOrNull(place?.label),
      placeLat: typeof place?.lat === "number" ? place.lat : null,
      placeLon: typeof place?.lon === "number" ? place.lon : null,
      planned: visit.is_unplanned !== true,
      repName: nameOf(people, personHrId, "Unknown person"),
      participants: visitParticipantNames(visit, personHrId, people),
      savedAtIso: String(visit.captured_at ?? ""),
      values,
      visitDate,
      visitId,
      visitLat: typeof visit.lat === "number" ? visit.lat : null,
      visitLon: typeof visit.lon === "number" ? visit.lon : null,
      visitType: phoenixVisitKindLabel(visit.kind) ?? "",
      kpiHoldBack: visitReportHoldBack(visit, customer, unplannedByVisit.get(visitId) ?? null),
    };
  });

  // His own single visits, under his own name and on nobody else's row (owner, 2026-10-20: "Show, keep out of
  // reps"), then everything in the order it happened. A rep or district report holds none, and keeps its order.
  if (ownVisits.length > 0) {
    const managerName = nameOf(people, target.personHrId, "Unnamed manager");
    rows.push(...ownVisits.map((own) => managerOwnVisitReportRow(own, managerName, fields)));
    rows.sort(
      (left, right) =>
        left.visitDate.localeCompare(right.visitDate) || left.savedAtIso.localeCompare(right.savedAtIso) || left.visitId.localeCompare(right.visitId),
    );
  }

  // The same two helpers the screen's filters use, so a narrowed screen and a narrowed file count alike.
  const filled = countVisitReportFilled(rows, fields);
  const days = visitReportDays(rows);

  return {
    dashboard: buildVisitReportDashboard({ days, fields, filled, rows }),
    days,
    filled,
    generatedAtIso: new Date().toISOString(),
    period: { days: period.days, from: period.from, to: period.to },
    rows,
    selected: fields.map((field) => field.key),
    target: {
      id: String(input.id),
      kind: target.kind,
      name: target.name,
      // The REPS among them — a manager's own call is in the rows under his name, and is not a rep.
      reps: [
        ...new Set(visits.flatMap((visit) => (textOrNull(visit.rep_hr_id) ? [nameOf(people, textOrNull(visit.rep_hr_id), "Unknown rep")] : []))),
      ].sort((left, right) => left.localeCompare(right)),
    },
    total: rows.length,
  };
}

/** The chosen fields for a view, in the catalogue's order — what the workbook's columns follow. */
export function fieldsOfView(view: VisitReportView): VisitReportField[] {
  const chosen = new Set(view.selected);
  return resolveVisitReportSelection([...chosen], "superAdmin");
}
