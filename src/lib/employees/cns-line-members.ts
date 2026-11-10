import { createHmac } from "node:crypto";

import {
  isActiveDirectoryEmployee,
  isActiveLifecycleStatus,
  isWorkEmailFormat,
  type DirectoryMembershipFields,
} from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { logCronUnauthorized, logError } from "@/lib/observability/log";
import { loadReferenceLines } from "@/lib/reference/reference-lists";
import { requiredTokenAuthorized } from "@/lib/security/cron-auth";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The CNS Line members feed — `GET /api/integrations/cns-line/members`.
 *
 * The CNS Line detailing app (its own server, outside Phoenix) lets a person in when their email
 * belongs to somebody who may use it today. This is the one thing Phoenix tells it, and it is
 * deliberately thin:
 *
 *  - ONLY KEYED HASHES LEAVE. Each address is trimmed, lower-cased and run through HMAC-SHA256 under
 *    `CNS_LINE_MEMBERS_HASH_KEY`; the app does the same to what the person typed and looks it up.
 *    No address, name or HR id is in the answer. A plain SHA-256 was NOT enough: work addresses
 *    follow first.second@satopharma.com, so an unkeyed list can be reversed in seconds by guessing
 *    names. A leaked list (the app's SQLite file, its backups) cannot be reversed without the hash
 *    key. Someone holding BOTH the token and the key can still confirm addresses they guess.
 *  - THE KEY IS NOT THE TOKEN, so the token can be rotated without changing a single hash. Either one
 *    unset or blank answers 503 before any read. The body names `hash: "hmac-sha256"` so the app
 *    refuses a list in any other format.
 *  - WHO IS IN (owner, 2026-11-08: "accept any email from cns line"; widened 2026-11-10: "not only
 *    reps and dms and nsms and marketing manager and all head office employees") — every ACTIVE
 *    employee who is any of:
 *      1. on the CNS line — `employees.line_id → public.lines` with `lines.code = 'cns'`;
 *      2. a manager of CNS-line people — anyone reached by walking `employees.manager_hr_id` UPWARD
 *         from an active CNS-line employee (their District Manager, then the National Sales Manager,
 *         and so on to the top). Titles are not read for this: a DM or NSM is in BECAUSE a CNS rep or
 *         DM names them as manager, so a manager of only non-CNS people is not. The walk passes
 *         THROUGH a departed manager (whose own manager is still in the chain) but never admits
 *         one, and stops at a person already seen, so a cycle in the data cannot loop;
 *      3. Head Office — `lines.code = 'head_office'`, which carries the Marketing Manager and every
 *         other head-office employee.
 *    Lines are matched by CODE, never by id, name or the dead `line_name` column. "Active" is the
 *    directory's own `isActiveDirectoryEmployee`, fed exactly the fields and defaults the lean name
 *    roster in employee-directory.ts feeds it — so a resignation drops a person the day it is
 *    submitted (the owner's decision).
 *  - BOTH ADDRESSES COUNT: `work_email` and `personal_email`, each only when well-formed.
 *  - ITS OWN TOKEN, `CNS_LINE_MEMBERS_TOKEN`, with NO development bypass: unset answers 503 (the feed
 *    is not configured), a missing or wrong bearer answers 401 and is logged as `cron_unauthorized`.
 */

export const CNS_LINE_CODE = "cns";
export const HEAD_OFFICE_LINE_CODE = "head_office";
export const CNS_LINE_MEMBERS_JOB = "integrations/cns-line/members";

/** One `employees` row as the feed reads it — the membership fields plus the two addresses. */
export type CnsLineMemberRow = {
  hr_id: string;
  full_name: string | null;
  job_title?: string | null;
  employment_status?: string | null;
  payroll_eligible?: boolean | null;
  organogram_visible?: boolean | null;
  position_id?: number | null;
  line_id?: number | null;
  manager_hr_id?: string | null;
  work_email?: string | null;
  personal_email?: string | null;
  positions?: { title?: string | null } | Array<{ title?: string | null }> | null;
  lines?: { code?: string | null; name?: string | null } | Array<{ code?: string | null; name?: string | null }> | null;
};

export const CNS_LINE_MEMBERS_HASH = "hmac-sha256";

export type CnsLineMembersBody = {
  line: typeof CNS_LINE_CODE;
  generatedAt: string;
  count: number;
  hash: typeof CNS_LINE_MEMBERS_HASH;
  emailHashes: string[];
};

const MEMBER_SELECT = [
  "hr_id,full_name,job_title,employment_status,payroll_eligible,organogram_visible,position_id,line_id,manager_hr_id,work_email,personal_email",
  "positions!employees_position_id_fkey(title)",
  "lines!employees_line_id_fkey(code,name)",
].join(",");

/** PostgREST hands back a to-one embed as an object or a one-element array. */
function embedded<T extends object>(embed: T | T[] | null | undefined): T | null {
  const one = Array.isArray(embed) ? embed[0] : embed;
  return one && typeof one === "object" ? one : null;
}

function text(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

/**
 * Hex HMAC-SHA256, under `key`, of the address trimmed and lower-cased; null when it is not a
 * well-formed address.
 */
export function hashMemberEmail(value: string | null | undefined, key: string): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!email || !isWorkEmailFormat(email)) return null;
  return createHmac("sha256", key).update(email, "utf8").digest("hex");
}

/** The row's line code, read from the joined `lines.code` (never the dead `line_name`), lower-cased. */
function lineCodeOf(row: CnsLineMemberRow): string | null {
  return text(embedded(row.lines)?.code)?.toLowerCase() ?? null;
}

/** Is this row on the CNS line? */
export function isCnsLineRow(row: CnsLineMemberRow): boolean {
  return lineCodeOf(row) === CNS_LINE_CODE;
}

/** Is this row on the Head Office line (the Marketing Manager and every other head-office employee)? */
export function isHeadOfficeRow(row: CnsLineMemberRow): boolean {
  return lineCodeOf(row) === HEAD_OFFICE_LINE_CODE;
}

/** The directory's membership rule, fed exactly as `fetchEmployeeNameRoster` feeds it — any line. */
export function isActiveEmployeeRow(row: CnsLineMemberRow): boolean {
  const active = isActiveLifecycleStatus(row.employment_status);
  const candidate: DirectoryMembershipFields = {
    hrId: row.hr_id,
    fullName: row.full_name ?? "",
    jobTitle: row.job_title ?? null,
    employmentStatus: row.employment_status ?? null,
    // The directory's own defaults: a NULL column means "whatever the lifecycle status implies".
    organogramVisible: row.organogram_visible ?? active,
    payrollEligible: row.payroll_eligible ?? active,
    positionTitle: row.position_id ? text(embedded(row.positions)?.title) : null,
    lineName: row.line_id ? text(embedded(row.lines)?.name) : null,
  };
  return isActiveDirectoryEmployee(candidate);
}

/** An active employee on the CNS line itself. */
export function isActiveCnsMember(row: CnsLineMemberRow): boolean {
  return isCnsLineRow(row) && isActiveEmployeeRow(row);
}

/**
 * Everyone the feed admits: active CNS-line employees, every active manager up their
 * `manager_hr_id` chain, and every active Head Office employee. Needs the WHOLE employee table, since a
 * manager can sit on any line.
 */
export function cnsLineMemberRows(rows: readonly CnsLineMemberRow[]): CnsLineMemberRow[] {
  const byHrId = new Map<string, CnsLineMemberRow>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.hr_id);
    if (key && !byHrId.has(key)) byHrId.set(key, row);
  }

  const admitted = new Set<CnsLineMemberRow>();
  const walked = new Set<string>();
  for (const row of rows) {
    if (isActiveEmployeeRow(row) && isHeadOfficeRow(row)) admitted.add(row);
    if (!isActiveCnsMember(row)) continue;
    admitted.add(row);
    // Up the chain. `walked` is shared across starts: a manager already walked from another rep has
    // had their whole chain walked too, and a cycle (A manages B manages A) stops at the repeat.
    let managerKey = canonicalHrIdKey(row.manager_hr_id);
    while (managerKey && !walked.has(managerKey)) {
      walked.add(managerKey);
      const manager = byHrId.get(managerKey);
      if (!manager) break;
      if (isActiveEmployeeRow(manager)) admitted.add(manager);
      managerKey = canonicalHrIdKey(manager.manager_hr_id);
    }
  }
  return rows.filter((row) => admitted.has(row));
}

/** Every admitted person's work and personal address, HMAC'd under `key`, de-duplicated and sorted. */
export function cnsLineMemberEmailHashes(rows: readonly CnsLineMemberRow[], key: string): string[] {
  const hashes = new Set<string>();
  for (const row of cnsLineMemberRows(rows)) {
    for (const email of [row.work_email, row.personal_email]) {
      const hash = hashMemberEmail(email, key);
      if (hash) hashes.add(hash);
    }
  }
  return [...hashes].sort();
}

/** Both line codes the feed matches on must exist; a missing one is a broken master, never "nobody". */
export function requireFeedLines(lines: ReadonlyArray<{ id: number | null; code: string | null }>): void {
  for (const code of [CNS_LINE_CODE, HEAD_OFFICE_LINE_CODE]) {
    const found = lines.some((line) => line.id !== null && (line.code ?? "").trim().toLowerCase() === code);
    // Refuse, so the app keeps its last good list instead of locking people out.
    if (!found) throw new Error(`The line lines.code = '${code}' was not found.`);
  }
}

/** Reads every employee with the service-role client (a manager can sit on any line). Throws rather than answer short. */
export async function loadCnsLineMemberRows(): Promise<CnsLineMemberRow[]> {
  // The lines come from the minute-cached reference list (throws on a failed read), never a direct
  // read of `lines`; matched by CODE, never by id.
  requireFeedLines(await loadReferenceLines());
  const admin = getSupabaseAdmin();
  return fetchAllRows<CnsLineMemberRow>(() => admin.from("employees").select(MEMBER_SELECT), "hr_id");
}

export type CnsLineMembersDeps = {
  token: string | undefined;
  /** `CNS_LINE_MEMBERS_HASH_KEY` — the HMAC key, kept apart from the token. */
  hashKey: string | undefined;
  loadRows?: () => Promise<CnsLineMemberRow[]>;
  now?: () => Date;
};

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The whole route, with its token and its read passed in so the test can drive every answer. */
export async function handleCnsLineMembersRequest(request: Request, deps: CnsLineMembersDeps): Promise<Response> {
  if (!deps.token?.trim()) {
    logError("CNS Line members feed called while CNS_LINE_MEMBERS_TOKEN is unset", {
      labels: { event: "cns_line_members_not_configured", job: CNS_LINE_MEMBERS_JOB },
    });
    return Response.json({ error: "not_configured" }, { status: 503, headers: NO_STORE });
  }
  const hashKey = deps.hashKey?.trim();
  if (!hashKey) {
    logError("CNS Line members feed called while CNS_LINE_MEMBERS_HASH_KEY is unset", {
      labels: { event: "cns_line_members_not_configured", job: CNS_LINE_MEMBERS_JOB },
    });
    return Response.json({ error: "not_configured" }, { status: 503, headers: NO_STORE });
  }
  if (!requiredTokenAuthorized(request, deps.token, "cns_line_members_not_configured", "Not configured.")) {
    logCronUnauthorized(CNS_LINE_MEMBERS_JOB, request);
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  try {
    const rows = await (deps.loadRows ?? loadCnsLineMemberRows)();
    const emailHashes = cnsLineMemberEmailHashes(rows, hashKey);
    const body: CnsLineMembersBody = {
      line: CNS_LINE_CODE,
      generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
      count: emailHashes.length,
      hash: CNS_LINE_MEMBERS_HASH,
      emailHashes,
    };
    return Response.json(body, { headers: NO_STORE });
  } catch (error) {
    logError("CNS Line members feed failed — the CNS Line app keeps its last list", {
      labels: { event: "cns_line_members_failed", job: CNS_LINE_MEMBERS_JOB },
      error,
    });
    return Response.json({ error: "cns_line_members_failed" }, { status: 500, headers: NO_STORE });
  }
}
