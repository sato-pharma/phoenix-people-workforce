/**
 * Phoenix CRM — the visits archive reader (owner, 2026-11-07).
 *
 * The old iReports360 visits that were not carried into Phoenix CRM as visits were retired into
 * `public.phoenix_crm_visit_archive`: a campaign visit (type -8), or a visit that carried no check-in
 * location — and, kept by a database trigger, a converted visit whose check-in lay more than 500 m
 * from the customer's validated place (`far`, with its distance and both points; owner, 7 Nov 2026). This file
 * reads that ONE table for /admin/phoenix-crm/visits-archive — a page of one tab's rows, the totals by tab and
 * by reason for the current filter, and the lists the filters offer. It writes nothing.
 *
 * 🔴 THE ADMIN CRM WORKSPACE'S TWO PEOPLE ONLY — `canUseAdminCrmWorkspace` (Super Admin + SFE Manager),
 * asked by the page AND again here before any read, because the table is the service role's alone (RLS on,
 * no policy) and this file reads it with `getSupabaseAdmin()`. A rep or a field manager never reaches it:
 * it sits under /admin, which they cannot open, and every loader below refuses them by name.
 *
 * 🔴 PAGED BY KEYSET ON (visit_date desc, crm_visit_id desc) — the table's own index — never by offset:
 * the archive holds tens of thousands of rows and an offset walk re-reads every row before the page.
 *
 * 🔴 NAMES, NEVER HR IDS. A rep is printed by his directory name (`loadPeopleNames`), with the vendor's own
 * label as the fallback when the row carries no HR id or the person has no employee record; a person whose
 * employee record says anything but active is marked as having left.
 *
 * The filter lists (months, reps, lines) come from one walk of four narrow columns, remembered for an hour:
 * the archive is written by the conversion and, for far visits, by the trigger as places are validated —
 * never by a person — so a list an hour old is at most missing the newest month or rep.
 */

import { unstable_cache } from "next/cache";

import type { AccessContext } from "@/lib/auth/permissions";
import { canUseAdminCrmWorkspace } from "@/lib/crm/admin-access";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { personKey } from "@/lib/phoenix-crm/scope";
import { chunk, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { loadPeopleNames } from "@/lib/phoenix-crm/server/people";
import {
  VISIT_ARCHIVE_PAGE_SIZE,
  VISIT_ARCHIVE_REASONS,
  VISIT_ARCHIVE_TAB_REASONS,
  VISIT_ARCHIVE_TABS,
  visitArchiveMonthBounds,
  visitArchiveMonthOf,
  visitArchivePersonLeft,
  type VisitArchiveCursor,
  type VisitArchiveFilter,
  type VisitArchiveReason,
  type VisitArchiveTab,
} from "@/lib/phoenix-crm/visit-archive-rules";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { quotePostgrestValue } from "@/lib/supabase/search-filter";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const ARCHIVE_TABLE = "phoenix_crm_visit_archive";

/**
 * The PostgREST `or` filter for the rows AFTER the cursor in (visit_date desc, crm_visit_id desc) order: an
 * earlier day, or the same day with a smaller id. The cursor is decoded (digits and dashes only), and both
 * parts still go through the shared quoting helper.
 */
function visitArchiveKeysetFilter(cursor: VisitArchiveCursor): string {
  const day = quotePostgrestValue(cursor.visitDate);
  const id = quotePostgrestValue(cursor.crmVisitId);
  return `visit_date.lt.${day},and(visit_date.eq.${day},crm_visit_id.lt.${id})`;
}
const LIST_COLUMNS =
  "crm_visit_id, visit_date, agent_hr_id, agent_name, customer_name, reason, visit_id, line_code, distance_meters, checkin_lat, checkin_lon, place_lat, place_lon";
const OPTION_COLUMNS = "crm_visit_id, visit_date, agent_hr_id, agent_name, line_code";
/** The most rows the filter-list walk reads. Far above the archive's size; past it the lists say so. */
const OPTION_WALK_MAX_ROWS = 400_000;
/** Rows per request on that walk — a handful of requests, and still correct under a lower server ceiling. */
const OPTION_WALK_PAGE = 10_000;

export class VisitArchiveRefused extends Error {
  constructor() {
    super("The visits archive is the Super Admin's and the SFE Manager's.");
    this.name = "VisitArchiveRefused";
  }
}

/** The gate, asked by every loader here as well as by the page. */
export function canReadVisitArchive(access: Pick<AccessContext, "role" | "scope">): boolean {
  return canUseAdminCrmWorkspace(access);
}

function assertReader(access: Pick<AccessContext, "role" | "scope">): void {
  if (!canReadVisitArchive(access)) throw new VisitArchiveRefused();
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pointOf(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
  const latitude = numberOrNull(lat);
  const longitude = numberOrNull(lon);
  return latitude === null || longitude === null ? null : { lat: latitude, lon: longitude };
}

// ── Who is who ───────────────────────────────────────────────────────────────────────────────────

type PersonFacts = { name: string; left: boolean };

/** Employment status by person key; a person with no employee record is simply absent. */
async function loadEmploymentStatus(keys: readonly string[]): Promise<Map<string, string | null>> {
  const statuses = new Map<string, string | null>();
  if (keys.length === 0) return statuses;
  const lookup = [...new Set(keys.flatMap((key) => hrIdLookupKeys(key)))];
  const supabase = getSupabaseAdmin();
  const batches = await mapWithConcurrency(chunk(lookup, 200), 4, async (part) => {
    const { data, error } = await supabase.from("employees").select("hr_id, employment_status").in("hr_id", part);
    throwIfError(error);
    return (data ?? []) as Array<Record<string, unknown>>;
  });
  for (const row of batches.flat()) {
    const key = personKey(text(row.hr_id));
    if (key && !statuses.has(key)) statuses.set(key, text(row.employment_status));
  }
  return statuses;
}

async function loadPeople(hrIds: Iterable<string | null>): Promise<Map<string, PersonFacts>> {
  const keys = [...new Set([...hrIds].map((hrId) => personKey(hrId)).filter((key): key is string => key !== null))];
  const people = new Map<string, PersonFacts>();
  if (keys.length === 0) return people;
  const [names, statuses] = await Promise.all([loadPeopleNames(keys), loadEmploymentStatus(keys)]);
  for (const key of keys) {
    const name = names.get(key);
    if (!name) continue;
    people.set(key, { name, left: statuses.has(key) ? visitArchivePersonLeft(statuses.get(key)) : false });
  }
  return people;
}

// ── The filter lists ───────────────────────────────────────────────────────────────────────────────

export type VisitArchiveRepOption = { hrId: string; name: string; left: boolean };
export type VisitArchiveLineOption = { code: string; name: string };

export type VisitArchiveOptions = {
  months: string[];
  reps: VisitArchiveRepOption[];
  lines: VisitArchiveLineOption[];
  /** Rows the archive holds with no HR id — their rep can be read on the rows, never picked in the list. */
  rowsWithoutHrId: number;
  /** True when the walk stopped at its ceiling, so a list may be missing an entry. */
  capped: boolean;
};

type OptionRow = { crm_visit_id: unknown; visit_date: unknown; agent_hr_id: unknown; agent_name: unknown; line_code: unknown };

async function readOptions(): Promise<VisitArchiveOptions> {
  const read = await readEveryPage<OptionRow>(
    () => getSupabaseAdmin().from(ARCHIVE_TABLE).select(OPTION_COLUMNS).order("crm_visit_id", { ascending: true }),
    {
      maxRows: OPTION_WALK_MAX_ROWS,
      whenFull: "stop",
      what: "The visits archive's filter lists",
      uniqueBy: (row) => String(row.crm_visit_id),
      pageSize: OPTION_WALK_PAGE,
    },
  );
  // A failed walk throws, so the hour-long cache never keeps an empty answer.
  throwIfError(read.error);

  const months = new Set<string>();
  const repKeys = new Set<string>();
  const lineCodes = new Set<string>();
  let rowsWithoutHrId = 0;
  for (const row of read.rows) {
    const month = visitArchiveMonthOf(String(row.visit_date ?? ""));
    if (month) months.add(month);
    const key = personKey(text(row.agent_hr_id));
    if (key) repKeys.add(key);
    else rowsWithoutHrId += 1;
    const line = text(row.line_code);
    if (line) lineCodes.add(line);
  }

  const [people, org] = await Promise.all([loadPeople(repKeys), loadPhoenixCrmOrg().catch(() => null)]);
  const lineNames = new Map<string, string>();
  for (const seat of org?.seats.values() ?? []) {
    if (seat.lineCode && seat.lineName && !lineNames.has(seat.lineCode)) lineNames.set(seat.lineCode, seat.lineName);
  }

  // A rep with no employee record has no name to pick him by, and his HR id is never printed — his rows
  // still list under the vendor's label.
  const reps = [...repKeys]
    .map((hrId) => {
      const person = people.get(hrId);
      return person ? { hrId, name: person.name, left: person.left } : null;
    })
    .filter((rep): rep is VisitArchiveRepOption => rep !== null)
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    months: [...months].sort().reverse(),
    reps,
    lines: [...lineCodes].map((code) => ({ code, name: lineNames.get(code) ?? code })).sort((left, right) => left.name.localeCompare(right.name)),
    rowsWithoutHrId,
    capped: read.capped,
  };
}

const cachedOptions = unstable_cache(readOptions, ["phoenix-crm-visit-archive-options-v1"], { revalidate: 3600 });

export async function loadVisitArchiveOptions(access: Pick<AccessContext, "role" | "scope">): Promise<VisitArchiveOptions> {
  assertReader(access);
  return cachedOptions();
}

// ── The page and the totals ────────────────────────────────────────────────────────────────────────

export type VisitArchiveRow = {
  crmVisitId: string;
  visitDate: string;
  repName: string;
  repLeft: boolean;
  customerName: string | null;
  reason: string;
  copiedIntoPhoenix: boolean;
  lineName: string | null;
  /** A far visit only: metres from the check-in to the validated place, and the two points. */
  distanceMeters: number | null;
  checkin: { lat: number; lon: number } | null;
  place: { lat: number; lon: number } | null;
};

export type VisitArchivePage = {
  rows: VisitArchiveRow[];
  /** The cursor for the next page, or null on the last one. */
  next: VisitArchiveCursor | null;
};

export type VisitArchiveTotals = {
  /** Rows in each tab for the month, rep and line chosen (the reason is not applied: it belongs to one tab). */
  byTab: Record<VisitArchiveTab, number>;
  /** Rows in the open tab for the whole filter. */
  total: number;
  byReason: Record<VisitArchiveReason, number>;
  copiedIntoPhoenix: number;
};

/**
 * The filter applied to a fresh query. Typed loosely on purpose: the PostgREST builder's generics change
 * shape with every select, and the filter methods are all this needs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilter(query: any, filter: Omit<VisitArchiveFilter, "cursor">, options: { reason: boolean; tab: boolean }): any {
  let next = query;
  // The open tab's reasons, always: a far row never lists under the first tab, nor a campaign row under far.
  if (options.tab) next = next.in("reason", [...VISIT_ARCHIVE_TAB_REASONS[filter.tab]]);
  const bounds = filter.month ? visitArchiveMonthBounds(filter.month) : null;
  if (bounds) next = next.gte("visit_date", bounds.from).lt("visit_date", bounds.before);
  if (filter.rep) next = next.in("agent_hr_id", hrIdLookupKeys(filter.rep));
  if (filter.line) next = next.eq("line_code", filter.line);
  if (options.reason && filter.reason) next = next.eq("reason", filter.reason);
  return next;
}

export async function loadVisitArchivePage(
  access: Pick<AccessContext, "role" | "scope">,
  filter: VisitArchiveFilter,
  lineNames: ReadonlyMap<string, string> = new Map(),
): Promise<VisitArchivePage> {
  assertReader(access);
  let query = applyFilter(getSupabaseAdmin().from(ARCHIVE_TABLE).select(LIST_COLUMNS), filter, { reason: true, tab: true });
  if (filter.cursor) query = query.or(visitArchiveKeysetFilter(filter.cursor));
  // One row past the page answers "is there another page?" without counting anything.
  const { data, error } = await query
    .order("visit_date", { ascending: false })
    .order("crm_visit_id", { ascending: false })
    .limit(VISIT_ARCHIVE_PAGE_SIZE + 1);
  throwIfError(error);

  const raw = (data ?? []) as Array<Record<string, unknown>>;
  const shown = raw.slice(0, VISIT_ARCHIVE_PAGE_SIZE);
  const people = await loadPeople(shown.map((row) => text(row.agent_hr_id)));

  const rows: VisitArchiveRow[] = shown.map((row) => {
    const key = personKey(text(row.agent_hr_id));
    const person = key ? people.get(key) : undefined;
    const lineCode = text(row.line_code);
    return {
      crmVisitId: String(row.crm_visit_id),
      visitDate: String(row.visit_date ?? ""),
      // The directory name first; the vendor's own label when there is no HR id or no employee record.
      repName: person?.name ?? text(row.agent_name) ?? "Rep not named",
      repLeft: person?.left ?? false,
      customerName: text(row.customer_name),
      reason: String(row.reason ?? ""),
      copiedIntoPhoenix: text(row.visit_id) !== null,
      lineName: lineCode ? (lineNames.get(lineCode) ?? lineCode) : null,
      distanceMeters: numberOrNull(row.distance_meters),
      checkin: pointOf(row.checkin_lat, row.checkin_lon),
      place: pointOf(row.place_lat, row.place_lon),
    };
  });

  const last = rows.at(-1);
  return {
    rows,
    next: raw.length > VISIT_ARCHIVE_PAGE_SIZE && last ? { visitDate: last.visitDate, crmVisitId: last.crmVisitId } : null,
  };
}

async function countWhere(
  filter: Omit<VisitArchiveFilter, "cursor">,
  extra: { reason?: VisitArchiveReason; copied?: boolean; tab?: VisitArchiveTab },
): Promise<number> {
  // Another tab's total is counted with that tab and without the open tab's reason choice.
  const scoped = extra.tab ? { ...filter, tab: extra.tab, reason: null } : filter;
  let query = applyFilter(getSupabaseAdmin().from(ARCHIVE_TABLE).select("crm_visit_id", { count: "exact", head: true }), scoped, {
    reason: true,
    tab: true,
  });
  if (extra.reason) query = query.eq("reason", extra.reason);
  if (extra.copied) query = query.not("visit_id", "is", null);
  const { count, error } = await query;
  throwIfError(error);
  return count ?? 0;
}

/** The totals for the current filter: every row it matches, each reason, and how many were copied into Phoenix. */
export async function loadVisitArchiveTotals(
  access: Pick<AccessContext, "role" | "scope">,
  filter: VisitArchiveFilter,
): Promise<VisitArchiveTotals> {
  assertReader(access);
  const [total, copiedIntoPhoenix, tabCounts, reasonCounts] = await Promise.all([
    countWhere(filter, {}),
    countWhere(filter, { copied: true }),
    Promise.all(VISIT_ARCHIVE_TABS.map((tab) => countWhere(filter, { tab }))),
    Promise.all(
      VISIT_ARCHIVE_REASONS.map((reason) =>
        // A reason outside the open tab, or one the filter already excludes, is zero without asking.
        !VISIT_ARCHIVE_TAB_REASONS[filter.tab].includes(reason) || (filter.reason && filter.reason !== reason)
          ? Promise.resolve(0)
          : countWhere(filter, { reason }),
      ),
    ),
  ]);
  const byTab = Object.fromEntries(VISIT_ARCHIVE_TABS.map((tab, index) => [tab, tabCounts[index] ?? 0])) as Record<VisitArchiveTab, number>;
  const byReason = Object.fromEntries(VISIT_ARCHIVE_REASONS.map((reason, index) => [reason, reasonCounts[index] ?? 0])) as Record<VisitArchiveReason, number>;
  return { byTab, total, byReason, copiedIntoPhoenix };
}
