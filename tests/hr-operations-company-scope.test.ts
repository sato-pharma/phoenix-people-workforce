import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { getNavigationSections, type AdminToolsPageItem } from "../src/config/system-navigation.ts";
import * as navigation from "../src/config/system-navigation.ts";
import {
  canAccess,
  canApproveCompanyVacationReportRow,
  canReadCompanyActivityReport,
  canReadCompanyVacationReport,
  getPayrollScope,
  permissionActions,
  permissionMatrix,
  permissionResources,
  scopeForRole,
  type AccessContext,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { mapPhoenixRoleToAccessScopeType } from "../src/lib/auth/supabase-identity.ts";
import { getVacationVisibilityScope } from "../src/lib/vacation/visibility-scope.ts";
import {
  getSections,
  permissionAllowed,
  roleAllowed,
  roleNotExcluded,
  type PermissionLookup,
} from "../src/lib/navigation/active-path.ts";

/**
 * HR OPERATIONS ON COMPANY SCOPE — owner ruling, 2026-08-29: "she should have company scope".
 *
 * Yasmine El Safoury (HR-009) administers attendance, leave and payroll inputs for the whole
 * company, and her job description says so in two whole sections. She was nonetheless resolving to
 * scope "self" — the scope of somebody who may see only their own row — which silently contradicted
 * grants she already held. She had `payroll:[read, export]` and `payslips:[read, export]` from the
 * phases the owner approved, and could open neither page: both /payroll and /admin/payslips-center
 * redirect on getPayrollScope(access) !== "COMPANY" and never reach the permission check. Granted on
 * paper, bounced in practice.
 *
 * The reason this is safe to state as a rule rather than a hope is that "company" is not a master
 * key here. `canAccess` short-circuits on scope === "system" ONLY; every other scope falls through
 * to the permission matrix unchanged. So moving a seat from "self" to "company" must move no
 * permission answer whatsoever, and the first section below proves that by exhausting the matrix
 * rather than by asserting it from a reading of canAccess. If a future change ever gave "company"
 * a shortcut of its own, that section goes red for every HR grant at once.
 *
 * What company scope DOES do is satisfy the four mechanisms that ask about it directly, and they
 * are four separate lists in three files with nothing tying them together — scopeForRole,
 * getPayrollScope, the two company-report reader sets, and the nav role lists. Delivering one and
 * not the others is the shape of this repo's recurring "granted on paper, bounced in practice"
 * defect, so each is pinned here.
 *
 * Section 4 is the failure this change was most likely to cause. Widening a seat's nav puts rows on
 * screen; a row that opens a hub whose children are all still closed renders an empty page, and
 * empty is indistinguishable from broken from the user's side. Three of Yasmine's hubs opened that
 * way before this change and one of Aya's did.
 *
 * Section 5 is the one that outlives this change. Section 1's invariance proof covers `canAccess`,
 * and it is easy to read that as "the scope grants nothing" — but about eight places read the scope
 * directly, and two of them hand out authority on the scope ALONE: the Outstation Expense Command
 * (money) and the company payroll summary. Her scope now satisfies both. The only thing refusing her
 * is her permission matrix, so a later, unrelated grant would open them silently.
 *
 * HR Advisory is the control throughout. The owner's ruling named HR Operations and nothing else,
 * so Aya must be untouched by every assertion here — her job description gives her company-wide HR
 * INSIGHT, while her Role Boundaries withhold the authority that comes with company scope.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * The lookup the sidebar is really built from — DENSE, every resource:action pair present as a
 * real boolean. `permissionAllowed` fails OPEN on a key it has never seen (active-path.ts), so a
 * sparse lookup would quietly answer "allowed" for every permission the seat does not hold and the
 * empty-hub section below would be measuring nothing. app-shell.tsx builds it exactly this way.
 */
function denseLookup(role: PhoenixRole): PermissionLookup {
  const lookup: Record<string, boolean> = {};
  for (const resource of permissionResources as readonly PermissionResource[]) {
    for (const action of permissionActions as readonly PermissionAction[]) {
      lookup[`${resource}:${action}`] = permissionMatrix[role]?.[resource]?.includes(action) ?? false;
    }
  }
  return lookup as PermissionLookup;
}

/** Same href-to-file resolution the route-coherence suite uses. `/hr/x` is `app/(admin)/x`. */
function pageFileFor(href: string): string | null {
  const rest = href.startsWith("/hr/") ? href.slice(3) : href === "/hr" ? "/" : href;
  const rel = rest.replace(/^\//, "");
  for (const candidate of [
    path.join(REPO_ROOT, "app", "(admin)", rel, "page.tsx"),
    path.join(REPO_ROOT, "app", rel, "page.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const OPERATIONS = "HR Operations" as PhoenixRole;
const ADVISORY = "HR Advisory" as PhoenixRole;
const RESOURCING = "HR Resourcing" as PhoenixRole;

/**
 * A whole AccessContext, because canAccess wants one — same shape and same cast the route-coherence
 * suite uses. `scope` is passed in rather than resolved, since section 1 has to ask the SAME role
 * the same question under two different scopes.
 */
function accessFor(role: PhoenixRole, scope = scopeForRole(role)): AccessContext {
  return { role, scope, hrId: "HR-SCOPE-TEST", source: "session" } as AccessContext;
}

export async function runHrOperationsCompanyScopeTests() {
  // ── 1. Company scope opens no permission boundary ──────────────────────────────────────────
  // The whole change rests on this. Exhaust the matrix for HR Operations under both scopes and
  // require every answer to be identical; anything else means "company" acquired a shortcut and
  // the seat silently gained everything the matrix was withholding.
  assert.notEqual(
    scopeForRole(OPERATIONS),
    "system",
    'HR Operations must never resolve to scope "system" — that is the one value canAccess ' +
      "short-circuits on, and it would bypass the permission matrix entirely",
  );

  let pairsChecked = 0;
  const scopeMoved: string[] = [];
  for (const resource of permissionResources as readonly PermissionResource[]) {
    for (const action of permissionActions as readonly PermissionAction[]) {
      const asSelf = await canAccess(accessFor(OPERATIONS, "self"), resource, action);
      const asCompany = await canAccess(accessFor(OPERATIONS, "company"), resource, action);
      pairsChecked += 1;
      if (asSelf !== asCompany) scopeMoved.push(`${resource}:${action} (self=${asSelf} company=${asCompany})`);
    }
  }
  // Floor on the LOOP, not just its result. If permissionResources or permissionActions ever came
  // back empty, the comparison above would pass by comparing nothing — the silent pass is the
  // failure mode worth guarding, and this suite's whole safety argument rests on that loop running.
  assert.ok(
    pairsChecked >= 300,
    `only ${pairsChecked} resource/action pairs were compared — the matrix did not load, so the ` +
      "scope-invariance proof below it checked almost nothing",
  );
  assert.deepEqual(
    scopeMoved,
    [],
    "moving HR Operations to company scope changed a permission answer. canAccess is supposed to " +
      'short-circuit on scope === "system" alone, so company scope must be inert against the ' +
      "matrix. Something now grants on scope, and this seat gained it without anyone deciding to",
  );

  // ── 2. The four mechanisms that DO read the scope ──────────────────────────────────────────
  const operations = accessFor(OPERATIONS);
  assert.equal(scopeForRole(OPERATIONS), "company", "the owner's 2026-08-29 ruling");
  assert.equal(
    // Note this one takes the ROLE and not the scope — it is a second, parallel scope system, which
    // is exactly why moving scopeForRole alone left her bounced. Passing only what it accepts keeps
    // that visible: nothing here can be satisfied by the scope change on its own.
    getPayrollScope({ role: OPERATIONS }),
    "COMPANY",
    "/payroll and /admin/payslips-center redirect on getPayrollScope before they ever reach the " +
      "permission check, so payroll:read and payslips:read are decorative without this",
  );
  assert.equal(
    canReadCompanyVacationReport(operations),
    true,
    "she maintains leave balances (job description, ops 2), which is this report",
  );
  assert.equal(
    getVacationVisibilityScope(operations),
    "COMPANY",
    "the leave module's Vacation Report is the third parallel scope switch — it stayed SELF after " +
      "this ruling, so her own rail row opened a report holding only herself (found 2026-10-20)",
  );
  assert.equal(
    canReadCompanyActivityReport(operations),
    true,
    "she reconciles attendance against leave before payroll closure (ops 2), which is this report",
  );
  assert.equal(
    mapPhoenixRoleToAccessScopeType(OPERATIONS),
    "COMPANY_READ",
    "the access_scope column written at provisioning is a MIRROR — nothing reads it back to decide " +
      "access — but one that disagrees with scopeForRole misleads anyone auditing user_access_profiles",
  );

  // The write side is deliberately NOT carried along with the read side. She administers leave and
  // payroll inputs; she does not decide them. Her job description's Role Boundaries say so, and
  // every payroll write, and approving a row on the vacation report, is a separate matrix action.
  assert.equal(
    canApproveCompanyVacationReportRow(operations),
    false,
    "HR Operations reads the company vacation report and approves nothing from it — approval is " +
      "the system-administrator workspace, and widening the read must not have widened the write",
  );

  // ── 3. HR Advisory is the control — the ruling named one seat ──────────────────────────────
  // The seat was retired on 2026-10-08 and its key holds nothing, so it is still a valid control:
  // a key that should resolve to nobody must not inherit the company read on the way out.
  const advisory = accessFor(ADVISORY);
  assert.equal(scopeForRole(ADVISORY), "self", "the ruling was about HR Operations only");
  assert.equal(getPayrollScope({ role: ADVISORY }), "SELF", "Aya's job description does not mention payroll at all");
  assert.equal(canReadCompanyVacationReport(advisory), false, "leave administration is Yasmine's section 2");
  assert.equal(canReadCompanyActivityReport(advisory), false, "leave administration is Yasmine's section 2");
  assert.equal(getVacationVisibilityScope(advisory), "SELF", "the retired seat reads only itself in the leave module");
  assert.equal(mapPhoenixRoleToAccessScopeType(ADVISORY), "SELF", "her provisioning mirror moves with her scope");

  // ── 4. No row a seat is offered opens a hub AT ALL ─────────────────────────────────────────
  //
  // ── REPOINTED 2026-09-05, because the subject was removed rather than fixed ─────────────────
  //
  // This section used to say "no hub a seat is offered opens EMPTY". A hub page renders a list of
  // child links, each gated on its own permission or role list, while the sidebar row that opens it
  // is gated SEPARATELY — so a seat could hold the row's permission and none of the children's, and
  // the row would look like a working module and open a blank page. "Nothing here" and "not for
  // you" are the same screen from the outside.
  //
  // The owner then removed the shape entirely: "I don't want any subtitle to be the one that when I
  // press, it redirects me to a page with big modules." Every hub row on every rail was replaced by
  // that hub's cards. So the old check now examines ZERO hubs and its own floor says so — which is
  // the honest outcome, not a defect. Left as it was it would have been a check with no subject:
  // green forever, and green the day somebody adds a hub row back.
  //
  // What it asserts instead is the stronger property that replaced it, over the same rows and with
  // the same extractor: not one row either seat is offered renders a *PageItems list. An empty hub
  // cannot be reached from the rail because no hub can.
  const catalog = getNavigationSections("hr");
  const hubRows: string[] = [];
  const visibleChildrenOf = (
    lists: readonly string[],
    lookup: ReturnType<typeof denseLookup>,
    seat: PhoenixRole,
  ) => {
    const children = lists.flatMap(
      (name) => (navigation as Record<string, unknown>)[name] as readonly AdminToolsPageItem[],
    );
    return children.filter(
      (child) =>
        permissionAllowed(lookup, child.permissions) &&
        roleAllowed(seat, child.roles) &&
        roleNotExcluded(seat, child.excludedRoles),
    );
  };
  // Which exported nav list does a page render? A page that renders none is not a hub.
  const listsRenderedBy = (file: string): string[] => {
    const source = readFileSync(file, "utf8");
    return [...new Set([...source.matchAll(/\b(\w+PageItems)\b/g)].map((match) => match[1]!))].filter(
      (name) => Array.isArray((navigation as Record<string, unknown>)[name]),
    );
  };

  // The HR Business Partner was the second seat here until she was retired on 2026-10-08; the
  // Talent Acquisition seat takes her place as the other live HR rail.
  for (const seat of [OPERATIONS, RESOURCING]) {
    const lookup = denseLookup(seat);
    const rows = getSections(catalog, "hr", lookup, seat).flatMap((section) => section.items);
    assert.ok(rows.length >= 10, `"${seat}" is offered only ${rows.length} HR nav rows — the shell did not build`);

    for (const row of rows) {
      const file = pageFileFor(row.href);
      if (!file) continue; // A row with no page file is the route-coherence suite's failure, not this one.
      const lists = listsRenderedBy(file);
      if (!lists.length) continue;
      hubRows.push(
        `${seat}: "${row.label}" (${row.href}) renders ${lists.join(" + ")} — it is a hub page, and ` +
          "the owner's 2026-09-05 rule is that no rail row opens one. Promote its cards onto the " +
          "rail under the hub's own heading instead of listing the door",
      );
    }
  }
  assert.deepEqual(hubRows, [], hubRows.join(String.fromCharCode(10) + "  "));

  // The floor, which the assertion above cannot supply for itself: an extractor that has stopped
  // matching finds no hub anywhere, and "no hub is offered" then passes by doing nothing — the same
  // vacuity the old `hubsChecked >= 4` guarded against, on a claim that has flipped sign.
  //
  // It is also the surviving half of the property this section used to make. The two hub pages the
  // HR command centre still points at (tiles and charts, see DASHBOARD_DESTINATIONS_THAT_ARE_NOT_
  // ROWS in tests/hr-command-center.test.ts) are the ones an empty hub would still hurt on, so the
  // control runs on exactly those: the extractor must find their lists, and HR Operations — the
  // seat sent to both — must see cards on each.
  for (const [href, floor] of [["/hr/attendance", 5], ["/hr/admin/payroll-management", 2]] as const) {
    const file = pageFileFor(href);
    assert.ok(file, `${href} has no page file — the hub the command centre links to is gone`);
    const lists = listsRenderedBy(file!);
    assert.ok(
      lists.length > 0,
      `the *PageItems extractor found no nav list on ${href}, a page that is one — it has stopped ` +
        "matching, and the hub assertion above is passing by examining nothing",
    );
    const visible = visibleChildrenOf(lists, denseLookup(OPERATIONS), OPERATIONS);
    assert.ok(
      visible.length >= floor,
      `HR Operations sees ${visible.length} card(s) on ${href}, below the ${floor} measured on ` +
        "2026-09-05. Her command centre sends her there from a tile or a chart, so a hub that has " +
        "emptied out is a figure that leads to a blank page — the exact shape this section was " +
        "written for, on the one route the rail no longer covers",
    );
  }

  // ── 5. What company scope moves OUTSIDE canAccess — and why she is still refused ────────────
  // Section 1 proves the permission matrix is scope-invariant. That is not the whole story, and
  // reading it as though it were is the mistake this section exists to prevent: canAccess is not
  // the only gate in the app. Roughly eight places read the scope DIRECTLY, and two of them hand
  // out real authority rather than visibility —
  //
  //   src/lib/outstation/expense-command.ts  resolveScope(): `access.scope === "company"` alone
  //     resolves the Outstation Expense Command to company scope, and the caller is then `isAdmin`.
  //     That is a money surface.
  //   src/lib/admin/command-center.ts  canUseCompanyPayrollSummary(): company scope alone opens the
  //     company payroll summary.
  //
  // She is refused at both today — but NOT by her scope, which now satisfies each of them. She is
  // refused by the permission that gates the page, because she holds no expenses, sales or
  // business_review grant at all. So the safety is entirely in her MATRIX, and the scope half of
  // each condition is already true and permanently so.
  //
  // That makes this the trap worth pinning rather than the ones above: a future change granting her
  // `expenses:read` for some ordinary HR reason — reimbursements sit close to payroll — would make
  // her an outstation expense ADMIN in the same commit, with nothing in that diff mentioning scope.
  // If this assertion fails, the grant may still be right; what must not happen is it going in
  // without anyone noticing the second half arrived with it.
  const authorityByScopeAlone: readonly string[] = ["expenses", "sales", "business_review", "marketing_requests"];
  for (const resource of authorityByScopeAlone) {
    const actions = permissionMatrix[OPERATIONS]?.[resource as PermissionResource] ?? [];
    assert.deepEqual(
      [...actions],
      [],
      `HR Operations now holds "${resource}", and company scope was already true — check what that ` +
        "combination opened before allowing it. outstation/expense-command.ts resolveScope() turns a " +
        "company-scoped caller into an expense-command admin on the scope alone, so an expenses grant " +
        "is no longer just a read: the page gate was the only thing refusing her",
    );
  }
}
