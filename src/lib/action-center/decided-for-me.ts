// "Decided for you" — the decisions somebody else took on requests that were yours.
//
// getMyApprovalHistory answers "what did I decide". That is scoped to the DECIDER, so when
// someone covers for you — a vacation cover, a Super Admin unblocking a stuck queue — their
// decisions on your team land in THEIR history and appear nowhere in yours. A manager coming
// back from leave then has no way to learn what happened while he was away, which is exactly
// the gap the 2026-08-30 vacation cover exposed: four marketing approvals and five weekly-plan
// decisions were taken on the Marketing Manager's behalf and were invisible to him on return.
//
// This is the mirror query: same modules, but scoped to the SUBJECT (your team, your lines)
// and filtered to decisions whose decider is not you.
//
// Two different ownership rules, because "mine" means two different things:
//   * team — the employee reports to you (leave, excuse, weekly plan)
//   * line — the request sits on a line you are the marketing reviewer for (marketing)
// A marketing request is usually raised by a rep who does NOT report to the reviewer, so a
// team-only rule would have missed three of that manager's four.

import { resolveNavigationMode, normalizeRole, type AccessContext } from "@/lib/auth/permissions";
import { isSamePerson, sharedIdentityKeys } from "@/lib/auth/identity-aliases";
import type { HistoricalApprovalItem } from "@/components/action-center/types";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Why this row counted as yours — shown to the reader so the list never looks arbitrary. */
export type DecidedForMeBasis = "team" | "line";

export type DecidedForMeItem = HistoricalApprovalItem & {
  decidedByHrId: string;
  decidedByName: string;
  basis: DecidedForMeBasis;
  // What the decider actually WROTE, verbatim, or null when they left no note. Owner request
  // 2026-09-07: knowing a plan was "Returned" is not the same as reading "please modify the plan
  // to have at least two DV this week to Cairo and Giza" — without the words, a returning manager
  // still has to go and ask what was said, which is the errand this feature exists to remove.
  decidedNote: string | null;
};

/** How far back to look. A returning manager cares about the trip, not his whole tenure. */
export const DECIDED_FOR_ME_WINDOW_DAYS = 90;

/** Per-module row cap. Mirrors the 200 used by getMyApprovalHistory. */
const PER_MODULE_LIMIT = 200;

// A PostgREST `.in()` carrying several hundred ids returns ZERO rows and no error (AGENTS.md
// 2.1, Migrations). An NSM has ~70 direct reports and the CEO far more, so every id list below
// is chunked rather than passed whole.
const IN_CHUNK = 50;

function chunk<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

/** The decider's own words, or null. Never an empty string — the UI branches on null. */
function decisionNote(value: unknown): string | null {
  const text = cleanText(value);
  return text ? text : null;
}

/**
 * approved / rejected / returned, from whatever the module calls it.
 *
 * Every module spells its own outcome differently ("returned_to_employee", "manager_returned",
 * "ceo_rejected"), so match on the substring rather than on an exhaustive value list. An
 * unmapped new status then reads as "approved" only when it says nothing about rejecting or
 * returning, which is the safe direction for a read-only list.
 */
export function normalizeDecidedForMeOutcome(value: unknown): HistoricalApprovalItem["decision"] {
  const text = cleanText(value).toLowerCase();
  if (text.includes("reject") || text.includes("declin")) return "rejected";
  if (text.includes("return")) return "returned";
  return "approved";
}

function windowStartIso(days: number): string {
  const start = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000);
  return start.toISOString();
}

export async function getDecisionsMadeForMe(
  access: AccessContext,
  options: { windowDays?: number } = {},
): Promise<DecidedForMeItem[]> {
  const viewerHrId = cleanText(access.hrId);
  if (!viewerHrId) return [];

  const db = getSupabaseAdmin();
  const since = windowStartIso(options.windowDays ?? DECIDED_FOR_ME_WINDOW_DAYS);
  // Deliberately NOT caught. Swallowing a directory failure into [] renders as "nothing
  // happened while you were away" — indistinguishable from a real quiet period, and the worst
  // possible lie for this particular feature. Let it throw; the pages turn it into a visible
  // "could not load" instead of a confident empty tab. Measured 2026-09-07: one transient
  // failure returned 0 items where the true answer was 8.
  const directory = await getEmployeeDirectory();

  // Identity, not login: a person holding two logins records decisions under either, so a
  // decision taken under the viewer's other login is still his own and must not surface here
  // as somebody else's work. isSamePerson covers every alias.
  const mine = sharedIdentityKeys(viewerHrId.toUpperCase());
  const isMe = (value: unknown) =>
    isSamePerson(viewerHrId, value == null ? null : String(value)) ||
    mine.has(cleanText(value).toUpperCase());

  const nameByHrId = new Map<string, string>();
  for (const employee of directory.employees) {
    const key = canonicalHrIdKey(employee.hrId);
    if (key) nameByHrId.set(key, employee.displayName || employee.fullName);
  }
  // canonicalHrIdKey returns null for a blank id, so the lookup is guarded rather than passed
  // straight into Map.get — and an unresolvable id falls back to the raw value rather than an
  // empty cell, because "Decided by (blank)" is worse than "Decided by A-9".
  const nameFor = (hrId: unknown): string => {
    const key = canonicalHrIdKey(cleanText(hrId));
    return (key ? nameByHrId.get(key) : null) ?? cleanText(hrId);
  };
  const deciderName = nameFor;

  // ── who is "my team" ────────────────────────────────────────────────────────
  // HR ids are mixed case in storage (AGENTS.md 2.1, Database), so compare canonical keys on
  // BOTH sides rather than trusting a plain `.eq` against manager_hr_id.
  const myKeys = new Set(Array.from(mine).map((id) => canonicalHrIdKey(id)).filter(Boolean));
  const teamHrIds = directory.employees
    .filter((employee) => myKeys.has(canonicalHrIdKey(employee.managerHrId)))
    .map((employee) => employee.hrId)
    .filter(Boolean);

  // ── which lines are "my lines" ──────────────────────────────────────────────
  // Read the routing table rather than hardcoding a role: it is the same row the marketing
  // workflow reads when deciding who reviews a line, so this list moves with it instead of
  // drifting away from it.
  const myRole = normalizeRole(access.role);
  const { data: routingRows } = await db
    .from("marketing_review_routing")
    .select("line_id,reviewer_role,active")
    .eq("active", true);
  const myLineIds = ((routingRows as Array<{ line_id: number; reviewer_role: string }> | null) ?? [])
    .filter((row) => normalizeRole(row.reviewer_role) === myRole)
    .map((row) => row.line_id)
    .filter((id): id is number => typeof id === "number");

  const isPortal = resolveNavigationMode(access) === "employee-portal";
  const approvalsBase = isPortal ? "/employee-portals/approvals" : "/admin/approvals";
  const href = (segment: string, id: unknown) =>
    `${approvalsBase}/${segment}/${encodeURIComponent(String(id ?? ""))}`;

  // (1) A real, NAMED decider or nothing. A blank decider column renders as "Decided by" with
  // an empty space after it, and asserting that somebody else decided a request when nobody is
  // recorded is simply false. Requiring the id to resolve to a real person in the directory
  // also drops rows stamped by retired service identities.
  const hasNamedDecider = (hrId: unknown): boolean => {
    const key = canonicalHrIdKey(cleanText(hrId));
    return Boolean(key && nameByHrId.has(key));
  };

  // (2) Records being TIDIED are not decisions taken on your behalf. These two notes are written
  // by the legacy leave backfill and by admin record corrections; 14 of the 38 rows on the first
  // production read were one of these, going back to January, burying the 8 that mattered.
  const isSystemRecord = (note: string | null): boolean => {
    if (!note) return false;
    const text = note.toLowerCase();
    return text.includes("historical import") || text.includes("manual admin record update");
  };

  const shouldReport = (decidedByHrId: unknown, note: string | null): boolean =>
    hasNamedDecider(decidedByHrId) && !isSystemRecord(note);

  const items: DecidedForMeItem[] = [];

  const pushTeamRow = (built: Omit<DecidedForMeItem, "decidedByName" | "basis"> | null) => {
    if (!built) return;
    if (!shouldReport(built.decidedByHrId, built.decidedNote)) return;
    items.push({ ...built, decidedByName: deciderName(built.decidedByHrId), basis: "team" });
  };

  // ── leave, excuse, weekly plan: scoped to my direct reports ─────────────────
  for (const batch of chunk(teamHrIds)) {
    const [leaves, excuses, plans] = await Promise.all([
      db
        .from("v2_vacation_requests")
        .select("id,employee_name,employee_hr_id,start_date,manager_decision,manager_decision_at,manager_decision_by_hr_id,manager_decision_comment")
        .in("employee_hr_id", batch)
        .not("manager_decision_at", "is", null)
        .gte("manager_decision_at", since)
        .order("manager_decision_at", { ascending: false })
        .limit(PER_MODULE_LIMIT),
      db
        .from("v2_excuse_requests")
        .select("id,employee_name,employee_hr_id,excuse_date,excuse_type,manager_decision,manager_decision_at,manager_decision_by_hr_id,manager_decision_comment")
        .in("employee_hr_id", batch)
        .not("manager_decision_at", "is", null)
        .gte("manager_decision_at", since)
        .order("manager_decision_at", { ascending: false })
        .limit(PER_MODULE_LIMIT),
      db
        .from("employee_plan_headers")
        .select("id,employee_name,employee_hr_id,period_key,plan_kind,status,manager_decision_at,manager_decision_by_hr_id,manager_decision_comment")
        .in("employee_hr_id", batch)
        .not("manager_decision_at", "is", null)
        .gte("manager_decision_at", since)
        .order("manager_decision_at", { ascending: false })
        .limit(PER_MODULE_LIMIT),
    ]);

    for (const row of (leaves.data as Array<Record<string, unknown>> | null) ?? []) {
      if (isMe(row.manager_decision_by_hr_id)) continue;
      pushTeamRow({
        id: `decided-for-me:leave:${String(row.id)}`,
        module: "leave",
        employeeName: cleanText(row.employee_name),
        employeeHrId: cleanText(row.employee_hr_id),
        title: `Leave · from ${cleanText(row.start_date)}`,
        decision: normalizeDecidedForMeOutcome(row.manager_decision),
        decidedAt: cleanText(row.manager_decision_at),
        href: href("vacation", row.id),
        decidedByHrId: cleanText(row.manager_decision_by_hr_id),
        decidedNote: decisionNote(row.manager_decision_comment),
      });
    }

    for (const row of (excuses.data as Array<Record<string, unknown>> | null) ?? []) {
      if (isMe(row.manager_decision_by_hr_id)) continue;
      const type = cleanText(row.excuse_type) === "morning" ? "Morning" : "Afternoon";
      pushTeamRow({
        id: `decided-for-me:excuse:${String(row.id)}`,
        module: "excuse",
        employeeName: cleanText(row.employee_name),
        employeeHrId: cleanText(row.employee_hr_id),
        title: `${type} excuse · ${cleanText(row.excuse_date)}`,
        decision: normalizeDecidedForMeOutcome(row.manager_decision),
        decidedAt: cleanText(row.manager_decision_at),
        href: href("excuse", row.id),
        decidedByHrId: cleanText(row.manager_decision_by_hr_id),
        decidedNote: decisionNote(row.manager_decision_comment),
      });
    }

    for (const row of (plans.data as Array<Record<string, unknown>> | null) ?? []) {
      if (isMe(row.manager_decision_by_hr_id)) continue;
      const kind = cleanText(row.plan_kind) === "monthly" ? "Monthly plan" : "Weekly plan";
      pushTeamRow({
        id: `decided-for-me:weekly_plan:${String(row.id)}`,
        module: "weekly_plan",
        employeeName: cleanText(row.employee_name),
        employeeHrId: cleanText(row.employee_hr_id),
        title: `${kind} · ${cleanText(row.period_key)}`,
        decision: normalizeDecidedForMeOutcome(row.status),
        decidedAt: cleanText(row.manager_decision_at),
        href: href("plan", row.id),
        decidedByHrId: cleanText(row.manager_decision_by_hr_id),
        decidedNote: decisionNote(row.manager_decision_comment),
      });
    }
  }

  // ── marketing: scoped to the lines I review ─────────────────────────────────
  if (myLineIds.length > 0) {
    const { data: requestRows } = await db
      .from("marketing_requests")
      .select("id,request_code,line_id,requester_hr_id")
      .in("line_id", myLineIds)
      .limit(1000);
    const requests = new Map<string, { code: string; requester: string }>();
    for (const row of (requestRows as Array<Record<string, unknown>> | null) ?? []) {
      requests.set(String(row.id), {
        code: cleanText(row.request_code),
        requester: cleanText(row.requester_hr_id),
      });
    }

    for (const batch of chunk(Array.from(requests.keys()))) {
      const { data: stepRows } = await db
        .from("marketing_request_approval_steps")
        .select("id,request_id,step_code,status,decision_at,decision_by_hr_id,decision_note")
        .eq("step_code", "marketing_review")
        .in("request_id", batch)
        .not("decision_at", "is", null)
        .gte("decision_at", since)
        .order("decision_at", { ascending: false })
        .limit(PER_MODULE_LIMIT);

      for (const row of (stepRows as Array<Record<string, unknown>> | null) ?? []) {
        if (isMe(row.decision_by_hr_id)) continue;
        const marketingNote = decisionNote(row.decision_note);
        if (!shouldReport(row.decision_by_hr_id, marketingNote)) continue;
        const request = requests.get(String(row.request_id));
        if (!request) continue;
        items.push({
          id: `decided-for-me:marketing_request:${String(row.id)}`,
          module: "marketing_request",
          employeeName: nameFor(request.requester),
          employeeHrId: request.requester,
          title: `Marketing review · ${request.code}`,
          decision: normalizeDecidedForMeOutcome(row.status),
          decidedAt: cleanText(row.decision_at),
          // The marketing inbox is an admin-shell page with no portal twin, so a portal
          // viewer gets no link rather than one that dead-ends on a 403.
          href: isPortal ? null : "/admin/marketing-requests/inbox",
          decidedByHrId: cleanText(row.decision_by_hr_id),
          decidedByName: deciderName(row.decision_by_hr_id),
          decidedNote: marketingNote,
          basis: "line",
        });
      }
    }
  }

  return items.sort((left, right) => right.decidedAt.localeCompare(left.decidedAt));
}
