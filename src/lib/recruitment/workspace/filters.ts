// Recruitment workspace — every filter, as the URL holds it and as the database filter receives it.
//
// The owner, 20 Oct 2026: filters for "all possible varieties", combinable (AND); a received-date
// range that is "100%" free — any from, any to, an optional time — beside quick picks; one search box;
// and filters that "start clean on every visit" (so nothing here is remembered in the browser: the
// URL is the only state, and a visit to /recruitment with no query is clean).
//
// Pure and runtime-neutral (no process.env, no database): the page, the client and the API routes all
// parse the same way. Days and times are CAIRO wall-clock, converted to UTC instants here.

import {
  NEEDS_PLACING,
  isWorkspaceTabKey,
  type WorkspaceTabKey,
  type WorkspaceViewer,
  allowedTabsForViewer,
} from "@/lib/recruitment/workspace/role-tabs";
import { DEFAULT_CANDIDATE_STATUS, candidateStatuses } from "@/lib/recruitment/candidate-status";
import { isUuid } from "@/lib/http/uuid";
import {
  OVERDUE_SENT_DAYS,
  OVERDUE_SHORTLIST_DAYS,
  candidateSources,
  isCallResult,
  type CallResult,
  type CandidateSourceKey,
} from "@/lib/recruitment/workspace/vocabulary";

export const CAIRO_TIME_ZONE = "Africa/Cairo";
/** The value an answer filter uses for "the applicant never answered this". */
export const MISSING_ANSWER = "__missing__";

export const quickDatePicks = ["today", "yesterday", "last_7", "last_30", "this_month"] as const;
export type QuickDatePick = (typeof quickDatePicks)[number];
export const quickDatePickLabels: Record<QuickDatePick, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7: "Last 7 days",
  last_30: "Last 30 days",
  this_month: "This month",
};

export type ArchivedMode = "exclude" | "only" | "include";

export type WorkspaceFilters = {
  /** Null = the viewer's first tab. */
  tab: WorkspaceTabKey | null;
  /** A recruitment region code, or "unspecified". */
  region: string | null;
  /** An AU area code (Medical Rep only). */
  area: string | null;
  statuses: string[];
  sources: CandidateSourceKey[];
  datePick: QuickDatePick | null;
  /** YYYY-MM-DD, Cairo. Ignored while a quick pick is set. */
  fromDate: string | null;
  /** HH:MM, Cairo. Optional; without it the day starts at 00:00. */
  fromTime: string | null;
  toDate: string | null;
  /** HH:MM, Cairo, inclusive of that minute. Optional; without it the whole day counts. */
  toTime: string | null;
  /** Answer key -> accepted stored values; MISSING_ANSWER matches an unanswered key. */
  answers: Record<string, string[]>;
  missing: boolean | null;
  callResults: CallResult[];
  returned: boolean | null;
  overdue: boolean | null;
  folderIds: string[];
  archived: ArchivedMode;
  search: string;
  /** The opened CV. Not a filter — kept here so the URL round-trips in one place. */
  candidate: string | null;
};

export function emptyWorkspaceFilters(): WorkspaceFilters {
  return {
    tab: null,
    region: null,
    area: null,
    statuses: [],
    sources: [],
    datePick: null,
    fromDate: null,
    fromTime: null,
    toDate: null,
    toTime: null,
    answers: {},
    missing: null,
    callResults: [],
    returned: null,
    overdue: null,
    folderIds: [],
    archived: "exclude",
    search: "",
    candidate: null,
  };
}

// ---------------------------------------------------------------------------------------------
// URL <-> filters
// ---------------------------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CODE_RE = /^[A-Za-z0-9_\-]{1,64}$/;
const ANSWER_PREFIX = "a.";
const LIST_SEP = ",";
const VALUE_SEP = "|";

type ParamsLike = { get(name: string): string | null; forEach?: (cb: (value: string, key: string) => void) => void } | URLSearchParams;

function list(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(LIST_SEP).map((part) => part.trim()).filter(Boolean);
}

function bool(raw: string | null): boolean | null {
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return null;
}

function validDate(raw: string | null): string | null {
  if (!raw || !DATE_RE.test(raw)) return null;
  const [y, m, d] = raw.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d ? raw : null;
}

function entries(params: ParamsLike): [string, string][] {
  const out: [string, string][] = [];
  if (typeof (params as URLSearchParams).forEach === "function") {
    (params as URLSearchParams).forEach((value, key) => out.push([key, value]));
  }
  return out;
}

/** Reads every filter from a URL query. Anything malformed is dropped, never guessed. */
export function parseWorkspaceFilters(params: ParamsLike): WorkspaceFilters {
  const filters = emptyWorkspaceFilters();
  const tab = params.get("tab");
  filters.tab = isWorkspaceTabKey(tab) ? tab : null;
  const region = params.get("region");
  filters.region = region && (region === "unspecified" || CODE_RE.test(region)) ? region : null;
  const area = params.get("area");
  filters.area = area && CODE_RE.test(area) ? area : null;
  filters.statuses = list(params.get("status")).filter((s) => (candidateStatuses as readonly string[]).includes(s));
  filters.sources = list(params.get("source")).filter((s): s is CandidateSourceKey =>
    (candidateSources as readonly string[]).includes(s),
  );
  const pick = params.get("date");
  filters.datePick = pick && (quickDatePicks as readonly string[]).includes(pick) ? (pick as QuickDatePick) : null;
  filters.fromDate = validDate(params.get("from"));
  filters.toDate = validDate(params.get("to"));
  const fromTime = params.get("fromTime");
  filters.fromTime = fromTime && TIME_RE.test(fromTime) && filters.fromDate ? fromTime : null;
  const toTime = params.get("toTime");
  filters.toTime = toTime && TIME_RE.test(toTime) && filters.toDate ? toTime : null;
  for (const [key, value] of entries(params)) {
    if (!key.startsWith(ANSWER_PREFIX)) continue;
    const answerKey = key.slice(ANSWER_PREFIX.length);
    if (!CODE_RE.test(answerKey)) continue;
    const values = value.split(VALUE_SEP).map((v) => v.trim()).filter(Boolean).slice(0, 50);
    if (values.length) filters.answers[answerKey] = values;
  }
  filters.missing = bool(params.get("missing"));
  filters.callResults = list(params.get("call")).filter(isCallResult);
  filters.returned = bool(params.get("returned"));
  filters.overdue = bool(params.get("overdue"));
  filters.folderIds = list(params.get("folder")).filter((id) => isUuid(id));
  const archived = params.get("archived");
  filters.archived = archived === "only" || archived === "include" ? archived : "exclude";
  filters.search = String(params.get("q") ?? "").trim().slice(0, 120);
  const candidate = params.get("candidate");
  filters.candidate = candidate && isUuid(candidate) ? candidate : null;
  return filters;
}

/** The URL query for these filters — only what differs from clean, so a clean visit has no query. */
export function serializeWorkspaceFilters(filters: WorkspaceFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.tab) params.set("tab", filters.tab);
  if (filters.region) params.set("region", filters.region);
  if (filters.area) params.set("area", filters.area);
  if (filters.statuses.length) params.set("status", filters.statuses.join(LIST_SEP));
  if (filters.sources.length) params.set("source", filters.sources.join(LIST_SEP));
  if (filters.datePick) params.set("date", filters.datePick);
  else {
    if (filters.fromDate) params.set("from", filters.fromDate);
    if (filters.fromDate && filters.fromTime) params.set("fromTime", filters.fromTime);
    if (filters.toDate) params.set("to", filters.toDate);
    if (filters.toDate && filters.toTime) params.set("toTime", filters.toTime);
  }
  for (const key of Object.keys(filters.answers).sort()) {
    const values = filters.answers[key];
    if (values?.length) params.set(`${ANSWER_PREFIX}${key}`, values.join(VALUE_SEP));
  }
  if (filters.missing !== null) params.set("missing", filters.missing ? "1" : "0");
  if (filters.callResults.length) params.set("call", filters.callResults.join(LIST_SEP));
  if (filters.returned !== null) params.set("returned", filters.returned ? "1" : "0");
  if (filters.overdue !== null) params.set("overdue", filters.overdue ? "1" : "0");
  if (filters.folderIds.length) params.set("folder", filters.folderIds.join(LIST_SEP));
  if (filters.archived !== "exclude") params.set("archived", filters.archived);
  if (filters.search) params.set("q", filters.search);
  if (filters.candidate) params.set("candidate", filters.candidate);
  return params;
}

// ---------------------------------------------------------------------------------------------
// The decided toggle — All · Not decided · Decided (owner, 20 Oct 2026: "add a toggle in the screen
// to filter by decided and all not decided")
// ---------------------------------------------------------------------------------------------
//
// Not a new filter: it is the status filter, set in one press. "Not decided" is New — nobody has
// moved the CV yet — and "Decided" is every other status (Shortlisted, Back-up, Sent to manager,
// Rejected, Hired). The status column is NOT NULL and every stored value is on the fixed list
// (read 20 Oct 2026), so the two halves cover every CV with nothing left between them. All is the
// clean default, because the filters start clean on every visit.

export const decisionModes = ["all", "undecided", "decided"] as const;
export type DecisionMode = (typeof decisionModes)[number];
export const decisionModeLabels: Record<DecisionMode, string> = {
  all: "All",
  undecided: "Not decided",
  decided: "Decided",
};

export const UNDECIDED_STATUSES: readonly string[] = [DEFAULT_CANDIDATE_STATUS];
export const DECIDED_STATUSES: readonly string[] = candidateStatuses.filter((status) => status !== DEFAULT_CANDIDATE_STATUS);

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && b.every((item) => a.includes(item));
}

/** Which press the status filter matches — null when the statuses were ticked one by one into some other set. */
export function decisionModeOf(statuses: readonly string[]): DecisionMode | null {
  if (statuses.length === 0) return "all";
  if (sameSet(statuses, UNDECIDED_STATUSES)) return "undecided";
  if (sameSet(statuses, DECIDED_STATUSES)) return "decided";
  return null;
}

export function statusesForDecisionMode(mode: DecisionMode): string[] {
  return mode === "undecided" ? [...UNDECIDED_STATUSES] : mode === "decided" ? [...DECIDED_STATUSES] : [];
}

/** The number beside each press, from the by-status counts (which ignore the status filter, so they hold still while he switches). */
export function decisionModeCount(mode: DecisionMode, byStatus: Partial<Record<string, number>> | undefined): number | null {
  if (!byStatus) return null;
  const keys = mode === "all" ? Object.keys(byStatus) : mode === "undecided" ? UNDECIDED_STATUSES : DECIDED_STATUSES;
  return keys.reduce((sum, key) => sum + (byStatus[key] ?? 0), 0);
}

/** How many filters beyond tab/place/candidate are set — the "Clear filters (3)" count. */
export function activeFilterCount(filters: WorkspaceFilters): number {
  let n = 0;
  if (filters.statuses.length) n += 1;
  if (filters.sources.length) n += 1;
  if (filters.datePick || filters.fromDate || filters.toDate) n += 1;
  n += Object.values(filters.answers).filter((v) => v.length).length;
  if (filters.missing !== null) n += 1;
  if (filters.callResults.length) n += 1;
  if (filters.returned !== null) n += 1;
  if (filters.overdue !== null) n += 1;
  if (filters.folderIds.length) n += 1;
  if (filters.archived !== "exclude") n += 1;
  if (filters.search) n += 1;
  return n;
}

// ---------------------------------------------------------------------------------------------
// Cairo wall-clock -> UTC instants
// ---------------------------------------------------------------------------------------------

function cairoParts(instant: Date): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CAIRO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { y: value("year"), m: value("month"), d: value("day"), h: value("hour"), mi: value("minute"), s: value("second") };
}

/** The UTC instant of a Cairo wall-clock time. DST-safe: reads Cairo's real offset at that moment. */
export function cairoWallClockToUtc(dateIso: string, time = "00:00", dayOffset = 0): Date {
  const [y, m, d] = dateIso.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d + dayOffset, h, mi, 0);
  const seen = cairoParts(new Date(guess));
  const asIfUtc = Date.UTC(seen.y, seen.m - 1, seen.d, seen.h, seen.mi, seen.s);
  const first = guess - (asIfUtc - guess);
  // Second pass: an offset change between the guess and the answer (a DST night) settles here.
  const seen2 = cairoParts(new Date(first));
  const asIfUtc2 = Date.UTC(seen2.y, seen2.m - 1, seen2.d, seen2.h, seen2.mi, seen2.s);
  return new Date(first - (asIfUtc2 - guess));
}

/** Today's date in Cairo, YYYY-MM-DD. */
export function cairoToday(now: Date = new Date()): string {
  const p = cairoParts(now);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

function addDays(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

/** The [from, to) instants a filter's received date covers, or nulls for "any time". */
export function receivedRange(filters: Pick<WorkspaceFilters, "datePick" | "fromDate" | "fromTime" | "toDate" | "toTime">, now: Date = new Date()): {
  from: string | null;
  to: string | null;
} {
  const today = cairoToday(now);
  switch (filters.datePick) {
    case "today":
      return { from: cairoWallClockToUtc(today).toISOString(), to: cairoWallClockToUtc(today, "00:00", 1).toISOString() };
    case "yesterday":
      return { from: cairoWallClockToUtc(today, "00:00", -1).toISOString(), to: cairoWallClockToUtc(today).toISOString() };
    case "last_7":
      return { from: cairoWallClockToUtc(today, "00:00", -6).toISOString(), to: cairoWallClockToUtc(today, "00:00", 1).toISOString() };
    case "last_30":
      return { from: cairoWallClockToUtc(today, "00:00", -29).toISOString(), to: cairoWallClockToUtc(today, "00:00", 1).toISOString() };
    case "this_month":
      return {
        from: cairoWallClockToUtc(`${today.slice(0, 8)}01`).toISOString(),
        to: cairoWallClockToUtc(today, "00:00", 1).toISOString(),
      };
    default:
      break;
  }
  const from = filters.fromDate ? cairoWallClockToUtc(filters.fromDate, filters.fromTime ?? "00:00").toISOString() : null;
  let to: string | null = null;
  if (filters.toDate) {
    if (filters.toTime) {
      // Inclusive of the minute named: "to 17:30" keeps a CV received at 17:30:59.
      to = new Date(cairoWallClockToUtc(filters.toDate, filters.toTime).getTime() + 60_000).toISOString();
    } else {
      to = cairoWallClockToUtc(addDays(filters.toDate, 1)).toISOString();
    }
  }
  return { from, to };
}

/** A range whose end is not after its start can return nothing — the screen says so instead of an empty table. */
export function receivedRangeProblem(filters: WorkspaceFilters, now: Date = new Date()): string | null {
  const { from, to } = receivedRange(filters, now);
  if (from && to && from >= to) return "The “to” date is before the “from” date.";
  return null;
}

// ---------------------------------------------------------------------------------------------
// filters -> the database filter's p
// ---------------------------------------------------------------------------------------------

export type WorkspaceDbParams = Record<string, unknown>;

/**
 * The jsonb `p` for ats_workspace_filter / _page / _counts. The viewer's allowed tabs and the
 * Talent Acquisition fence come from the SESSION (`viewer`), never from the request — a tab the
 * viewer may not see is simply not in `allowed_tabs`, and the filter returns nothing for it.
 */
export function workspaceDbParams(
  filters: WorkspaceFilters,
  viewer: WorkspaceViewer,
  options: { searchIds?: string[] | null; candidateIds?: string[] | null; folderIdsExpanded?: string[] | null; now?: Date; scope?: "tab" | "all" } = {},
): WorkspaceDbParams {
  const allowed = allowedTabsForViewer(viewer);
  const { from, to } = receivedRange(filters, options.now);
  const p: WorkspaceDbParams = {
    allowed_tabs: allowed,
    hide_hr_people: viewer.hidesHrPeople,
    overdue_shortlist_days: OVERDUE_SHORTLIST_DAYS,
    overdue_sent_days: OVERDUE_SENT_DAYS,
    archived: filters.archived,
  };
  // A search with no tab chosen looks across every tab the viewer can see (owner: "one search box
  // for everything"); otherwise the tab narrows, and a tab outside `allowed` returns nothing.
  const tab = options.scope === "all" ? null : filters.tab ?? allowed[0] ?? NEEDS_PLACING;
  if (tab && tab !== "folders") {
    p.tab = tab;
    if (filters.region) p.region = filters.region;
    if (filters.area) p.area = filters.area;
  }
  if (filters.statuses.length) p.statuses = filters.statuses;
  if (filters.sources.length) p.sources = filters.sources;
  if (from) p.from = from;
  if (to) p.to = to;
  const answers = Object.fromEntries(Object.entries(filters.answers).filter(([, values]) => values.length));
  if (Object.keys(answers).length) p.answers = answers;
  if (filters.missing !== null) p.missing = filters.missing;
  if (filters.callResults.length) p.call_results = filters.callResults;
  if (filters.returned !== null) p.returned = filters.returned;
  if (filters.overdue !== null) p.overdue = filters.overdue;
  const folderIds = options.folderIdsExpanded ?? filters.folderIds;
  if (folderIds.length) p.folder_ids = folderIds;
  if (filters.search) p.search = filters.search;
  if (options.searchIds?.length) p.search_ids = options.searchIds;
  if (options.candidateIds) p.candidate_ids = options.candidateIds;
  return p;
}
