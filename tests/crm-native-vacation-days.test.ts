import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  VACATION_DAY_BLOCKED_MESSAGE,
  VACATION_DAY_WAITING_MESSAGE,
  isVacationDayHrDecider,
  vacationDayDecisionRefusal,
  vacationDayRequestRefusal,
  vacationDayRequestStatus,
  vacationDayWorkRefusal,
  type VacationDayRequestState,
} from "../src/lib/crm/native-visits/vacation-day-rules.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Working on an approved vacation day — CRM phase 6, rule 9.
//
// WHAT THIS FILE GUARDS:
//   · DORMANT UNTIL CUTOVER. With no cutover date, or a day before it, no visit is refused.
//   · THE OWNER'S RULE (2026-09-13): a rep cannot submit a visit on an HR-approved vacation day
//     "except if he send a request to his manager and the HR" — the day opens only when BOTH approved.
//   · ONLY WORK IS BLOCKED. A day type with no contact (annual vacation itself) stays recordable.
//   · NOBODY DECIDES FOR ANYONE. Only the stored manager answers as manager, only HR as HR, never
//     their own request, never both halves; the service writes the parsed decision, never a literal.
//   · THE REP IS THE SESSION, and createNativeVisit runs the check before it inserts.
// ─────────────────────────────────────────────────────────────────────────────

function read(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

const pending: VacationDayRequestState = { managerDecision: "pending", hrDecision: "pending", cancelledAt: null };

export function runCrmNativeVacationDaysTests() {
  // ── 1. One status: approved only when both approved ───────────────────────────────────────────
  assert.equal(vacationDayRequestStatus(pending), "waiting");
  assert.equal(vacationDayRequestStatus({ ...pending, managerDecision: "approved" }), "waiting", "the manager alone does not open the day");
  assert.equal(vacationDayRequestStatus({ ...pending, hrDecision: "approved" }), "waiting", "HR alone does not open the day");
  assert.equal(vacationDayRequestStatus({ ...pending, managerDecision: "approved", hrDecision: "approved" }), "approved");
  assert.equal(vacationDayRequestStatus({ ...pending, managerDecision: "approved", hrDecision: "rejected" }), "rejected");
  assert.equal(
    vacationDayRequestStatus({ managerDecision: "approved", hrDecision: "approved", cancelledAt: "2026-10-01T08:00:00Z" }),
    "cancelled",
    "a withdrawn request opens nothing",
  );

  // ── 2. The visit check ────────────────────────────────────────────────────────────────────────
  const onVacation = { ruleActive: true, contactRule: "required" as const, onApprovedVacation: true };
  assert.equal(
    vacationDayWorkRefusal({ ...onVacation, ruleActive: false, request: null }),
    null,
    "before the CRM cutover no visit is refused",
  );
  assert.equal(vacationDayWorkRefusal({ ...onVacation, onApprovedVacation: false, request: null }), null, "a working day is never blocked");
  assert.equal(
    vacationDayWorkRefusal({ ...onVacation, contactRule: "none", request: null }),
    null,
    "annual vacation and other no-contact day types stay recordable",
  );
  assert.equal(vacationDayWorkRefusal({ ...onVacation, request: null }), VACATION_DAY_BLOCKED_MESSAGE, "no request: refused");
  assert.equal(
    vacationDayWorkRefusal({ ...onVacation, contactRule: "contact_or_prospect", request: null }),
    VACATION_DAY_BLOCKED_MESSAGE,
    "a campaign visit is work too",
  );
  assert.equal(vacationDayWorkRefusal({ ...onVacation, request: pending }), VACATION_DAY_WAITING_MESSAGE);
  assert.equal(
    vacationDayWorkRefusal({ ...onVacation, request: { ...pending, managerDecision: "approved" } }),
    VACATION_DAY_WAITING_MESSAGE,
    "one approval is not enough",
  );
  assert.equal(
    vacationDayWorkRefusal({ ...onVacation, request: { ...pending, managerDecision: "approved", hrDecision: "approved" } }),
    null,
    "both approved: the visit saves",
  );
  assert.equal(
    vacationDayWorkRefusal({ ...onVacation, request: { ...pending, hrDecision: "rejected" } }),
    VACATION_DAY_BLOCKED_MESSAGE,
    "a refused request leaves the day closed",
  );

  // ── 3. Asking ─────────────────────────────────────────────────────────────────────────────────
  const today = "2026-10-10";
  const ask = (visitDate: string, reason = "A launch meeting with the district") =>
    vacationDayRequestRefusal({ visitDate, reason, cairoToday: today });
  assert.equal(ask("2026-10-09"), null, "yesterday, the oldest day a rep can still enter");
  assert.equal(ask("2026-12-09"), null, "sixty days ahead");
  assert.ok(ask("2026-10-08"), "older than yesterday is refused");
  assert.ok(ask("2026-12-10"), "more than sixty days ahead is refused");
  assert.ok(ask("10/10/2026"), "not a date");
  assert.ok(ask("2026-10-11", "   "), "a reason is required");
  assert.ok(ask("2026-10-11", "x".repeat(1001)), "the reason has a limit");

  // ── 4. Answering ──────────────────────────────────────────────────────────────────────────────
  const decide = (overrides: Partial<Parameters<typeof vacationDayDecisionRefusal>[0]>) =>
    vacationDayDecisionRefusal({
      as: "manager",
      viewerHrKey: "DM-1",
      repHrKey: "REP-1",
      managerHrKey: "DM-1",
      state: pending,
      isHrAuthority: false,
      repInViewerScope: true,
      decision: "approved",
      note: null,
      ...overrides,
    });
  assert.equal(decide({}), null, "the stored manager approves a rep beneath him");
  assert.ok(decide({ viewerHrKey: null }), "no signed-in person");
  assert.ok(decide({ state: { ...pending, cancelledAt: "2026-10-01T08:00:00Z" } }), "a withdrawn request");
  assert.ok(decide({ state: { ...pending, hrDecision: "rejected" } }), "a request HR already refused");
  assert.ok(decide({ viewerHrKey: "REP-1", managerHrKey: "REP-1" }), "nobody answers their own request");
  assert.ok(decide({ viewerHrKey: "RM-9" }), "only the manager the request was sent to answers as manager");
  assert.ok(decide({ repInViewerScope: false }), "scope runs downward only");
  assert.ok(decide({ state: { ...pending, managerDecision: "approved" } }), "the manager answers once");
  assert.ok(decide({ decision: "rejected", note: "  " }), "a refusal must say why");
  assert.equal(decide({ decision: "rejected", note: "Not a field day" }), null);

  const hr = { as: "hr" as const, viewerHrKey: "HR-2", isHrAuthority: true, repInViewerScope: false };
  assert.equal(decide(hr), null, "HR answers as HR");
  assert.ok(decide({ ...hr, isHrAuthority: false }), "only the administrator answers as HR");
  assert.ok(decide({ ...hr, viewerHrKey: "DM-1" }), "the rep's manager cannot also answer as HR");
  assert.ok(decide({ ...hr, state: { ...pending, hrDecision: "approved" } }), "HR answers once");

  // The owner, 2026-09-13: "only administrator" gives the HR approval — not the HR seats.
  assert.equal(isVacationDayHrDecider("Super Admin"), true, "the administrator gives the HR approval");
  for (const role of ["HR Operations", "HR Advisory", "CEO", "National Sales Manager", "District Manager", null]) {
    assert.equal(isVacationDayHrDecider(role), false, `${role ?? "no role"} does not give the HR approval`);
  }

  // ── 5. The service ────────────────────────────────────────────────────────────────────────────
  const service = read("src/lib/crm/native-visits/vacation-days.ts");
  const exported = [...service.matchAll(/export async function (\w+)\(/g)].map((match) => match[1]);
  assert.ok(exported.length >= 6, "the vacation-day service's exported functions must be found");
  for (const name of exported) {
    const body = functionBody(service, name);
    const guard =
      name === "assertVacationDayAccess" || name === "getVacationDayRequestAvailability"
        ? /viewerCapabilities\(access\)/
        : /assertPermission\(access, "(crm_visit_entry|leave)", "(create|approve)"\)|assertVacationDayAccess\(access\)/;
    assert.match(body, guard, `${name} must check the viewer's access itself, not trust its caller`);
  }
  const capabilities = service.slice(service.indexOf("async function viewerCapabilities("), service.indexOf("export async function assertVacationDayAccess("));
  assert.match(capabilities, /canAccess\(access, "crm_visit_entry", "create"\)/);
  assert.match(capabilities, /canAccess\(access, "crm_visit_entry", "approve"\)/);
  assert.match(capabilities, /isVacationDayHrDecider\(access\.role\) && mayApproveLeave/, "the HR approval is the administrator's alone");
  assert.doesNotMatch(service, /isHrAuthorityRole/, "the HR seats do not give the HR approval (owner: only administrator)");

  const decideBody = functionBody(service, "decideVacationDayRequest");
  assert.match(decideBody, /assertPermission\(access, "crm_visit_entry", "approve"\)/, "a manager answer needs visit approval");
  assert.match(decideBody, /assertPermission\(access, "leave", "approve"\)/, "an HR answer needs leave approval");
  assert.match(decideBody, /isHrAuthority: isVacationDayHrDecider\(access\.role\)/, "an HR answer is refused unless the viewer is the administrator");
  assert.match(decideBody, /vacationDayDecisionRefusal\(/);
  assert.match(decideBody, /\.eq\(pendingColumn, "pending"\)/, "a decision may only move a pending half");
  assert.match(decideBody, /\.is\("cancelled_at", null\)/, "a withdrawn request cannot be answered");
  assert.match(decideBody, /manager_decided_by: record\.managerHrId/, "the manager decision is the stored manager's own");
  assert.doesNotMatch(service, /_decision:\s*"(approved|rejected)"/, "the service must never write a decision literal");
  assert.doesNotMatch(service, /cancelled_at:\s*null/, "nothing re-opens a withdrawn request");

  for (const name of ["requestVacationDayWork", "cancelVacationDayRequest"]) {
    assert.match(functionBody(service, name), /requireActiveSelf\(access, directory\)/, `${name}: the rep is the session`);
  }
  // The orchestration wrapper that used to call vacationDayWorkRefusal for createNativeVisit is
  // retired with the pilot's own visit creation (2026-09-25) — the pure rule below stays tested and
  // ready for whatever calls it once native visit entry is rebuilt.

  // ── 6. The route ──────────────────────────────────────────────────────────────────────────────
  const route = read("app/api/crm/native-visits/vacation-day-requests/route.ts");
  assert.doesNotMatch(route, /body\.(hrId|hr_id|repHrId|agentHrId|managerHrId)|searchParams/, "the route must not take a person from the request");
  const post = route.slice(route.indexOf("export async function POST"));
  assert.ok(post.indexOf("assertSameOriginMutation(request)") < post.indexOf("resolveAccessContext(request)"));
  assert.match(post, /assertVacationDayAccess\(access\)/);
  assert.match(route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST")), /assertVacationDayAccess\(access\)/);

  // ── 7. The migration ──────────────────────────────────────────────────────────────────────────
  const sql = read("supabase/migrations/20260914010000_crm_native_visit_vacation_day_requests.sql").replace(/--[^\n]*/g, "");
  assert.match(sql, /manager_decided_by = manager_hr_id/, "the database refuses a manager decision by anyone but the stored manager");
  assert.match(sql, /hr_decided_by <> hr_id and hr_decided_by <> manager_hr_id/, "HR is never the rep and never the manager");
  assert.match(sql, /manager_hr_id <> hr_id/);
  assert.match(sql, /where cancelled_at is null and manager_decision <> 'rejected' and hr_decision <> 'rejected'/, "one live request per rep per day");
  assert.equal(sql.match(/enable row level security/g)?.length, 2);
  assert.match(sql, /revoke all on table public\.crm_native_visit_vacation_day_requests from anon, authenticated/);
  assert.doesNotMatch(sql, /v2_vacation_requests|salary|deduction/i, "the migration touches no vacation, pay or deduction table");

  // ── 8. Reachability: linked, and hidden until the cutover ─────────────────────────────────────
  const myVisits = read("app/employee-portals/visits/page.tsx");
  assert.match(myVisits, /vacationDays\.show \? \(\s*<Link[^>]*href="\/employee-portals\/visits\/vacation-day-requests"/);
  const adminApprovals = read("app/(admin)/admin/approvals/vacation/page.tsx");
  assert.match(adminApprovals, /vacationDayWork\.show \? \([\s\S]*?href="\/admin\/approvals\/vacation-day-work"/);
  for (const page of ["app/employee-portals/visits/vacation-day-requests/page.tsx", "app/(admin)/admin/approvals/vacation-day-work/page.tsx"]) {
    assert.match(read(page), /assertVacationDayAccess\(access\)[\s\S]*?if \(!allowed\) redirect\(/, `${page} redirects a viewer who can neither ask nor answer`);
  }
}
