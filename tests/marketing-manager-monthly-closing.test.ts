import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { employeePortalNavigationSections } from "../src/config/system-navigation.ts";
import { computeSalesAccessScope } from "../src/lib/sales/access-scope.ts";
import {
  createAccessContext,
  permissionActions,
  permissionMatrix,
  permissionResources,
  resolveNavigationMode,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";
import { OFFICIAL_LINE_VALUES } from "../src/lib/sales/official-lines.ts";
import { canAccessPortalClosing, PORTAL_CLOSING_ROLES } from "../src/lib/sales/monthly-closing-portal.ts";
import { selectClosingLines } from "../src/lib/sales/monthly-distributor-import.ts";
import { permissionAllowed, roleAllowed, roleNotExcluded, type PermissionLookup } from "../src/lib/navigation/active-path.ts";

const MARKETING: PhoenixRole = "Marketing Manager";
const PORTAL_CLOSING_HREF = "/employee-portals/monthly-closing";

/**
 * Owner, 2026-08-12: the Marketing Manager needs a Monthly Closing sidebar tab and the ability to
 * export any line's FULL closing sheet.
 *
 * He named /sales/monthly-closing. Her tab points somewhere else ON PURPOSE, and that decision is
 * what this file protects, because it reads like an oversight until you check why that URL cannot
 * be her door:
 *   - it is in the (admin) route group, and she is a portal-navigation role, so its page redirects
 *     her on `resolveNavigationMode(access) === "employee-portal"` BEFORE any role or permission
 *     check runs;
 *   - past that it admits only Super Admin, system scope and SFE Manager;
 *   - and past THAT it loads its matrix behind assertPermission(sales, "import"). `sales:import` is
 *     the one action she must never hold — it gates the upload/publish workspace and ten other
 *     pages. Granting it to reach an export would let her PRODUCE the closing she may only CONSUME.
 *
 * Same call the Finance Manager got in #2010 for the same request; see
 * tests/finance-manager-monthly-closing-row.test.ts.
 */
function lookupFor(role: PhoenixRole): PermissionLookup {
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      const key = `${resource}:${action}` as const;
      lookup[key] = permissionMatrix[role]?.[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

function portalHrefsFor(role: PhoenixRole): string[] {
  const lookup = lookupFor(role);
  const hrefs: string[] = [];
  for (const section of employeePortalNavigationSections) {
    for (const item of section.items) {
      if (
        permissionAllowed(lookup, item.permissions) &&
        roleAllowed(role, item.roles) &&
        roleNotExcluded(role, item.excludedRoles)
      ) {
        hrefs.push(item.href);
      }
    }
  }
  return hrefs;
}

export function runMarketingManagerMonthlyClosingTests() {
  // ── The row ────────────────────────────────────────────────────────────────
  assert.ok(
    portalHrefsFor(MARKETING).includes(PORTAL_CLOSING_HREF),
    "the Marketing Manager must have a Monthly Closing row in her portal sidebar — this row IS the " +
      "tab the owner asked for; the /sales/monthly-closing URL he named bounces her before any check",
  );

  // ── The three gates that must agree, or the tab is a dead link ─────────────
  // Gate 1: the page's own server gate (canAccessPortalClosing).
  assert.equal(
    canAccessPortalClosing(createAccessContext({ hrId: "A-9", loginId: "A-9", role: MARKETING })),
    true,
    "the portal closing page redirects anyone outside PORTAL_CLOSING_ROLES — without this the new " +
      "sidebar row renders and then bounces her to her landing page",
  );

  // Gate 2: the nav visibility flag. This is the pair that actually rots: the flag and the server
  // gate live in different files, and either one moving alone gives a visible tab that refuses, or
  // a grant with nothing to click. Asserted for EVERY role, not just hers.
  for (const role of PORTAL_CLOSING_ROLES) {
    assert.equal(
      resolveEmployeePortalNavVisibility(role, role).showMonthlyClosingTab,
      true,
      `${role} passes canAccessPortalClosing, so showMonthlyClosingTab must agree — a server gate ` +
        "that admits a role whose tab is hidden is an access grant nobody can reach",
    );
  }
  assert.equal(
    resolveEmployeePortalNavVisibility("Medical Rep", "Medical Rep").showMonthlyClosingTab,
    false,
    "Medical Rep has no line and stays out of both — this change opened one role, not the gate",
  );

  // Gate 3: the two permissions the page and the export route actually assert.
  assert.ok(
    permissionMatrix[MARKETING]?.sales?.includes("read"),
    "the portal closing page asserts sales:read — without it her new row 403s instead of rendering",
  );
  assert.ok(
    permissionMatrix[MARKETING]?.sales?.includes("export"),
    "the export route asserts sales:export before anything else — without it her Export XLSX 403s",
  );

  // ── The boundary that makes the destination choice correct ─────────────────
  // If she ever holds sales:import, someone has "simplified" this by pointing her at the admin
  // upload workspace — which hands her the publish-adjacent surfaces she was deliberately kept out
  // of, and makes the /sales/monthly-closing card visible to her as a side effect (that card is
  // gated on exactly this action).
  assert.equal(
    permissionMatrix[MARKETING]?.sales?.includes("import") ?? false,
    false,
    "the Marketing Manager must NEVER hold sales:import — she consumes the closing, she does not " +
      "produce it, and that action gates the upload/publish workspace plus ten other pages",
  );
  // The redirect that makes the admin URL unreachable for her in the first place. If this ever
  // returns "admin", she has been moved out of the employee portal entirely and every portal tab
  // she has went with it.
  assert.equal(
    resolveNavigationMode(createAccessContext({ hrId: "A-9", loginId: "A-9", role: MARKETING })),
    "employee-portal",
    "she is a portal-navigation role — this is WHY /sales/monthly-closing cannot be her tab, and " +
      "flipping it to admin would be a far larger change than a Monthly Closing row",
  );

  // ── The full-sheet guarantee ───────────────────────────────────────────────
  // Branch A of the export route is what makes her workbook the COMPLETE sheet set for any line she
  // oversees. The scoped branch silently degrades to a Data+Total-only workbook on HTTP 200, so
  // losing this naming is a quiet downgrade, not an error she would ever see.
  const exportSource = readFileSync(
    new URL("../app/api/sales/monthly-closing/export/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    exportSource,
    /marketingOversight !== null/,
    "the monthly-closing export route must still admit the Marketing Manager to its full-workbook " +
      "branch — without it she silently gets a Data+Total-only sheet on HTTP 200",
  );
  // The APPEND-ONLY contract on that disjunction: tests/sfe-manager-nav-dead-links.test.ts pins the
  // first three terms as a literal substring, so her term must sit at the END.
  assert.match(
    exportSource,
    /access\.role === "Super Admin" \|\| access\.scope === "system" \|\| access\.role === "SFE Manager"/,
    "the first three terms of the full-workbook disjunction must stay in order and in front — " +
      "another suite pins them as a literal source substring",
  );
  // An out-of-scope line must be REFUSED, never traded for one she does hold: Branch A's
  // loadMonthlyClosingParts falls back to availableLines[0] for a line it does not recognise, which
  // would build a full workbook labelled for the line she asked for and filled with another's.
  // Matched on the check itself, not on the 403 message — the scoped branch below already returns
  // that same message for details.outOfScope, so the string alone would pass with the guard deleted.
  assert.match(
    exportSource,
    /marketingOversight\.allowedLines\.some/,
    "her requested line must be checked against her own scope before the full-workbook branch runs " +
      "— that branch reads company-wide and would otherwise substitute a line she never asked for",
  );
  // The scoped branch's old Marketing carve-out is unreachable now that she takes Branch A, and a
  // second, lesser answer left lying there is how a future edit quietly re-routes her to it. Pinned
  // on the CALL, which only that dead branch ever made — the name still appears in a comment there
  // explaining why it went, and that comment is worth keeping.
  assert.doesNotMatch(
    exportSource,
    /loadMonthlyClosingWithStoreSplit\(/,
    "the scoped branch must not still build her a second, lesser matrix — she takes the " +
      "full-workbook branch, so that call is dead code and a trap for the next reader",
  );

  // ── Which lines she may open ──────────────────────────────────────────────
  // Her role default is LINE scope over the fixed head-office oversight set.
  const lineScoped = computeSalesAccessScope({
    role: MARKETING,
    businessScope: "LINE",
    viewerLineName: "Head Office",
    viewerRegionName: "Head office",
    includeRestricted: false,
    overseenLineNames: ["Anti Infective", "Pedia", "CNS"],
  });
  assert.deepEqual(
    [...(lineScoped.allowedLineNames ?? [])].sort(),
    ["Anti Infective", "CNS", "Pedia"],
    "her oversight set REPLACES her own Head Office line — falling back to it would resolve her to " +
      "a confidential line that carries no product sales and is never published",
  );
  // LINE scope is not region-scoped, so she must not pick up a geography bound. Her employee row
  // carries region "Head office", and a region bound built from it would match no sales row and
  // silently blank her matrix.
  assert.equal(
    lineScoped.allowedRegionNames,
    null,
    "LINE scope must leave geography unbounded — a region bound from her 'Head office' label would " +
      "match no closing row and render a confident empty matrix",
  );
  assert.equal(
    lineScoped.allowedAreaCodes,
    null,
    "and no seat-derived area bound either — she oversees whole lines, not a territory",
  );

  // ── The confidential line stays shut ──────────────────────────────────────
  // She reaches the full-workbook branch, which reads company-wide. Head Office is kept out of it
  // one level down, by the line list that branch resolves against.
  const rawLines = ["Anti Infective", "CNS", "Pedia", "Head Office", "IGNORE"];
  assert.deepEqual(
    selectClosingLines(rawLines),
    ["Anti Infective", "CNS", "Pedia"],
    "Head Office must stay out of the closeable line list for every caller — this is what makes a " +
      "hand-crafted {line:'Head Office'} export unserveable, hers included",
  );

  // The route comment leans on these two sets being the same today. If a fifth product line is ever
  // added, this fires — and whoever adds it has to decide whether she oversees it, instead of the
  // full-workbook branch silently handing her a company-wide matrix for a line she does not.
  assert.deepEqual(
    [...OFFICIAL_LINE_VALUES].filter((line) => line !== "Head Office").sort(),
    ["Anti Infective", "CNS", "Pedia"],
    "her oversight set covers every closeable line there is, which is why the full-workbook branch " +
      "is safe for her — add a line without revisiting MARKETING_OVERSIGHT_OFFICIAL_LINES and it is not",
  );

  // ── Roles this row must not leak to ────────────────────────────────────────
  assert.ok(
    !portalHrefsFor("Medical Rep").includes(PORTAL_CLOSING_HREF),
    "Medical Rep must not pick up the portal closing row — no resolvable product line",
  );
}
