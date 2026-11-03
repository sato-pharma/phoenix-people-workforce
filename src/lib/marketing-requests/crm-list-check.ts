/**
 * The server half of the list check (`crm-list-check-rules.ts` holds the rules).
 *
 * One pass reads the validated marketing customers, places each one in an area from the GPS of his own
 * live photo, reads the AM and PM lists of that area and line, and stores one verdict per customer and
 * line. The hourly cron re-reads all of them (fewer than 120 customers today), so all ten paths that write
 * a rep's list are covered with no hook in any of them; a validation save also runs it for its own
 * customers after the reply.
 *
 * 🔴 NOTHING HERE WRITES TO PHOENIX CRM, AND NOTHING HERE MAY REFUSE A SAVE. It reads a rep's list; it
 * writes only `marketing_customer_list_checks` and the customer's own three list columns.
 * 🔴 The area always comes from the GPS, never from the hand-chosen area (`chosen_area_*`), which is
 * only ever a way to open a list.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AccessContext } from "@/lib/auth/permissions";
import { loadBrickCentroids, resolveBrickForPoint } from "@/lib/crm/brick-geo";
import { loadPhoenixContactPlaces } from "@/lib/crm/validated-place-points";
import { phoenixContactId } from "@/lib/customer-360/validated";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import {
  canDecideListCheck,
  compareNames,
  judgeListCheck,
  listTypesForCustomerType,
  planListCheckCustomerWrite,
  type CrmListSource,
  type ListCheckCandidate,
  type ListCheckCustomerWrite,
  type ListCheckLinkedRow,
  type ListCheckListType,
  type ListCheckPlace,
  type ListCheckPoint,
  type ListCheckPrior,
  type ListCheckState,
  type ListCheckVerdict,
  LIST_CHECKED_VALIDATION_STATUSES,
  listCheckSpokesmanIndex,
} from "@/lib/marketing-requests/crm-list-check-rules";
import { isUsableFix } from "@/lib/phoenix-crm/geo";
import { chunk, dedupeIds, textOrNull } from "@/lib/phoenix-crm/server/db";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { matchAnchorOf } from "@/lib/phoenix-crm/server/place-match-groups";
import { seatOccupants, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { hrIdForStorage } from "@/lib/hr-id";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** The statuses that mean a customer really was validated. `system_validated` means no human looked, and still counts as captured. */

const ON_LIST_STATUSES: ReadonlySet<string> = new Set(["active", "pending"]);
const CUSTOMER_COLUMNS =
  "id, display_name, customer_type, line_id, captured_latitude, captured_longitude, crm_list_status, crm_list_source, phoenix_crm_customer_id, line:lines(code, name)";
const LIST_ROW_COLUMNS = "id, seat_id, name, list_type, status, reference_contact_crm_id, own_contact_crm_id, campaign_visit_holder";
const PLACE_COLUMNS =
  "id, customer_id, seat_id, lat, lon, accuracy_meters, pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_path, brick_id";
const IN_CHUNK = 100;

export type ListCheckPlanRow = {
  areaCode: string | null;
  areaName: string | null;
  crmListSource: CrmListSource | null;
  crmListStatus: "on_list" | "not_on_list" | null;
  customerId: string;
  customerType: string | null;
  displayName: string;
  /** The rep seats of this area and line: who should hold him. */
  holderSeatIds: string[];
  lineId: number | null;
  lineName: string | null;
  verdict: ListCheckVerdict;
  write: ListCheckCustomerWrite | null;
};

function toListStatus(value: unknown): "on_list" | "not_on_list" | null {
  return value === "on_list" || value === "not_on_list" ? value : null;
}

function toListSource(value: unknown): CrmListSource | null {
  return value === "picked" || value === "typed" || value === "checked" ? value : null;
}

function toListType(value: unknown): ListCheckListType | null {
  return value === "AM" || value === "PM" ? value : null;
}

async function readIn(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  column: string,
  ids: readonly (string | number)[],
  refine?: (query: never) => unknown,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const part of chunk([...new Set(ids)], IN_CHUNK)) {
    let query = supabase.from(table).select(columns).in(column, part);
    if (refine) query = refine(query as never) as typeof query;
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...((data ?? []) as unknown as Row[]));
  }
  return rows;
}

function placeOf(row: Row): ListCheckPlace | null {
  const anchor = matchAnchorOf(row);
  if (!anchor) return null;
  return { brickId: textOrNull(row.brick_id), photoPath: textOrNull(row.photo_path), point: anchor.point };
}

function groupPlaces(rows: readonly Row[]): Map<string, ListCheckPlace[]> {
  const out = new Map<string, ListCheckPlace[]>();
  for (const row of rows) {
    const customerId = textOrNull(row.customer_id);
    const place = placeOf(row);
    if (!customerId || !place) continue;
    out.set(customerId, [...(out.get(customerId) ?? []), place]);
  }
  return out;
}

function listRowOf(row: Row, places: ReadonlyMap<string, ListCheckPlace[]>): ListCheckCandidate | null {
  const crmCustomerId = textOrNull(row.id);
  const listType = toListType(row.list_type);
  const name = textOrNull(row.name);
  const seatId = textOrNull(row.seat_id);
  if (!crmCustomerId || !listType || !name || !seatId) return null;
  return {
    contactBrickId: null,
    contactId: phoenixContactId({
      own_contact_crm_id: row.own_contact_crm_id as number | null,
      reference_contact_crm_id: row.reference_contact_crm_id as number | null,
    }),
    crmCustomerId,
    listType,
    name,
    places: places.get(crmCustomerId) ?? [],
    seatId,
  };
}

/** One seat's area and line, compared the way the stored codes are written. */
export function seatKey(lineCode: string | null | undefined, areaCode: string | null | undefined): string | null {
  const line = lineCode?.trim().toLowerCase();
  const area = areaCode?.trim().toLowerCase();
  return line && area ? `${line}|${area}` : null;
}

export function indexSeats(territories: readonly OrgSeat[]): Map<string, OrgSeat[]> {
  const out = new Map<string, OrgSeat[]>();
  for (const seat of territories) {
    if (seat.isOtherPseudoDm) continue;
    const key = seatKey(seat.lineCode, seat.areaCode);
    if (!key) continue;
    out.set(key, [...(out.get(key) ?? []), seat]);
  }
  return out;
}

/**
 * Compute the verdicts. Reads only: `applyMarketingListCheck` writes them, so the first production run
 * can be compared with the owner's answers before a single row changes.
 */
export async function computeMarketingListCheck(options: { customerIds?: readonly string[]; now?: string } = {}): Promise<ListCheckPlanRow[]> {
  const supabase = getSupabaseAdmin();
  const now = options.now ?? new Date().toISOString();

  let customerQuery = supabase
    .from("marketing_customers")
    .select(CUSTOMER_COLUMNS)
    .is("merged_into_customer_id", null)
    .or("active.is.null,active.eq.true")
    .in("validation_status", [...LIST_CHECKED_VALIDATION_STATUSES]);
  if (options.customerIds) customerQuery = customerQuery.in("id", [...options.customerIds]);
  const customerRead = await customerQuery;
  if (customerRead.error) throw customerRead.error;
  const customers = (customerRead.data ?? []) as unknown as Row[];
  if (customers.length === 0) return [];
  const customerIds = customers.map((row) => String(row.id));

  const [requestRows, evidenceRows, contactRows, priorRows, org, centroids] = await Promise.all([
    readIn(supabase, "marketing_requests", "customer_id, line_id, line:lines(code, name)", "customer_id", customerIds),
    readIn(supabase, "marketing_evidence_files", "entity_id, captured_latitude, captured_longitude, created_at", "entity_id", customerIds, ((query: { eq: (c: string, v: string) => { eq: (c: string, v: string) => unknown } }) =>
      query.eq("entity_type", "customer").eq("evidence_type", "location_photo")) as never),
    readIn(supabase, "marketing_customer_contacts", "customer_id, crm_code, active", "customer_id", customerIds),
    readIn(supabase, "marketing_customer_list_checks", "customer_id, line_id, state, matched_crm_customer_id, left_list_at, decided_state", "customer_id", customerIds),
    loadPhoenixCrmOrg(),
    loadBrickCentroids(),
  ]);
  if (centroids.length === 0) throw new Error("The brick centres could not be read, so no customer can be placed in an area.");
  // The line's code and name come joined on the rows that name it: marketing keeps its own fresh reads, and
  // this adds no read of the lines table (tests/performance-phase-3.test.ts, tests/reference-list-cache.test.ts).
  const lineById = new Map<number, { code: string | null; name: string | null }>();
  for (const row of [...customers, ...requestRows]) {
    if (row.line_id === null || row.line_id === undefined) continue;
    const line = row.line as { code?: unknown; name?: unknown } | null | undefined;
    lineById.set(Number(row.line_id), { code: textOrNull(line?.code), name: textOrNull(line?.name) });
  }

  const linesByCustomer = new Map<string, Set<number>>();
  for (const row of requestRows) {
    const customerId = textOrNull(row.customer_id);
    if (!customerId || row.line_id === null || row.line_id === undefined) continue;
    linesByCustomer.set(customerId, (linesByCustomer.get(customerId) ?? new Set<number>()).add(Number(row.line_id)));
  }

  // The photo's own fix first (owner, 2026-10-18: a live photo's GPS is the primary source of trust).
  const photoPoint = new Map<string, { at: string; point: ListCheckPoint }>();
  for (const row of evidenceRows) {
    if (!isUsableFix(row.captured_latitude, row.captured_longitude)) continue;
    const customerId = String(row.entity_id);
    const at = String(row.created_at ?? "");
    const held = photoPoint.get(customerId);
    if (held && held.at >= at) continue;
    photoPoint.set(customerId, { at, point: { lat: Number(row.captured_latitude), lon: Number(row.captured_longitude) } });
  }

  const declared = new Map<string, string[]>();
  for (const row of contactRows) {
    const code = textOrNull(row.crm_code);
    if (!code || row.active === false) continue;
    const customerId = String(row.customer_id);
    declared.set(customerId, [...(declared.get(customerId) ?? []), code]);
  }

  const priorKey = (customerId: string, lineId: number | null) => `${customerId}|${lineId ?? ""}`;
  const priors = new Map<string, ListCheckPrior>();
  for (const row of priorRows) {
    const lineId = row.line_id === null || row.line_id === undefined ? null : Number(row.line_id);
    priors.set(priorKey(String(row.customer_id), lineId), {
      decidedState: toListStatus(row.decided_state),
      leftListAt: textOrNull(row.left_list_at),
      matchedCrmCustomerId: textOrNull(row.matched_crm_customer_id),
      state: textOrNull(row.state) as ListCheckState | null,
    });
  }

  type Work = {
    areaCode: string | null;
    areaName: string | null;
    brickId: string | null;
    customer: Row;
    lineId: number | null;
    lineName: string | null;
    point: ListCheckPoint | null;
    prior: ListCheckPrior | null;
    seats: OrgSeat[];
  };
  const seatsByKey = indexSeats(org.territories);
  const work: Work[] = customers.flatMap((customer) => {
    const customerId = String(customer.id);
    const fromPhoto = photoPoint.get(customerId)?.point ?? null;
    const point =
      fromPhoto ??
      (isUsableFix(customer.captured_latitude, customer.captured_longitude)
        ? { lat: Number(customer.captured_latitude), lon: Number(customer.captured_longitude) }
        : null);
    const brick = point ? resolveBrickForPoint(point.lat, point.lon, centroids) : null;
    const requestLines = [...(linesByCustomer.get(customerId) ?? [])];
    const ownLine = customer.line_id === null || customer.line_id === undefined ? null : Number(customer.line_id);
    const lineIds: Array<number | null> = requestLines.length > 0 ? requestLines : [ownLine];
    return lineIds.map((lineId) => {
      const line = lineId === null ? undefined : lineById.get(lineId);
      const key = seatKey(line?.code, brick?.areaCode);
      return {
        areaCode: brick?.areaCode ?? null,
        areaName: brick?.areaName ?? null,
        brickId: brick?.brickId ?? null,
        customer,
        lineId,
        lineName: line?.name ?? null,
        point,
        prior: priors.get(priorKey(customerId, lineId)) ?? null,
        seats: (key && seatsByKey.get(key)) || [],
      };
    });
  });

  const seatIds = dedupeIds(work.flatMap((item) => item.seats.map((seat) => seat.seatId)));
  const listRows: Row[] = [];
  const placeRows: Row[] = [];
  for (const part of chunk(seatIds, 50)) {
    const [lists, places] = await Promise.all([
      fetchAllRowsKeyset<Row>(
        () =>
          supabase
            .from("phoenix_crm_customers")
            .select(LIST_ROW_COLUMNS)
            .in("seat_id", part)
            .eq("is_test", false)
            .eq("campaign_visit_holder", false)
            .in("status", [...ON_LIST_STATUSES])
            .in("list_type", ["AM", "PM"]),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      ),
      fetchAllRowsKeyset<Row>(
        () => supabase.from("phoenix_crm_places").select(PLACE_COLUMNS).in("seat_id", part).eq("is_test", false).eq("status", "active"),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      ),
    ]);
    listRows.push(...lists);
    placeRows.push(...places);
  }
  const placesByRow = groupPlaces(placeRows);
  const listBySeat = new Map<string, ListCheckCandidate[]>();
  for (const row of listRows) {
    const candidate = listRowOf(row, placesByRow);
    if (candidate) listBySeat.set(candidate.seatId, [...(listBySeat.get(candidate.seatId) ?? []), candidate]);
  }

  // A row a pick or an earlier match points at, read whether or not it is still on a list.
  const linkedIds = dedupeIds(work.flatMap((item) => [textOrNull(item.customer.phoenix_crm_customer_id), item.prior?.matchedCrmCustomerId ?? null]));
  const [linkedRead, linkedPlaces] = await Promise.all([
    readIn(supabase, "phoenix_crm_customers", LIST_ROW_COLUMNS, "id", linkedIds),
    readIn(supabase, "phoenix_crm_places", PLACE_COLUMNS, "customer_id", linkedIds, ((query: { eq: (c: string, v: unknown) => { eq: (c: string, v: unknown) => unknown } }) =>
      query.eq("is_test", false).eq("status", "active")) as never),
  ]);
  const linkedPlacesByRow = groupPlaces(linkedPlaces);
  const linkedById = new Map<string, ListCheckLinkedRow>();
  for (const row of linkedRead) {
    const candidate = listRowOf(row, linkedPlacesByRow);
    if (!candidate) continue;
    linkedById.set(candidate.crmCustomerId, {
      ...candidate,
      onList: ON_LIST_STATUSES.has(String(row.status)) && row.campaign_visit_holder !== true,
    });
  }

  const candidatesFor = (item: Work): ListCheckCandidate[] => {
    const { listTypes } = listTypesForCustomerType(textOrNull(item.customer.customer_type));
    return item.seats.flatMap((seat) => (listBySeat.get(seat.seatId) ?? []).filter((row) => listTypes.includes(row.listType)));
  };

  // A doctor still waiting on this rep may already be validated on another rep's row, and the old contact
  // record knows his brick. Read those only for the rows whose NAME agrees: nothing else can use them.
  const nameAgreeing = work.flatMap((item) =>
    candidatesFor(item).filter((row) => {
      const match = compareNames(textOrNull(item.customer.display_name), row.name);
      return match === "same" || match === "one_letter";
    }),
  );
  const contactIds = [...new Set(nameAgreeing.map((row) => row.contactId).filter((id): id is number => id !== null))];
  const [contactPlaces, contactBrickRows] = await Promise.all([
    loadPhoenixContactPlaces(contactIds),
    readIn(supabase, "crm_contacts", "contact_crm_id, brick_id", "contact_crm_id", contactIds),
  ]);
  const contactBricks = new Map(contactBrickRows.map((row) => [Number(row.contact_crm_id), textOrNull(row.brick_id)]));
  const enrich = (row: ListCheckCandidate): ListCheckCandidate => {
    if (row.contactId === null) return row;
    const contactBrickId = contactPlaces.brickIds.get(row.contactId) ?? contactBricks.get(row.contactId) ?? null;
    const shared = contactPlaces.points.get(row.contactId);
    const places: ListCheckPlace[] =
      row.places.length === 0 && shared ? [{ brickId: contactBrickId, photoPath: null, point: { lat: shared.lat, lon: shared.lon } }] : [...row.places];
    return { ...row, contactBrickId, places };
  };

  const planned: ListCheckPlanRow[] = work.map((item) => {
    const customerId = String(item.customer.id);
    const displayName = textOrNull(item.customer.display_name) ?? "";
    const crmListStatus = toListStatus(item.customer.crm_list_status);
    const crmListSource = toListSource(item.customer.crm_list_source);
    const phoenixCrmCustomerId = textOrNull(item.customer.phoenix_crm_customer_id);
    // A person answered about this row's own doctor, so that answer points at him, not at another line's.
    const linkedId = item.prior?.decidedState
      ? (item.prior.matchedCrmCustomerId ?? phoenixCrmCustomerId)
      : (phoenixCrmCustomerId ?? item.prior?.matchedCrmCustomerId ?? null);
    const verdict = judgeListCheck({
      areaCode: item.areaCode,
      brickId: item.brickId,
      candidates: candidatesFor(item).map(enrich),
      crmListSource,
      crmListStatus,
      customerType: textOrNull(item.customer.customer_type),
      declaredCrmCodes: declared.get(customerId) ?? [],
      displayName,
      holderOccupied: item.seats.some((seat) => seatOccupants(seat).length > 0),
      linkedRow: linkedId ? (linkedById.get(linkedId) ?? null) : null,
      lineKnown: item.lineId !== null,
      now,
      point: item.point,
      prior: item.prior,
    });
    return {
      areaCode: item.areaCode,
      areaName: item.areaName,
      crmListSource,
      crmListStatus,
      customerId,
      customerType: textOrNull(item.customer.customer_type),
      displayName,
      holderSeatIds: item.seats.map((seat) => seat.seatId),
      lineId: item.lineId,
      lineName: item.lineName,
      verdict,
      write: planListCheckCustomerWrite({
        current: { crmListSource, crmListStatus, phoenixCrmCustomerId },
        decidedState: item.prior?.decidedState ?? null,
        verdict,
      }),
    };
  });

  // One answer per customer: only the row that speaks for him may write his own columns.
  const rowsByCustomer = new Map<string, number[]>();
  planned.forEach((row, at) => rowsByCustomer.set(row.customerId, [...(rowsByCustomer.get(row.customerId) ?? []), at]));
  return planned.map((row, at) => {
    const own = rowsByCustomer.get(row.customerId) ?? [at];
    if (own.length < 2) return row;
    const speaker = own[listCheckSpokesmanIndex(own.map((index) => ({ decidedState: work[index].prior?.decidedState ?? null, state: planned[index].verdict.state })))];
    return at === speaker ? row : { ...row, write: null };
  });
}

/** Stores the verdicts. A person's decision columns are never named here, so a re-check cannot touch them. */
export async function applyMarketingListCheck(rows: readonly ListCheckPlanRow[], now = new Date().toISOString()): Promise<{ checks: number; customers: number }> {
  const supabase = getSupabaseAdmin();
  let customers = 0;
  for (const part of chunk([...rows], IN_CHUNK)) {
    const { error } = await supabase.from("marketing_customer_list_checks").upsert(
      part.map((row) => ({
        area_code: row.areaCode,
        area_name: row.areaName,
        checked_at: now,
        customer_id: row.customerId,
        left_list_at: row.verdict.leftListAt,
        line_id: row.lineId,
        list_type: row.verdict.listType,
        looks_like_nursery: row.verdict.looksLikeNursery,
        matched_crm_customer_id: row.verdict.matched?.crmCustomerId ?? null,
        matched_name: row.verdict.matched?.name ?? null,
        metres_apart: row.verdict.metresApart,
        name_match: row.verdict.nameMatch,
        reason: row.verdict.reason,
        same_brick: row.verdict.sameBrick,
        seat_id: row.verdict.matched?.seatId ?? null,
        state: row.verdict.state,
        updated_at: now,
      })),
      { onConflict: "customer_id,line_id" },
    );
    if (error) throw error;
  }
  // A line this pass no longer holds for these customers goes, unless a person answered on it: that answer
  // is kept for the day the line comes back, and `currentListCheckRows` keeps it off every screen until then.
  for (const part of chunk([...new Set(rows.map((row) => row.customerId))], IN_CHUNK)) {
    const { error } = await supabase
      .from("marketing_customer_list_checks")
      .delete()
      .in("customer_id", part)
      .is("decided_state", null)
      .lt("checked_at", now);
    if (error) throw error;
  }
  for (const row of rows) {
    if (!row.write) continue;
    // A pick saved between the read and this write keeps its own answer.
    const { error } = await supabase
      .from("marketing_customers")
      .update(row.write)
      .eq("id", row.customerId)
      .or("crm_list_source.is.null,crm_list_source.neq.picked");
    if (error) throw error;
    customers += 1;
  }
  return { checks: rows.length, customers };
}

/** The hourly pass, and the run after a validation save for its own customers. */
export async function runMarketingListCheck(customerIds?: readonly string[]): Promise<{ checks: number; customers: number }> {
  if (customerIds && customerIds.length === 0) return { checks: 0, customers: 0 };
  const rows = await computeMarketingListCheck({ customerIds });
  return applyMarketingListCheck(rows);
}

/**
 * The SFE Manager's or Super Admin's answer on an unsure row. It records who and when, then re-runs the
 * check for that customer so his own list columns follow the answer at once.
 */
export async function decideMarketingListCheck(
  access: Pick<AccessContext, "hrId" | "loginId" | "role">,
  input: { checkId: string; decision: "same" | "not_same" },
): Promise<void> {
  if (!canDecideListCheck(access.role)) throw forbiddenError("Only the SFE Manager or the Super Admin answers this.");
  const supabase = getSupabaseAdmin();
  const read = await supabase
    .from("marketing_customer_list_checks")
    .select("id, customer_id, matched_crm_customer_id, state, decided_state")
    .eq("id", input.checkId)
    .maybeSingle();
  if (read.error) throw read.error;
  const row = read.data as Row | null;
  if (!row) throw notFoundError("That row is no longer on the list check.");
  if (input.decision === "same" && !row.matched_crm_customer_id) {
    throw validationError("There is no doctor on the rep's list to confirm this customer against.");
  }
  const now = new Date().toISOString();
  const update = await supabase
    .from("marketing_customer_list_checks")
    .update({
      decided_at: now,
      decided_by_hr_id: hrIdForStorage(access.hrId),
      decided_source: "board",
      decided_state: input.decision === "same" ? "on_list" : "not_on_list",
      updated_at: now,
    })
    .eq("id", input.checkId);
  if (update.error) throw update.error;
  // Required: this sets which customers count as on a rep's list, on the screen an approver reads.
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityId: String(row.customer_id),
    entityType: "marketing_customer",
    newValues: { checkId: input.checkId, decidedState: input.decision === "same" ? "on_list" : "not_on_list" },
    oldValues: { decidedState: row.decided_state ?? null, state: row.state },
    summary: `Doctor-list check answered: ${input.decision === "same" ? "same doctor" : "not the same doctor"}.`,
  });
  await runMarketingListCheck([String(row.customer_id)]);
}
