import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  buildPermissionLookup,
  permissionMatrix,
  phoenixRoles,
  scopeForRole,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";

import {
  permissionGateKeys,
  roleSetGates,
  unreadableGatePredicates,
} from "./support/page-gate-reader.ts";

/**
 * The two entry-gate shapes tests/support/page-gate-reader.ts could not see until 2026-09-05, and
 * the shapes it must keep REFUSING to reduce.
 *
 * That reader's own header states the stakes: *"a parser that under-reads is a fail-open parser"*.
 * Two shapes were under-read, and both landed in navigation-granted-but-unreachable's `canOpen()`,
 * which answers "can this role open this page" for every role and every static route:
 *
 *   SHAPE A  `if (access.role !== "Super Admin") redirect("/employee-portals")` — 25 page files.
 *            /attendance/employee-day-report is the worked example. Its own comment says *"gate it
 *            to Super Admin only, not just the coarse attendance:read permission"*; the reader saw
 *            `attendance:read` and nothing else, so every role holding that grant read as able to
 *            open a Super-Admin-only page.
 *   SHAPE B  `const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
 *            if (!allowed) redirect("/admin")` — 8 page files. `unreadableGatePredicates` requires
 *            the `!` immediately before the CALL, so a predicate reached through a const was
 *            invisible and the page reported no role gate at all.
 *
 * ## Why this file pins the REFUSALS as hard as the reads
 *
 * The fix has an obvious wrong version, and it is the one a reader of the grep output would write.
 * A deny condition's admit set is its NEGATION, which swaps the operators: in `a && b`, each
 * conjunct is an alternative way IN, so harvesting only the role inequalities from
 *
 *     if (!canReadPlans && access.role !== "CEO" && access.role !== "Super Admin") redirect(…)
 *
 * yields {CEO, Super Admin} and silently locks out every role holding weekly_plans:read. That is not
 * a conservative approximation — it is a false accusation waiting for a caller, and
 * hr-seat-route-coherence.test.ts is exactly that caller: it already records
 * /hr/admin/weekly-plans/calendar as unparseable, *"an OR chain … which is why it cannot be
 * parsed"*, and both HR seats hold weekly_plans:read. So the four OR-chain files are asserted to
 * yield NOTHING, by name, and a future "improvement" that reduces them fails here.
 *
 * There were five until 2026-09-16, when /sales/monthly-closing/performance-review moved its gate
 * into `canOpenClosingPerformanceReview` so that its export route could ask the same question.
 * tests/closing-performance-review-export-gate.test.ts pins how the reader sees that page now.
 */

const APP_DIR = path.resolve(process.cwd(), "app");

function pageSource(...segments: string[]): string {
  return readFileSync(path.join(APP_DIR, ...segments, "page.tsx"), "utf8");
}

function walkPages(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkPages(full, out);
    else if (entry.name === "page.tsx") out.push(full);
  }
  return out;
}

/**
 * Every role the permission matrix grants `resource:action`.
 *
 * The lookup is keyed by the literal union of all 328 permission keys, so a plain `string` cannot
 * index it. Widened at the boundary the same way navigation-granted-but-unreachable's `canOpen()`
 * does — that keeps the key a string here, which is what makes the assertion messages below able to
 * name the permission they measured.
 */
function rolesHolding(key: string): PhoenixRole[] {
  return phoenixRoles.filter((role) => {
    const lookup: Record<string, boolean> = buildPermissionLookup(permissionMatrix, role);
    return Boolean(lookup[key]);
  });
}

export async function runPageGateReaderRoleInequalityGateTests(): Promise<void> {
  // ── SHAPE A, the worked example, stated as the fail-open it closes ───────────────────────────
  // Not "the reader returns [["Super Admin"]]" alone — that is a shape assertion and would still
  // pass if the grant it is measured against quietly emptied. The claim is the gap: the permission
  // is held by several roles, the page admits one, and before this change the reader reported only
  // the permission.
  const dayReport = pageSource("(admin)", "attendance", "employee-day-report");
  assert.deepEqual(
    [...permissionGateKeys(dayReport)].sort(),
    ["attendance:read"],
    "/attendance/employee-day-report no longer gates on attendance:read — re-measure this whole test",
  );
  const attendanceReaders = rolesHolding("attendance:read");
  assert.ok(
    attendanceReaders.length >= 3,
    `attendance:read is held by ${attendanceReaders.length} role(s) — with fewer than 3 this test ` +
      "cannot demonstrate the gap it exists for",
  );
  assert.deepEqual(
    roleSetGates(dayReport),
    [["Super Admin"]],
    "the reader stopped seeing `if (access.role !== \"Super Admin\") redirect(…)` on " +
      "/attendance/employee-day-report. That is the FAIL-OPEN this file exists to prevent: with no " +
      `role gate the page reads as openable by all ${attendanceReaders.length} holders of ` +
      `attendance:read (${attendanceReaders.join(", ")}) when its own comment says "gate it to ` +
      'Super Admin only, not just the coarse attendance:read permission"',
  );
  for (const role of attendanceReaders) {
    if (role === "Super Admin") continue;
    assert.ok(
      !roleSetGates(dayReport).some((names) => names.includes(role)),
      `${role} holds attendance:read and must NOT be admitted by /attendance/employee-day-report`,
    );
  }

  // ── SHAPE A, all four reducible forms, one page each ─────────────────────────────────────────
  // Each is a different arrangement of the same statement, and each was verified against the page's
  // own source on 2026-09-05. The `||` and `scope` rows are the ones worth keeping honest: the first
  // is EXACT only because the other disjunct is a permission gate that the caller requires
  // separately, and the second only because no role resolves to system scope (asserted below).
  assert.deepEqual(
    roleSetGates(pageSource("(admin)", "admin", "dev-preview")),
    [["Super Admin"]],
    "plain single inequality — `if (access.role !== \"Super Admin\") { redirect(…) }`",
  );
  assert.deepEqual(
    roleSetGates(pageSource("(admin)", "admin", "ceo-probation")),
    // Three names since 2026-10-08, when the Talent Acquisition seat (HR Resourcing) joined the chain.
    [["CEO", "Super Admin", "HR Resourcing"]],
    "an && chain of inequalities admits EVERY name in it — reading it as one would lock out the others",
  );

  const analytics = pageSource("(admin)", "attendance", "analytics");
  assert.deepEqual(
    roleSetGates(analytics),
    [["Super Admin"]],
    "`role !== \"Super Admin\" || !await canAccess(…)` — an OR-group is an INDEPENDENT requirement, " +
      "so the role half must be read even though the permission half is read separately",
  );
  assert.deepEqual(
    [...permissionGateKeys(analytics)].sort(),
    ["attendance:read"],
    "and the permission half must still be read, or the pair stops being exact",
  );

  assert.deepEqual(
    roleSetGates(pageSource("(admin)", "sales", "normalizer")),
    [["Super Admin"]],
    "`role !== \"Super Admin\" && access.scope !== \"system\"` — the scope conjunct is dropped, which " +
      "can only NARROW the admit list, never widen it",
  );
  // The scope conjunct is dropped as if unreadable, which makes the list a lower bound. It is
  // currently an EXACT one, and that rests on a fact outside this file: no role resolves to system
  // scope, so `access.scope !== "system"` admits nobody. If that ever changes the list is still safe
  // (narrower than the truth), but it stops being exact — so the fact is pinned here rather than
  // assumed in a comment.
  const systemScoped = phoenixRoles.filter((role) => scopeForRole(role) === "system");
  assert.deepEqual(
    systemScoped,
    [],
    `scopeForRole() now returns "system" for ${systemScoped.join(", ")}. The admit lists this reader ` +
      "builds from `role !== \"X\" && access.scope !== \"system\"` are still safe — they are a lower " +
      "bound — but they are no longer EXACT, and /sales/normalizer, /sales/closing-corrections, " +
      "/sales/customer-mapping and both customer-directory pages now admit more than they say",
  );

  // ── SHAPE A, the refusals: an && group with a non-inequality conjunct yields NOTHING ─────────
  const orChainPages: [string, string[], string][] = [
    ["/admin/weekly-plans", ["(admin)", "admin", "weekly-plans"], "canReadPlans"],
    ["/admin/weekly-plans/calendar", ["(admin)", "admin", "weekly-plans", "calendar"], "canReadPlans"],
    ["/employee-portals/plans", ["employee-portals", "plans"], "canReadPlans"],
    ["/sales/monthly-closing", ["(admin)", "sales", "monthly-closing"], "isSystemAdministratorViewer"],
  ];
  for (const [href, segments, hoisted] of orChainPages) {
    const source = pageSource(...segments);
    assert.match(
      source,
      new RegExp(`!${hoisted}\\s*&&`),
      `${href} no longer writes its gate as \`!${hoisted} && access.role !== …\` — re-verify whether ` +
        "it is now reducible before changing the assertion below",
    );
    assert.deepEqual(
      roleSetGates(source),
      [],
      `${href} must yield NO admit list. Its deny condition is \`!${hoisted} && role !== … && role !== …\`, ` +
        `where \`${hoisted}\` is an ALTERNATIVE way in — harvesting only the inequalities would claim ` +
        "the page admits two roles when it admits those two PLUS everyone the hoisted boolean lets " +
        "through, and hr-seat-route-coherence.test.ts would then accuse two working HR rows of " +
        "bouncing (both seats hold weekly_plans:read)",
    );
  }

  // ── SHAPE A, the two grep hits that are not entry gates at all ───────────────────────────────
  // Excluded by what the `if` DOES, not by a name list, so neither can drift back in unnoticed.
  const jsxProp = pageSource("(admin)", "admin", "field-workforce-compliance");
  assert.match(jsxProp, /showPayrollRecommendations=\{access\.role !== "SFE Manager"\}/);
  assert.deepEqual(
    roleSetGates(jsxProp),
    [],
    "/admin/field-workforce-compliance writes the inequality as a JSX PROP with no `if` — it dims a " +
      "panel, it does not refuse the visitor, and counting it would lock the page to one role",
  );
  const helperReturn = pageSource("(admin)", "coaching", "[id]");
  assert.match(helperReturn, /if \(access\.role !== "Training Manager"\) return true;/);
  assert.deepEqual(
    roleSetGates(helperReturn),
    [],
    "/coaching/[id] writes `if (access.role !== \"Training Manager\") return true;` inside an " +
      "ownership helper — the consequent does not exit the page, so it is not an entry gate",
  );

  // ── SHAPE B: the predicate reached through a const ───────────────────────────────────────────
  const constGated: [string, string[]][] = [
    ["/admin/ceo-command-center", ["(admin)", "admin", "ceo-command-center"]],
    ["/admin/company-calendar", ["(admin)", "admin", "company-calendar"]],
    ["/admin/email-control-center", ["(admin)", "admin", "email-control-center"]],
    ["/admin/finance-command-center", ["(admin)", "admin", "finance-command-center"]],
    ["/admin/finance-leave-management", ["(admin)", "admin", "finance-leave-management"]],
    ["/admin/payroll-copilot", ["(admin)", "admin", "payroll-copilot"]],
    ["/admin/payroll-copilot/insurance-wages", ["(admin)", "admin", "payroll-copilot", "insurance-wages"]],
    // /admin/system-issues left this list on 23 Oct 2026: it is now a redirect to /admin/system-audit.
  ];
  for (const [href, segments] of constGated) {
    const source = pageSource(...segments);
    assert.ok(
      unreadableGatePredicates(source).includes("canAccessSystemAdministratorWorkspace"),
      `${href} gates on \`const allowed = … || canAccessSystemAdministratorWorkspace(access); if ` +
        "(!allowed) redirect(\"/admin\")\` and the reader reported NOTHING for it — the page then " +
        "reads as open to every admin-shell role when it admits two",
    );
    // And it must stay REPORTED, never guessed: the role literal beside the predicate is one arm of
    // an `||`, so an admit list built from it would exclude the Super Admin the other arm lets in.
    assert.deepEqual(
      roleSetGates(source),
      [],
      `${href} must not produce an admit list. \`access.role === "CEO" || canAccess…(access)\` is a ` +
        "DISJUNCTION — reducing it to {CEO} would lock out Super Admin, which is the mirror error of " +
        "the fail-open being fixed",
    );
  }
  // email-control-center is the one that needs TWO hops — `allowed` names `isSuperAdmin`, and only
  // `isSuperAdmin` names the predicate. A one-level resolver passes every other page here and fails
  // this one, so it is called out rather than left to the loop.
  const emailControlCenter = pageSource("(admin)", "admin", "email-control-center");
  assert.match(
    emailControlCenter,
    /const isSuperAdmin = canAccessSystemAdministratorWorkspace\(access\);[\s\S]*const allowed = access\.role === "CEO" \|\| isSuperAdmin;/,
    "/admin/email-control-center no longer chains two consts — the two-hop resolution below is then " +
      "untested by this file even if it still works",
  );

  // ── Anti-vacuity: the extractors must still be extracting ────────────────────────────────────
  // Every assertion above names one page, so all of them could pass while the reader had quietly
  // stopped working everywhere else. These two floors are measured across all of `app/`: 24 pages
  // carry a readable role-set gate (6 named sets + 18 inequality gates) and 23 pages carry a
  // const-bound unreadable predicate, on 2026-09-05.
  const sources = walkPages(APP_DIR).map((file) => readFileSync(file, "utf8"));
  const withRoleSet = sources.filter((source) => roleSetGates(source).length > 0).length;
  assert.ok(
    withRoleSet >= 20,
    `only ${withRoleSet} pages across app/ carry a readable role-set gate (24 on 2026-09-05) — the ` +
      "extractor has probably stopped matching, which makes every role-name gate invisible again",
  );
  const inequalityGated = sources.filter(
    (source) => roleSetGates(source).length > 0 && !/new Set\(|\.includes\(\s*access\.role/.test(source),
  ).length;
  assert.ok(
    inequalityGated >= 14,
    `only ${inequalityGated} pages gate by role INEQUALITY rather than a named set (18 on ` +
      "2026-09-05) — SHAPE A specifically has stopped being read, which the floor above would miss " +
      "because the six named-set pages alone nearly satisfy it",
  );
}
