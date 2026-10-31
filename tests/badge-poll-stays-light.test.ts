import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * PERF-001 (2026-10-04 performance review): the sidebar badge poll — every 30 s, from every open tab —
 * used to build the full Vacation Report twice for the leave badge (once inside the Action Center,
 * once more for sick leave) and once more for the hub badge, which then threw every leave, excuse and
 * plan item away. These pin both halves of the fix:
 *
 *   • LIGHT: the badge paths never reach the full report, its enrichment, or the discarded sources.
 *   • SAME ANSWER: the light paths share the exact deciding code with the full ones — the per-row
 *     Action Center logic, the awaiting/upcoming split, and the inbox item builders and filter — so a
 *     badge can never count a request its page would not list.
 *
 * Source-level on purpose: this suite runs with production credentials, and driving these functions
 * would read live leave requests to check which helper they call.
 */
export function runBadgePollStaysLightTests() {
  const read = (path: string) => stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
  const bodyOf = (source: string, signature: string, file: string) => {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found in ${file}`);
    const end = source.indexOf("\n}\n", start);
    return source.slice(start, end < 0 ? undefined : end);
  };

  const VACATION = "src/lib/vacation/service.ts";
  const HUB = "src/lib/approvals-hub/service.ts";
  const ACTION = "src/lib/action-center/service.ts";
  const vacation = read(VACATION);
  const hub = read(HUB);
  const action = read(ACTION);

  // ── The leave badge's source reads no report and no enrichment ──────────────
  const badgeSource = bodyOf(vacation, "export async function getVacationAwaitingBadgeSource(", VACATION);
  for (const heavy of ["getVacationReportData(", "getVacationActionCenterData(", "enrichVacationRows(", "getEmployeeDirectory("]) {
    assert.ok(
      !badgeSource.includes(heavy),
      `getVacationAwaitingBadgeSource calls ${heavy.slice(0, -1)} — the badge polls every 30 s from every tab and must ` +
        "not rebuild the full Vacation Report (or its enrichment) to produce a count and an overdue flag.",
    );
  }
  assert.match(
    badgeSource,
    /fetchVacationReportRowsFromDatabase\(\{\s*access,\s*filters: cleanFilters\(\{ status: "all" \}\),/,
    "the badge must read the SAME scoped, cached request rows the report reads for status \"all\"",
  );
  assert.match(badgeSource, /canSeeVacation\(access, row, visibleEmployeeHrIds\)/, "the badge must apply the report's own visibility filter");
  assert.match(badgeSource, /VACATION_ACTIONABLE_STATUSES\.has\(row\.status\)/, "the badge must keep the Action Center's actionable statuses");
  assert.match(badgeSource, /fetchActorPendingApprovalStepRequestIds\(access\)/, "the badge must add the same out-of-scope pending-approver rows");

  // ── Same answer: both vacation paths run the one per-row decision ───────────
  assert.match(
    badgeSource,
    /buildVacationActionCenterRows\(\{ access, candidateRows, directory: null, stepsByRequest \}\)/,
    "the badge's rows must come from the shared Action Center row builder",
  );
  assert.match(
    bodyOf(vacation, "export async function getVacationActionCenterData(", VACATION),
    /buildVacationActionCenterRows\(\{ access, candidateRows, directory, stepsByRequest \}\)/,
    "the full Action Center must use the same row builder as the badge, or the two can drift apart",
  );
  const builder = bodyOf(vacation, "function buildVacationActionCenterRows(", VACATION);
  assert.match(builder, /resolveActionAvailability\(/, "the shared builder must decide the buttons");
  assert.match(builder, /evaluateAdminOverride\(/, "the shared builder must decide the override window");

  // ── The badge, the count and the overdue flag all take the light path ──────
  for (const fn of ["getVacationAwaitingBadge", "countVacationAwaiting", "isVacationAwaitingOverdue"]) {
    const body = bodyOf(hub, `export async function ${fn}(`, HUB);
    assert.ok(body.includes("getVacationAwaitingForBadge(access)"), `${fn} must read the light badge source`);
    assert.ok(
      !body.includes("getVacationApprovalsForResponder("),
      `${fn} calls getVacationApprovalsForResponder — that builds the full Action Center AND a second full Vacation Report per poll`,
    );
  }
  assert.match(
    bodyOf(hub, "async function getVacationAwaitingForBadge(", HUB),
    /\(await partitionVacationApprovals\(access, source\?\.centerRows \?\? \[\], source\?\.scopedRows \?\? \[\]\)\)\.awaiting/,
    "the badge must split awaiting from upcoming with the hub page's own partition",
  );
  assert.match(
    bodyOf(hub, "export async function getVacationApprovalsForResponder(", HUB),
    /return partitionVacationApprovals\(access, center\?\.rows \?\? \[\], report\?\.rows \?\? \[\]\);/,
    "the hub page must split with the same partition the badge uses",
  );

  // ── The hub badge counts only the sources whose items it keeps ──────────────
  const count = bodyOf(action, "export async function countAwaitingMyActionItems(", ACTION);
  for (const discarded of ["getVacationActionCenterData(", "getManagerPendingExcuses(", "getPlansAwaitingAction("]) {
    assert.ok(
      !count.includes(discarded),
      `countAwaitingMyActionItems reads ${discarded.slice(0, -1)} — every item it produces is filtered out of the inbox, ` +
        "so reading it costs a full read per poll for nothing.",
    );
  }
  // 31 Oct 2026, the owner's "lighter inbox count": the count no longer reads the two whole dashboards
  // (about ten Supabase requests per badge refresh) — only who is waiting and in which status.
  for (const dashboard of ["getResignationsDashboardData(", "getContractRenewalDashboardData("]) {
    assert.ok(!count.includes(dashboard), `countAwaitingMyActionItems reads ${dashboard.slice(0, -1)} — a whole dashboard for a number; read its light loader`);
  }
  assert.match(count, /residualInboxEntries\(/, "the count must build its entries with the list's own open-status rules");
  assert.match(count, /survivesAwaitingInbox\(item, access\)/, "the count must apply the list's own filter");
  // The list and the count decide what is WAITING by the same three rules, so neither can drift.
  const listBuilder = bodyOf(action, "function residualActionItems(", ACTION) + bodyOf(action, "function mapContractRenewalItem(", ACTION);
  const countBuilder = bodyOf(action, "function residualInboxEntries(", ACTION);
  for (const rule of ["isOpenResignation(", "isOpenOutstation(", "isActiveContractRenewal("]) {
    assert.ok(listBuilder.includes(rule), `the list must decide what waits with ${rule.slice(0, -1)}`);
    assert.ok(countBuilder.includes(rule), `the count must decide what waits with ${rule.slice(0, -1)}`);
  }
  const list = bodyOf(action, "export async function getAwaitingMyActionItemsWithHealth(", ACTION);
  assert.match(list, /residualActionItems\(/, "the list must build its residual items with the shared builders");
  assert.match(list, /survivesAwaitingInbox\(item, access\)/, "the list must filter with the shared filter");

  // The OTHER half of PERF-001, closed 2026-10-23. The badge was narrowed on 2026-10-04 and the
  // LIST was left reading all seven — and the list is what the Needs You board reads, through an
  // adapter that declares `cost: "heavy"` and so gets ONE 8-second budget in a lane of its own.
  // Measured from the delivered digests: "Other approvals inbox" was unreadable on 15 of the 15
  // mornings 9-23 Oct 2026, the worst of eleven sources, and three of its reads could contribute
  // nothing to the answer because every item they produced was filtered out again.
  for (const discarded of ["getVacationActionCenterData(", "getManagerPendingExcuses(", "getPlansAwaitingAction("]) {
    assert.ok(
      !list.includes(discarded),
      `getAwaitingMyActionItemsWithHealth reads ${discarded.slice(0, -1)} — every item it produces is filtered out ` +
        "by survivesAwaitingInbox, so it spends part of the Needs You heavy budget on an answer it cannot change. " +
        "Leave, excuse and plans each have their own Needs You source (leaveApprovals, excuseApprovals, " +
        "planApprovals), so dropping the read here under-reports nothing.",
    );
  }

  for (const route of ["src/lib/approvals-hub/badge-counts-payload.ts", "app/api/approvals-hub/pending-count/route.ts"]) {
    const source = read(route);
    assert.match(source, /countAwaitingMyActionItems\(access, audience\)/, `${route} must count, not list, the hub inbox`);
    assert.doesNotMatch(source, /getAwaitingMyActionItems\(/, `${route} must not build the seven-source inbox list just to take its length`);
  }
}
