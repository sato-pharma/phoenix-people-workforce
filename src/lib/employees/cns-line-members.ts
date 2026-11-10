import { createHash } from "node:crypto";

import {
  isActiveDirectoryEmployee,
  isActiveLifecycleStatus,
  isWorkEmailFormat,
  type DirectoryMembershipFields,
} from "@/lib/employees/employee-directory";
import { logCronUnauthorized, logError } from "@/lib/observability/log";
import { requiredTokenAuthorized } from "@/lib/security/cron-auth";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The CNS Line members feed — `GET /api/integrations/cns-line/members`.
 *
 * The CNS Line detailing app (its own server, outside Phoenix) lets a person in when their email
 * belongs to somebody working on the CNS line today (owner: "integrate with phoenix and accept any
 * email from cns line"). This is the one thing Phoenix tells it, and it is deliberately thin:
 *
 *  - ONLY HASHES LEAVE. Each address is trimmed, lower-cased and SHA-256'd; the app hashes what the
 *    person typed the same way and looks it up. No address, name or HR id is ever in the answer, so
 *    a leaked token discloses nothing anyone can read off the response.
 *  - WHO IS IN is the directory's own rule, never a second copy: the line resolves through
 *    `employees.line_id → public.lines` where `lines.code = 'cns'` (never the dead `line_name`
 *    column, never the id), and "active" is `isActiveDirectoryEmployee`, fed exactly the fields and
 *    defaults the lean name roster in employee-directory.ts feeds it.
 *  - BOTH ADDRESSES COUNT: `work_email` and `personal_email`, each only when well-formed.
 *  - ITS OWN TOKEN, `CNS_LINE_MEMBERS_TOKEN`, with NO development bypass: unset answers 503 (the feed
 *    is not configured), a missing or wrong bearer answers 401 and is logged as `cron_unauthorized`.
 */

export const CNS_LINE_CODE = "cns";
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
  work_email?: string | null;
  personal_email?: string | null;
  positions?: { title?: string | null } | Array<{ title?: string | null }> | null;
  lines?: { code?: string | null; name?: string | null } | Array<{ code?: string | null; name?: string | null }> | null;
};

export type CnsLineMembersBody = {
  line: typeof CNS_LINE_CODE;
  generatedAt: string;
  count: number;
  emailHashes: string[];
};

const MEMBER_SELECT = [
  "hr_id,full_name,job_title,employment_status,payroll_eligible,organogram_visible,position_id,line_id,work_email,personal_email",
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

/** SHA-256 hex of the address trimmed and lower-cased, or null when it is not a well-formed address. */
export function hashMemberEmail(value: string | null | undefined): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!email || !isWorkEmailFormat(email)) return null;
  return createHash("sha256").update(email, "utf8").digest("hex");
}

/** Is this row on the CNS line, read from the joined `lines.code` (never the dead `line_name`)? */
export function isCnsLineRow(row: CnsLineMemberRow): boolean {
  return text(embedded(row.lines)?.code)?.toLowerCase() === CNS_LINE_CODE;
}

/** The directory's membership rule, fed exactly as `fetchEmployeeNameRoster` feeds it. */
export function isActiveCnsMember(row: CnsLineMemberRow): boolean {
  if (!isCnsLineRow(row)) return false;
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

/** Every active CNS member's work and personal address, hashed, de-duplicated and sorted. */
export function cnsLineMemberEmailHashes(rows: readonly CnsLineMemberRow[]): string[] {
  const hashes = new Set<string>();
  for (const row of rows) {
    if (!isActiveCnsMember(row)) continue;
    for (const email of [row.work_email, row.personal_email]) {
      const hash = hashMemberEmail(email);
      if (hash) hashes.add(hash);
    }
  }
  return [...hashes].sort();
}

/** Reads the CNS line's employees with the service-role client. Throws rather than answer short. */
export async function loadCnsLineMemberRows(): Promise<CnsLineMemberRow[]> {
  const admin = getSupabaseAdmin();
  const { data: lines, error: lineError } = await admin.from("lines").select("id,code").eq("code", CNS_LINE_CODE);
  if (lineError) throw lineError;
  const lineIds = (lines ?? []).map((line: { id: number }) => line.id);
  // No CNS line is a broken master, not an empty line: refuse, so the app keeps its last good list
  // instead of locking every CNS representative out.
  if (lineIds.length === 0) throw new Error("The CNS line (lines.code = 'cns') was not found.");
  return fetchAllRows<CnsLineMemberRow>(
    () => admin.from("employees").select(MEMBER_SELECT).in("line_id", lineIds),
    "hr_id",
  );
}

export type CnsLineMembersDeps = {
  token: string | undefined;
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
  if (!requiredTokenAuthorized(request, deps.token, "cns_line_members_not_configured", "Not configured.")) {
    logCronUnauthorized(CNS_LINE_MEMBERS_JOB, request);
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  try {
    const rows = await (deps.loadRows ?? loadCnsLineMemberRows)();
    const emailHashes = cnsLineMemberEmailHashes(rows);
    const body: CnsLineMembersBody = {
      line: CNS_LINE_CODE,
      generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
      count: emailHashes.length,
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
