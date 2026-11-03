/**
 * Phoenix CRM — four of the five reports the owner picked on 2026-10-02, read for the Reports tab:
 *
 *   capacity  grade against capacity — what each territory's list asks of a month, against what the
 *             month's field days hold (capacity-board.ts)
 *   heard     what the field heard — the products discussed and the objections raised, by product,
 *             speciality and area (field-heard.ts)
 *   stock     the missing-stock board — which pharmacies last said they do not have which product
 *             (missing-stock.ts, through the customer card's own `groupCustomerPharmacies`)
 *   samples   samples and materials left, month by month (samples-report.ts)
 *
 * The fifth, the customer's own timeline, is on the customer's page (server/customer-timeline.ts).
 *
 * And one the owner added on 3 November 2026:
 *
 *   objections  objections by doctor — each rep's doctors and what they objected to, counts only, for
 *               the managers alone (objections-by-doctor.ts). It reads `phoenix_crm_countable_visits`,
 *               which leaves out the visits copied from iReports360, where the other boards read the
 *               view that keeps them.
 *
 * ## 🔴 WHO READS THEM
 *
 * The district managers for their teams, the national sales managers for their lines, SFE, the CEO and
 * the Super Admin — `readsTeamReports`, the one predicate the module's other manager boards already
 * use, and never a second copy of it. A medical rep is refused all four, here and not only by a hidden
 * chip. Scope runs DOWNWARD only: the territories are `chooseTerritories`' (server/reports.ts), which
 * is the viewer's own `scopeTerritories` narrowed by the line and territory he picked.
 *
 * And "What the field heard" has a second audience, by the owner's ruling the same day: the product
 * and marketing managers, for THEIR OWN products, company-wide — never an area, never a territory,
 * never a rep (`readsFieldHeardByProduct`).
 *
 * ## 🔴 WHAT IS READ
 *
 * Real entries only, unless the Super Admin ticked his own test entries in, or the reader is a test
 * account (`reportIncludesTest`, exactly as every other report). The visits come from
 * `phoenix_crm_countable_visits` — an off-plan visit counts in NOTHING until it is approved (owner,
 * 2026-09-26) — and the customer lists from `phoenix_crm_customers`.
 *
 * 🔴 NO `customer_validated` FILTER — THESE BOARDS MEASURE NOBODY. The validation half of the
 * countable view is the rule for a tally or a rate a person is measured by (owner, 2026-10-01: a
 * customer is "not counted in KPIs till validated"). None of these four is one: they say what customers
 * said, what was on a pharmacy's shelf, what was handed over and how big a list is — and on the day they
 * shipped nearly every customer was still carried over from iReports360, so filtering would have blanked
 * all four for weeks while protecting no figure. The capacity board says so in words, on the screen.
 */

import { forbiddenError, validationError } from "@/lib/http/api-errors";
import {
  buildCapacityBoard,
  capacityMonthsOffered,
  monthFieldDays,
  perDayFigures,
  resolveCapacityMonth,
  type CapacityCustomer,
  type CapacityMonth,
  type CapacityRow,
  type CapacitySummary,
  type CapacityTerritoryInput,
  type FieldDays,
} from "@/lib/phoenix-crm/capacity-board";
import { parseProductAvailability } from "@/lib/phoenix-crm/entry-rules";
import {
  buildFieldHeard,
  HEARD_OBJECTIONS,
  heardProductScope,
  type FieldHeardResult,
  type HeardProductBasis,
  type HeardVisit,
} from "@/lib/phoenix-crm/field-heard";
import { buildMissingStock, type MissingStockResult, type StockAnswer, type StockChase } from "@/lib/phoenix-crm/missing-stock";
import { buildObjectionsByDoctor, type ObjectionsByDoctorResult, type ObjectionVisit } from "@/lib/phoenix-crm/objections-by-doctor";
import { resolveReportMonth, type ReportMonth, type ReportPeriod } from "@/lib/phoenix-crm/report-rules";
import { buildSamplesReport, type SamplesReportResult } from "@/lib/phoenix-crm/samples-report";
import { personKey, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import type { PhoenixCrmDoctorListType, PhoenixCrmGrade, PhoenixCrmSettings } from "@/lib/phoenix-crm/types";
import { readsFieldHeardByProduct, readsTeamReports, reportIncludesTest, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { chunk, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { groupCustomerPharmacies, normalizePharmacyName, type PharmacyFeedback } from "@/lib/phoenix-crm/server/list";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { doctorListType, parseListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { loadPlanHolidays } from "@/lib/phoenix-crm/server/plan-holidays";
import { lineProductsByFamily } from "@/lib/phoenix-crm/server/products";
import {
  chooseTerritories,
  periodOf,
  readSeatGroups,
  shareInFlight,
  type ChosenTerritories,
  type ReportFilterInput,
} from "@/lib/phoenix-crm/server/reports";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { resolveSalesAccessScope } from "@/lib/sales/access-scope";
import { RESTRICTED_PRODUCT_CODES } from "@/lib/sales/confidential-products";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const RESTRICTED_CODES = new Set<string>(RESTRICTED_PRODUCT_CODES);

const MANAGERS_ONLY = "This report is for district managers, national sales managers, SFE and the Super Admin.";
const HEARD_AUDIENCE =
  "What the field heard is for district managers, national sales managers, SFE, the Super Admin, and the product and marketing managers.";

// ── Who reads, and over which territories ───────────────────────────────────────────────────────

/**
 * The four boards' gate and scope: `readsTeamReports`, then the viewer's own territories narrowed by
 * the line and territory he picked. Pure — no read — so the scope matrix is tested without a database.
 */
export function insightTerritories(viewer: PhoenixCrmViewer, raw: ReportFilterInput): ChosenTerritories {
  if (!readsTeamReports(viewer)) throw forbiddenError(MANAGERS_ONLY);
  return chooseTerritories(viewer, raw);
}

/**
 * Who "What the field heard" is read for, and over which territories.
 *
 *   team      a manager, SFE, the CEO or the Super Admin: his own scope, narrowed by LINE only. The
 *             territory filter is deliberately ignored — this report is about what customers said,
 *             and narrowed to one territory it would be about one rep.
 *   products  a product or marketing manager: every territory of every open line — company-wide, on
 *             his own products only — and never the area grain.
 *
 * The team's gate is asked first, so a product manager who also held a manager seat would read as a
 * manager. Pure, like `insightTerritories`.
 */
export function fieldHeardAudience(
  viewer: PhoenixCrmViewer,
  raw: ReportFilterInput,
): { audience: "team"; seats: OrgSeat[]; includeTest: boolean } | { audience: "products"; seats: OrgSeat[]; includeTest: boolean } {
  if (readsTeamReports(viewer)) {
    const chosen = chooseTerritories(viewer, { ...raw, seatId: null });
    return { audience: "team", seats: chosen.seats, includeTest: chosen.includeTest };
  }
  if (readsFieldHeardByProduct(viewer)) {
    const seats = viewer.org.territories.filter((seat) => Boolean(seat.lineCode && viewer.openLines.has(seat.lineCode)));
    return { audience: "products", seats, includeTest: reportIncludesTest(viewer, raw.includeTest) };
  }
  throw forbiddenError(HEARD_AUDIENCE);
}

/** A territory's name and its rep, for every row a board prints. Names, never codes. */
async function territoryLabels(seats: ReadonlyArray<OrgSeat>): Promise<Map<string, { territoryName: string; lineName: string | null; repName: string | null }>> {
  const names = await loadPeopleNames(seats.map((seat) => seat.occupantHrId));
  return new Map(
    seats.map((seat) => [
      seat.seatId,
      { territoryName: territoryName(seat), lineName: seat.lineName, repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null },
    ]),
  );
}

/**
 * The countable visits of the chosen territories between two days. Real entries only, unless the test
 * entries are included — then both, as every visit report reads them.
 */
async function countableVisits(
  seats: ReadonlyArray<OrgSeat>,
  period: { from: string; to: string },
  includeTest: boolean,
  columns: string,
): Promise<Row[]> {
  // Groups of territories four at a time, handed back exactly as one walk per batch of 200 returned
  // them (`readSeatGroups`).
  return readSeatGroups(seats.map((seat) => seat.seatId), 200, (batch) =>
    fetchAllRowsKeyset<Row>(
      () => {
        let query = getSupabaseAdmin()
          .from("phoenix_crm_countable_visits_with_history")
          .select(`id, ${columns}`)
          .in("seat_id", batch)
          .gte("visit_date", period.from)
          .lte("visit_date", period.to);
        if (!includeTest) query = query.eq("is_test", false);
        return query;
      },
      { cursorColumn: "id", cursorOf: (row) => textOrNull(row.id) },
    ),
  );
}

/**
 * The columns What the field heard and the missing-stock board read, as ONE list — so the reports
 * pack, which opens both at the same moment over the same territories and period, reads the period's
 * visits once (`shareInFlight`). Each board still takes only the fields it uses; the extra columns
 * reach no screen.
 */
const HEARD_AND_STOCK_COLUMNS =
  "seat_id, customer_id, list_type, visit_date, captured_at, pharmacy_name, product_availability, next_step, next_step_on, products, objection, objection_note";

/** The period's countable visits for the two boards above. The rows are shared: neither board changes them. */
function heardAndStockVisits(seats: ReadonlyArray<OrgSeat>, period: ReportPeriod, includeTest: boolean): Promise<Row[]> {
  const key = `phoenix-crm:heard-and-stock|${includeTest}|${period.from}|${period.to}|${seats.map((seat) => seat.seatId).join(",")}`;
  return shareInFlight(key, () => countableVisits(seats, period, includeTest, HEARD_AND_STOCK_COLUMNS));
}

// CAPACITY is a KPI, and a pharmacy is in none of them (owner, 2026-10-02): a pharmacy on the
// rep's list is not part of what his day has room for, and is not graded against a target.
// null says so; the two callers below drop the row rather than file it among the doctors.
function listTypeOf(value: unknown): PhoenixCrmDoctorListType | null {
  return doctorListType(value);
}

function gradeOf(value: unknown): PhoenixCrmGrade | null {
  return value === "A" || value === "B" || value === "C" ? value : null;
}

// ── 1. Grade against capacity ───────────────────────────────────────────────────────────────────

export type CapacityBoardView = {
  month: CapacityMonth;
  /** This month and the next — the only two the board reads (`capacityMonthsOffered`). */
  monthsOffered: string[];
  includeTest: boolean;
  fieldDays: FieldDays;
  /** What each list is read against, straight from Settings: the call rate and the plan cap. */
  perDay: { AM: { target: number; cap: number }; PM: { target: number; cap: number } };
  /** The grades' monthly visits, straight from Settings, so the screen can say what was used. */
  gradeTargets: PhoenixCrmSettings["gradeTargets"];
  rows: CapacityRow[];
  summary: CapacitySummary;
};

type SeatList = { customers: CapacityCustomer[]; source: "phoenix" | "reference" };

/**
 * Each chosen territory's list: Phoenix's own (validated and carried over), or — for a territory whose
 * list has never been opened in Phoenix, so nothing has been carried over yet — the iReports360 list
 * the first opening would carry over, read through the module's own `phoenix_crm_seat_reference`.
 *
 * 🔴 ONE WORLD AT A TIME. A list is either the real one or the Super Admin's test copy of it, and the
 * two describe the same customers — so this reads `is_test = includeTest`, as frequency and the
 * tracking sheet do, never both at once (which would count every customer twice).
 */
async function capacityLists(seats: ReadonlyArray<OrgSeat>, includeTest: boolean): Promise<Map<string, SeatList>> {
  const lists = new Map<string, SeatList>();
  const seen = new Set<string>();
  const seatIds = seats.map((seat) => seat.seatId);
  // On the list: validated, or carried over and waiting to be. Outside the list and the Archive are
  // not — so only those two statuses travel. Read over groups of territories four at a time, in the
  // single walk's own order (`readSeatGroups`), so each list's customers arrive as they always did.
  const rows = await readSeatGroups(seatIds, 200, (batch) =>
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_customers")
          .select("id, seat_id, list_type, grade, status, validated_at")
          .in("seat_id", batch)
          .eq("is_test", includeTest)
          .in("status", ["active", "pending"]),
      { cursorColumn: "id", cursorOf: (row) => textOrNull(row.id) },
    ),
  );
  for (const row of rows) {
    const seatId = String(row.seat_id);
    seen.add(seatId);
    const status = String(row.status);
    if (status !== "active" && status !== "pending") continue;
    const list: SeatList = lists.get(seatId) ?? { customers: [], source: "phoenix" };
    const capacityListType = listTypeOf(row.list_type);
    if (capacityListType === null) continue;
    list.customers.push({ listType: capacityListType, grade: gradeOf(row.grade), validated: textOrNull(row.validated_at) !== null });
    lists.set(seatId, list);
  }

  // 🔴 "OPENED" IS ANY ROW AT ALL, NOT ANY ROW ON THE LIST. A territory whose every customer was
  // dropped or moved outside the list has been opened in Phoenix, so it reads its own (empty) list and
  // never the iReports360 reference — that is what the unfiltered read above used to decide. Only the
  // territories it found nothing for are asked again, without the status filter; on a working day
  // that is the few never opened, which hold no rows, so this read is all but free.
  const unseen = seatIds.filter((seatId) => !seen.has(seatId));
  if (unseen.length > 0) {
    const opened = await readSeatGroups(unseen, 200, (batch) =>
      fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_customers")
            .select("id, seat_id")
            .in("seat_id", batch)
            .eq("is_test", includeTest)
            // Customers the iReports360 history import made (20261029212200) do not open a territory.
            .is("imported_from_ireports360_at", null),
        { cursorColumn: "id", cursorOf: (row) => textOrNull(row.id) },
      ),
    );
    for (const row of opened) seen.add(String(row.seat_id));
  }

  const unopened = seatIds.filter((seatId) => !seen.has(seatId));
  if (unopened.length > 0) {
    const reference = await rpcAll<Row>(getSupabaseAdmin(), "phoenix_crm_seat_reference", { p_seat_ids: unopened, p_is_test: includeTest }, [
      "seat_id",
      "list_type",
      "contact_crm_id",
    ]);
    for (const row of reference) {
      // Nothing of this territory is carried over yet, so every reference row is still to come — unless
      // a drop already took it off (which cannot be true of an unopened list, and is refused anyway).
      if (textOrNull(row.customer_id) !== null || row.state === "dropped") continue;
      const seatId = String(row.seat_id);
      const list: SeatList = lists.get(seatId) ?? { customers: [], source: "reference" };
      const referenceListType = listTypeOf(row.list_type);
      if (referenceListType === null) continue;
      list.customers.push({ listType: referenceListType, grade: gradeOf(row.grade), validated: false });
      lists.set(seatId, list);
    }
  }
  return lists;
}

export async function loadCapacityBoard(viewer: PhoenixCrmViewer, raw: ReportFilterInput): Promise<CapacityBoardView> {
  const { seats, includeTest } = insightTerritories(viewer, raw);
  const monthResult = resolveCapacityMonth({ month: raw.month, cairoToday: viewer.cairoToday });
  if (!monthResult.ok) throw validationError(monthResult.error);
  const month = monthResult.value;
  const settings = viewer.config.settings;

  const [holidays, lists, labels] = await Promise.all([
    // The confirmed national calendar, the same reader the plan greys a holiday with. It never throws:
    // a month it cannot read gives no holiday, which only ever errs towards MORE capacity.
    loadPlanHolidays(month.monthStart, month.monthEnd),
    seats.length > 0 ? capacityLists(seats, includeTest) : Promise.resolve(new Map<string, SeatList>()),
    territoryLabels(seats),
  ]);
  const fieldDays = monthFieldDays(month.month, holidays);
  const board = buildCapacityBoard(
    seats.map((seat): CapacityTerritoryInput => {
      const label = labels.get(seat.seatId);
      const list = lists.get(seat.seatId);
      return {
        seatId: seat.seatId,
        territoryName: label?.territoryName ?? territoryName(seat),
        lineName: seat.lineName,
        repName: label?.repName ?? null,
        customers: list?.customers ?? [],
        listSource: list?.source ?? "phoenix",
      };
    }),
    fieldDays,
    settings,
  );
  return {
    month,
    monthsOffered: capacityMonthsOffered(viewer.cairoToday),
    includeTest,
    fieldDays,
    perDay: { AM: perDayFigures(settings, "AM"), PM: perDayFigures(settings, "PM") },
    gradeTargets: settings.gradeTargets,
    rows: board.rows,
    summary: board.summary,
  };
}

// ── 2. What the field heard ─────────────────────────────────────────────────────────────────────

export type FieldHeardView = FieldHeardResult & {
  period: ReportPeriod;
  includeTest: boolean;
  audience: "team" | "products";
  /** A product or marketing manager's own products, and where that list came from; null for the team. */
  products: { names: string[]; basis: HeardProductBasis } | null;
};

/**
 * The product families behind a list of product codes, from the sales master the line's products come
 * from. The confidential codes are left out exactly as the visit form leaves them out (server/products.ts):
 * a rep is never offered one, so no visit can have discussed one, and its family name never reaches a
 * screen through here either.
 */
async function familiesOfCodes(codes: ReadonlyArray<string>): Promise<string[]> {
  const wanted = [
    ...new Set(codes.map((code) => String(code ?? "").trim().toUpperCase()).filter((code) => code.length > 0 && !RESTRICTED_CODES.has(code))),
  ];
  const families = new Set<string>();
  for (const part of chunk(wanted, 200)) {
    const { data, error } = await getSupabaseAdmin().from("source_of_sales_products").select("product_code, family").in("product_code", part);
    throwIfError(error);
    for (const row of (data ?? []) as Row[]) {
      const family = textOrNull(row.family);
      if (family) families.add(family);
    }
  }
  return [...families];
}

/** The product families of the lines the sales side bounds a person to, from the same cached product list. */
async function familiesOfLines(lineNames: ReadonlyArray<string>): Promise<string[]> {
  const families = new Set<string>();
  for (const lineName of new Set(lineNames)) {
    for (const entry of await lineProductsByFamily(lineName)) families.add(entry.family);
  }
  return [...families];
}

/** The visits as the report reads them: the customer's speciality, and the territory's area by name. */
async function heardVisits(seats: ReadonlyArray<OrgSeat>, period: ReportPeriod, includeTest: boolean): Promise<HeardVisit[]> {
  if (seats.length === 0) return [];
  // What the DOCTORS said: the report has an AM side and a PM side and nothing else, so a pharmacy
  // visit would be filed as PM — and the pharmacy a doctor's visit names carries that visit's own
  // products (owner, 2026-10-03), so it would count every product heard there twice.
  const rows = (await heardAndStockVisits(seats, period, includeTest)).filter((row) => listTypeOf(row.list_type) !== null);
  if (rows.length === 0) return [];

  const specialities = new Map<string, string | null>();
  const customerIds = [...new Set(rows.map((row) => textOrNull(row.customer_id)).filter((id): id is string => id !== null))];
  // Four id batches at a time rather than one after another; a lookup by id, so the order is moot.
  const specialityBatches = await mapWithConcurrency(chunk(customerIds, 200), 4, async (part) => {
    const { data, error } = await getSupabaseAdmin().from("phoenix_crm_customers").select("id, speciality").in("id", part);
    throwIfError(error);
    return (data ?? []) as Row[];
  });
  for (const row of specialityBatches.flat()) specialities.set(String(row.id), textOrNull(row.speciality));

  const seatsById = new Map(seats.map((seat) => [seat.seatId, seat]));
  return rows.map((row) => {
    const seat = seatsById.get(String(row.seat_id));
    return {
      visitDate: String(row.visit_date ?? "").slice(0, 10),
      listType: parseListType(row.list_type),
      products: Array.isArray(row.products) ? row.products.map((entry) => String(entry)) : [],
      objection: textOrNull(row.objection),
      objectionNote: textOrNull(row.objection_note),
      speciality: specialities.get(String(row.customer_id)) ?? null,
      // The territory's AREA, by name — a place, never the rep who works it.
      area: seat ? (seat.areaName ?? seat.regionName ?? null) : null,
    };
  });
}

export async function loadFieldHeardReport(viewer: PhoenixCrmViewer, raw: ReportFilterInput): Promise<FieldHeardView> {
  const chosen = fieldHeardAudience(viewer, raw);
  const period = periodOf(viewer, raw);

  if (chosen.audience === "team") {
    const visits = await heardVisits(chosen.seats, period, chosen.includeTest);
    return {
      ...buildFieldHeard(visits, { products: null, withArea: true }),
      audience: "team",
      includeTest: chosen.includeTest,
      period,
      products: null,
    };
  }

  // A product or marketing manager: his own products (`productOwnerFamilies`), company-wide, and no area.
  const scope = await productOwnerFamilies(viewer);
  const visits = scope.families !== null && scope.families.size === 0 ? [] : await heardVisits(chosen.seats, period, chosen.includeTest);
  return {
    ...buildFieldHeard(visits, { products: scope.families, withArea: false }),
    audience: "products",
    includeTest: chosen.includeTest,
    period,
    products: { names: scope.families ? [...scope.families].sort((left, right) => left.localeCompare(right)) : [], basis: scope.basis },
  };
}

/**
 * A product or marketing manager's own products, as product families — ONE rule with two readers:
 * "What the field heard" narrows his report to them, and the visit asks offer a rep the product
 * managers whose products touch his line (owner, 2026-10-02 — server/visit-asks.ts, through
 * visit-ask-rules.ts `productManagersOfLine`). A second copy of it would drift.
 *
 * "His own products" is what the sales side already says they are — `resolveSalesAccessScope`, the one
 * rule Sales Analytics, marketing requests and the monthly closing read: his product list when he has
 * one (Scope & Visibility and Weekly Sales keep one list per person), and otherwise the lines it bounds
 * him to — his line override, the Marketing Manager's three-line oversight, or his own line. Takes the
 * person's own access context: the viewer's for his report, each product manager's for the asks.
 */
export async function productOwnerFamilies(viewer: Pick<PhoenixCrmViewer, "access">): Promise<{ families: Set<string> | null; basis: HeardProductBasis }> {
  const salesScope = await resolveSalesAccessScope(viewer.access);
  const assignedFamilies = salesScope.allowedProductCodes === null ? null : await familiesOfCodes([...salesScope.allowedProductCodes]);
  const lineFamilies =
    assignedFamilies !== null || salesScope.allowedLineNames === null ? null : await familiesOfLines([...salesScope.allowedLineNames]);
  return heardProductScope({ assignedFamilies, lineFamilies });
}

// ── 3. The missing-stock board ──────────────────────────────────────────────────────────────────

export type MissingStockView = MissingStockResult & { period: ReportPeriod; includeTest: boolean };

/** The key the per-territory, per-product grouping is made under; a seat id never holds this character. */
const KEY_SEPARATOR = "\u0000";

/**
 * Each pharmacy's LATEST answer for each product, territory by territory: the customer card's own
 * grouping (`groupCustomerPharmacies`), fed one PRODUCT at a time per territory — so each answer here is
 * exactly what the card would show for that pharmacy and that product. A visit that named no pharmacy
 * gave no answer. Pure, and exported so the tests read the board's answers without a database.
 */
export function latestStockAnswers(rows: ReadonlyArray<Row>): StockAnswer[] {
  const feedback: PharmacyFeedback[] = [];
  for (const row of rows) {
    const seatId = String(row.seat_id);
    const pharmacyName = textOrNull(row.pharmacy_name);
    if (!pharmacyName) continue;
    for (const [product, answer] of Object.entries(parseProductAvailability(row.product_availability))) {
      feedback.push({
        customerId: `${seatId}${KEY_SEPARATOR}${product}`,
        pharmacyName,
        productAvailability: { [product]: answer },
        capturedAt: String(row.captured_at),
      });
    }
  }

  const answers: StockAnswer[] = [];
  // No limit: a board that dropped the 51st pharmacy short of a product would be telling a manager
  // it was in stock.
  for (const [key, pharmacies] of groupCustomerPharmacies(feedback, Number.POSITIVE_INFINITY)) {
    const at = key.indexOf(KEY_SEPARATOR);
    const seatId = key.slice(0, at);
    const product = key.slice(at + 1);
    for (const pharmacy of pharmacies) {
      const answer = pharmacy.products.find((entry) => entry.product === product)?.answer;
      if (!answer) continue;
      answers.push({
        seatId,
        product,
        pharmacy: pharmacy.name,
        pharmacyKey: normalizePharmacyName(pharmacy.name),
        answer,
        lastReportedAt: pharmacy.lastFeedbackAt,
        reports: pharmacy.visits,
      });
    }
  }
  return answers;
}

/** The visits whose next step was "Chase the pharmacy stock", the customer named. Pure, like the answers. */
export function stockChasesOf(rows: ReadonlyArray<Row>, customerNames: ReadonlyMap<string, string>): StockChase[] {
  return rows
    .filter((row) => row.next_step === "pharmacy_stock")
    .map((row) => {
      const pharmacy = textOrNull(row.pharmacy_name);
      return {
        visitId: String(row.id),
        seatId: String(row.seat_id),
        visitDate: String(row.visit_date ?? "").slice(0, 10),
        dueOn: textOrNull(row.next_step_on),
        pharmacy,
        pharmacyKey: pharmacy ? normalizePharmacyName(pharmacy) : null,
        customerName: customerNames.get(String(row.customer_id)) ?? "Unnamed customer",
        // A record of what HAPPENED, not a measure of the rep — a pharmacy call belongs in it.
        listType: parseListType(row.list_type),
      };
    });
}

export async function loadMissingStockReport(viewer: PhoenixCrmViewer, raw: ReportFilterInput): Promise<MissingStockView> {
  const { seats, includeTest } = insightTerritories(viewer, raw);
  const period = periodOf(viewer, raw);
  if (seats.length === 0) return { ...buildMissingStock([], [], () => ""), includeTest, period };

  const rows = await heardAndStockVisits(seats, period, includeTest);

  // The customers named on a chase, by name — never an id on the screen.
  const customerNames = new Map<string, string>();
  const chaseCustomerIds = [
    ...new Set(rows.filter((row) => row.next_step === "pharmacy_stock").map((row) => textOrNull(row.customer_id)).filter((id): id is string => id !== null)),
  ];
  const nameBatches = await mapWithConcurrency(chunk(chaseCustomerIds, 200), 4, async (part) => {
    const { data, error } = await getSupabaseAdmin().from("phoenix_crm_customers").select("id, name").in("id", part);
    throwIfError(error);
    return (data ?? []) as Row[];
  });
  for (const row of nameBatches.flat()) customerNames.set(String(row.id), textOrNull(row.name) ?? "Unnamed customer");

  const seatsById = new Map(seats.map((seat) => [seat.seatId, seat]));
  return {
    ...buildMissingStock(latestStockAnswers(rows), stockChasesOf(rows, customerNames), (seatId) => {
      const seat = seatsById.get(seatId);
      return seat ? territoryName(seat) : "Territory";
    }),
    includeTest,
    period,
  };
}

// ── 4. Samples by month ─────────────────────────────────────────────────────────────────────────

export type SamplesReportView = SamplesReportResult & { month: ReportMonth; includeTest: boolean };

export async function loadSamplesReport(viewer: PhoenixCrmViewer, raw: ReportFilterInput): Promise<SamplesReportView> {
  const { seats, includeTest } = insightTerritories(viewer, raw);
  const monthResult = resolveReportMonth({ month: raw.month, cairoToday: viewer.cairoToday });
  if (!monthResult.ok) throw validationError(monthResult.error);
  const month = monthResult.value;

  const [rows, labels] = await Promise.all([
    seats.length > 0
      ? countableVisits(seats, { from: month.monthStart, to: month.monthEnd }, includeTest, "seat_id, list_type, samples_given")
      : Promise.resolve([] as Row[]),
    territoryLabels(seats),
  ]);
  const result = buildSamplesReport(
    // Samples given are a record of what happened, so a pharmacy call counts here like any other.
    rows.map((row) => ({ seatId: String(row.seat_id), listType: parseListType(row.list_type), samples: row.samples_given })),
    seats.map((seat) => {
      const label = labels.get(seat.seatId);
      return { seatId: seat.seatId, territoryName: label?.territoryName ?? territoryName(seat), lineName: seat.lineName, repName: label?.repName ?? null };
    }),
  );
  return { ...result, month, includeTest };
}

// ── 5. Objections by doctor ─────────────────────────────────────────────────────────────────────

export type ObjectionsByDoctorView = ObjectionsByDoctorResult & { period: ReportPeriod; includeTest: boolean };

const OBJECTION_VISIT_COLUMNS = "seat_id, customer_id, list_type, visit_date, rep_hr_id, manager_hr_id, products, objection, objection_note";

/**
 * The period's visits on which a doctor raised an objection, read as the report reads them. Pure, so
 * the mapping is tested without a database. A visit with no rep is a manager's own, said in his name.
 */
export function objectionVisitsOf(
  rows: ReadonlyArray<Row>,
  named: {
    seats: ReadonlyMap<string, OrgSeat>;
    people: ReadonlyMap<string, string>;
    customers: ReadonlyMap<string, { name: string; speciality: string | null }>;
  },
): ObjectionVisit[] {
  return rows.map((row) => {
    const repHrId = textOrNull(row.rep_hr_id);
    const managerHrId = repHrId ? null : textOrNull(row.manager_hr_id);
    const seat = named.seats.get(String(row.seat_id));
    const customerId = String(row.customer_id);
    const customer = named.customers.get(customerId);
    return {
      repKey: personKey(repHrId ?? managerHrId) ?? "",
      repName: repHrId
        ? nameOf(named.people, repHrId)
        : managerHrId
          ? `${nameOf(named.people, managerHrId)} (own visits)`
          : "No rep recorded",
      territoryName: seat ? territoryName(seat) : null,
      customerId,
      doctorName: customer?.name ?? "Unnamed customer",
      speciality: customer?.speciality ?? null,
      visitDate: String(row.visit_date ?? "").slice(0, 10),
      listType: row.list_type,
      products: Array.isArray(row.products) ? row.products.map((entry) => String(entry)) : [],
      objection: row.objection,
      objectionNote: textOrNull(row.objection_note),
    };
  });
}

/**
 * Objections by doctor. The gate comes first and is the managers' one, so a rep and a product or
 * marketing manager are refused before anything is read; a manager's seats are his own team's.
 *
 * 🔴 `phoenix_crm_countable_visits`, not the view with the copied history: a visit copied from
 * iReports360 is the old system's and stays out of this list.
 */
export async function loadObjectionsByDoctorReport(viewer: PhoenixCrmViewer, raw: ReportFilterInput): Promise<ObjectionsByDoctorView> {
  const { seats, includeTest } = insightTerritories(viewer, raw);
  const period = periodOf(viewer, raw);
  if (seats.length === 0) return { ...buildObjectionsByDoctor([]), includeTest, period };

  // Asked for by the objections themselves, so the many visits with none never leave the database.
  const raised = HEARD_OBJECTIONS.map((entry) => entry.key);
  const rows = await readSeatGroups(seats.map((seat) => seat.seatId), 200, (batch) =>
    fetchAllRowsKeyset<Row>(
      () => {
        let query = getSupabaseAdmin()
          .from("phoenix_crm_countable_visits")
          .select(`id, ${OBJECTION_VISIT_COLUMNS}`)
          .in("seat_id", batch)
          .in("objection", raised)
          .gte("visit_date", period.from)
          .lte("visit_date", period.to);
        if (!includeTest) query = query.eq("is_test", false);
        return query;
      },
      { cursorColumn: "id", cursorOf: (row) => textOrNull(row.id) },
    ),
  );

  const customerIds = [...new Set(rows.map((row) => textOrNull(row.customer_id)).filter((id): id is string => id !== null))];
  const customerBatches = await mapWithConcurrency(chunk(customerIds, 200), 4, async (part) => {
    const { data, error } = await getSupabaseAdmin().from("phoenix_crm_customers").select("id, name, speciality").in("id", part);
    throwIfError(error);
    return (data ?? []) as Row[];
  });
  const customers = new Map(
    customerBatches.flat().map((row) => [String(row.id), { name: textOrNull(row.name) ?? "Unnamed customer", speciality: textOrNull(row.speciality) }]),
  );
  const people = await loadPeopleNames(rows.map((row) => textOrNull(row.rep_hr_id) ?? textOrNull(row.manager_hr_id)));

  return {
    ...buildObjectionsByDoctor(objectionVisitsOf(rows, { customers, people, seats: new Map(seats.map((seat) => [seat.seatId, seat])) })),
    includeTest,
    period,
  };
}
