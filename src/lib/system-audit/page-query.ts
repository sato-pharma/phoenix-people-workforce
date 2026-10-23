/**
 * System Error & Data Integrity Audit — the query string, parsed and refused in ONE place.
 *
 * The page (`/admin/system-audit`), its JSON route (`/api/admin/system-audit`) and the export route
 * (`/api/admin/system-audit/export`) all read the same filters, so an export can never carry a
 * different set of rows than the screen it was started from. Pure: no database, no request object,
 * so it is tested without a server.
 *
 * A value this does not recognise is REFUSED (400, a plain sentence), never dropped: a dropped
 * filter widens the result, and a widened result reads as "these are the errors you asked for".
 * Unknown PARAMETER NAMES are ignored on purpose — the page URL also carries `tab`, and the export
 * carries `format`.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";
import {
  ROOT_CAUSE_LEVELS,
  SYSTEM_AUDIT_FAMILIES,
  SYSTEM_AUDIT_SORTS,
  SYSTEM_AUDIT_STATUSES,
  type RootCauseLevel,
  type SharedScope,
  type SystemAuditFamily,
  type SystemAuditFilters,
  type SystemAuditSort,
  type SystemAuditStatus,
} from "@/lib/system-audit/types";

/** Rows per screen page. The export never pages by this — it reads every filtered row. */
export const SYSTEM_AUDIT_PAGE_SIZE = 50;
/** `system_audit_page` refuses to skip further than this; the screen says so instead of stopping. */
export const SYSTEM_AUDIT_SCREEN_ROW_CAP = 10_000;
/** The furthest a screen page may start and still be a whole page inside the cap. */
export const SYSTEM_AUDIT_MAX_OFFSET = SYSTEM_AUDIT_SCREEN_ROW_CAP - SYSTEM_AUDIT_PAGE_SIZE;
export const SYSTEM_AUDIT_ARRAY_CAP = 200;
export const SYSTEM_AUDIT_SEARCH_MAX = 200;
const MODULE_LABEL_MAX = 200;
const HR_KEY_MAX = 64;

export const SYSTEM_AUDIT_SCOPES = ["only", "shared", "system"] as const satisfies readonly SharedScope[];

/** The URL parameter names, one per filter. Arrays repeat the name (`module=A&module=B`). */
export const SYSTEM_AUDIT_PARAM = {
  from: "from",
  to: "to",
  hrKey: "hrKey",
  module: "module",
  status: "status",
  why: "why",
  family: "family",
  scope: "scope",
  search: "q",
  includeSilent: "silent",
  includeTest: "test",
  sort: "sort",
  offset: "offset",
} as const;

export type SystemAuditQuery = {
  filters: SystemAuditFilters & { includeSilent: boolean; includeTest: boolean };
  sort: SystemAuditSort;
  offset: number;
  limit: number;
};

/** A refusal the route turns into a 400 with this sentence. */
export class SystemAuditQueryError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "SystemAuditQueryError";
  }
}

export function isSystemAuditQueryError(error: unknown): error is SystemAuditQueryError {
  return error instanceof SystemAuditQueryError;
}

export type QueryInput = URLSearchParams | Record<string, string | string[] | undefined | null>;

function readAll(input: QueryInput, name: string): string[] {
  if (input instanceof URLSearchParams) return input.getAll(name);
  const value = input[name];
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function readOne(input: QueryInput, name: string, label: string): string | null {
  const values = readAll(input, name).map((value) => value.trim()).filter((value) => value !== "");
  if (values.length === 0) return null;
  const distinct = Array.from(new Set(values));
  if (distinct.length > 1) {
    throw new SystemAuditQueryError(`${label} was given more than once with different values.`);
  }
  return distinct[0];
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day as YYYY-MM-DD, or a refusal. `2026-02-30` is refused, never rolled over. */
export function parseCairoDate(value: string, label: string): string {
  const match = ISO_DATE.exec(value);
  if (!match) throw new SystemAuditQueryError(`${label} must be a date written as YYYY-MM-DD.`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new SystemAuditQueryError(`${label} ${value} is not a real calendar day.`);
  }
  if (year < 2020 || year > 2100) throw new SystemAuditQueryError(`${label} ${value} is outside the years this ledger can hold.`);
  return value;
}

function readList<T extends string>(
  input: QueryInput,
  name: string,
  label: string,
  allowed: readonly T[] | null,
  normalise: (value: string) => string = (value) => value,
  maxLength = MODULE_LABEL_MAX,
): T[] {
  const raw = readAll(input, name)
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const out: T[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (value.length > maxLength) {
      throw new SystemAuditQueryError(`A ${label} value is longer than ${maxLength} characters.`);
    }
    const normalised = normalise(value);
    if (allowed && !(allowed as readonly string[]).includes(normalised)) {
      throw new SystemAuditQueryError(`"${value}" is not a known ${label}.`);
    }
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    out.push(normalised as T);
  }
  if (out.length > SYSTEM_AUDIT_ARRAY_CAP) {
    throw new SystemAuditQueryError(
      `${out.length} ${label} values were chosen; at most ${SYSTEM_AUDIT_ARRAY_CAP} can be applied at once. Narrow the choice.`,
    );
  }
  return out;
}

function readFlag(input: QueryInput, name: string, label: string, fallback: boolean): boolean {
  const value = readOne(input, name, label);
  if (value === null) return fallback;
  const lowered = value.toLowerCase();
  if (lowered === "1" || lowered === "true" || lowered === "yes") return true;
  if (lowered === "0" || lowered === "false" || lowered === "no") return false;
  throw new SystemAuditQueryError(`${label} must be 1 or 0, not "${value}".`);
}

function readOffset(input: QueryInput): number {
  const value = readOne(input, SYSTEM_AUDIT_PARAM.offset, "The page position");
  if (value === null) return 0;
  if (!/^\d{1,7}$/.test(value)) throw new SystemAuditQueryError(`The page position must be a whole number, not "${value}".`);
  const offset = Number(value);
  if (offset > SYSTEM_AUDIT_MAX_OFFSET) {
    throw new SystemAuditQueryError(
      `Only the first ${SYSTEM_AUDIT_SCREEN_ROW_CAP.toLocaleString("en-US")} incidents can be paged on screen. Narrow the filters, or export them — the export carries every row.`,
    );
  }
  return offset;
}

/**
 * Parse and validate. Throws `SystemAuditQueryError` (a 400) on any value it does not recognise.
 * Defaults: every date, silent data findings included, test accounts excluded, newest first.
 */
export function parseSystemAuditQuery(input: QueryInput): SystemAuditQuery {
  const fromRaw = readOne(input, SYSTEM_AUDIT_PARAM.from, "The start date");
  const toRaw = readOne(input, SYSTEM_AUDIT_PARAM.to, "The end date");
  const from = fromRaw ? parseCairoDate(fromRaw, "The start date") : null;
  const to = toRaw ? parseCairoDate(toRaw, "The end date") : null;
  if (from && to && from > to) {
    throw new SystemAuditQueryError(`The start date ${from} is after the end date ${to}.`);
  }

  const hrKeys = readList<string>(
    input,
    SYSTEM_AUDIT_PARAM.hrKey,
    "person",
    null,
    (value) => {
      const key = canonicalHrIdKey(value);
      if (!key) throw new SystemAuditQueryError("A person filter value is empty.");
      return key;
    },
    HR_KEY_MAX,
  );
  const modules = readList<string>(input, SYSTEM_AUDIT_PARAM.module, "module", null);
  const statuses = readList<SystemAuditStatus>(input, SYSTEM_AUDIT_PARAM.status, "fixed status", SYSTEM_AUDIT_STATUSES);
  const rootCauseLevels = readList<RootCauseLevel>(input, SYSTEM_AUDIT_PARAM.why, "root-cause level", ROOT_CAUSE_LEVELS);
  const families = readList<SystemAuditFamily>(input, SYSTEM_AUDIT_PARAM.family, "source", SYSTEM_AUDIT_FAMILIES);

  const scopeRaw = readOne(input, SYSTEM_AUDIT_PARAM.scope, "The scope");
  if (scopeRaw !== null && !(SYSTEM_AUDIT_SCOPES as readonly string[]).includes(scopeRaw)) {
    throw new SystemAuditQueryError(`"${scopeRaw}" is not a known scope — use only, shared or system.`);
  }
  const scope = (scopeRaw as SharedScope | null) ?? null;

  const searchValues = readAll(input, SYSTEM_AUDIT_PARAM.search).map((value) => value.trim()).filter(Boolean);
  if (searchValues.length > 1) throw new SystemAuditQueryError("The search was given more than once.");
  const search = searchValues[0] ?? null;
  if (search && search.length > SYSTEM_AUDIT_SEARCH_MAX) {
    throw new SystemAuditQueryError(`The search is ${search.length} characters; at most ${SYSTEM_AUDIT_SEARCH_MAX} are allowed.`);
  }

  const includeSilent = readFlag(input, SYSTEM_AUDIT_PARAM.includeSilent, "Include silent data findings", true);
  const includeTest = readFlag(input, SYSTEM_AUDIT_PARAM.includeTest, "Include test accounts", false);

  const sortRaw = readOne(input, SYSTEM_AUDIT_PARAM.sort, "The sort");
  if (sortRaw !== null && !(SYSTEM_AUDIT_SORTS as readonly string[]).includes(sortRaw)) {
    throw new SystemAuditQueryError(`"${sortRaw}" is not a known sort.`);
  }
  const sort = (sortRaw as SystemAuditSort | null) ?? "occurred_desc";

  return {
    filters: {
      from,
      to,
      hrKeys,
      modules,
      statuses,
      rootCauseLevels,
      families,
      scope,
      search,
      includeSilent,
      includeTest,
    },
    sort,
    offset: readOffset(input),
    limit: SYSTEM_AUDIT_PAGE_SIZE,
  };
}

/**
 * The inverse, for the client: the query string that reproduces these filters. Defaults are left
 * out so a plain visit keeps a plain URL. `parseSystemAuditQuery(systemAuditQueryToParams(q))`
 * returns `q` (pinned by the test).
 */
export function systemAuditQueryToParams(query: {
  filters: SystemAuditFilters;
  sort?: SystemAuditSort;
  offset?: number;
}): URLSearchParams {
  const params = new URLSearchParams();
  const f = query.filters;
  if (f.from) params.set(SYSTEM_AUDIT_PARAM.from, f.from);
  if (f.to) params.set(SYSTEM_AUDIT_PARAM.to, f.to);
  for (const value of f.hrKeys ?? []) params.append(SYSTEM_AUDIT_PARAM.hrKey, value);
  for (const value of f.modules ?? []) params.append(SYSTEM_AUDIT_PARAM.module, value);
  for (const value of f.statuses ?? []) params.append(SYSTEM_AUDIT_PARAM.status, value);
  for (const value of f.rootCauseLevels ?? []) params.append(SYSTEM_AUDIT_PARAM.why, value);
  for (const value of f.families ?? []) params.append(SYSTEM_AUDIT_PARAM.family, value);
  if (f.scope) params.set(SYSTEM_AUDIT_PARAM.scope, f.scope);
  if (f.search) params.set(SYSTEM_AUDIT_PARAM.search, f.search);
  if (f.includeSilent === false) params.set(SYSTEM_AUDIT_PARAM.includeSilent, "0");
  if (f.includeTest === true) params.set(SYSTEM_AUDIT_PARAM.includeTest, "1");
  if (query.sort && query.sort !== "occurred_desc") params.set(SYSTEM_AUDIT_PARAM.sort, query.sort);
  if (query.offset && query.offset > 0) params.set(SYSTEM_AUDIT_PARAM.offset, String(query.offset));
  return params;
}

/** One line for the audit log and the workbook subtitle: what the export was filtered by. */
export function describeSystemAuditFilters(filters: SystemAuditFilters): string {
  const parts: string[] = [];
  if (filters.from || filters.to) parts.push(`dates ${filters.from ?? "start"} to ${filters.to ?? "today"} (Cairo)`);
  if (filters.hrKeys?.length) parts.push(`${filters.hrKeys.length} ${filters.hrKeys.length === 1 ? "person" : "people"}`);
  if (filters.modules?.length) parts.push(`modules: ${filters.modules.join("; ")}`);
  if (filters.statuses?.length) parts.push(`status: ${filters.statuses.join(", ")}`);
  if (filters.rootCauseLevels?.length) parts.push(`why: ${filters.rootCauseLevels.join(", ")}`);
  if (filters.families?.length) parts.push(`source: ${filters.families.join(", ")}`);
  if (filters.scope) parts.push(`scope: ${filters.scope}`);
  if (filters.search) parts.push(`search: "${filters.search}"`);
  parts.push(filters.includeSilent === false ? "silent findings excluded" : "silent findings included");
  parts.push(filters.includeTest ? "test accounts included" : "test accounts excluded");
  return parts.join(" · ");
}

// ─── The two mutation bodies ──────────────────────────────────────────────────────────────────
// Refused here, in words, before the database function sees them; the function re-checks every
// rule and its own refusal is shown verbatim when it disagrees.

export const SYSTEM_AUDIT_REASON_MAX = 2000;
const FULL_SHA = /^[0-9a-f]{40}$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The statuses a person may set by hand. FIXED — VERIFIED belongs to the verifier alone. */
const HUMAN_STATUSES = ["investigating", "not_fixed", "fix_implemented", "no_defect", "unknown"] as const;
export type HumanStatus = (typeof HUMAN_STATUSES)[number];

export type StatusChangeInput = {
  to: HumanStatus;
  reason: string | null;
  fixSha: string | null;
  occurrenceId: string | null;
};

function optionalText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new SystemAuditQueryError(`${label} must be text.`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > SYSTEM_AUDIT_REASON_MAX) {
    throw new SystemAuditQueryError(`${label} is ${text.length} characters; at most ${SYSTEM_AUDIT_REASON_MAX} are kept.`);
  }
  return text;
}

export function parseStatusChange(body: unknown): StatusChangeInput {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!record) throw new SystemAuditQueryError("The request carried no status change.");
  const to = typeof record.to === "string" ? record.to.trim() : "";
  if (to === "fixed_verified") {
    throw new SystemAuditQueryError("FIXED — VERIFIED is set only by the automatic verifier, after it re-measures the fix.");
  }
  if (!(HUMAN_STATUSES as readonly string[]).includes(to)) {
    throw new SystemAuditQueryError(`"${to || "nothing"}" is not a status that can be set here.`);
  }
  const reason = optionalText(record.reason, "The reason");
  const shaRaw = optionalText(record.fixSha, "The fix commit");
  const fixSha = shaRaw ? shaRaw.toLowerCase() : null;
  if (to === "fix_implemented") {
    if (!fixSha || !FULL_SHA.test(fixSha)) {
      throw new SystemAuditQueryError("FIX IMPLEMENTED needs the fix's full 40-character commit.");
    }
  } else if (fixSha) {
    throw new SystemAuditQueryError("A fix commit is recorded only with FIX IMPLEMENTED.");
  }
  if ((to === "no_defect" || to === "unknown") && !reason) {
    throw new SystemAuditQueryError(
      to === "no_defect" ? "Say why this is expected business behaviour." : "Say what evidence is missing.",
    );
  }
  const occurrenceRaw = optionalText(record.occurrenceId, "The occurrence");
  if (occurrenceRaw && !UUID_SHAPE.test(occurrenceRaw)) throw new SystemAuditQueryError("The occurrence id is not valid.");
  return { to: to as HumanStatus, reason, fixSha, occurrenceId: occurrenceRaw };
}

export type TriageInput = { override: "no_defect" | "unknown" | null; reason: string | null };

/** Mark ONE occurrence no-defect / unknown (with a reason), or clear the mark (`override: null`). */
export function parseTriage(body: unknown): TriageInput {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!record) throw new SystemAuditQueryError("The request carried no decision for this occurrence.");
  const raw = record.override;
  if (raw !== null && raw !== "no_defect" && raw !== "unknown") {
    throw new SystemAuditQueryError("This occurrence can be marked no defect or unknown, or cleared.");
  }
  const reason = optionalText(record.reason, "The reason");
  if (raw !== null && !reason) {
    throw new SystemAuditQueryError(
      raw === "no_defect" ? "Say why this occurrence is expected business behaviour." : "Say what evidence is missing.",
    );
  }
  return { override: raw, reason: raw === null ? null : reason };
}

/** True for a well-formed occurrence or issue id. */
export function isAuditId(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_SHAPE.test(value);
}

/**
 * The id a change is recorded under — the Super Admin's HR ID in its stored form, else the login.
 * An id the database function would read as an automatic actor is refused: `system:verifier` and
 * `seed:` may set FIXED — VERIFIED, and no person may borrow them.
 */
export function auditActorId(access: { hrId: string | null; loginId?: string | null }): string | null {
  const hr = access.hrId?.trim() ? (canonicalHrIdKey(access.hrId) ?? "").toUpperCase() : "";
  const actor = hr || access.loginId?.trim() || "";
  if (!actor) return null;
  if (/^(system|seed):/i.test(actor)) return null;
  return actor;
}
