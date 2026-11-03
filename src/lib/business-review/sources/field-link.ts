// Business Review — the reads behind the linked sections (field work beside the money).
//
// Owner, 2026-10-01: link the CRM, the Monthly Closing, direct orders, marketing requests, market
// awareness and expenses into one review. This module READS; field-link.ts next door computes and
// pack/link-sections.ts words it. Nothing here decides a figure.
//
// 🔴 CALLED AT EXPORT TIME, PER VIEWER, AND NEVER CACHED. Like the closing's customer rows, these
// facts are scoped to the viewer before they are read — a medical rep's call reads HIS list and HIS
// visits and nothing else — so they must never sit in the shared review cache, which is keyed on the
// window and nothing about who is looking.
//
// WHERE EACH HALF COMES FROM, and why:
//
//   * THE LIST is Phoenix's own contact register (`crm_contact_assignments` + `crm_contacts`), never
//     the raw `ireports360_contacts` scrape. The register dates every list period from its first
//     sweep on 28 Aug 2026, so a month is measured against the list AS IT STOOD.
//   * EACH CONTACT'S BRICK comes through the Reps List's one door (`loadContactPlacements`, owner,
//     2026-10-31: "any data anywhere depending on data from ireports must shift to pulling its data
//     from phoenix crm") — the validated Phoenix place first, then the SFE's locality, and only then
//     the register's old iReports360 brick — so a doctor and his visits can never disagree about where
//     he is, and the pack places him where his rep's own list does.
//   * VISITS AND RIDES come through the CRM read door (`queryVisits`), with the resigned floor
//     opened exactly as the review's own visit source opens it, and the same duplicate collapse. The
//     door itself decides which system speaks for a rep-day (owner, 2026-10-02): a team that works in
//     Phoenix CRM is served by its own Phoenix visits from the team's start, and its reps' iReports360
//     rows from that day are left out of the same view — so nothing here reads Phoenix CRM's tables,
//     and one call is never counted twice. See src/lib/crm/phoenix-team-starts.ts.
//   * DIRECT ORDERS are the order table itself: approved, not reversed, not a duplicate, at the
//     pharmacy's own area — the rows `phx_rebuild_direct_order_sos_batch` turns into the closing's
//     `DirectReq` sales. The month is the one FINANCE booked; an order it has not booked is shown as
//     not booked and counted in no month.
//   * MARKETING REQUESTS are keyed on the pay month like every marketing aggregate in Phoenix, and
//     their return is the Marketing ROI engine's own (`loadActuals`), with the confidential Head
//     Office products masked for everyone — the review never shows those products at all.
//   * MARKET AWARENESS activities are read at their area and line, from their start date.

import { CATCH_ALL_CONTACT_CRM_ID } from "@/lib/crm/call-rate";
import { resolvePersonDisplayName } from "@/lib/employees/display-name";
import { loadContactPlacements } from "@/lib/crm/reps-list";
import { collapseDuplicateVisitSubmissions, isCrmDoubleVisitRow, queryVisits } from "@/lib/crm/reads";
import { isPhoenixNativeVisitRow } from "@/lib/crm/phoenix-team-starts";
import { addBucketToSplit, emptyVisitCountSplit, visitCountBucket } from "@/lib/crm/visit-count-buckets";
import { classifyVisit, REGULAR_TYPE } from "@/lib/crm/visit-types";
import { loadActuals, roiValueBucket } from "@/lib/marketing-requests/roi-report-service";
import { loadReferenceAreas, loadReferenceLines } from "@/lib/reference/reference-lists";
import { RESTRICTED_PRODUCT_CODES } from "@/lib/sales/access-scope";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";

import {
  LIST_HISTORY_FROM,
  listBucketOf,
  normaliseGrade,
  type AwarenessFact,
  type ContactVisitTally,
  type DirectOrderFact,
  type FieldLinkFacts,
  type ListedContact,
  type MarketingRequestFact,
  type RepDayFact,
  type RideFact,
} from "../field-link";
import { periodMonthEnd } from "../period-format";
import { hrKey } from "./attribution";

/** Above this many reps the reads take the whole window and narrow in memory — an `in` list of every
 *  casing of a hundred HR ids is a URL PostgREST should never be handed. */
const NARROW_READ_MAX_PEOPLE = 40;
/** The vendor's unlabelled field visit — its AM · PM · Pharmacies bucket is read off its comment. */
const UNLABELLED_FIELD_VISIT_TYPE = -30;
const IN_CHUNK = 200;

const VISIT_COLUMNS =
  "agent_crm_id, agent_hr_id, ampm, contact_crm_id, crm_save_date, crm_visit_id, double_crm_id, " +
  "double_hr_id, double2_hr_id, source, speciality, visit_date, visit_type";

type VisitRow = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  ampm: string | null;
  contact_crm_id: number | null;
  crm_save_date: string | null;
  crm_visit_id: number | null;
  double_crm_id: number | null;
  double_hr_id: string | null;
  double2_hr_id: string | null;
  source?: string | null;
  speciality: string | null;
  visit_date: string | null;
  visit_type: number | null;
};

export type FieldLinkScope = {
  /** The FIGURE months — never the requested window (see coverage.ts). */
  months: readonly string[];
  /** The reps whose lists and field work the pack covers, any casing. */
  repHrIds: readonly string[];
  /** The district seats in the pack — their holders are the managers whose rides are read. */
  managerSeatIds: readonly string[];
  /** Area codes and lines in the pack. An area code alone is not enough: an area is not per line. */
  areaCodes: readonly string[];
  /** `lines.name` spellings ("Pedia", "CNS", "Anti Infective") of the pack's lines. */
  lineNames: readonly string[];
  include: { directOrders: boolean; marketing: boolean; awareness: boolean };
};

const up = (value: unknown) => String(value ?? "").trim().toUpperCase();
const text = (value: unknown) => String(value ?? "").trim();
const numOf = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function chunks<T>(values: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function monthBounds(months: readonly string[]): { from: string; to: string } | null {
  const sorted = [...new Set(months.filter(Boolean))].sort();
  if (sorted.length === 0) return null;
  return { from: `${sorted[0]}-01`, to: periodMonthEnd(sorted[sorted.length - 1]) };
}

/**
 * Load every fact the linked sections read, for one viewer's scope.
 *
 * Every read is independent and fails SOFT: a source that cannot be read comes back empty or null
 * (null where the section must then be dropped rather than drawn as zero), and the rest of the pack
 * still ships. The caller logs the failure; a half-read never pretends to be a whole one because
 * the null halves are exactly what the model checks before it draws.
 */
export async function loadFieldLinkFacts(scope: FieldLinkScope): Promise<FieldLinkFacts> {
  const months = [...new Set(scope.months.filter(Boolean))].sort();
  const bounds = monthBounds(months);
  const reps = [...new Set(scope.repHrIds.map(hrKey).filter(Boolean))];
  const empty: FieldLinkFacts = {
    awareness: scope.include.awareness ? [] : null,
    brickNames: {},
    contacts: [],
    directOrders: scope.include.directOrders ? [] : null,
    listBeforeHistory: false,
    managers: [],
    marketing: scope.include.marketing ? [] : null,
    months,
    names: {},
    repDays: [],
    repHrIds: reps,
    rides: [],
    ridesOutside: [],
    visitsByContact: {},
  };
  if (!bounds) return empty;

  const db = getSupabaseAdmin();
  const repSet = new Set(reps);

  // ── Who holds the district seats, so a ride can be credited to "his manager". ─────────────────
  const managers = await loadManagers(db, scope.managerSeatIds);
  const managerIds = [...new Set(managers.map((m) => m.hrId))];

  const [contacts, visitRows, outsideRows, brickNames, directOrders, marketing, awareness] = await Promise.all([
    loadListedContacts(db, reps, bounds),
    loadVisitRows(reps, bounds),
    managerIds.length > 0 && reps.length <= NARROW_READ_MAX_PEOPLE
      ? queryVisits<VisitRow>({
          columns: VISIT_COLUMNS,
          dateFrom: bounds.from,
          dateTo: bounds.to,
          doubleHrIds: managerIds,
          includeResignedAgents: true,
        }).catch(() => [] as VisitRow[])
      : Promise.resolve([] as VisitRow[]),
    loadBrickNames(db),
    scope.include.directOrders ? loadDirectOrders(db, scope, months).catch(() => null) : Promise.resolve(null),
    scope.include.marketing ? loadMarketingRequests(db, scope, bounds).catch(() => null) : Promise.resolve(null),
    scope.include.awareness ? loadAwareness(db, scope, bounds).catch(() => null) : Promise.resolve(null),
  ]);

  // ── Visits: per contact, per rep-month, and rides. ────────────────────────────────────────────
  const inWindow = new Set(months);
  const visitsByContact: Record<string, ContactVisitTally> = {};
  const repDayKeys = new Map<string, { days: Set<string>; fact: RepDayFact }>();
  const rideKeys = new Map<string, { days: Set<string>; fact: RideFact }>();
  const outside = new Map<string, Set<string>>(); // `${manager}|${period}` → days
  const managerSet = new Set(managerIds);

  for (const row of visitRows.rows) {
    const date = text(row.visit_date).slice(0, 10);
    const period = date.slice(0, 7);
    if (!inWindow.has(period)) continue;
    const agent = hrKey(row.agent_hr_id);
    const { bucket } = classifyVisit(row.visit_type ?? null, null, null);
    const isField = bucket === "regular" || bucket === "campaign";
    const countBucket = visitCountBucket({
      ampm: row.ampm,
      comment:
        row.visit_type === UNLABELLED_FIELD_VISIT_TYPE && row.crm_visit_id != null
          ? visitRows.comments.get(row.crm_visit_id) ?? null
          : null,
      speciality: row.speciality,
      visit_type: row.visit_type,
    });
    // A Phoenix CRM row logs no pharmacy visit: the split counts it, so the pack words that pharmacy
    // figure as not recorded, never 0 (src/lib/crm/visit-count-buckets.ts).
    const fromPhoenix = isPhoenixNativeVisitRow(row);

    // A named customer, reached by a regular visit — never contact 0, never the catch-all slot.
    const contactId =
      row.visit_type === REGULAR_TYPE &&
      row.contact_crm_id != null &&
      row.contact_crm_id !== 0 &&
      row.contact_crm_id !== CATCH_ALL_CONTACT_CRM_ID
        ? Number(row.contact_crm_id)
        : null;

    if (repSet.has(agent)) {
      if (contactId != null) {
        const key = String(contactId);
        const tally = visitsByContact[key] ?? { brickId: null, lastVisit: null, split: emptyVisitCountSplit(), visits: 0 };
        tally.visits += 1;
        addBucketToSplit(tally.split, countBucket, 1, fromPhoenix);
        if (!tally.lastVisit || date > tally.lastVisit) tally.lastVisit = date;
        visitsByContact[key] = tally;
      }
      if (isField) {
        const key = `${agent}|${period}`;
        const entry =
          repDayKeys.get(key) ??
          { days: new Set<string>(), fact: { fieldDays: 0, fieldVisits: 0, period, repHrId: agent, split: emptyVisitCountSplit() } };
        entry.days.add(date);
        entry.fact.fieldVisits += 1;
        addBucketToSplit(entry.fact.split, countBucket, 1, fromPhoenix);
        repDayKeys.set(key, entry);
      }
    }

    // A ride: a real partner on a fieldwork type, the one predicate Double Visit Analytics uses.
    if (!isCrmDoubleVisitRow(row)) continue;
    // BOTH partner slots: a chain visit carries two managers and each really gave that ride.
    for (const manager of [hrKey(row.double_hr_id), hrKey(row.double2_hr_id)]) {
      if (!manager) continue;
      if (repSet.has(agent)) {
        const key = `${manager}|${agent}|${period}`;
        const entry = rideKeys.get(key) ?? { days: new Set<string>(), fact: { days: 0, managerHrId: manager, period, repHrId: agent, visits: 0 } };
        entry.days.add(date);
        entry.fact.visits += 1;
        rideKeys.set(key, entry);
      } else if (managerSet.has(manager)) {
        const key = `${manager}|${period}`;
        const days = outside.get(key) ?? new Set<string>();
        days.add(`${agent}|${date}`);
        outside.set(key, days);
      }
    }
  }

  // Rides a manager in the pack gave people OUTSIDE it — only the narrow read needs the second query;
  // the whole-window read above already saw every row.
  for (const row of outsideRows) {
    const date = text(row.visit_date).slice(0, 10);
    const period = date.slice(0, 7);
    if (!inWindow.has(period) || !isCrmDoubleVisitRow(row)) continue;
    const agent = hrKey(row.agent_hr_id);
    if (repSet.has(agent)) continue;
    for (const manager of [hrKey(row.double_hr_id), hrKey(row.double2_hr_id)]) {
      if (!managerSet.has(manager)) continue;
      const key = `${manager}|${period}`;
      const days = outside.get(key) ?? new Set<string>();
      days.add(`${agent}|${date}`);
      outside.set(key, days);
    }
  }

  // Every visited contact gets the register's brick, listed or not, so a brick's work is complete.
  const brickOfContact = await loadContactBricks(db, Object.keys(visitsByContact).map(Number)).catch(
    () => new Map<number, string | null>(),
  );
  for (const [key, tally] of Object.entries(visitsByContact)) {
    tally.brickId = brickOfContact.get(Number(key)) ?? null;
  }

  // Names for every person the facts mention, so no section ever prints an HR id.
  const people = new Set<string>([...reps, ...managerIds]);
  for (const entry of rideKeys.values()) people.add(entry.fact.managerHrId);
  const names = await loadNames(db, [...people]).catch(() => ({} as Record<string, string>));
  for (const manager of managers) if (!names[manager.hrId]) names[manager.hrId] = manager.name;

  return {
    awareness,
    brickNames,
    contacts: contacts.contacts,
    directOrders,
    listBeforeHistory: months.some((month) => periodMonthEnd(month) < LIST_HISTORY_FROM),
    managers,
    marketing,
    months,
    names,
    repDays: [...repDayKeys.values()].map(({ days, fact }) => ({ ...fact, fieldDays: days.size })),
    repHrIds: reps,
    rides: [...rideKeys.values()].map(({ days, fact }) => ({ ...fact, days: days.size })),
    ridesOutside: [...outside.entries()].map(([key, days]) => {
      const [managerHrId, period] = key.split("|");
      // Days, not rep-days: a day spent with two outside reps is still one day away from the team.
      const distinctDays = new Set([...days].map((value) => value.split("|")[1]));
      return { days: distinctDays.size, managerHrId, period };
    }),
    visitsByContact,
  };
}

// ─────────────────────────────────────────────────────────────── the reads ──

type Db = ReturnType<typeof getSupabaseAdmin>;

async function loadManagers(db: Db, seatIds: readonly string[]): Promise<FieldLinkFacts["managers"]> {
  const seats = [...new Set(seatIds.filter(Boolean))];
  if (seats.length === 0) return [];
  try {
    const rows: { seat_id: string | null; occupant_hr_id: string | null }[] = [];
    for (const part of chunks(seats)) {
      const { data, error } = await db.from("au_v_org_tree_sales").select("seat_id, occupant_hr_id").in("seat_id", part);
      if (error) throw error;
      rows.push(...((data ?? []) as typeof rows));
    }
    const held = rows.filter((row) => row.seat_id && hrKey(row.occupant_hr_id));
    const names = await loadNames(db, held.map((row) => hrKey(row.occupant_hr_id)));
    return held.map((row) => {
      const hrId = hrKey(row.occupant_hr_id);
      // A name, never the HR id (owner, 2026-10-01: "NEVER SHOW CODES ALWAYS SHOW NAMES").
      return { dmSeatId: String(row.seat_id), hrId, name: names[hrId] ?? "Unnamed manager" };
    });
  } catch {
    // No holder known means no "his manager" — the DV section is then dropped, never guessed.
    return [];
  }
}

async function loadNames(db: Db, hrIds: readonly string[]): Promise<Record<string, string>> {
  const keys = [...new Set(hrIds.map(hrKey).filter(Boolean))];
  const out: Record<string, string> = {};
  if (keys.length === 0) return out;
  // Every casing, because employees.hr_id is stored as HR typed it.
  const variants = [...new Set(keys.flatMap((key) => [key, key.toLowerCase()]))];
  for (const part of chunks(variants)) {
    const { data, error } = await db.from("employees").select("hr_id, full_name, nickname").in("hr_id", part);
    if (error) throw error;
    for (const row of (data ?? []) as { hr_id: string | null; full_name: string | null; nickname: string | null }[]) {
      const key = hrKey(row.hr_id);
      const name = text(row.full_name);
      if (key && name) out[key] = resolvePersonDisplayName(name, row.nickname, row.hr_id);
    }
  }
  return out;
}

async function loadBrickNames(db: Db): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const rows = await fetchAllRows<{ brick_id: string | null; brick_name: string | null }>(
      () => db.from("source_of_sales_bricks").select("brick_id, brick_name"),
      "brick_id",
    );
    for (const row of rows) {
      const id = text(row.brick_id);
      const name = text(row.brick_name);
      if (id && name) out[id] = name;
    }
  } catch {
    // A brick then prints by its id rather than failing the export over a lookup.
  }
  return out;
}

/**
 * Every list period of these reps that touches the window — or, for a window wholly before the
 * register's first sweep, the list as first recorded, because that is the earliest honest answer.
 */
async function loadListedContacts(
  db: Db,
  reps: readonly string[],
  bounds: { from: string; to: string },
): Promise<{ contacts: ListedContact[] }> {
  if (reps.length === 0) return { contacts: [] };
  const repSet = new Set(reps);
  type AssignmentRow = {
    contact_crm_id: number | null;
    agent_hr_id: string | null;
    list_type: string | null;
    grade: string | null;
    effective_from: string | null;
    effective_to: string | null;
  };
  let rows: AssignmentRow[] = [];
  try {
    const select = "contact_crm_id, agent_hr_id, list_type, grade, effective_from, effective_to";
    // A window wholly before the history reads the first sweep; otherwise, anything overlapping it.
    const floor = bounds.to < LIST_HISTORY_FROM ? LIST_HISTORY_FROM : bounds.from;
    if (reps.length > NARROW_READ_MAX_PEOPLE) {
      rows = await fetchAllRows<AssignmentRow>(
        () => db.from("crm_contact_assignments").select(select).or(`effective_to.is.null,effective_to.gte.${floor}`),
        "id",
      );
    } else {
      const variants = [...new Set(reps.flatMap((rep) => [rep, rep.toLowerCase()]))];
      rows = await fetchAllRows<AssignmentRow>(
        () =>
          db
            .from("crm_contact_assignments")
            .select(select)
            .in("agent_hr_id", variants)
            .or(`effective_to.is.null,effective_to.gte.${floor}`),
        "id",
      );
    }
  } catch {
    return { contacts: [] };
  }

  const beforeHistory = bounds.to < LIST_HISTORY_FROM;
  const periods = rows.filter((row) => {
    if (!repSet.has(hrKey(row.agent_hr_id)) || row.contact_crm_id == null) return false;
    const from = text(row.effective_from);
    const to = row.effective_to ? text(row.effective_to) : null;
    if (beforeHistory) return from === LIST_HISTORY_FROM;
    return from <= bounds.to && (to == null || to >= bounds.from);
  });

  // The latest period per (rep, contact) decides the grade and the list he is shown on.
  const latest = new Map<string, AssignmentRow>();
  for (const row of periods) {
    const key = `${hrKey(row.agent_hr_id)}|${row.contact_crm_id}`;
    const current = latest.get(key);
    if (!current || text(row.effective_from) > text(current.effective_from)) latest.set(key, row);
  }

  const ids = [...new Set([...latest.values()].map((row) => Number(row.contact_crm_id)))];
  const detail = new Map<
    number,
    { name: string; speciality: string; brickId: string | null; lastVisitedOn: string | null; region: string | null }
  >();
  for (const part of chunks(ids)) {
    const { data, error } = await db
      .from("crm_contacts")
      .select("contact_crm_id, name, name_ar, speciality, brick_id, crm_region_name, last_visited_on")
      .in("contact_crm_id", part);
    if (error) break;
    for (const row of (data ?? []) as {
      contact_crm_id: number;
      name: string | null;
      name_ar: string | null;
      speciality: string | null;
      brick_id: string | null;
      crm_region_name: string | null;
      last_visited_on: string | null;
    }[]) {
      detail.set(Number(row.contact_crm_id), {
        brickId: text(row.brick_id) || null,
        lastVisitedOn: row.last_visited_on ? text(row.last_visited_on).slice(0, 10) : null,
        name: text(row.name) || text(row.name_ar) || "Unnamed customer",
        region: text(row.crm_region_name) || null,
        speciality: text(row.speciality),
      });
    }
  }
  // Phoenix CRM's place first; the register's old iReports360 brick only where Phoenix has none.
  const placements = await loadContactPlacements(
    [...detail.entries()].map(([contactCrmId, info]) => ({ contactCrmId, region: info.region })),
  );
  for (const [id, info] of detail) info.brickId = placements.get(id)?.brickId ?? info.brickId;

  const contacts: ListedContact[] = [];
  for (const row of latest.values()) {
    const id = Number(row.contact_crm_id);
    if (id === CATCH_ALL_CONTACT_CRM_ID) continue;
    const info = detail.get(id);
    contacts.push({
      brickId: info?.brickId ?? null,
      bucket: listBucketOf(row.list_type, info?.speciality),
      contactId: id,
      grade: normaliseGrade(row.grade),
      lastVisitedOn: info?.lastVisitedOn ?? null,
      name: info?.name ?? "Unnamed customer",
      repHrId: hrKey(row.agent_hr_id),
      speciality: info?.speciality ?? "",
    });
  }
  return { contacts };
}

/**
 * Each contact's brick — for contacts visited but not on any list in the pack. Phoenix CRM's place
 * first (the one door), the register's old iReports360 brick only where Phoenix has none.
 */
async function loadContactBricks(db: Db, ids: readonly number[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  const regions: { contactCrmId: number; region: string | null }[] = [];
  for (const part of chunks([...new Set(ids)].filter((id) => Number.isFinite(id)))) {
    const { data, error } = await db
      .from("crm_contacts")
      .select("contact_crm_id, brick_id, crm_region_name")
      .in("contact_crm_id", part);
    if (error) throw error;
    for (const row of (data ?? []) as { contact_crm_id: number; brick_id: string | null; crm_region_name: string | null }[]) {
      out.set(Number(row.contact_crm_id), text(row.brick_id) || null);
      regions.push({ contactCrmId: Number(row.contact_crm_id), region: text(row.crm_region_name) || null });
    }
  }
  const placements = await loadContactPlacements(regions);
  for (const [id, brickId] of out) out.set(id, placements.get(id)?.brickId ?? brickId);
  return out;
}

/**
 * The window's visits for these reps, collapsed exactly as the review's visit source collapses them,
 * plus the comment of every unlabelled `-30` field visit — the only thing that can say whether one
 * was a pharmacy call (the AM · PM · Pharmacies golden rule).
 */
async function loadVisitRows(
  reps: readonly string[],
  bounds: { from: string; to: string },
): Promise<{ rows: VisitRow[]; comments: Map<number, string | null> }> {
  if (reps.length === 0) return { comments: new Map(), rows: [] };
  const narrow = reps.length <= NARROW_READ_MAX_PEOPLE;
  const base = {
    dateFrom: bounds.from,
    dateTo: bounds.to,
    includeResignedAgents: true,
    ...(narrow ? { agentHrIds: reps } : {}),
  };
  try {
    const [raw, unlabelled] = await Promise.all([
      queryVisits<VisitRow>({ ...base, columns: VISIT_COLUMNS }),
      queryVisits<{ comment: string | null; crm_visit_id: number | null }>({
        ...base,
        columns: "comment, crm_visit_id",
        visitTypes: [UNLABELLED_FIELD_VISIT_TYPE],
      }),
    ]);
    const comments = new Map<number, string | null>();
    for (const row of unlabelled) if (row.crm_visit_id != null) comments.set(row.crm_visit_id, row.comment ?? null);
    return { comments, rows: collapseDuplicateVisitSubmissions(raw) };
  } catch {
    // No visits read is "no data", which the sections then say — never a month nobody worked.
    return { comments: new Map(), rows: [] };
  }
}

async function loadDirectOrders(db: Db, scope: FieldLinkScope, months: readonly string[]): Promise<DirectOrderFact[]> {
  const areas = new Set(scope.areaCodes.map(up).filter(Boolean));
  const lines = new Set(scope.lineNames.map((name) => name.toLowerCase()));
  if (areas.size === 0 || lines.size === 0) return [];
  const inWindow = new Set(months);

  type RequestRow = {
    id: string;
    requester_hr_id: string | null;
    line: string | null;
    sales_value: number | string | null;
    sales_month: string | null;
    pharmacy_id: string | null;
    decided_at: string | null;
  };
  const rows = await fetchAllRows<RequestRow>(
    () =>
      db
        .from("direct_order_requests")
        .select("id, requester_hr_id, line, sales_value, sales_month, pharmacy_id, decided_at")
        .eq("status", "approved")
        .is("reversal_of_request_id", null)
        .is("reversed_by_request_id", null)
        .is("duplicate_of_request_id", null),
    "id",
  );
  // Booked in the window, or approved and not booked yet (it counts in no month until Finance books
  // it — shown, never suggested for a month).
  const wanted = rows.filter(
    (row) =>
      lines.has(text(row.line).toLowerCase()) &&
      (row.sales_month ? inWindow.has(text(row.sales_month).slice(0, 7)) : true),
  );
  const pharmacyIds = [...new Set(wanted.map((row) => text(row.pharmacy_id)).filter(Boolean))];
  const pharmacies = new Map<string, { name: string; doctor: string | null; brickId: string | null; areaCode: string }>();
  for (const part of chunks(pharmacyIds)) {
    const { data, error } = await db
      .from("direct_order_pharmacies")
      .select("id, pharmacy_name, doctor_name, brick_id, area_code")
      .in("id", part);
    if (error) throw error;
    for (const row of (data ?? []) as {
      id: string;
      pharmacy_name: string | null;
      doctor_name: string | null;
      brick_id: string | null;
      area_code: string | null;
    }[]) {
      pharmacies.set(row.id, {
        areaCode: up(row.area_code),
        brickId: text(row.brick_id) || null,
        doctor: text(row.doctor_name) || null,
        name: text(row.pharmacy_name) || "Unnamed pharmacy",
      });
    }
  }
  const requesterNames = await loadNames(db, wanted.map((row) => hrKey(row.requester_hr_id)));

  const out: DirectOrderFact[] = [];
  for (const row of wanted) {
    const pharmacy = pharmacies.get(text(row.pharmacy_id));
    if (!pharmacy || !areas.has(pharmacy.areaCode)) continue;
    const requester = hrKey(row.requester_hr_id);
    out.push({
      areaCode: pharmacy.areaCode,
      brickId: pharmacy.brickId,
      doctorName: pharmacy.doctor,
      line: text(row.line),
      pharmacyName: pharmacy.name,
      requestId: row.id,
      requesterName: requesterNames[requester] ?? "Not recorded",
      salesMonth: row.sales_month ? text(row.sales_month).slice(0, 7) : null,
      value: numOf(row.sales_value),
    });
  }
  out.sort((a, b) => (a.salesMonth ?? "9999").localeCompare(b.salesMonth ?? "9999") || b.value - a.value);
  return out;
}

async function loadMarketingRequests(
  db: Db,
  scope: FieldLinkScope,
  bounds: { from: string; to: string },
): Promise<MarketingRequestFact[]> {
  const areas = new Set(scope.areaCodes.map(up).filter(Boolean));
  const lines = new Set(scope.lineNames.map((name) => name.toLowerCase()));
  type Row = {
    id: string;
    request_code: string | null;
    requester_hr_id: string | null;
    line_id: number | null;
    area_id: number | null;
    customer_id: string | null;
    request_type_id: number | null;
    other_request_type: string | null;
    estimated_cost: number | string | null;
    required_roi_value: number | string | null;
    status: string | null;
    pay_date: string | null;
  };
  const rows = await fetchAllRows<Row>(
    () =>
      db
        .from("marketing_requests")
        .select(
          "id, request_code, requester_hr_id, line_id, area_id, customer_id, request_type_id, other_request_type, " +
            "estimated_cost, required_roi_value, status, pay_date",
        )
        .not("pay_date", "is", null)
        .gte("pay_date", bounds.from)
        .lte("pay_date", bounds.to),
    "id",
  );
  if (rows.length === 0) return [];

  // The four lines and the 143 areas come from the shared one-minute copy, so every pack, board and
  // page that needs them pays at most one round trip between them (src/lib/reference/reference-lists.ts).
  // Both reads ignored their own error here and that posture is kept in the open, at the call site:
  // a pack that cannot name a line shows no field link, exactly as before.
  const [lineRows, areaRows, typeRows] = await Promise.all([
    loadReferenceLines().catch(() => []),
    loadReferenceAreas().catch(() => []),
    db.from("marketing_request_types").select("id, name"),
  ]);
  const lineName = new Map(lineRows.map((r) => [Number(r.id), text(r.name)]));
  const areaCode = new Map(areaRows.map((r) => [Number(r.id), up(r.code)]));
  const typeName = new Map(((typeRows.data ?? []) as { id: number; name: string | null }[]).map((r) => [Number(r.id), text(r.name)]));

  // Every request for the pack's lines in the pack's areas, whoever raised it — a medical rep's pack
  // too ("all on his patch", owner 2026-10-01). An area is shared by every line's reps, so the line
  // must match too — never the area alone (owner, 2026-09-30).
  const kept = rows.filter((row) => {
    const line = lineName.get(Number(row.line_id))?.toLowerCase() ?? "";
    const area = row.area_id != null ? areaCode.get(Number(row.area_id)) ?? "" : "";
    return lines.has(line) && areas.has(area);
  });
  if (kept.length === 0) return [];

  const customerIds = [...new Set(kept.map((row) => text(row.customer_id)).filter(Boolean))];
  const customers = new Map<string, string>();
  for (const part of chunks(customerIds)) {
    const { data } = await db.from("marketing_customers").select("id, display_name").in("id", part);
    for (const row of (data ?? []) as { id: string; display_name: string | null }[]) {
      customers.set(row.id, text(row.display_name) || "Unnamed customer");
    }
  }
  const names = await loadNames(db, kept.map((row) => hrKey(row.requester_hr_id)));

  const buckets = kept.map((row) => {
    const bucket = roiValueBucket(text(row.status) as never);
    return bucket === "approved" ? "committed" : bucket === "pending" ? "pending" : null;
  });
  // The ROI engine's own matching, for the committed ones only — a pending request has no return yet.
  const committedIds = kept.filter((_, i) => buckets[i] === "committed").map((row) => row.id);
  let returns = new Map<string, { value: number }>();
  try {
    const actuals = await loadActuals(db, committedIds, RESTRICTED_PRODUCT_CODES.map((code) => code.toUpperCase()));
    returns = actuals.byRequest;
  } catch {
    // The request still shows; its return reads "not read" rather than a zero it did not earn.
  }

  return kept.map((row, i): MarketingRequestFact => {
    const requester = hrKey(row.requester_hr_id);
    const type = row.request_type_id != null ? typeName.get(Number(row.request_type_id)) ?? "" : "";
    return {
      areaCode: row.area_id != null ? areaCode.get(Number(row.area_id)) ?? null : null,
      bucket: buckets[i],
      code: text(row.request_code),
      cost: numOf(row.estimated_cost),
      customerName: customers.get(text(row.customer_id)) ?? "Unnamed customer",
      line: lineName.get(Number(row.line_id)) ?? null,
      period: text(row.pay_date).slice(0, 7),
      requestId: row.id,
      requesterHrId: requester,
      requesterName: names[requester] ?? "Not recorded",
      requiredReturn: numOf(row.required_roi_value),
      returnSoFar: buckets[i] === "committed" ? returns.get(row.id)?.value ?? 0 : null,
      status: text(row.status),
      typeName: type || text(row.other_request_type) || "Other",
    };
  });
}

/** Awareness statuses, the module's own three buckets. */
const AWARENESS_COMMITTED = new Set(["approved", "executed", "closed"]);
const AWARENESS_PENDING = new Set(["pending_group", "on_hold", "pending_ceo", "returned"]);

async function loadAwareness(
  db: Db,
  scope: FieldLinkScope,
  bounds: { from: string; to: string },
): Promise<AwarenessFact[]> {
  const areas = [...new Set(scope.areaCodes.map(up).filter(Boolean))];
  const lines = new Set(scope.lineNames.map((name) => name.toLowerCase()));
  if (areas.length === 0) return [];
  type Row = {
    id: string;
    title: string | null;
    status: string | null;
    activity_type_id: number | null;
    start_date: string | null;
    estimated_cost: number | string | null;
    amended_cost: number | string | null;
    actual_cost: number | string | null;
    expected_attendees: number | null;
    area_code: string | null;
    primary_line_id: number | null;
    rep_hr_id_at_approval: string | null;
  };
  const rows: Row[] = [];
  for (const part of chunks(areas)) {
    const { data, error } = await db
      .from("market_awareness_activities")
      .select(
        "id, title, status, activity_type_id, start_date, estimated_cost, amended_cost, actual_cost, " +
          "expected_attendees, area_code, primary_line_id, rep_hr_id_at_approval",
      )
      .in("area_code", part)
      // In the period, or still ahead of it: a review names what is already planned for the area.
      .gte("start_date", bounds.from);
    if (error) throw error;
    // The column list is two joined literals, which the client's select parser cannot read — so the
    // rows are named here, once, against the columns the select above asks for.
    rows.push(...((data ?? []) as unknown as Row[]));
  }
  // A draft, a withdrawal or a refusal is nobody's activity.
  const live = rows.filter((row) => AWARENESS_COMMITTED.has(text(row.status)) || AWARENESS_PENDING.has(text(row.status)));
  if (live.length === 0) return [];

  const [lineRows, typeRows, brickRows] = await Promise.all([
    db.from("lines").select("id, name"),
    db.from("market_awareness_activity_types").select("id, name"),
    db.from("market_awareness_activity_bricks").select("activity_id, brick_id").in("activity_id", live.map((row) => row.id)),
  ]);
  const lineName = new Map(((lineRows.data ?? []) as { id: number; name: string | null }[]).map((r) => [Number(r.id), text(r.name)]));
  const typeName = new Map(((typeRows.data ?? []) as { id: number; name: string | null }[]).map((r) => [Number(r.id), text(r.name)]));
  const bricks = new Map<string, string[]>();
  for (const row of (brickRows.data ?? []) as { activity_id: string; brick_id: string | null }[]) {
    const list = bricks.get(row.activity_id) ?? [];
    if (text(row.brick_id)) list.push(text(row.brick_id));
    bricks.set(row.activity_id, list);
  }

  return live
    .filter((row) => {
      const line = row.primary_line_id != null ? lineName.get(Number(row.primary_line_id))?.toLowerCase() : undefined;
      return line == null || lines.has(line);
    })
    .map((row) => {
      const status = text(row.status);
      const cost = row.actual_cost != null ? numOf(row.actual_cost) : row.amended_cost != null ? numOf(row.amended_cost) : numOf(row.estimated_cost);
      return {
        activityId: row.id,
        areaCode: up(row.area_code),
        brickIds: bricks.get(row.id) ?? [],
        bucket: AWARENESS_COMMITTED.has(status) ? "committed" : AWARENESS_PENDING.has(status) ? "pending" : null,
        cost,
        expectedAttendees: row.expected_attendees ?? null,
        line: row.primary_line_id != null ? lineName.get(Number(row.primary_line_id)) ?? null : null,
        repHrId: hrKey(row.rep_hr_id_at_approval) || null,
        startDate: text(row.start_date).slice(0, 10),
        status,
        title: text(row.title) || "Untitled activity",
        typeName: row.activity_type_id != null ? typeName.get(Number(row.activity_type_id)) ?? "Activity" : "Activity",
      } satisfies AwarenessFact;
    })
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}
